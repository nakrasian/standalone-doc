import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/* The plugins sheet: the author-facing half, and the first place where *installing*
 * writes to the file rather than reading from it.
 *
 *   - it lists what is pinned, with the island profile and the figure count
 *   - a plugin a figure needs cannot be switched off or removed
 *   - install from a url fetches, hashes, then pins — and refuses a relative url
 *   - install from the catalog uses the version's own pin
 *   - everything it writes lands in #asset-manifest, and a save carries it
 *   - the sheet itself never reaches a saved file
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
/* One directory per worker. The sheet derives the catalog url from `cdnBase`, and the
   no-catalog test deletes that file — so a shared directory is a race between workers,
   not a fixture. */
const DIR = `sheet-${process.pid}`;
const FILES = path.join(TMP, DIR);
const LOCAL = `http://127.0.0.1:8080/.test-tmp/${DIR}`;
const EDITOR = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");

const PLUGIN_JS = `export function createWidget() {
  return {
    async activate() {
      return {
        command: {
          ping: () => { globalThis.__pinged = (globalThis.__pinged || 0) + 1; },
        },
        insert: {
          tile: async () => ({ html: "<body>a widget tile</body>", caption: "Widget tile" }),
        },
      };
    },
  };
}
`;

const sha384 = (text) => "sha384-" + createHash("sha384").update(text, "utf8").digest("base64");
const byteLength = (text) => Buffer.byteLength(text, "utf8");
/* A second module for the bundle fixture: a plain library, no factory, so the test proves
   that "many assets" is the shape and not "the same asset twice". */
