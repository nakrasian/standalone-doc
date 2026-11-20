import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/* Contributions: the join between what a plugin declares in the manifest and what it
 * implements in `activate()`. The contract this file pins down:
 *
 *   - a plugin offering UI is built at boot, so its menu entries exist
 *   - a plugin offering only a content runtime is not: a figure asks for it
 *   - an insert contribution inserts through the host: the figure's store entry
 *     records the plugin's pin and the island profile
 *   - the plugin never touches the store, the editor or the dirty flag
 *   - unloading withdraws the entries (host-owned), and re-loading restores them once
 *   - an export contribution downloads through the host, not through the plugin
 *   - `host.use("figures")` resolves, because figures offers that capability
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const STAGE = "http://127.0.0.1:8080/.test-tmp";
const EDITOR = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");

const PLUGIN_JS = `export function createTile() {
  return {
    async activate(host) {
      const figures = host.use("figures");
      globalThis.__providerOk = typeof figures.insertHTML === "function";
      globalThis.__editorProvider = typeof host.use("editor").insertBlock;
      globalThis.__statusProvider = typeof host.use("status").markDirty;
      let absent = "resolved";
      try { host.use("nothing-offers-this"); } catch (error) { absent = error.kind; }
      globalThis.__absentProvider = absent;
      let materialize = "unavailable";
      try { materialize = typeof host.use("materialize").build; } catch (error) { materialize = error.kind; }
      globalThis.__materializeProvider = materialize;
      return {
        insert: {
          tile: async ({ contribution }) => ({
            html: "<body style='display:grid;place-items:center;height:100%;margin:0;font:14px system-ui'>"
              + "<p>a tile from <b>" + contribution.label + "</b></p></body>",
            caption: "Tile",
          }),
        },
        export: {
          outline: async () => ({ name: "outline.txt", mime: "text/plain", text: "outline from the plugin" }),
          /* A .docx is a zip: the host has to take bytes, or no binary format exists. */
          binary: async () => ({ name: "tile.bin", mime: "application/octet-stream",
            bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0xff]) }),
          /* Fails the way a real one does: the asset it needs is not at the url the document
             pins. The host has to name the address, not just the status. */
          missing: async () => {
            const bytes = await host.bytes("gone");
            return { name: "gone.bin", mime: "application/octet-stream", bytes };
          },
        },
        panel: {
          inspector: (body) => {
            const line = document.createElement("p");
            line.className = "tile-inspector";
            line.textContent = "the plugin filled this body";
            body.append(line);
          },
        },
        command: {
          stamp: () => {
            host.use("editor").insertBlock(Object.assign(document.createElement("p"), {
              className: "tile-stamp",
              textContent: "stamped by the plugin",
            }));
            host.use("status").markDirty();
          },
        },
        deactivate() { globalThis.__deactivated = (globalThis.__deactivated || 0) + 1; },
      };
    },
  };
}
`;

const sha384 = (text) => "sha384-" + createHash("sha384").update(text, "utf8").digest("base64");
const byteLength = (text) => Buffer.byteLength(text, "utf8");
const MANIFEST_RE = /(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/;

/** An editor document with one plugin pinned that contributes an insert and an export. */
function makeDoc({ contributes = {
  insert: [{ id: "tile", label: "Tile", island: "sealed" }],
  export: [{ id: "outline", label: "Outline…" }, { id: "binary", label: "Binary…" }],
  panel: [{ id: "inspector", label: "Tile inspector" }],
  command: [{ id: "stamp", label: "Stamp a paragraph" }],
}, assets: extraAssets = [] } = {}) {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(path.join(TMP, "tile-plugin.js"), PLUGIN_JS);
  let html = EDITOR;
  const manifest = JSON.parse(MANIFEST_RE.exec(html)[2]);
  manifest.assets.push({
    id: "tile",
    kind: "js",
    role: "module",
    order: 210,
    mode: "online",
    category: "plugin",
    plugin: "tile",
    requiredBy: ["*"],
    bytes: byteLength(PLUGIN_JS),
    factory: "createTile",
    url: `${STAGE}/tile-plugin.js`,
    integrity: sha384(PLUGIN_JS),
  });
  /* Pinned, verified, and not there: the shape of a release whose host refused one file.
     Only a test that asks for it gets this asset — the save policy fetches what a document
     pins, so a permanently missing one would break every other test in this file. */
  manifest.assets.push(...extraAssets);
  manifest.plugins = {
    tile: {
      label: "Tiles",
      version: "1.0.0",
      island: "sealed",
      enabled: true,
      entry: "tile",
      assets: ["tile", ...extraAssets.map((asset) => asset.id)],
      contributes,
    },
  };
  html = html.replace(MANIFEST_RE, (_, open, _json, close) => open + JSON.stringify(manifest) + close);
  const name = `.test-tmp/contributions-${process.pid}-${Object.keys(contributes).join("-") || "none"}.html`;
  fs.writeFileSync(path.join(ROOT, name), html);
  return "/" + name;
}

async function load(page, url) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, { timeout: 20_000 });
  return problems;
}

test("a UI plugin is built at boot, and its entries are in both bars", async ({ page }) => {
  const problems = await load(page, makeDoc());
  await page.waitForFunction(() => !!document.querySelector("[data-plugin-insert]"));

  const state = await page.evaluate(() => {
    const inserts = [...document.querySelectorAll("[data-plugin-inserts]")];
    const exports = [...document.querySelectorAll("[data-plugin-exports]")];
    return {
      built: Object.keys(StandaloneDoc.modules).includes("tile"),
      providerOk: globalThis.__providerOk,
      editorProvider: globalThis.__editorProvider,
      statusProvider: globalThis.__statusProvider,
      absentProvider: globalThis.__absentProvider,
      materializeProvider: globalThis.__materializeProvider,
      insertHosts: inserts.length,
      insertButtons: inserts.map((host) => host.querySelectorAll("[data-plugin-insert]").length),
      insertHidden: inserts.map((host) => host.hidden),
      exportHosts: exports.length,
      exportButtons: exports.map((host) => host.querySelectorAll("[data-plugin-export]").length),
      label: inserts[0]?.querySelector(".menu-label")?.textContent,
      state: StandaloneDoc.state,
    };
  });
  expect(state.built).toBe(true);
  /* three modules offer capabilities now, and asking for one nobody offers is a kind */
  expect(state.providerOk).toBe(true);
  expect(state.editorProvider).toBe("function");
  expect(state.statusProvider).toBe("function");
  expect(state.absentProvider).toBe("unavailable");
  /* exporting is a capability the materializer offers; a plugin may call it, never own it */
  expect(state.materializeProvider).toBe("function");
  /* the host element exists in both the ribbon and the minimal bar */
  expect(state.insertHosts).toBe(2);
  expect(state.insertButtons).toEqual([1, 1]);
  expect(state.insertHidden).toEqual([false, false]);
  expect(state.exportHosts).toBe(2);
  expect(state.exportButtons).toEqual([2, 2]);
  expect(state.label).toBe("Tiles");
  expect(state.state).toBe("ready");
  expect(problems).toEqual([]);
});

test("an insert contribution inserts a figure that records the plugin and its island", async ({ page }) => {
  await load(page, makeDoc());
  await page.waitForSelector("[data-plugin-insert]", { state: "attached" });

  await page.evaluate(() => document.querySelector("[data-plugin-insert]").click());
  await page.waitForFunction(() => !!document.querySelector('figure.figure[data-kind="html"]'));

  const figure = await page.evaluate(() => {
    const element = document.querySelector('figure.figure[data-kind="html"]');
    const id = element.dataset.figureId;
    const entry = globalThis.StandaloneDoc.modules.figures.store.figures[id];
    return {
      hasElement: Boolean(element),
      caption: element.querySelector("figcaption")?.textContent,
      entry: {
        kind: entry?.kind,
        hasSrc: typeof entry?.src === "string" && entry.src.includes("a tile from"),
        pluginId: entry?.plugin?.id,
        pluginLabel: entry?.plugin?.label,
        hasIntegrity: typeof entry?.plugin?.integrity === "string",
        island: entry?.island,
      },
      dirty: !document.querySelector("[data-dirty]")?.hidden,
    };
  });
  expect(figure.hasElement).toBe(true);
  expect(figure.caption).toBe("Tile");
  expect(figure.entry.kind).toBe("html");
  expect(figure.entry.hasSrc).toBe(true);
  /* the pin travels with the figure: id, label, and the hash that was verified */
  expect(figure.entry.pluginId).toBe("tile");
  expect(figure.entry.pluginLabel).toBe("Tiles");
  expect(figure.entry.hasIntegrity).toBe(true);
  expect(figure.entry.island).toBe("sealed");
  /* and the host, not the plugin, marked the document dirty */
  expect(figure.dirty).toBe(true);
});

test("the inserted figure mounts, because its plugin is already built", async ({ page }) => {
  await load(page, makeDoc());
  await page.waitForSelector("[data-plugin-insert]", { state: "attached" });
  await page.evaluate(() => document.querySelector("[data-plugin-insert]").click());
  await page.waitForFunction(() => {
    const figure = document.querySelector('figure.figure[data-kind="html"]');
    return figure?.dataset.pluginState === "ready" && !!figure.querySelector(".figure-frame iframe");
  });
  const state = await page.evaluate(() => {
    const figure = document.querySelector('figure.figure[data-kind="html"]');
    return {
      pluginState: figure.dataset.pluginState,
      iframe: Boolean(figure.querySelector(".figure-frame iframe")),
      usage: StandaloneDoc.modules.figures.pluginUsage(),
    };
  });
  expect(state.pluginState).toBe("ready");
  expect(state.iframe).toBe(true);
  expect(state.usage).toEqual({ tile: 1 });
});

test("unloading withdraws the entries, and loading again restores them once", async ({ page }) => {
  await load(page, makeDoc());
  await page.waitForSelector("[data-plugin-insert]", { state: "attached" });

  const during = await page.evaluate(async () => {
    await StandaloneDoc.deactivate("tile");
    const afterUnload = {
      buttons: document.querySelectorAll("[data-plugin-insert]").length,
      hostsHidden: [...document.querySelectorAll("[data-plugin-inserts]")].every((host) => host.hidden),
      deactivated: globalThis.__deactivated,
    };
    await StandaloneDoc.require("tile");
    const afterReload = {
      buttons: document.querySelectorAll("[data-plugin-insert]").length,
      hostsHidden: [...document.querySelectorAll("[data-plugin-inserts]")].every((host) => !host.hidden),
      labels: document.querySelectorAll("[data-plugin-inserts] .menu-label").length,
    };
    return { afterUnload, afterReload };
  });
  expect(during.afterUnload.buttons).toBe(0);
  expect(during.afterUnload.hostsHidden).toBe(true);
  expect(during.afterUnload.deactivated).toBe(1);
  /* exactly one entry per host: a reload must not double what it renders */
  expect(during.afterReload.buttons).toBe(2);
  expect(during.afterReload.hostsHidden).toBe(true);
  expect(during.afterReload.labels).toBe(2);
});

test("a panel contribution opens in a host-owned dialog", async ({ page }) => {
  await load(page, makeDoc());
  await page.waitForSelector("[data-plugin-panel]", { state: "attached" });

  await page.evaluate(() => document.querySelector("[data-plugin-panel]").click());
  await page.waitForSelector("dialog.plugin-panel[open] .tile-inspector");

  const open = await page.evaluate(() => {
    const dialog = document.querySelector("dialog.plugin-panel");
    return {
      title: dialog.querySelector("h2")?.textContent,
      body: dialog.querySelector(".tile-inspector")?.textContent,
      modal: dialog.open,
      tagged: dialog.hasAttribute("data-plugin-ui"),
      onBody: dialog.parentElement === document.body,
    };
  });
  expect(open.title).toBe("Tile inspector");
  expect(open.body).toBe("the plugin filled this body");
  expect(open.modal).toBe(true);
  /* session state: tagged, and outside anything the save path walks as content */
  expect(open.tagged).toBe(true);
  expect(open.onBody).toBe(true);

  /* the close button is the host's, not the plugin's */
  await page.evaluate(() => document.querySelector("dialog.plugin-panel .pp-head button").click());
  expect(await page.evaluate(() => document.querySelector("dialog.plugin-panel").open)).toBe(false);

  /* unloading removes the dialog and its menu entry */
  const after = await page.evaluate(async () => {
    document.querySelector("[data-plugin-panel]").click();
    await StandaloneDoc.deactivate("tile");
    return {
      dialogs: document.querySelectorAll("dialog.plugin-panel").length,
      entries: document.querySelectorAll("[data-plugin-panel]").length,
    };
  });
  expect(after.dialogs).toBe(0);
  expect(after.entries).toBe(0);
});

test("a command contribution acts through the capabilities", async ({ page }) => {
  await load(page, makeDoc());
  await page.waitForSelector("[data-plugin-command]", { state: "attached" });
  await page.evaluate(() => document.querySelector("[data-plugin-command]").click());
  await page.waitForSelector("#content .tile-stamp");

  const state = await page.evaluate(() => ({
    text: document.querySelector("#content .tile-stamp")?.textContent,
    dirty: !document.querySelector("[data-dirty]")?.hidden,
  }));
  expect(state.text).toBe("stamped by the plugin");
  /* the plugin asked status to mark it, rather than reaching for the dot itself */
  expect(state.dirty).toBe(true);
});

test("a plugin's panel never reaches a saved file", async ({ page }) => {
  await load(page, makeDoc());
  await page.waitForSelector("[data-plugin-panel]", { state: "attached" });
  const saved = await page.evaluate(async () => {
    document.querySelector("[data-plugin-panel]").click();
    const open = document.querySelectorAll("dialog.plugin-panel[open]").length;
    const serialized = await StandaloneDoc.modules.toolbar.serialize({policy: "inline"});
    /* Parsed, never text-searched: the plugin-panel CSS is *in* this document as a
       stylesheet, so a substring match would always be true. */
    const doc = new DOMParser().parseFromString(serialized.html, "text/html");
    return {
      open,
      leaked: doc.querySelectorAll("dialog.plugin-panel").length,
      tagged: doc.querySelectorAll("[data-plugin-ui]").length,
      problems: StandaloneDoc.modules.toolbar.validate(serialized.html),
    };
  });
  expect(saved.open).toBe(1);
  expect(saved.leaked).toBe(0);
  expect(saved.tagged).toBe(0);
  expect(saved.problems).toEqual([]);
});

test("an export contribution downloads through the host", async ({ page }) => {
  await load(page, makeDoc());
  await page.waitForSelector("[data-plugin-export]", { state: "attached" });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.evaluate(() => document.querySelector("[data-plugin-export]").click()),
  ]);
  expect(download.suggestedFilename()).toBe("outline.txt");
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString("utf8")).toBe("outline from the plugin");
});

test("an export contribution may return bytes", async ({ page }) => {
  await load(page, makeDoc());
  await page.waitForSelector('[data-plugin-export="tile:binary"]', { state: "attached" });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.evaluate(() => document.querySelector('[data-plugin-export="tile:binary"]').click()),
  ]);
  expect(download.suggestedFilename()).toBe("tile.bin");
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  /* Bytes out, byte for byte — not a string that happened to survive UTF-8. */
  expect([...Buffer.concat(chunks)]).toEqual([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0xff]);
});

test("a refused export names the address it could not fetch", async ({ page }) => {
  /* v0.12.0's Word export, in miniature: the plugin asks the host for a pinned asset, the
     host's fetch fails, and the dialog used to say only `HTTP 404` — no file, no host, no
     next step. The failure record already carried the url; now the sentence does too. */
  await load(page, makeDoc({
    contributes: {
      insert: [{ id: "tile", label: "Tile", island: "sealed" }],
      export: [{ id: "missing", label: "Missing…" }],
    },
    assets: [{
      id: "gone",
      kind: "bin",
      role: "module",
      order: 211,
      mode: "online",
      category: "plugin",
      plugin: "tile",
      requiredBy: ["*"],
      bytes: 12,
      url: `${STAGE}/not-published.bin`,
      integrity: sha384("absent"),
    }],
  }));
  await page.waitForSelector('[data-plugin-export="tile:missing"]', { state: "attached" });
  await page.evaluate(() => document.querySelector('[data-plugin-export="tile:missing"]').click());

  const dialog = page.locator("#plugin-refusal");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('export "missing" failed: HTTP 404');
  await expect(dialog).toContainText(`${STAGE}/not-published.bin`);
});

test("a plugin with no UI contribution is not built at boot", async ({ page }) => {
  /* No contributes at all: only a figure could want it, so boot must leave it alone. */
  await load(page, makeDoc({ contributes: {} }));
  const state = await page.evaluate(() => ({
    built: Object.keys(StandaloneDoc.modules).includes("tile"),
    buttons: document.querySelectorAll("[data-plugin-insert]").length,
    hostsHidden: [...document.querySelectorAll("[data-plugin-inserts]")].every((host) => host.hidden),
  }));
  expect(state.built).toBe(false);
  expect(state.buttons).toBe(0);
  expect(state.hostsHidden).toBe(true);
});
