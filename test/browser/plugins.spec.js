import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/* Plugins are lazy, and they run against a host the registry owns. The contract this
   file pins down:

     - boot() never builds one, whatever its requiredBy says
     - require() fetches, verifies, constructs the bundle, then activates it
     - two concurrent requires share one build
     - a tampered plugin is never evaluated, and the document stays readable
     - a missing, switched-off or wrong-API plugin refuses with a reason
     - unload withdraws what the host handed out even when deactivate() lies or throws
     - a build that was in flight during an unload cannot resurrect the plugin

   The plugin's bytes are served from .test-tmp/, so these exercise the same
   fetch → SHA-384 → blob-import path a real pinned plugin takes. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const CDN = "http://127.0.0.1:8080/dist/cdn";
const STAGE = "http://127.0.0.1:8080/.test-tmp";
const SLIM = fs.readFileSync(path.join(ROOT, "dist/slim.html"), "utf8");

const sha384 = (text) => "sha384-" + createHash("sha384").update(text, "utf8").digest("base64");
const byteLength = (text) => Buffer.byteLength(text, "utf8");
const MANIFEST_RE = /(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/;

/* The minimum plausible plugin: a factory, deps, and one deliberate top-level side
   effect so the spec can count evaluations. */
const BASIC_JS = `globalThis.__evalCount = (globalThis.__evalCount || 0) + 1;

export function createWhiteboard(deps = {}) {
  return {
    kind: "whiteboard",
    mode: deps.settings && deps.settings.mode,
    hasEnv: Boolean(deps.env && deps.env.document),
  };
}
`;

/* A plugin that actually uses the host: reads its own bytes, asks for a capability,
   asks for one this document does not have, and registers cleanup two ways. */
const HOST_JS = `globalThis.__evalCount = (globalThis.__evalCount || 0) + 1;

export async function createHarness() {
  return {
    kind: "harness",
    async activate(host) {
      /* own bytes, then a refusal from a module it does not own, then a capability
         this document has no provider for. All three are awaited: host.text() is
         async by design (bytes may have to be fetched). */
      const own = await host.text("whiteboard");
      let borrowed = "read a module it does not own";
      try { await host.text("signals"); } catch (error) { borrowed = error.kind; }
      let missing = "resolved";
      try { host.use("editor"); } catch (error) { missing = error.kind; }
      let demo = "unavailable";
      try { demo = host.use("demo").value; } catch (error) { demo = error.kind; }
      globalThis.__host = {
        api: host.api,
        id: host.plugin.id,
        label: host.plugin.label,
        isolation: host.plugin.isolation,
        own: own.includes("createHarness"),
        borrowed,
        demo,
        missing,
      };
      host.track(() => { globalThis.__tracked = (globalThis.__tracked || 0) + 1; });
      return {
        deactivate() {
          globalThis.__deactivated = (globalThis.__deactivated || 0) + 1;
          /* Deliberately does not undo the tracked disposal: the point is that the
             host does not need it to. */
        },
      };
    },
  };
}

export async function createLiar() {
  return {
    async activate(host) {
      host.track(() => { globalThis.__tracked = (globalThis.__tracked || 0) + 1; });
      return {
        deactivate() {
          throw new Error("deactivate is a lie");
        },
      };
    },
  };
}
`;

const CSS = `.whiteboard-chrome { outline: 1px solid rgb(1, 2, 3); }\n`;

function writeFixtureFiles() {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(path.join(TMP, "plugin-basic.js"), BASIC_JS);
  fs.writeFileSync(path.join(TMP, "plugin-host.js"), HOST_JS);
  fs.writeFileSync(path.join(TMP, "plugin-styles.css"), CSS);
}

/**
 * A slim document plus one pinned plugin bundle.
 *
 * `integrity` is wrong on purpose in the tampered fixture; `enabled: false` is the
 * switched-off case; `api` above the host's is the version-mismatch case. All of them
 * must still boot the document.
 */