const LIB_JS = `export const WIDGET_LIB = "1.2.3";\n`;
const MANIFEST_RE = /(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/;

/**
 * An editor document whose cdnBase points at the local server, so the catalog url
 * (`<base>/registry.json`) resolves to a file this spec controls. The document itself
 * is fully inline, so nothing else is fetched.
 */
function makeDoc({
  pinned = false, catalog = true, withFigure = false, inlineCatalog = false, bundle = false,
  tamper = false, catalogVersion = "2.0.0", catalogJs = PLUGIN_JS, catalogTag = null,
  catalogIsland = "trusted", pinDir = null, bundleApi = 1, bundleMinRuntime = null,
} = {}) {
  fs.mkdirSync(FILES, { recursive: true });
  fs.writeFileSync(path.join(FILES, "widget-plugin.js"), PLUGIN_JS);
  fs.writeFileSync(path.join(FILES, "widget-lib.js"), LIB_JS);
  /* The bytes the *catalog* proposes, which are not necessarily the bytes this file pins —
     that difference is what an update and a substitution both are. */
  /* Same bytes, same url: only a *different* proposal needs its own file, so the fixtures that
     are about installing keep pointing where a real catalog would. */
  const catalogFile = catalogJs === PLUGIN_JS ? "widget-plugin.js" : "widget-plugin-catalog.js";
  if (catalogFile !== "widget-plugin.js") fs.writeFileSync(path.join(FILES, catalogFile), catalogJs);

  /* A tag-shaped base is what a *released* document has; `pinDir` fabricates one
     (`<dir>/t@v0.9.0/cdn`) so staleness and refresh can be tested without a release. */
  const base = pinDir ? `${LOCAL}/${pinDir}/cdn` : `${LOCAL}/cdn`;
  let html = EDITOR.replace(/"cdnBase":"[^"]*"/, `"cdnBase":"${base}"`);
  const manifest = JSON.parse(MANIFEST_RE.exec(html)[2]);
  /* These fixtures serve the legacy catalog beside `cdnBase`, so they remove the authored
     index: the loader then falls back to `<cdnBase>/../registry.json`, which is the path a
     document written before `pluginIndex` exists still takes. The index itself is covered
     by the plugin-index unit test and the dev-build test. */
  delete manifest.pluginIndex;

  if (pinned) {
    manifest.assets.push({
      id: "widget", kind: "js", role: "module", order: 210, mode: "online",
      category: "plugin", plugin: "widget", requiredBy: ["*"],
      bytes: byteLength(PLUGIN_JS), factory: "createWidget",
      url: `${LOCAL}/widget-plugin.js`, integrity: sha384(PLUGIN_JS),
    });
    manifest.plugins = {
      widget: {
        label: "Widgets", version: "2.0.0", island: "sealed", enabled: true,
        entry: "widget", assets: ["widget"],
        contributes: { command: [{ id: "ping", label: "Ping" }] },
      },
    };
  }
  html = html.replace(MANIFEST_RE, (_, open, _json, close) => open + JSON.stringify(manifest) + close);

  if (withFigure) {
    const store = JSON.parse(/(<script id="figure-store" type="application\/json">)([\s\S]*?)(<\/script>)/.exec(html)[2]);
    store.figures.widgetfig = {
      id: "widgetfig", kind: "html", name: "Widget figure", mime: "text/html",
      bytes: 20, hash: "x", src: "<body>widget</body>", width: 0, height: 0,
      plugin: { id: "widget", label: "Widgets", url: `${LOCAL}/widget-plugin.js`, integrity: sha384(PLUGIN_JS) },
      island: "sealed",
    };
    html = html.replace(/(<script id="figure-store" type="application\/json">)([\s\S]*?)(<\/script>)/,
      (_, open, _json, close) => open + JSON.stringify(store) + close);
    html = html.replace('<article id="content" contenteditable="true" spellcheck="true">',
      '<article id="content" contenteditable="true" spellcheck="true">'
      + '<figure class="figure" data-figure-id="widgetfig" data-kind="html">'
      + '<div class="figure-frame" data-runtime="ephemeral"></div><figcaption>Widget figure</figcaption></figure>');
  }

  /* One plugin, many assets: the catalog's whole contribution is the manifest's location and
     its hash. The fixture's manifest is written beside the registry, which is where a real
     one lives under the tag's `dist/`. */
  const bundleManifest = bundle ? {
    schema: 1,
    id: "widget",
    label: "Widgets (bundle)",
    version: "3.0.0",
    api: bundleApi,
    island: "sealed",
    entry: "widget",
    about: "Two assets, one switch.",
    assets: [
      { id: "widget-lib", kind: "js", role: "module", order: 300, mode: "online", category: "plugin", plugin: "widget", requiredBy: ["*"], bytes: byteLength(LIB_JS), url: `${LOCAL}/widget-lib.js`, integrity: sha384(LIB_JS) },
      { id: "widget", kind: "js", role: "module", order: 301, mode: "online", category: "plugin", plugin: "widget", requiredBy: ["*"], bytes: byteLength(PLUGIN_JS), factory: "createWidget", url: `${LOCAL}/widget-plugin.js`, integrity: sha384(PLUGIN_JS) },
    ],
    contributes: { insert: [{ id: "tile", label: "Widget tile", island: "sealed" }] },
  } : null;
  const bundleJson = bundle ? JSON.stringify(bundleManifest, null, 2) + "\n" : null;
  if (bundle) fs.writeFileSync(path.join(FILES, "widget-bundle.json"), bundleJson);
  /* `tamper` rewrites the hash the catalog pins and leaves the manifest alone: two different
     files disagreeing about the same bytes, which is the only thing standing between a
     document and pins it never chose. */
  const bundleEntry = () => ({
    label: bundleManifest.label,
    version: bundleManifest.version,
    api: bundleManifest.api,
    ...(bundleMinRuntime ? {minRuntime: bundleMinRuntime} : {}),
    island: bundleManifest.island,
    entry: bundleManifest.entry,
    manifest: "widget-bundle.json",
    bytes: byteLength(bundleJson),
    sha384: tamper ? "sha384-" + "A".repeat(64) : sha384(bundleJson),
    assets: bundleManifest.assets.length,
    assetBytes: bundleManifest.assets.reduce((sum, asset) => sum + asset.bytes, 0),
    about: bundleManifest.about,
  });

  const catalogJson = JSON.stringify({
      schema: 1,
      assets: bundle ? {} : {
        widget: {
          label: "Widgets",
          island: catalogIsland,
          description: "A widget from the catalog.",
          versions: [{
            version: catalogVersion,
            url: `${LOCAL}/${catalogFile}`,
            sha384: sha384(catalogJs),
            bytes: byteLength(catalogJs),
            factory: "createWidget",
            /* what the plugin offers travels with the proposal: an installed plugin that
               contributed a menu must keep contributing it */
            contributes: { insert: [{ id: "tile", label: "Widget tile", island: "sealed" }] },
          }],
        },
      },
      ...(bundle ? { bundles: { widget: bundleEntry() } } : {}),
  });
  if (catalog) {
    fs.writeFileSync(path.join(FILES, "registry.json"), catalogJson);
    if (pinDir) {
      fs.mkdirSync(path.join(FILES, pinDir), { recursive: true });
      fs.writeFileSync(path.join(FILES, pinDir, "registry.json"), catalogJson);
    }
  } else {
    fs.rmSync(path.join(FILES, "registry.json"), { force: true });
    if (pinDir) fs.rmSync(path.join(FILES, pinDir, "registry.json"), { force: true });
  }

  const slug = [
    pinned && "pinned", !catalog && "nocat", withFigure && "fig",
    inlineCatalog && (catalogTag ? `inlinecat-${catalogTag}` : "inlinecat"),
    bundle && (tamper ? "bundle-tampered" : "bundle"),
    catalogVersion !== "2.0.0" && `cat-${catalogVersion}`,
    catalogJs !== PLUGIN_JS && "cat-other-bytes",
    catalogIsland !== "trusted" && `island-${catalogIsland}`,
    bundleApi !== 1 && `api-${bundleApi}`,
    bundleMinRuntime && `min-${bundleMinRuntime}`,
    pinDir,
  ].filter(Boolean).join("-") || "base";
  /* A document may carry its catalog: that is what makes "Available" work from disk,
     where a relative fetch is impossible (lab/007). */
  if (inlineCatalog) {
    /* The same JSON, carried by the document instead of served next to it. `catalogTag` is
       what a snapshot knows about itself: the tag it was taken at. */
    const carried = catalogTag ? JSON.stringify({...JSON.parse(catalogJson), tag: catalogTag}) : catalogJson;
    const block = `<script id="plugin-catalog" type="application/json">${carried.replace(/</g, "\\u003c")}</script>`;
    const at = html.lastIndexOf("</body>");
    html = html.slice(0, at) + block + html.slice(at);
  }

  const name = `.test-tmp/${DIR}/doc-${slug}.html`;
  fs.writeFileSync(path.join(ROOT, name), html);
  return "/" + name;
}

/* The plugin sheet is a *panel* of the document dialog now: plugins, storage and the pin are
   one file's business, and the menu item opens the dialog on that panel. */
async function openSheet(page, url) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, { timeout: 20_000 });
  await page.evaluate(() => document.querySelector("[data-plugins-open]").click());
  await page.waitForSelector('#doc-settings-dialog[open] [data-dd-panel="plugins"]:not([hidden])');
  await page.waitForSelector("[data-dd-plugins] .ps-root");
  return problems;
}


