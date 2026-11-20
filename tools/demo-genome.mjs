#!/usr/bin/env node
/* tools/demo-genome.mjs — a document with the genome plugin installed and a real figure in it.
 *
 *   npm run demo:genome        writes .test-tmp/genome-demo.html (and stages the plugin beside it)
 *   npm run dev               (in another shell) serve the repository root, then open
 *                             http://127.0.0.1:8080/.test-tmp/genome-demo.html
 *
 * Nothing is mocked. `genome.js` and `genome-view.js` are the files under `plugins/genome/`,
 * pinned by `url` at this working tree; the engine is the published GenomeSpy pin, fetched from
 * jsDelivr once and verified against the sha384 in the manifest. The figure in the page was
 * built by the plugin's own `figureHTML()` — the same string the Insert menu produces — so what
 * you click is what a document gets.
 *
 * The one thing the generator does that a document does differently: it writes the figure
 * straight into `#figure-store` instead of going through Insert ▸ Genome map…, which needs a
 * file picker. Pick `plugins/genome/fixtures/locus.spec.json` in that dialog to see the other
 * half.
 */
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {figureHTML, readSpec} from "../plugins/genome/genome.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".test-tmp/genome-demo.html");
const STAGE_DIR = path.join(ROOT, ".test-tmp/genome");
const STAGE_URL = "http://127.0.0.1:8080/.test-tmp/genome";
const FIXTURE = path.join(ROOT, "plugins/genome/fixtures/locus.spec.json");

/* The published pin, copied from `plugins/genome/plugin.json` so the demo cannot drift from
   what an install would write. */
const ENGINE = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins/genome/plugin.json"), "utf8"))
  .pins.find((pin) => pin.id === "genomespy");

