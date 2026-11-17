import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/* A `bin` asset: bytes carried by a text document.
 *
 *   - the block is base64 in a `<script type="application/wasm">`, and the loader decodes
 *     it back to exactly the bytes the pin describes
 *   - `host.bytes(id)` is how a plugin gets them; `host.text(id)` refuses, with a pointer
 *   - one plugin cannot read another plugin's bytes
 *   - boot never builds or touches a plugin's binary: `require()` does
 *
 * The 41-byte module is assembled here byte by byte: `add(i32, i32) -> i32`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const EDITOR = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");
const MANIFEST_RE = /(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/;
const BOOTSTRAP = '<!-- @asset id="bootstrap" kind="js" order="120" -->';

const WASM = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);
const BASE64 = WASM.toString("base64");
const sha384 = (buffer) => "sha384-" + createHash("sha384").update(buffer).digest("base64");

const PLUGIN_JS = `export function createWasmProbe() {
  return {
    async activate(host) {
      const bytes = await host.bytes("probe-runtime");
      const { instance } = await WebAssembly.instantiate(bytes);
      globalThis.__probe = {
        size: bytes.byteLength,
        five: instance.exports.add(2, 3),
        exports: Object.keys(instance.exports),
        textRefused: await host.text("probe-runtime").then(() => "resolved", (error) => error.message),
        foreignRefused: await host.bytes("figures").then(() => "resolved", (error) => error.kind),
      };
      return { deactivate() {} };
    },
  };
}
`;

/** An editor document with one plugin bundling an inline wasm asset and an inline module. */
function makeDoc() {
  let html = EDITOR;
  const manifest = JSON.parse(MANIFEST_RE.exec(html)[2]);
  manifest.assets.push(
    {
      id: "probe-runtime", kind: "bin", role: "module", order: 200, mode: "inline",
      category: "plugin", plugin: "wasm-probe", requiredBy: ["*"],
      bytes: WASM.length, url: "/.test-tmp/probe-runtime.wasm", integrity: sha384(WASM),
    },
    {
      id: "wasm-probe", kind: "js", role: "module", order: 210, mode: "inline",
      category: "plugin", plugin: "wasm-probe", requiredBy: ["*"],
      bytes: Buffer.byteLength(PLUGIN_JS), factory: "createWasmProbe",
      url: "/.test-tmp/wasm-probe.js", integrity: sha384(Buffer.from(PLUGIN_JS)),
    },
  );
  manifest.plugins = {
    "wasm-probe": {
      label: "Wasm probe", version: "1.0.0", island: "sealed", enabled: true,
      entry: "wasm-probe", assets: ["probe-runtime", "wasm-probe"],
    },
  };
  html = html.replace(MANIFEST_RE, (_, open, _json, close) => open + JSON.stringify(manifest) + close);

  const blocks = [
    `<!-- @asset id="probe-runtime" kind="bin" order="200" -->\n<script type="application/wasm" id="probe-runtime">\n${BASE64}\n</script>\n<!-- /@asset -->`,
    `<!-- @asset id="wasm-probe" kind="js" order="210" -->\n<script type="module" id="wasm-probe">\n${PLUGIN_JS}\nStandaloneDoc.register("wasm-probe", createWasmProbe);\n</script>\n<!-- /@asset -->`,
  ].join("\n\n");
  if (!html.includes(BOOTSTRAP)) throw new Error("fixture: no bootstrap block");
  html = html.replace(BOOTSTRAP, `${blocks}\n\n${BOOTSTRAP}`);

  fs.mkdirSync(TMP, { recursive: true });
  const name = `.test-tmp/bin-${process.pid}.html`;
  fs.writeFileSync(path.join(ROOT, name), html);
  return "/" + name;
}

async function load(page) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(makeDoc());
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, { timeout: 20_000 });
  return problems;
}

test("boot leaves a plugin's binary alone; require() hands it over as bytes", async ({ page }) => {
  const problems = await load(page);

  const before = await page.evaluate(() => ({
    built: Object.keys(StandaloneDoc.modules).includes("wasm-probe"),
    cached: typeof StandaloneDoc.bytes === "function",
  }));
  expect(before.built).toBe(false);

  const after = await page.evaluate(async () => {
    await StandaloneDoc.require("wasm-probe");
    return globalThis.__probe;
  });
  expect(after.size).toBe(WASM.length);
  expect(after.five).toBe(5);
  expect(after.exports).toEqual(["add"]);
  expect(problems).toEqual([]);
});

test("only bytes are readable from a binary asset, and only its own", async ({ page }) => {
  await load(page);
  const probe = await page.evaluate(async () => {
    await StandaloneDoc.require("wasm-probe");
    return globalThis.__probe;
  });
  expect(probe.textRefused).toContain("use host.bytes()");
  expect(probe.foreignRefused).toBe("forbidden");
});

test("the block is base64 in a wasm script element, and decodes to the pinned bytes", async ({ page }) => {
  await load(page);
  const block = await page.evaluate(async () => {
    const el = document.getElementById("probe-runtime");
    const bytes = new Uint8Array(await StandaloneDoc.bytes("probe-runtime"));
    return {
      type: el.getAttribute("type"),
      text: el.textContent.trim(),
      first: [bytes[0], bytes[1], bytes[2], bytes[3]],
      magic: new TextDecoder().decode(bytes.subarray(0, 4)),
    };
  });
  expect(block.type).toBe("application/wasm");
  expect(block.text).toBe(BASE64);
  expect(block.magic).toBe("\0asm");
  expect(block.first).toEqual([0x00, 0x61, 0x73, 0x6d]);
});