/* The fixture's catalog entry is `trusted`, so every install asks first. Confirm it, then
   wait for the pin *and* the activation (the menu entry appears when activate() resolves). */
async function confirmInstall(page) {
  await page.evaluate(() => document.querySelector("[data-install]").click());
  await page.waitForSelector("dialog.plugin-trust[open]");
  await page.evaluate(() => document.querySelector("[data-pt-ok]").click());
  await page.waitForFunction(() => Object.keys(JSON.parse(document.getElementById("asset-manifest").textContent).plugins || {}).includes("widget"));
  await page.waitForFunction(() => document.querySelectorAll("[data-plugin-insert]").length > 0);
}

const sheetState = (page) =>
  page.evaluate(() => {
    const sheet = document.querySelector("[data-dd-plugins]");
    const rows = [...sheet.querySelectorAll('[data-ps-list="installed"] .ps-row')].map((row) => ({
      id: row.dataset.id,
      name: row.querySelector(".ps-name")?.textContent,
      island: row.querySelector(".ps-badge")?.textContent,
      used: row.querySelector(".ps-used")?.textContent,
      on: row.querySelector("[data-toggle]")?.checked,
      assets: row.querySelectorAll(".ps-assets tbody tr").length,
    }));
    return {
      open: document.getElementById("doc-settings-dialog").open,
      sub: sheet.querySelector("[data-ps-sub]").textContent,
      foot: sheet.querySelector("[data-ps-foot]").textContent,
      rows,
      available: [...sheet.querySelectorAll('[data-ps-list="available"] .ps-row')].map((row) => row.dataset.id),
      empty: sheet.querySelector('[data-ps-list="installed"] .ps-empty')?.textContent || null,
      manifest: JSON.parse(document.getElementById("asset-manifest").textContent).plugins || {},
      dirty: !document.querySelector("[data-dirty]")?.hidden,
    };
  });

test("the sheet opens from both bars and says what is in the file", async ({ page }) => {
  const problems = await openSheet(page, makeDoc());
  const state = await sheetState(page);
  expect(state.open).toBe(true);
  expect(state.rows).toEqual([]);
  expect(state.empty).toContain("No plugins in this file");
  /* one entry per bar */
  expect(await page.evaluate(() => document.querySelectorAll("[data-plugins-open]").length)).toBe(2);
  /* One dialog, and no second sheet: the panel is a tab, not a sibling window. */
  expect(await page.evaluate(() => document.querySelectorAll("dialog.plugin-sheet, dialog[data-plugin-ui]").length)).toBe(0);
  expect(problems).toEqual([]);
});

test("a pinned plugin is listed with its island, its assets and its figure count", async ({ page }) => {
  await openSheet(page, makeDoc({ pinned: true, withFigure: true }));
  await page.waitForFunction(() => !!document.querySelector('[data-ps-list="installed"] .ps-row'));
  const state = await sheetState(page);
  expect(state.rows).toEqual([
    { id: "widget", name: "Widgets", island: "sealed", used: "used by 1 figure", on: true, assets: 1 },
  ]);
});