const sha384 = (buffer) => "sha384-" + createHash("sha384").update(buffer).digest("base64");
const byteLength = (text) => Buffer.byteLength(text, "utf8");
const MANIFEST_RE = /(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/;
const STORE_RE = /(<script id="figure-store" type="application\/json">)([\s\S]*?)(<\/script>)/;
const CONTENT_RE = /(<article id="content"[^>]*>)[\s\S]*?(<\/article>)/;

/* ---- the plugin, staged where the dev server can serve it ------------------ */

fs.mkdirSync(STAGE_DIR, {recursive: true});
const copies = {
  genome: fs.readFileSync(path.join(ROOT, "plugins/genome/genome.js"), "utf8"),
  "genome-view": fs.readFileSync(path.join(ROOT, "plugins/genome/genome-view.js"), "utf8"),
};
fs.writeFileSync(path.join(STAGE_DIR, "genome.js"), copies.genome);
fs.writeFileSync(path.join(STAGE_DIR, "genome-view.js"), copies["genome-view"]);

/* ---- the figure, built by the plugin --------------------------------------- */

const specText = fs.readFileSync(FIXTURE, "utf8");
const {spec, bounds, caption} = readSpec(specText, {name: "locus.spec.json"});
const FIGURE = "genome-1";
const source = figureHTML(spec, {clamp: bounds.clamp === 1});
const geometry = {w: 1, h: 0.32};

const store = {
  version: 1,
  figures: {
    [FIGURE]: {
      id: FIGURE,
      kind: "html",
      name: caption,
      mime: "text/html",
      bytes: byteLength(source),
      hash: sha384(source),
      src: source,
      width: 0,
      height: 0,
      island: "compute",
      assets: ["genome-view", "genomespy"],
      exports: ["svg"],
      plugin: {
        id: "genome",
        label: "Genome map",
        url: `${STAGE_URL}/genome.js`,
        integrity: sha384(copies.genome),
      },
    },
  },
};

const figure = `<figure class="figure" data-figure-id="${FIGURE}" data-kind="html"`
  + ` data-w="${geometry.w}" data-h="${geometry.h}"`
  + ` style="--figure-w:${geometry.w};--figure-scale:${geometry.w};--figure-h:${geometry.h}">`
  + `<div class="figure-frame" data-runtime="ephemeral"></div>`
  + `<figcaption contenteditable="true">${caption.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</figcaption>`
  + `</figure>`;

const content = `
<h1>Genome map</h1>
<p>One locus out of <em>Xanthobacter versatilis</em> Py2, drawn by GenomeSpy inside the page.
Hover a gene for its product, identifiers and coordinates. The field is a figure: it prints,
it paginates, and it is one row of the same store as an image or a video.</p>
${figure}
<h2>Try this</h2>
<ul>
  <li><strong>Hover</strong> an arrow or a label — the tooltip is the spec's, not the plugin's.</li>
  <li><strong>Toggle “clamp to locus”</strong> in the figure's top-right corner. Clamped, the view
  cannot leave the authored window; free, it may zoom out to the contig. That is
  <code>scales.x.zoom.extent</code> in the grammar, not a subscription in the plugin.</li>
  <li><strong>Labels</strong> are measured at the width the figure actually has — hover one and it
  highlights — so the same spec reads cleanly in a narrow column and in a wide one. The layout is
  GenomeSpy's own gene-map grammar (the lambda-phage example), not rows baked for a fixed width.</li>
  <li><strong>Export</strong> with File ▸ Export ▸ Static HTML, then open the exported page: it is
  paginated like this one, and the figure is an <code>&lt;img src="data:image/svg+xml"&gt;</code>,
  vector text and all, because the figure declares <code>exports: ["svg"]</code> and the island
  answers with <code>imageExport.svg()</code>. A figure that cannot draw itself gets a raster.</li>
  <li><strong>Insert another</strong> with Insert ▸ <em>Genome map…</em> and pick
  <code>plugins/genome/fixtures/locus.spec.json</code>. Two figures, one 1.4 MB engine in the
  file — the plugin adds about 25 KB per locus.</li>
  <li><strong>Resize</strong> the figure with the handles: the island is a live chart, so it
  reflows, and the geometry is stored on the figure.</li>
</ul>
<h2>Where the spec came from</h2>
<p>The spec carries the data — labels, classes, colours, tooltips — and the view re-lays the
labels at the figure's own width, so the tuned <code>labels.json</code> and this page cannot
disagree about a product name, and neither has to guess the column width.</p>
<p><code>locus.py</code> slices a GenBank file into <code>*.locus.json</code>,
<code>spec.py</code> turns that into a GenomeSpy spec, and this plugin draws whatever spec it is
handed — a locus from that pipeline, or any spec in GenomeSpy's grammar with a genomic x scale.
Layout decisions stay in Python: the plugin re-renders the spec, it never re-derives it.</p>
`;

/* ---- the document ---------------------------------------------------------- */

let html = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");
html = html.replace(CONTENT_RE, (_, open, close) => `${open}${content}${close}`);
html = html.replace(STORE_RE, (_, open, _json, close) =>
  open + JSON.stringify(store).replace(/</g, "\\u003c") + close);

const manifest = JSON.parse(MANIFEST_RE.exec(html)[2]);
const pin = (id, kind, file, bytes, extra = {}) => Object.assign({
  id, kind, role: "module", mode: "online", category: "plugin", plugin: "genome",
  requiredBy: ["*"], bytes: byteLength(bytes), url: `${STAGE_URL}/${file}`, integrity: sha384(bytes),
}, extra);

manifest.assets.push(
  pin("genome", "js", "genome.js", copies.genome, {factory: "createGenome", order: 700}),
  pin("genome-view", "bin", "genome-view.js", copies["genome-view"], {order: 701}),
  {
    id: ENGINE.id, kind: ENGINE.kind, role: "module", mode: "online", category: "plugin",
    plugin: "genome", requiredBy: ["*"], bytes: ENGINE.bytes, order: 800,
    url: ENGINE.url, integrity: ENGINE.integrity,
  },
);
manifest.plugins = Object.assign(manifest.plugins || {}, {
  genome: {
    label: "Genome map", version: "0.1.0", api: 3, island: "compute", enabled: true,
    entry: "genome", assets: ["genome", "genome-view", "genomespy"],
    url: `${STAGE_URL}/genome.js`, integrity: sha384(copies.genome),
    contributes: {insert: [{id: "locus", label: "Genome map…", island: "compute"}]},
  },
});
html = html.replace(MANIFEST_RE, (_, open, _json, close) => open + JSON.stringify(manifest) + close);

fs.mkdirSync(path.dirname(OUT), {recursive: true});
fs.writeFileSync(OUT, html);

console.log(`demo:genome wrote ${path.relative(ROOT, OUT)} (${Math.round(byteLength(html) / 1024)} KB)`);
console.log(`  figure ${FIGURE}: ${Math.round(byteLength(source) / 1024)} KB of spec, island "compute", exports svg`);
console.log(`  serve the repository root, then open http://127.0.0.1:8080/${path.relative(ROOT, OUT)}`);
