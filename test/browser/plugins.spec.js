import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/* Plugins are lazy. The contract this file pins down:
     - boot() never builds one, whatever its requiredBy says
     - require() fetches, verifies, then constructs the whole bundle in order
     - two concurrent requires share one build
     - a tampered plugin is never evaluated, and the document stays readable
     - a missing or switched-off plugin refuses with a reason, not a crash

   The plugin's bytes are served from .test-tmp/, so these specs exercise the same
   fetch → SHA-384 → blob-import path a real pinned plugin takes. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const CDN = "http://127.0.0.1:8080/dist/cdn";
const STAGE = "http://127.0.0.1:8080/.test-tmp";
const SLIM = fs.readFileSync(path.join(ROOT, "dist/slim.html"), "utf8");

/* A plugin bundle shaped like ours: an entry that takes deps, a stylesheet, and one
   deliberate top-level side effect so the spec can count evaluations. */
const PLUGIN_JS = `globalThis.__evalCount = (globalThis.__evalCount || 0) + 1;

export function createWhiteboard(deps = {}) {
  return {
    kind: "whiteboard",
    mode: deps.settings && deps.settings.mode,
    hasEnv: Boolean(deps.env && deps.env.document),
  };
}
`;

const PLUGIN_CSS = `.whiteboard-chrome { outline: 1px solid rgb(1, 2, 3); }\n`;

const sha384 = (text) => "sha384-" + createHash("sha384").update(text, "utf8").digest("base64");
const bytes = (text) => Buffer.byteLength(text, "utf8");

const MANIFEST_RE = /(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/;

const PLUGIN_FILES = {
  entry: "plugin-whiteboard.js",
  styles: "plugin-whiteboard.css",
};

function writePluginFiles() {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(path.join(TMP, PLUGIN_FILES.entry), PLUGIN_JS);
  fs.writeFileSync(path.join(TMP, PLUGIN_FILES.styles), PLUGIN_CSS);
}

/**
 * A slim document plus one pinned plugin bundle.
 *
 * `integrity` is wrong on purpose in the tampered fixture; `enabled: false` is the
 * switched-off case. Both must still boot the document.
 */
function makeDoc({ tampered = false, enabled = true, withBundle = true } = {}) {
  writePluginFiles();
  const published = /"cdnBase":"([^"]*)"/.exec(SLIM)[1];
  let html = SLIM.split(published).join(CDN);

  const found = MANIFEST_RE.exec(html);
  const manifest = JSON.parse(found[2]);

  if (withBundle) {
    manifest.assets.push({
      id: "whiteboard-styles",
      kind: "css",
      role: "module",
      order: 200,
      mode: "online",
      category: "plugin",
      plugin: "whiteboard",
      requiredBy: ["*"],
      bytes: bytes(PLUGIN_CSS),
      url: `${STAGE}/${PLUGIN_FILES.styles}`,
      integrity: sha384(PLUGIN_CSS),
    });
    manifest.assets.push({
      id: "whiteboard",
      kind: "js",
      role: "module",
      order: 210,
      mode: "online",
      category: "plugin",
      plugin: "whiteboard",
      requiredBy: ["*"],
      bytes: bytes(PLUGIN_JS),
      factory: "createWhiteboard",
      url: `${STAGE}/${PLUGIN_FILES.entry}`,
      /* The whole point of the tampered fixture: the bytes at that url no longer
         match what the document pinned. */
      integrity: tampered ? sha384(PLUGIN_JS + "\n// different bytes\n") : sha384(PLUGIN_JS),
    });
    manifest.plugins = {
      whiteboard: {
        label: "Whiteboard",
        version: "1.0.0",
        isolation: "sealed",
        enabled,
        entry: "whiteboard",
        assets: ["whiteboard-styles", "whiteboard"],
        contributes: { insert: [{ id: "whiteboard", label: "Whiteboard" }] },
      },
    };
  }

  html = html.replace(MANIFEST_RE, (_, open, _json, close) => open + JSON.stringify(manifest) + close);

  const name = `.test-tmp/plugins-${process.pid}-${tampered ? "tampered" : enabled ? "on" : "off"}.html`;
  fs.writeFileSync(path.join(ROOT, name), html);
  return "/" + name;
}

async function load(page, url) {
  const problems = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, { timeout: 20_000 });
  return problems;
}

test.beforeAll(() => writePluginFiles());