test("a plugin a figure needs cannot be switched off or removed", async ({ page }) => {
  await openSheet(page, makeDoc({ pinned: true, withFigure: true }));
  await page.waitForFunction(() => !!document.querySelector("[data-toggle]"));

  const refused = await page.evaluate(async () => {
    const box = document.querySelector("[data-toggle]");
    box.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterToggle = {
      foot: document.querySelector("[data-ps-foot]").textContent,
      stillOn: document.querySelector("[data-toggle]").checked,
    };
    document.querySelector("[data-remove]").click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterRemove = {
      foot: document.querySelector("[data-ps-foot]").textContent,
      rows: document.querySelectorAll('[data-ps-list="installed"] .ps-row').length,
      plugins: Object.keys(JSON.parse(document.getElementById("asset-manifest").textContent).plugins || {}),
    };
    return { afterToggle, afterRemove };
  });
  expect(refused.afterToggle.stillOn).toBe(true);
  expect(refused.afterToggle.foot).toContain("Refused");
  expect(refused.afterToggle.foot).toContain("1 figure");
  expect(refused.afterRemove.rows).toBe(1);
  expect(refused.afterRemove.plugins).toEqual(["widget"]);
  expect(refused.afterRemove.foot).toContain("Refused");
});

test("a document that carries its catalog needs no network for it", async ({ page }) => {
  /* The catalog file is deliberately absent: only the block in the document can supply it. */
  await openSheet(page, makeDoc({ catalog: false, inlineCatalog: true }));
  await page.waitForFunction(() => !!document.querySelector("[data-install]"));

  const state = await page.evaluate(() => ({
    from: document.querySelector("[data-ps-from]").textContent,
    available: [...document.querySelectorAll('[data-ps-list="available"] .ps-row')].map((row) => row.dataset.id),
    installs: document.querySelectorAll("[data-install]").length,
  }));
  /* "· this file" is the label: it says where the list came from, which is the difference
     between a real catalog and a document that remembered one. */
  expect(state.from).toContain("this file");
  expect(state.available).toEqual(["widget"]);
  expect(state.installs).toBe(1);

  await confirmInstall(page);
  const pinned = await page.evaluate(() => {
    const asset = JSON.parse(document.getElementById("asset-manifest").textContent).assets.find((a) => a.id === "widget");
    return { url: asset.url, integrity: asset.integrity };
  });
  expect(pinned.url).toBe(`${LOCAL}/widget-plugin.js`);
  expect(pinned.integrity).toMatch(/^sha384-/);
});

test("install from the catalog pins the version's own hash", async ({ page }) => {
  await openSheet(page, makeDoc());
  await page.waitForFunction(() => !!document.querySelector("[data-install]"));

  await page.evaluate(() => document.querySelector("[data-install]").click());
  /* A trusted bundle asks before it is pinned. Nothing is written until it is confirmed. */
  await page.waitForSelector("dialog.plugin-trust[open]");
  const asked = await page.evaluate(() => ({
    title: document.querySelector(".plugin-trust h2").textContent,
    what: document.querySelector(".plugin-trust .pt-what").textContent,
    manifest: Object.keys(JSON.parse(document.getElementById("asset-manifest").textContent).plugins || {}),
  }));
  expect(asked.title).toContain("unsandboxed content");
  expect(asked.what).toContain("read and modify this document");
  expect(asked.manifest).toEqual([]);

  /* Cancelling changes nothing… */
  await page.evaluate(() => document.querySelector("[data-pt-cancel]").click());
  expect(await page.evaluate(() => Object.keys(JSON.parse(document.getElementById("asset-manifest").textContent).plugins || {}))).toEqual([]);

  /* …and confirming pins it. */
  await page.evaluate(() => document.querySelector("[data-install]").click());
  await page.waitForSelector("dialog.plugin-trust[open]");
  await page.evaluate(() => document.querySelector("[data-pt-ok]").click());
  await page.waitForFunction(() => Object.keys(JSON.parse(document.getElementById("asset-manifest").textContent).plugins || {}).includes("widget"));
  /* The pin lands first; the menu entry appears when activate() resolves. Both are part
     of "installed", so wait for both rather than racing the second. */
  await page.waitForFunction(() => document.querySelectorAll("[data-plugin-insert]").length > 0);

  const state = await page.evaluate(() => {
    const manifest = JSON.parse(document.getElementById("asset-manifest").textContent);
    const asset = manifest.assets.find((candidate) => candidate.id === "widget");
    return {
      plugin: manifest.plugins.widget,
      asset: { kind: asset.kind, mode: asset.mode, category: asset.category, plugin: asset.plugin, factory: asset.factory, url: asset.url, integrity: asset.integrity },
      /* installed from the catalog, so the catalog's island wins over the default */
      island: manifest.plugins.widget.island,
      dirty: !document.querySelector("[data-dirty]")?.hidden,
      loaded: Boolean(StandaloneDoc.instance("widget")),
      insertEntries: document.querySelectorAll("[data-plugin-insert]").length,
      manifestContributes: manifest.plugins.widget.contributes,
    };
  });
  expect(state.plugin.label).toBe("Widgets");
  expect(state.plugin.version).toBe("2.0.0");
  expect(state.island).toBe("trusted");
  expect(state.asset.kind).toBe("js");
  expect(state.asset.mode).toBe("online");
  expect(state.asset.category).toBe("plugin");
  expect(state.asset.plugin).toBe("widget");
  expect(state.asset.factory).toBe("createWidget");
  expect(state.asset.url).toBe(`${LOCAL}/widget-plugin.js`);
  expect(state.asset.integrity).toMatch(/^sha384-/);
  expect(state.dirty).toBe(true);
  /* the capability resolves and the plugin is built: a catalog install is usable now */
  expect(state.loaded).toBe(true);
  /* and its declaration came with it: the menu entry exists without a reload */
  expect(state.insertEntries).toBeGreaterThan(0);
  expect(state.manifestContributes).toEqual({ insert: [{ id: "tile", label: "Widget tile", island: "sealed" }] });
});