function makeDoc(options = {}) {
  const {
    tampered = false,
    enabled = true,
    withBundle = true,
    api,
    source = BASIC_JS,
    factory = "createWhiteboard",
  } = options;
  writeFixtureFiles();

  const published = /"cdnBase":"([^"]*)"/.exec(SLIM)[1];
  let html = SLIM.split(published).join(CDN);
  const manifest = JSON.parse(MANIFEST_RE.exec(html)[2]);

  if (withBundle) {
    manifest.assets.push(
      {
        id: "whiteboard-styles",
        kind: "css",
        role: "module",
        order: 200,
        mode: "online",
        category: "plugin",
        plugin: "whiteboard",
        requiredBy: ["*"],
        bytes: byteLength(CSS),
        url: `${STAGE}/plugin-styles.css`,
        integrity: sha384(CSS),
      },
      {
        id: "whiteboard",
        kind: "js",
        role: "module",
        order: 210,
        mode: "online",
        category: "plugin",
        plugin: "whiteboard",
        requiredBy: ["*"],
        bytes: byteLength(source),
        factory,
        url: `${STAGE}/${source === BASIC_JS ? "plugin-basic.js" : "plugin-host.js"}`,
        /* The point of the tampered fixture: the bytes at that url no longer match
           what the document pinned. */
        integrity: tampered ? sha384(source + "\n// different bytes\n") : sha384(source),
      },
    );
    manifest.plugins = {
      whiteboard: {
        label: "Whiteboard",
        version: "1.0.0",
        isolation: "sealed",
        enabled,
        entry: "whiteboard",
        assets: ["whiteboard-styles", "whiteboard"],
        contributes: { insert: [{ id: "whiteboard", label: "Whiteboard" }] },
        ...(api ? { api } : {}),
      },
    };
  }

  html = html.replace(MANIFEST_RE, (_, open, _json, close) => open + JSON.stringify(manifest) + close);

  const slug = [tampered && "tampered", !enabled && "off", !withBundle && "bare", api && `api${api}`, source === HOST_JS && "host", factory]
    .filter(Boolean)
    .join("-") || "base";
  const name = `.test-tmp/plugins-${process.pid}-${slug}.html`;
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

test.beforeAll(() => writeFixtureFiles());

