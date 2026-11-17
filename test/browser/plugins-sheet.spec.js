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
const MANIFEST_RE = /(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/;

/**
 * An editor document whose cdnBase points at the local server, so the catalog url
 * (`<base>/registry.json`) resolves to a file this spec controls. The document itself
 * is fully inline, so nothing else is fetched.
 */
function makeDoc({ pinned = false, catalog = true, withFigure = false } = {}) {
  fs.mkdirSync(FILES, { recursive: true });
  fs.writeFileSync(path.join(FILES, "widget-plugin.js"), PLUGIN_JS);

  let html = EDITOR.replace(/"cdnBase":"[^"]*"/, `"cdnBase":"${LOCAL}/cdn"`);
  const manifest = JSON.parse(MANIFEST_RE.exec(html)[2]);

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

  if (catalog) {
    fs.writeFileSync(path.join(FILES, "registry.json"), JSON.stringify({
      schema: 1,
      assets: {
        widget: {
          label: "Widgets",
          island: "trusted",
          description: "A widget from the catalog.",
          versions: [{
            version: "2.0.0",
            url: `${LOCAL}/widget-plugin.js`,
            sha384: sha384(PLUGIN_JS),
            bytes: byteLength(PLUGIN_JS),
            factory: "createWidget",
            /* what the plugin offers travels with the proposal: an installed plugin that
               contributed a menu must keep contributing it */
            contributes: { insert: [{ id: "tile", label: "Widget tile", island: "sealed" }] },
          }],
        },
      },
    }));
  } else {
    fs.rmSync(path.join(FILES, "registry.json"), { force: true });
  }

  const slug = [pinned && "pinned", !catalog && "nocat", withFigure && "fig"].filter(Boolean).join("-") || "base";
  const name = `.test-tmp/${DIR}/doc-${slug}.html`;
  fs.writeFileSync(path.join(ROOT, name), html);
  return "/" + name;
}

async function openSheet(page, url) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, { timeout: 20_000 });
  await page.evaluate(() => document.querySelector("[data-plugins-open]").click());
  await page.waitForSelector("dialog.plugin-sheet[open]");
  return problems;
}

const sheetState = (page) =>
  page.evaluate(() => {
    const sheet = document.querySelector("dialog.plugin-sheet");
    const rows = [...sheet.querySelectorAll('[data-ps-list="installed"] .ps-row')].map((row) => ({
      id: row.dataset.id,
      name: row.querySelector(".ps-name")?.textContent,
      island: row.querySelector(".ps-badge")?.textContent,
      used: row.querySelector(".ps-used")?.textContent,
      on: row.querySelector("[data-toggle]")?.checked,
      assets: row.querySelectorAll(".ps-assets tbody tr").length,
    }));
    return {
      open: sheet.open,
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
  expect(await page.evaluate(() => document.querySelectorAll("dialog.plugin-sheet").length)).toBe(1);
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

test("install from the catalog pins the version's own hash", async ({ page }) => {
  await openSheet(page, makeDoc());
  await page.waitForFunction(() => !!document.querySelector("[data-install]"));

  await page.evaluate(() => document.querySelector("[data-install]").click());
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