test("install from a url fetches, hashes and pins; a relative url is refused", async ({ page }) => {
  await openSheet(page, makeDoc({ catalog: false }));
  await page.waitForFunction(() => document.querySelectorAll(".ps-field input").length === 2);

  const relative = await page.evaluate(async () => {
    const [url, name] = document.querySelectorAll(".ps-field input");
    url.value = "./widget-plugin.js";
    name.value = "Relative widget";
    document.querySelector(".ps-field .ps-btn").click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      result: document.querySelector(".ps-result").textContent,
      addDisabled: [...document.querySelectorAll(".ps-field .ps-btn")][1].disabled,
    };
  });
  expect(relative.result).toContain("absolute");

  /* The url is Node-side state; evaluate() runs in the page, so pass it in. */
  const absolute = await page.evaluate(async (pluginUrl) => {
    const [url, name] = document.querySelectorAll(".ps-field input");
    url.value = pluginUrl;
    name.value = "Widget";
    document.querySelector(".ps-field .ps-btn").click();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const buttons = [...document.querySelectorAll(".ps-field .ps-btn")];
    const verified = document.querySelector(".ps-result").textContent;
    buttons[1].click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const manifest = JSON.parse(document.getElementById("asset-manifest").textContent);
    return {
      verified,
      plugin: manifest.plugins.widget,
      asset: manifest.assets.find((candidate) => candidate.id === "widget"),
    };
  }, `${LOCAL}/widget-plugin.js`);
  expect(absolute.verified).toContain("verified");
  expect(absolute.verified).toMatch(/verified \d+ (bytes|KB)/);
  /* the id is the slugged name, and the label stays what the author typed */
  expect(absolute.plugin.label).toBe("Widget");
  expect(absolute.asset.id).toBe("widget");
  /* no factory declared: a raw ES module is pinned as a library, not a factory */
  expect(absolute.asset.factory).toBeUndefined();
  expect(absolute.asset.integrity).toMatch(/^sha384-/);
});

test("removing an unused plugin drops its entry, its assets and its menus", async ({ page }) => {
  await openSheet(page, makeDoc({ pinned: true }));
  await page.waitForFunction(() => !!document.querySelector("[data-remove]"));

  const after = await page.evaluate(async () => {
    document.querySelector("[data-remove]").click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const manifest = JSON.parse(document.getElementById("asset-manifest").textContent);
    return {
      plugins: manifest.plugins || {},
      assets: manifest.assets.filter((asset) => asset.plugin).map((asset) => asset.id),
      commands: document.querySelectorAll("[data-plugin-command]").length,
      rows: document.querySelectorAll('[data-ps-list="installed"] .ps-row').length,
      foot: document.querySelector("[data-ps-foot]").textContent,
      state: StandaloneDoc.state,
    };
  });
  expect(after.plugins).toEqual({});
  expect(after.assets).toEqual([]);
  /* the contribution went with it, and the document is still perfectly alive */
  expect(after.commands).toBe(0);
  expect(after.rows).toBe(0);
  expect(after.foot).toContain("removed from this file");
  expect(after.state).toBe("ready");
});

test("what the sheet installs survives a save, and the sheet itself does not", async ({ page }) => {
  await openSheet(page, makeDoc());
  await page.waitForFunction(() => !!document.querySelector("[data-install]"));
  const saved = await page.evaluate(async () => {
    document.querySelector("[data-install]").click();
    /* trusted bundle: confirm, then let the pin and the activation land */
    await new Promise((resolve) => setTimeout(resolve, 150));
    document.querySelector("[data-pt-ok]").click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const serialized = await StandaloneDoc.modules.toolbar.serialize({ policy: "inline" });
    const doc = new DOMParser().parseFromString(serialized.html, "text/html");
    const manifest = JSON.parse(doc.getElementById("asset-manifest").textContent);
    return {
      sheets: doc.querySelectorAll("dialog.plugin-sheet").length,
      tagged: doc.querySelectorAll("[data-plugin-ui]").length,
      plugins: Object.keys(manifest.plugins || {}),
      /* the pin the sheet wrote is what a reader gets */
      integrity: manifest.assets.find((asset) => asset.id === "widget")?.integrity,
      mode: manifest.assets.find((asset) => asset.id === "widget")?.mode,
      /* the inline preset really does embed it: the block is in the saved file */
      block: Boolean(doc.getElementById("widget")),
      problems: StandaloneDoc.modules.toolbar.validate(serialized.html),
    };
  });
  expect(saved.sheets).toBe(0);
  expect(saved.tagged).toBe(0);
  expect(saved.plugins).toEqual(["widget"]);
  expect(saved.integrity).toMatch(/^sha384-/);
  /* Saved with the inline preset, so the plugin's bytes travel in the file — that is the
     storage decision, and it is what makes a plugin document work from disk, offline. */
  expect(saved.mode).toBe("inline");
  expect(saved.block).toBe(true);
  expect(saved.problems).toEqual([]);
});