test("boot builds every module but never a plugin", async ({ page }) => {
  const problems = await load(page, makeDoc());
  const state = await page.evaluate(() => ({
    doc: StandaloneDoc.state,
    built: Object.keys(StandaloneDoc.modules),
    plugins: StandaloneDoc.plugins(),
    styles: Boolean(document.querySelector('style[data-asset="whiteboard-styles"]')),
    errors: StandaloneDoc.errors.length,
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

test("activate() receives a host scoped to its own bundle", async ({ page }) => {
  const problems = await load(page, makeDoc({ source: HOST_JS, factory: "createHarness" }));
  const host = await page.evaluate(async () => {
    StandaloneDoc.provide("demo", { value: 42 });
    await StandaloneDoc.require("whiteboard");
    return globalThis.__host;
  });
  expect(host.api).toBe(1);
  expect(host.id).toBe("whiteboard");
  /* The label and isolation come from the manifest — that is where the document's
     own description of the plugin lives. */
  expect(host.label).toBe("Whiteboard");
  expect(host.isolation).toBe("sealed");
  /* It can read its own bytes… */
  expect(host.own).toBe(true);
  /* …cannot read another plugin's, and cannot reach a capability this document has
     no module for. Both refuse with a kind, not a stack trace. */
  expect(host.borrowed).toBe("forbidden");
  expect(host.demo).toBe(42);
  expect(host.missing).toBe("unavailable");
  expect(problems).toEqual([]);
});

test("unload withdraws host-tracked effects even when deactivate() is not called", async ({ page }) => {
  await load(page, makeDoc({ source: HOST_JS, factory: "createHarness" }));
  const result = await page.evaluate(async () => {
    globalThis.__tracked = 0;
    globalThis.__deactivated = 0;
    await StandaloneDoc.require("whiteboard");
    const built = {
      module: Object.keys(StandaloneDoc.modules).includes("whiteboard"),
      styles: Boolean(document.querySelector('style[data-asset="whiteboard-styles"]')),
    };
    const events = [];
    StandaloneDoc.on("plugin", (detail) => events.push(detail.state));
    const unloaded = await StandaloneDoc.deactivate("whiteboard");
    return {
      built,
      unloaded,
      module: Object.keys(StandaloneDoc.modules).includes("whiteboard"),
      styles: Boolean(document.querySelector('style[data-asset="whiteboard-styles"]')),
      tracked: globalThis.__tracked,
      deactivated: globalThis.__deactivated,
      events,
      state: StandaloneDoc.state,
    };
  });
  expect(result.built).toEqual({ module: true, styles: true });
  expect(result.unloaded).toBe(true);
  expect(result.module).toBe(false);
  expect(result.styles).toBe(false);
  expect(result.tracked).toBe(1);
  expect(result.deactivated).toBe(1);
  expect(result.events).toEqual(["deactivated"]);
  expect(result.state).toBe("ready");
});

test("a deactivate() that throws is recorded, and the host still cleans up", async ({ page }) => {
  const problems = await load(page, makeDoc({ source: HOST_JS, factory: "createLiar" }));
  const result = await page.evaluate(async () => {
    globalThis.__tracked = 0;
    await StandaloneDoc.require("whiteboard");
    await StandaloneDoc.deactivate("whiteboard");
    return {
      tracked: globalThis.__tracked,
      module: Object.keys(StandaloneDoc.modules).includes("whiteboard"),
      kinds: StandaloneDoc.errors.map((e) => e.kind),
      message: StandaloneDoc.errors[0]?.message,
      state: StandaloneDoc.state,
    };
  });
  expect(result.tracked).toBe(1);
  expect(result.module).toBe(false);
  expect(result.kinds).toEqual(["construct"]);
  expect(result.message).toContain("deactivate is a lie");
  expect(result.state).toBe("ready");
  /* The plugin's own error is reported through the registry, not the console. */
  expect(problems.some((line) => line.includes("deactivate is a lie"))).toBe(false);
});

test("a plugin that needs a newer host API is refused before activate", async ({ page }) => {
  await load(page, makeDoc({ source: HOST_JS, factory: "createHarness", api: 2 }));
  const result = await page.evaluate(async () => {
    globalThis.__host = null;
    try {
      await StandaloneDoc.require("whiteboard");
      return { threw: false };
    } catch (error) {
      return {
        threw: true,
        kind: error?.kind,
        message: error?.message,
        activated: Boolean(globalThis.__host),
        module: Object.keys(StandaloneDoc.modules).includes("whiteboard"),
        styles: Boolean(document.querySelector('style[data-asset="whiteboard-styles"]')),
        state: StandaloneDoc.state,
      };
    }
  });
  expect(result.threw).toBe(true);
  expect(result.kind).toBe("api");
  expect(result.message).toContain("host API 2");
  expect(result.activated).toBe(false);
  expect(result.module).toBe(false);
  expect(result.styles).toBe(false);
  expect(result.state).toBe("ready");
});

test("an unload during a build cannot be undone by that build", async ({ page }) => {
  await load(page, makeDoc({ source: HOST_JS, factory: "createHarness" }));
  const result = await page.evaluate(async () => {
    globalThis.__host = null;
    const building = StandaloneDoc.require("whiteboard");
    /* Unloading before the fetch finishes bumps the generation. */
    await StandaloneDoc.deactivate("whiteboard");
    try {
      await building;
      return { threw: false, activated: Boolean(globalThis.__host) };
    } catch (error) {
      return {
        threw: true,
        kind: error?.kind,
        activated: Boolean(globalThis.__host),
        module: Object.keys(StandaloneDoc.modules).includes("whiteboard"),
      };
    }
  });
  expect(result.threw).toBe(true);
  expect(result.kind).toBe("stale");
  expect(result.activated).toBe(false);
  expect(result.module).toBe(false);
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

/* ------------------------------------------------------------------ file:// ---
   A document opened from disk is the archival case, so a plugin has to work there
   too. Two ways, and both are measured here rather than argued:

     inline   the plugin's bytes are a block in the file — require() does no I/O at all
     online   the bytes arrive by reference; a file:// page can fetch and hash them,
              but only from a host that sends Access-Control-Allow-Origin (lab/007)

   What a file:// page cannot do is fetch a *relative* path: Chromium and WebKit treat
   each file as an opaque origin and refuse it. So a pinned url is either absolute or
   the bytes are inline — there is no third option. */

const EDITOR = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");

const DISK_PLUGIN_JS = `globalThis.__activated = globalThis.__activated || 0;

export async function createWhiteboard() {
  return {
    kind: "whiteboard-from-disk",
    async activate() {
      globalThis.__activated += 1;
      return { deactivate() {} };
    },
  };
}
`;

/**
 * An editor document on disk with one plugin pinned, inline or by reference.
 * `file://` has no server, so the online case points at the dev server, which is the
 * only CORS-enabled host a spec can reach offline.
 */
function makeFileDoc({ inline }) {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(path.join(TMP, "plugin-disk.js"), DISK_PLUGIN_JS);
  let html = EDITOR;
  const manifest = JSON.parse(MANIFEST_RE.exec(html)[2]);
  manifest.assets.push({
    id: "whiteboard",
    kind: "js",
    role: "module",
    order: 220,
    mode: inline ? "inline" : "online",
    category: "plugin",
    plugin: "whiteboard",
    requiredBy: ["*"],
    bytes: byteLength(DISK_PLUGIN_JS),
    factory: "createWhiteboard",
    url: `${STAGE}/plugin-disk.js`,
    integrity: sha384(DISK_PLUGIN_JS),
  });
  manifest.plugins = {
    whiteboard: {
      label: "Whiteboard",
      version: "1.0.0",
      isolation: "sealed",
      enabled: true,
      entry: "whiteboard",
      assets: ["whiteboard"],
    },
  };
  html = html.replace(MANIFEST_RE, (_, open, _json, close) => open + JSON.stringify(manifest) + close);

  if (inline) {
    /* The block carries the register line, exactly as a save-produced inline asset
       does: that is what makes require() a construct-only operation offline. */
    const block = `<!-- @asset id="whiteboard" kind="js" order="220" -->\n`
      + `<script type="module" id="whiteboard">\n${DISK_PLUGIN_JS}\nStandaloneDoc.register("whiteboard", createWhiteboard);\n</script>\n`
      + `<!-- /@asset -->\n`;
    html = html.replace('<!-- @asset id="bootstrap" kind="js" order="120" -->', `${block}\n<!-- @asset id="bootstrap" kind="js" order="120" -->`);
  }

  const name = `.test-tmp/disk-${process.pid}-${inline ? "inline" : "online"}.html`;
  fs.writeFileSync(path.join(ROOT, name), html);
  return path.join(ROOT, name);
}

async function openFromDisk(page, file) {
  const http = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) http.push(request.url());
  });
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto("file://" + file);
  await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, { timeout: 20_000 });
  return { http, problems };
}

test("an inline plugin loads from disk with no network at all", async ({ page }) => {
  const file = makeFileDoc({ inline: true });
  const { http, problems } = await openFromDisk(page, file);
  const result = await page.evaluate(async () => {
    const mod = await StandaloneDoc.require("whiteboard");
    return {
      kind: mod?.kind,
      activated: globalThis.__activated,
      state: StandaloneDoc.state,
      errors: StandaloneDoc.errors.length,
      /* the bytes really are in the document, as a block, not fetched */
      block: Boolean(document.getElementById("whiteboard")),
    };
  });
  expect(result.kind).toBe("whiteboard-from-disk");
  expect(result.activated).toBe(1);
  expect(result.block).toBe(true);
  expect(result.state).toBe("ready");
  expect(result.errors).toBe(0);
  expect(http).toEqual([]);
  expect(problems).toEqual([]);
});

test("an online plugin loads from disk when the host allows CORS", async ({ page }) => {
  const file = makeFileDoc({ inline: false });
  const { http, problems } = await openFromDisk(page, file);
  const result = await page.evaluate(async () => {
    const mod = await StandaloneDoc.require("whiteboard");
    return { kind: mod?.kind, activated: globalThis.__activated, state: StandaloneDoc.state, errors: StandaloneDoc.errors.length };
  });
  expect(result.kind).toBe("whiteboard-from-disk");
  expect(result.activated).toBe(1);
  expect(result.state).toBe("ready");
  expect(result.errors).toBe(0);
  /* exactly one request: the plugin. Everything else in this document is inline. */
  expect(http.filter((url) => url.endsWith("/plugin-disk.js")).length).toBe(1);
  expect(problems).toEqual([]);
});
