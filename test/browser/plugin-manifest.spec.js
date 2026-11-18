import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { entries } from "../../tools/reproducible.mjs";

/* The plugin as *published*: `dist/plugins/pandoc-export.json` is the contract, and this spec
 * installs from it exactly as a document would — copy `assets` into `#asset-manifest`, add the
 * `plugins` entry, open the file.
 *
 * What it proves, in the order the loader cares:
 *
 *   1. every asset the manifest declares is fetchable at the url it names (here: the dev
 *      server standing in for the tag, because the tag does not exist yet);
 *   2. the bytes at that url match the `bytes` and `integrity` the manifest recorded — so a
 *      document that copies these entries verifies, and one edited by hand does not;
 *   3. the plugin loads and produces a real .docx from those pinned bytes only.
 *
 * The three large assets are npm pins (58 MB + 27 MB + 211 KB). Their urls are jsDelivr; the
 * test resolves them to the devDependencies and checks the recorded hash against the local
 * file, which is the same claim `cdn:verify` makes about our own published bytes.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const MANIFEST = path.join(ROOT, "dist/plugins/pandoc-export.json");
const EDITOR = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");
const MANIFEST_RE = /(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/;

const sha384 = (buffer) => "sha384-" + createHash("sha384").update(buffer).digest("base64");

/* url → the file the dev server serves it from. Published assets live under the tag's
 * `dist/cdn/plugins/…`; the npm pins live in the devDependencies. Keyed by id because the id
 * is what the document pins — the url is only the address, which is the whole point of the
 * hash beside it. */
const LARGE_LOCAL = {
  pandoc: "node_modules/pandoc-wasm/src/pandoc.wasm",
  "typst-bundle": "node_modules/@myriaddreamin/typst.ts/dist/esm/contrib/all-in-one-lite.bundle.js",
  "typst-compiler": "node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm",
};
function localFor(asset) {
  if (LARGE_LOCAL[asset.id]) return path.join(ROOT, LARGE_LOCAL[asset.id]);
  const name = new URL(asset.url).pathname.split("/").pop();
  return path.join(ROOT, "dist/cdn/plugins/pandoc-export", name);
}
const relativeFor = (file) => path.relative(ROOT, file).split(path.sep).join("/");

function manifest() {
  if (!fs.existsSync(MANIFEST)) throw new Error("dist/plugins/pandoc-export.json is missing — run: node tools/publish-plugin.mjs");
  return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
}

/** A document built *only* from the published manifest. */
function installFrom(published) {
  let html = EDITOR;
  const doc = JSON.parse(MANIFEST_RE.exec(html)[2]);
  for (const asset of published.assets) {
    doc.assets.push({
      ...asset,
      /* The dev server stands in for the tag: same path under dist/, same bytes. */
      url: `http://127.0.0.1:8080/${relativeFor(localFor(asset))}`,
    });
  }
  doc.plugins = {
    [published.id]: {
      label: published.label,
      version: published.version,
      island: published.island,
      enabled: true,
      entry: published.entry,
      assets: published.assets.map((asset) => asset.id),
      contributes: published.contributes,
    },
  };
  html = html.replace(MANIFEST_RE, (_, open, _json, close) => open + JSON.stringify(doc) + close);
  html = html.replace(/<article id="content"[^>]*>[\s\S]*?<\/article>/, `<article id="content" contenteditable="true" spellcheck="true">
        <h1>Published manifest</h1>
        <p>Installed from <code>dist/plugins/pandoc-export.json</code>, with nothing hand-written.</p>
        <h2>What we measured</h2>
        <ul><li>pRX1 — 41 %</li><li>pRX2 — 8 %</li></ul>
      </article>`);
  html = html.replace(/<script id="figure-store" type="application\/json">[\s\S]*?<\/script>/,
    `<script id="figure-store" type="application/json">{"version":1,"figures":{}}</script>`);

  fs.mkdirSync(TMP, {recursive: true});
  const name = `.test-tmp/plugin-manifest-${process.pid}.html`;
  fs.writeFileSync(path.join(ROOT, name), html);
  return "/" + name;
}

test("every published asset matches the size and hash the manifest declares", () => {
  const published = manifest();
  expect(published.assets).toHaveLength(8);
  for (const asset of published.assets) {
    const file = localFor(asset);
    expect(fs.existsSync(file), `${asset.id}: ${file}`).toBe(true);
    const bytes = fs.readFileSync(file);
    expect(bytes.length, `${asset.id} bytes`).toBe(asset.bytes);
    expect(sha384(bytes), `${asset.id} integrity`).toBe(asset.integrity);
  }
});

test("a document installs the plugin from the manifest alone, and exports", async ({ page }) => {
  test.slow(); /* 58 MB over the loopback and a wasm compile */
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(installFrom(manifest()));
  await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state),
    null, {timeout: 30_000});
  expect(await page.evaluate(() => globalThis.StandaloneDoc.state)).toBe("ready");

  /* The four contributions are the manifest's, rendered by the host. */
  const contributed = await page.evaluate(() => [...document.querySelectorAll("[data-plugin-export]")]
    .map((button) => button.dataset.pluginExport).filter((id, i, all) => all.indexOf(id) === i));
  expect(contributed).toEqual(["pandoc-export:docx", "pandoc-export:typ",
    "pandoc-export:md", "pandoc-export:pdf"]);

  const [download] = await Promise.all([
    page.waitForEvent("download", {timeout: 180_000}),
    page.evaluate(() => document.querySelector('[data-plugin-export="pandoc-export:docx"]').click()),
  ]);
  expect(download.suggestedFilename()).toBe("document.docx");
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const docx = Buffer.concat(chunks);

  const document = entriesOf(docx, "word/document.xml");
  expect(document.startsWith("<?xml")).toBe(true);
  expect(document).toContain("<w:document");
  expect(document).toContain("Published manifest");
  expect(problems).toEqual([]);
});

const entriesOf = (buffer, name) => entries(buffer).find((entry) => entry.name === name).data.toString("utf8");