test("a catalog bundle installs its manifest's assets, not a single module", async ({ page }) => {
  await openSheet(page, makeDoc({ bundle: true }));
  await page.waitForFunction(() => !!document.querySelector("[data-install-bundle]"));

  /* The row can only say what the projection carries: a count and a price, never the pins. */
  const row = await page.evaluate(() => ({
    name: document.querySelector('[data-ps-list="available"] .ps-name').textContent,
    version: document.querySelector('[data-ps-list="available"] .ps-version').textContent,
    summary: document.querySelector('[data-ps-list="available"] .ps-used').textContent,
    hint: document.querySelector('[data-ps-list="available"] .ps-hint')?.textContent,
  }));
  expect(row.name).toBe("Widgets (bundle)");
  expect(row.version).toBe("v3.0.0");
  expect(row.summary).toContain("2 assets");
  expect(row.hint).toContain("Two assets, one switch.");

  await page.evaluate(() => document.querySelector("[data-install-bundle]").click());
  await page.waitForFunction(() => Object.keys(JSON.parse(document.getElementById("asset-manifest").textContent).plugins || {}).includes("widget"));
  await page.waitForFunction(() => document.querySelectorAll("[data-plugin-insert]").length > 0);

  const state = await page.evaluate(() => {
    const manifest = JSON.parse(document.getElementById("asset-manifest").textContent);
    return {
      plugin: manifest.plugins.widget,
      assets: manifest.assets.filter((asset) => asset.plugin === "widget").map((asset) => ({
        id: asset.id, category: asset.category, mode: asset.mode, plugin: asset.plugin,
        url: asset.url, integrity: asset.integrity, factory: asset.factory,
      })),
      loaded: Boolean(StandaloneDoc.instance("widget")),
      insertEntries: document.querySelectorAll("[data-plugin-insert]").length,
      offered: Boolean(document.querySelector("[data-install-bundle]")),
    };
  });
  /* The plugin entry is the manifest's, including the host API it declares — the field that
     used to be dropped on the way in. */
  expect(state.plugin.label).toBe("Widgets (bundle)");
  expect(state.plugin.version).toBe("3.0.0");
  expect(state.plugin.api).toBe(1);
  expect(state.plugin.entry).toBe("widget");
  expect(state.plugin.assets).toEqual(["widget-lib", "widget"]);
  expect(state.plugin.contributes).toEqual({ insert: [{ id: "tile", label: "Widget tile", island: "sealed" }] });
  /* Both pins landed, each as a plugin asset of this file. */
  expect(state.assets.map((asset) => asset.id)).toEqual(["widget-lib", "widget"]);
  for (const asset of state.assets) {
    expect(asset.category).toBe("plugin");
    expect(asset.plugin).toBe("widget");
    expect(asset.mode).toBe("online");
    expect(asset.integrity).toMatch(/^sha384-/);
  }
  expect(state.assets[1].factory).toBe("createWidget");
  expect(state.assets[0].factory).toBeUndefined();
  /* One click, N assets, and the capability works without a reload. */
  expect(state.loaded).toBe(true);
  expect(state.insertEntries).toBeGreaterThan(0);
  expect(state.offered).toBe(false);
});

test("a bundle whose manifest is not the one the catalog pins is refused", async ({ page }) => {
  await openSheet(page, makeDoc({ bundle: true, tamper: true }));
  await page.waitForFunction(() => !!document.querySelector("[data-install-bundle]"));

  const refused = await page.evaluate(async () => {
    const before = JSON.parse(document.getElementById("asset-manifest").textContent);
    document.querySelector("[data-install-bundle]").click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = JSON.parse(document.getElementById("asset-manifest").textContent);
    return {
      foot: document.querySelector("[data-ps-foot]").textContent,
      plugins: Object.keys(after.plugins || {}),
      assets: after.assets.length,
      before: before.assets.length,
    };
  });
  expect(refused.foot).toContain("is not the manifest the catalog pins");
  expect(refused.plugins).toEqual([]);
  expect(refused.assets).toBe(refused.before);
});

/* ---------------------------------------------------------------- updates and staleness */

/* A plugin's upgrade belongs to the plugin, not to the runtime: the catalog data is per
   entry, the trust decision is per plugin, and a runtime bump must not change a plugin
   behind the author's back. So the row carries the update and the Runtime panel only
   *notices* — the count lives on the tab label. */
