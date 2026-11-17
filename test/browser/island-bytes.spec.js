import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/* Bytes into an island (5k).
 *
 * A sealed island has no network, so anything it needs to *run* has to be handed in. The
 * island asks by name through the bridge that is already in every island; the **figure**
 * decides what it may ask for, and the host answers with verified bytes — transferred, not
 * fetched, and never evaluated in the parent.
 *
 * The contract:
 *   - a declared asset arrives as an ArrayBuffer over postMessage
 *   - an undeclared one is refused, by name
 *   - the parent's cached bytes survive the transfer (a copy is sent)
 *   - it works in a sealed island, which is the entire point
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const EDITOR = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");
const MANIFEST_RE = /(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/;
const STORE_RE = /(<script id="figure-store" type="application\/json">)([\s\S]*?)(<\/script>)/;
const BOOTSTRAP = '<!-- @asset id="bootstrap" kind="js" order="120" -->';
const CONTENT_OPEN = '<article id="content" contenteditable="true" spellcheck="true">';

const WASM = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);
const BASE64 = WASM.toString("base64");
const sha384 = (buffer) => "sha384-" + createHash("sha384").update(buffer).digest("base64");

const ISLAND = `<body style="margin:0;font:12px system-ui">
<script>
(async () => {
  const report = {};
  try {
    const bytes = await window.__figureBytes("probe-runtime");
    report.size = bytes.byteLength;
    report.isBuffer = bytes instanceof ArrayBuffer;
    const { instance } = await WebAssembly.instantiate(bytes);
    report.five = instance.exports.add(2, 3);
  } catch (error) { report.error = String(error && error.message || error); }
  try { await window.__figureBytes("figures"); report.undeclared = "resolved"; }
  catch (error) { report.undeclared = String(error && error.message || error); }
  try { await window.__figureBytes("nothing-pinned"); report.unpinned = "resolved"; }
  catch (error) { report.unpinned = String(error && error.message || error); }
  parent.postMessage({ islandReport: report }, "*");
})();
</scr` + `ipt>
</body>`;

/** A document with one sealed figure that declares one binary asset. */
function makeDoc({ declared = ["probe-runtime"] } = {}) {
  let html = EDITOR;
  const manifest = JSON.parse(MANIFEST_RE.exec(html)[2]);
  manifest.assets.push({
    id: "probe-runtime",
    kind: "bin",
    role: "module",
    order: 200,
    mode: "inline",
    category: "plugin",
    plugin: "probe",
    requiredBy: ["*"],
    bytes: WASM.length,
    url: "/.test-tmp/probe-runtime.wasm",
    integrity: sha384(WASM),
  });
  html = html.replace(MANIFEST_RE, (_, open, _json, close) => open + JSON.stringify(manifest) + close);

  /* The block, before bootstrap: nothing registers here, but keeping binary bodies in one
     place makes the fixture readable. */
  const block = `<!-- @asset id="probe-runtime" kind="bin" order="200" -->\n<script type="application/wasm" id="probe-runtime">\n${BASE64}\n</script>\n<!-- /@asset -->`;
  html = html.replace(BOOTSTRAP, `${block}\n\n${BOOTSTRAP}`);

  const store = JSON.parse(STORE_RE.exec(html)[2]);
  store.figures.sealed = {
    id: "sealed",
    kind: "html",
    name: "sealed",
    mime: "text/html",
    bytes: 10,
    hash: "sealed",
    src: ISLAND,
    width: 0,
    height: 0,
    island: "sealed",
    assets: declared,
  };
  html = html.replace(STORE_RE, (_, open, _json, close) =>
    open + JSON.stringify(store).replace(/</g, "\\u003c") + close);

  html = html.replace(CONTENT_OPEN, CONTENT_OPEN
    + '<figure class="figure" data-figure-id="sealed" data-kind="html">'
    + '<div class="figure-frame" data-runtime="ephemeral"></div><figcaption>sealed</figcaption></figure>');

  fs.mkdirSync(TMP, { recursive: true });
  const name = `.test-tmp/island-bytes-${process.pid}-${declared.length}.html`;
  fs.writeFileSync(path.join(ROOT, name), html);
  return "/" + name;
}

async function run(page, url) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    globalThis.__report = null;
    window.addEventListener("message", (event) => {
      if (event.data && event.data.islandReport) globalThis.__report = event.data.islandReport;
    });
  });
  await page.goto(url);
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, { timeout: 20_000 });
  await page.evaluate(() => StandaloneDoc.modules.figures.mount(document.querySelector("figure.figure")));
  await page.waitForFunction(() => globalThis.__report, null, { timeout: 15_000 });
  const report = await page.evaluate(() => globalThis.__report);
  return { report, errors };
}

test("a sealed island receives its declared bytes and runs them", async ({ page }) => {
  const { report, errors } = await run(page, makeDoc());
  expect(report.error).toBeUndefined();
  expect(report.isBuffer).toBe(true);
  expect(report.size).toBe(WASM.length);
  /* sealed means no network, and the module ran anyway: the bytes came over the bridge */
  expect(report.five).toBe(5);
  expect(errors).toEqual([]);
});

test("an undeclared asset is refused by name, and so is an unpinned one", async ({ page }) => {
  const { report } = await run(page, makeDoc());
  expect(report.undeclared).toContain("not declared by this figure");
  expect(report.unpinned).toContain("not declared by this figure");
});

test("the island gets a copy: the parent's bytes survive the transfer", async ({ page }) => {
  await run(page, makeDoc());
  const after = await page.evaluate(async () => {
    /* If the island had been handed the cached ArrayBuffer, this would be detached. */
    const bytes = await StandaloneDoc.bytes("probe-runtime");
    return { size: bytes.byteLength, detached: bytes.byteLength === 0 };
  });
  expect(after.size).toBe(WASM.length);
  expect(after.detached).toBe(false);
});

test("a figure that declares nothing can still ask — and gets a refusal", async ({ page }) => {
  const { report } = await run(page, makeDoc({ declared: [] }));
  expect(report.size).toBeUndefined();
  expect(report.error).toContain("not declared by this figure");
});