test("boot builds every module but never a plugin", async ({ page }) => {
  const problems = await load(page, makeDoc());
  const state = await page.evaluate(() => ({
    doc: StandaloneDoc.state,
    built: Object.keys(StandaloneDoc.modules),
    plugins: StandaloneDoc.plugins(),
    styles: Boolean(document.querySelector('style[data-asset="whiteboard-styles"]')),
    errors: StandaloneDoc.errors.length,
    /* the plugin is on the manifest, and out of the boot order */
    inManifest: StandaloneDoc.manifest().assets.some((a) => a.id === "whiteboard"),
    inOrder: StandaloneDoc.order().includes("whiteboard"),
    evalCount: globalThis.__evalCount ?? 0,
  }));
  expect(state.doc).toBe("ready");
  expect(state.inManifest).toBe(true);
  expect(state.inOrder).toBe(false);
  expect(state.built).not.toContain("whiteboard");
  expect(state.styles).toBe(false);
  expect(state.errors).toBe(0);
  expect(state.evalCount).toBe(0);
  expect(state.plugins.whiteboard.label).toBe("Whiteboard");
  expect(problems).toEqual([]);
});

test("require() fetches, verifies and constructs the whole bundle", async ({ page }) => {
  const problems = await load(page, makeDoc());
  const result = await page.evaluate(async () => {
    const before = Boolean(document.querySelector('style[data-asset="whiteboard-styles"]'));
    const mod = await StandaloneDoc.require("whiteboard");
    return {
      before,
      built: Object.keys(StandaloneDoc.modules).includes("whiteboard"),
      kind: mod?.kind,
      deps: { mode: mod?.mode, env: mod?.hasEnv },
      styles: Boolean(document.querySelector('style[data-asset="whiteboard-styles"]')),
      /* a second call is the same module, not a rebuild */
      same: (await StandaloneDoc.require("whiteboard")) === mod,
      state: StandaloneDoc.state,
      errors: StandaloneDoc.errors.length,
    };
  });
  expect(result.before).toBe(false);
  expect(result.built).toBe(true);
  expect(result.kind).toBe("whiteboard");
  expect(result.deps).toEqual({ mode: "edit", env: true });
  expect(result.styles).toBe(true);
  expect(result.same).toBe(true);
  expect(result.state).toBe("ready");
  expect(result.errors).toBe(0);
  expect(problems).toEqual([]);
});

test("two concurrent require() calls construct once", async ({ page }) => {
  await load(page, makeDoc());
  const count = await page.evaluate(async () => {
    globalThis.__evalCount = 0;
    const [a, b, c] = await Promise.all([
      StandaloneDoc.require("whiteboard"),
      StandaloneDoc.require("whiteboard"),
      StandaloneDoc.require("whiteboard"),
    ]);
    return { evaluations: globalThis.__evalCount, same: a === b && b === c };
  });
  expect(count.evaluations).toBe(1);
  expect(count.same).toBe(true);
});

test("a tampered plugin is never evaluated, and the document survives", async ({ page }) => {
  const problems = await load(page, makeDoc({ tampered: true }));
  const result = await page.evaluate(async () => {
    globalThis.__evalCount = 0;
    try {
      await StandaloneDoc.require("whiteboard");
      return { threw: false };
    } catch (error) {
      return {
        threw: true,
        kind: error?.kind,
        message: error?.message,
        built: Object.keys(StandaloneDoc.modules).includes("whiteboard"),
        styles: Boolean(document.querySelector('style[data-asset="whiteboard-styles"]')),
        state: StandaloneDoc.state,
        errors: StandaloneDoc.errors.map((e) => e.kind),
        evaluations: globalThis.__evalCount,
      };
    }
  });
  expect(result.threw).toBe(true);
  expect(result.kind).toBe("integrity");
  expect(result.built).toBe(false);
  expect(result.state).toBe("ready");
  expect(result.errors).toEqual(["integrity"]);
  /* Neither the module nor the stylesheet was applied: verification happens before
     anything runs or is injected. */
  expect(result.styles).toBe(false);
  expect(result.evaluations).toBe(0);
  expect(problems).toEqual([]);
});

test("a switched-off plugin refuses with a reason", async ({ page }) => {
  await load(page, makeDoc({ enabled: false }));
  const result = await page.evaluate(async () => {
    try {
      await StandaloneDoc.require("whiteboard");
      return { threw: false };
    } catch (error) {
      return { threw: true, kind: error?.kind, message: error?.message, state: StandaloneDoc.state };
    }
  });
  expect(result.threw).toBe(true);
  expect(result.kind).toBe("disabled");
  expect(result.message).toContain("turned off");
  expect(result.state).toBe("ready");
});

test("a document with no pinned copy says so", async ({ page }) => {
  await load(page, makeDoc({ withBundle: false }));
  const result = await page.evaluate(async () => {
    try {
      await StandaloneDoc.require("whiteboard");
      return { threw: false };
    } catch (error) {
      return { threw: true, kind: error?.kind, message: error?.message, state: StandaloneDoc.state, errors: StandaloneDoc.errors.length };
    }
  });
  expect(result.threw).toBe(true);
  expect(result.kind).toBe("unresolved");
  expect(result.message).toContain("no pinned copy");
  expect(result.state).toBe("ready");
  expect(result.errors).toBe(1);
});