test("an installed plugin with a newer version offers the update on its row, and the tab counts it", async ({ page }) => {
  const newer = `export function createWidget() {\n  return {activate() { return {command: {ping: () => { globalThis.__pinged2 = true; }}}; }};\n}\n`;
  await openSheet(page, makeDoc({pinned: true, catalogVersion: "2.1.0", catalogJs: newer, catalogIsland: "sealed"}));
  await page.waitForFunction(() => !!document.querySelector('[data-update="widget"]'));

  const offered = await page.evaluate(() => ({
    label: document.querySelector('[data-update="widget"]').textContent,
    rowVersion: document.querySelector('[data-ps-list="installed"] .ps-version').textContent,
    tab: document.querySelector('[data-dd-tab="plugins"]').textContent,
    pinned: JSON.parse(document.getElementById("asset-manifest").textContent).plugins.widget.version,
  }));
  expect(offered.label).toBe("Update to 2.1.0");
  expect(offered.rowVersion).toBe("v2.0.0");
  expect(offered.tab).toBe("Plugins · 1");
  expect(offered.pinned).toBe("2.0.0");

  await page.evaluate(() => document.querySelector('[data-update="widget"]').click());
  await page.waitForFunction(() => JSON.parse(document.getElementById("asset-manifest").textContent).plugins.widget.version === "2.1.0");
  const after = await page.evaluate(() => {
    const manifest = JSON.parse(document.getElementById("asset-manifest").textContent);
    return {
      asset: manifest.assets.find((asset) => asset.id === "widget"),
      enabled: manifest.plugins.widget.enabled,
      updateGone: !document.querySelector('[data-update="widget"]'),
    };
  });
  /* The pin moved: url + integrity + size are the catalog's, and the row stops offering it. */
  expect(after.asset.url).toContain("widget-plugin-catalog.js");
  expect(after.asset.integrity).toBe(sha384(newer));
  expect(after.asset.bytes).toBe(byteLength(newer));
  expect(after.enabled).toBe(true);
  expect(after.updateGone).toBe(true);
});

test("the same version with different bytes is a substitution, not an update", async ({ page }) => {
  const impostor = `export function createWidget() {\n  return {activate() { return {command: {ping: () => { globalThis.__stolen = true; }}}; }};\n}\n`;
  await openSheet(page, makeDoc({pinned: true, catalogVersion: "2.0.0", catalogJs: impostor, catalogIsland: "sealed"}));
  await page.waitForFunction(() => !!document.querySelector('[data-update="widget"]'));

  const before = await page.evaluate(() => document.getElementById("asset-manifest").textContent);
  const row = await page.evaluate(() => ({
    label: document.querySelector('[data-update="widget"]').textContent,
    title: document.querySelector('[data-update="widget"]').title,
    primary: document.querySelector('[data-update="widget"]').classList.contains("ps-primary"),
    tab: document.querySelector('[data-dd-tab="plugins"]').textContent,
  }));
  expect(row.label).toBe("Bytes differ");
  expect(row.primary).toBe(false);
  expect(row.title).toContain("different bytes");
  /* It is not offered as an upgrade, so it is not counted as one. */
  expect(row.tab).toBe("Plugins");

  await page.evaluate(() => document.querySelector('[data-update="widget"]').click());
  await page.waitForFunction(() => /not an update/.test(document.querySelector("[data-ps-foot]").textContent));
  expect(await page.evaluate(() => document.getElementById("asset-manifest").textContent)).toBe(before);
});

/* A plugin and a runtime are versioned independently, so the two numbers meet in the sheet:
   a plugin that asks for an API this file does not provide has exactly one remedy, and the
   index names the first release that supplies it. */
test("a plugin that outruns the runtime names the release that would fix it", async ({ page }) => {
  await openSheet(page, makeDoc({bundle: true, bundleApi: 99, bundleMinRuntime: "v0.13.0", catalogIsland: "sealed"}));
  const row = await page.evaluate(() => {
    const line = document.querySelector('[data-ps-list="available"] .ps-row');
    const button = line.querySelector("[data-install]");
    return { label: button.textContent, disabled: button.disabled, text: line.textContent };
  });
  expect(row.label).toBe("Update runtime to v0.13.0");
  expect(row.disabled).toBe(true);
  expect(row.text).toContain("host API 99");
  expect(row.text).toContain("Update this file's runtime to v0.13.0 or later");
});

test("no published runtime provides it: the row says so instead of offering a dead update", async ({ page }) => {
  await openSheet(page, makeDoc({bundle: true, bundleApi: 100, catalogIsland: "sealed"}));
  const row = await page.evaluate(() => {
    const line = document.querySelector('[data-ps-list="available"] .ps-row');
    const button = line.querySelector("[data-install]");
    return { label: button.textContent, disabled: button.disabled, text: line.textContent };
  });
  expect(row.label).toBe("Needs newer runtime");
  expect(row.disabled).toBe(true);
  expect(row.text).toContain("no published runtime provides 100 yet");
});

