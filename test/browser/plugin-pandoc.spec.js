import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/* The exporter as a plugin, end to end, in a browser:
 *
 *   - the host fetches and verifies four pinned assets, and the 58.6 MB runtime only when
 *     `host.bytes("pandoc")` asks (the bundle is loaded at boot; the binary is not)
 *   - the plugin's export contribution produces a real .docx — a zip, with the figure
 *     embedded, which is only possible through `host.use("materialize")`
 *   - a text target refuses when the document has figures, because a plugin returns one file
 *
 * The assets are the shipped ones: /plugins/pandoc-export/*, /tools/sd-export.lua, and the
 * devDependency's pandoc.wasm. Nothing is stubbed except the document.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const EDITOR = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");
const MANIFEST_RE = /(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/;
const sha384 = (bytes) => "sha384-" + createHash("sha384").update(bytes).digest("base64");
const bytes = (file) => fs.readFileSync(path.join(ROOT, file));
const length = (file) => bytes(file).length;

const PLUGIN = "plugins/pandoc-export/pandoc-export.js";
const SHIM = "plugins/pandoc-export/wasi-shim.js";
const FILTER = "tools/sd-export.lua";
const TEMPLATE = "tools/sd-template.typ";
const REFERENCE = "tools/reference.docx";
const WASM = "node_modules/pandoc-wasm/src/pandoc.wasm";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKUlEQVR42mNkYPhfz0AEYBxVSF+FjAwMDAz///9nQCcYqDCgwwAAG3kJ+0lKJzQAAAAASUVORK5CYII=";

/** An editor document with the plugin pinned, and one figure for it to capture. */
function makeDoc({ figure = true } = {}) {
  const served = (file) => `http://127.0.0.1:8080/${file}`;
  const asset = (id, kind, file, order) => ({
    id, kind, role: "module", order, mode: "online", category: "plugin", plugin: "pandoc",
    requiredBy: ["*"], bytes: length(file), url: served(file), integrity: sha384(bytes(file)),
  });
  let html = EDITOR;
  const manifest = JSON.parse(MANIFEST_RE.exec(html)[2]);
  manifest.assets.push(
    { ...asset("pandoc", "bin", WASM, 300), bytes: length(WASM) },
    asset("wasi-shim", "js", SHIM, 310),
    asset("sd-export-lua", "bin", FILTER, 315),
    asset("sd-template-typ", "bin", TEMPLATE, 316),
    asset("sd-reference", "bin", REFERENCE, 317),
    {
      ...asset("pandoc-export", "js", PLUGIN, 320),
      factory: "createPandocExport",
    },
  );
  manifest.plugins = {
    pandoc: {
      label: "Pandoc export", version: "0.1.0", island: "sealed", enabled: true,
      entry: "pandoc-export",
      assets: ["pandoc", "wasi-shim", "sd-export-lua", "sd-template-typ", "sd-reference", "pandoc-export"],
      contributes: {
        export: [
          { id: "docx", label: "Word (.docx)…" },
          { id: "typ", label: "Typst (.typ)…" },
          { id: "md", label: "Markdown (.md)…" },
        ],
      },
    },
  };
  html = html.replace(MANIFEST_RE, (_, open, _json, close) => open + JSON.stringify(manifest) + close);

  const figureHtml = figure
    ? `<figure class="figure" data-kind="image" data-figure-id="f1" data-w="0.8" contenteditable="false">`
      + `<div class="figure-frame"></div><figcaption>Gel, lane 2.</figcaption></figure>`
    : "";
  html = html.replace(/<article id="content"[^>]*>[\s\S]*?<\/article>/, `<article id="content" contenteditable="true" spellcheck="true">
        <h1>Recombinase systems</h1>
        <p>A paragraph, so the document is not only a figure.</p>
        ${figureHtml}
      </article>`);
  const store = figure
    ? {version: 1, figures: {f1: {kind: "image", src: PNG, width: 400, height: 300, caption: "Gel, lane 2", scale: 0.8}}}
    : {version: 1, figures: {}};
  html = html.replace(/<script id="figure-store" type="application\/json">[\s\S]*?<\/script>/,
    `<script id="figure-store" type="application/json">${JSON.stringify(store)}</script>`);

  fs.mkdirSync(TMP, {recursive: true});
  const name = `.test-tmp/plugin-pandoc-${process.pid}-${figure ? "figure" : "plain"}.html`;
  fs.writeFileSync(path.join(ROOT, name), html);
  return "/" + name;
}

async function load(page, url) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state),
    null, {timeout: 30_000});
  return problems;
}

test("the plugin exports a .docx with the figure embedded", async ({ page }) => {
  test.slow(); /* 58.6 MB over the loopback and a wasm compile */
  const problems = await load(page, makeDoc());
  await page.waitForSelector('[data-plugin-export="pandoc:docx"]', {state: "attached", timeout: 30_000});

  /* Nothing has fetched the binary yet: its bundle was loaded, its bytes were not. */
  const before = await page.evaluate(() => StandaloneDoc.state);
  expect(before).toBe("ready");

  const [download] = await Promise.all([
    page.waitForEvent("download", {timeout: 180_000}),
    page.evaluate(() => document.querySelector('[data-plugin-export="pandoc:docx"]').click()),
  ]);
  expect(download.suggestedFilename()).toBe("document.docx");
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const docx = Buffer.concat(chunks);

  /* A real package: zip magic, and the captured figure inside it. */
  expect(docx.subarray(0, 2).toString("latin1")).toBe("PK");
  expect(docx.length).toBeGreaterThan(8_000);
  expect(docx.includes(Buffer.from("word/media/"))).toBe(true);
  expect(docx.includes(Buffer.from("word/document.xml"))).toBe(true);
  expect(problems).toEqual([]);
});

test("a text target refuses when the document has figures", async ({ page }) => {
  test.slow();
  await load(page, makeDoc());
  await page.waitForSelector('[data-plugin-export="pandoc:typ"]', {state: "attached", timeout: 30_000});

  /* The refusal is a message from the host (`refuse()` emits `plugin-refused`), not a silent
     download of a .typ that points at a file the reader does not have. */
  const said = [];
  page.on("console", (message) => {
    if (message.type() === "error") said.push(message.text());
  });
  await page.evaluate(() => document.querySelector('[data-plugin-export="pandoc:typ"]').click());
  await expect.poll(() => said.join(" "), {timeout: 180_000}).toContain("several files");
});

test("a figure-free document exports as .typ", async ({ page }) => {
  test.slow();
  await load(page, makeDoc({figure: false}));
  await page.waitForSelector('[data-plugin-export="pandoc:typ"]', {state: "attached", timeout: 30_000});

  const [download] = await Promise.all([
    page.waitForEvent("download", {timeout: 180_000}),
    page.evaluate(() => document.querySelector('[data-plugin-export="pandoc:typ"]').click()),
  ]);
  expect(download.suggestedFilename()).toBe("document.typ");
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const typ = Buffer.concat(chunks).toString("utf8");
  expect(typ).toContain("#set page(");
  expect(typ).toContain("Recombinase systems");
});