test("an installed plugin that outruns the runtime sends the author to Runtime, not to a plugin update", async ({ page }) => {
  await openSheet(page, makeDoc({pinned: true, bundle: true, bundleApi: 99, bundleMinRuntime: "v0.13.0", catalogIsland: "sealed"}));
  await page.waitForFunction(() => /runtime/.test(document.querySelector('[data-ps-list="installed"] .ps-row')?.textContent || ""));
  const offered = await page.evaluate(() => {
    const row = document.querySelector('[data-ps-list="installed"] .ps-row');
    const button = [...row.querySelectorAll("button")].find((candidate) => /runtime/.test(candidate.textContent));
    return { label: button?.textContent, disabled: button?.disabled };
  });
  expect(offered.label).toBe("Update runtime to v0.13.0");
  expect(offered.disabled).toBe(false);
  await page.evaluate(() => {
    const row = document.querySelector('[data-ps-list="installed"] .ps-row');
    [...row.querySelectorAll("button")].find((candidate) => /runtime/.test(candidate.textContent)).click();
  });
  await page.waitForFunction(() => !document.querySelector('[data-dd-panel="runtime"]')?.hidden);
  expect(await page.evaluate(() => document.querySelector("[data-ps-foot]").textContent)).toContain("host API 99");
});

/* A snapshot is true only at the tag it was taken at, because a bundle's manifest resolves
   against the document's own base. After a re-pin the old snapshot names a manifest hash the
   new tag does not serve, and an install would fail as "not the manifest the catalog pins" —
   a true statement that reads like a tampering report. */
test("a catalog snapshot from another tag is named, and can be refreshed in place", async ({ page }) => {
  await openSheet(page, makeDoc({pinned: true, inlineCatalog: true, catalogTag: "v0.0.9", pinDir: "t@v0.9.0"}));
  await page.waitForFunction(() => {
    const note = document.querySelector("[data-ps-stale]");
    return note && !note.hidden && /v0\.0\.9/.test(note.textContent);
  });

  const before = await page.evaluate(() => ({
    note: document.querySelector("[data-ps-stale]").textContent,
    tag: JSON.parse(document.getElementById("plugin-catalog").textContent).tag,
    dirty: !document.querySelector("[data-dirty]")?.hidden,
    from: document.querySelector("[data-ps-from]").textContent,
  }));
  expect(before.note).toContain("taken at v0.0.9");
  expect(before.note).toContain("this file pins");
  expect(before.tag).toBe("v0.0.9");
  expect(before.dirty).toBe(false);
  expect(before.from).toContain("this file");

  /* Refreshing reads the catalog the document's own base names, and rewrites the block at
     the tag this file pins. It is a document change, so it is dirty and needs a save. */
  await page.evaluate(() => document.querySelector("[data-ps-stale] button").click());
  await page.waitForFunction(() => {
    const el = document.getElementById("plugin-catalog");
    return el && JSON.parse(el.textContent).tag !== "v0.0.9";
  });
  const after = await page.evaluate(() => ({
    tag: JSON.parse(document.getElementById("plugin-catalog").textContent).tag,
    staleHidden: document.querySelector("[data-ps-stale]").hidden,
    dirty: !document.querySelector("[data-dirty]")?.hidden,
    foot: document.querySelector("[data-ps-foot]").textContent,
  }));
  expect(after.tag).toBe("v0.9.0");
  expect(after.staleHidden).toBe(true);
  expect(after.dirty).toBe(true);
  expect(after.foot).toContain("refreshed");
});

/* A panel is markup plus the rules scoped to its host, and the host is `[data-dd-plugins]`.
   The first cut scoped the `ps-*` rules to `[data-plugin-panel]` — which is the *attribute a
   plugin's panel button carries*, not the panel — so the panel rendered with no styles at all
   and menu buttons picked up its grid. These two computed values can only come from the
   panel's own rules, so the mistake cannot ship silently again. */
test("the Plugins panel is styled by its own rules, not left to the UA sheet", async ({ page }) => {
  await openSheet(page, makeDoc({ pinned: true }));
  const styled = await page.evaluate(() => {
    const host = document.querySelector("[data-dd-plugins]");
    const search = host.querySelector(".ps-search");
    const badge = host.querySelector(".ps-badge") || host.querySelector(".ps-badge");
    return {
      searchRadius: getComputedStyle(search).borderRadius,
      badgeRadius: badge ? getComputedStyle(badge).borderRadius : null,
      /* the host is a grid container; a plugin's panel *button* must not be */
      hostDisplay: getComputedStyle(host).display,
    };
  });
  expect(styled.searchRadius).toBe("7px");
  expect(styled.badgeRadius).toBe("99px");
  expect(styled.hostDisplay).toBe("grid");
});
