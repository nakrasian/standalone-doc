#!/usr/bin/env node
/* tools/demo.mjs — a document with the exporter installed, to click through by hand.
 *
 *   npm run demo                 writes .test-tmp/plugin-demo.html and prints the URL
 *   npm run dev                  (in another shell) serve it, then open the URL
 *
 * It pins the plugin exactly as a user would: four assets with `url` + `integrity`, one
 * plugin entry, and a figure whose source lives in `#figure-store`. Nothing is stubbed, so
 * the menu you click is the code in plugins/pandoc-export/. The wasm is served from
 * node_modules because that is where the devDependency puts it.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".test-tmp/plugin-demo.html");

const assets = {
  "pandoc": {file: "node_modules/pandoc-wasm/src/pandoc.wasm", kind: "bin", order: 300},
  "wasi-shim": {file: "plugins/pandoc-export/wasi-shim.js", kind: "js", order: 310},
  "sd-export-lua": {file: "tools/sd-export.lua", kind: "bin", order: 315},
  "sd-template-typ": {file: "tools/sd-template.typ", kind: "bin", order: 316},
  "sd-reference": {file: "tools/reference.docx", kind: "bin", order: 317},
  "typst-bundle": {
    file: "node_modules/@myriaddreamin/typst.ts/dist/esm/contrib/all-in-one-lite.bundle.js",
    kind: "bin", order: 330,
  },
  "typst-compiler": {
    file: "node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm",
    kind: "bin", order: 331,
  },
  "pandoc-export": {file: "plugins/pandoc-export/pandoc-export.js", kind: "js", order: 320, factory: "createPandocExport"},
};

const bytesOf = (file) => fs.readFileSync(path.join(ROOT, file));
const sha384 = (buffer) => "sha384-" + createHash("sha384").update(buffer).digest("base64");

/* A real PNG, so the figure survives both a browser and typst's stricter decoder. */
function png(width, height) {
  const table = Array.from({length: 256}, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const on = Math.abs(y - (x * height) / width) < 2;
      raw[row + 1 + x * 3] = on ? 47 : 246;
      raw[row + 2 + x * 3] = on ? 111 : 248;
      raw[row + 3 + x * 3] = on ? 237 : 250;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, {level: 9})),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const figure = "data:image/png;base64," + png(180, 120).toString("base64");

const MANIFEST_RE = /(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/;
let html = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");
const manifest = JSON.parse(MANIFEST_RE.exec(html)[2]);

for (const [id, spec] of Object.entries(assets)) {
  const data = bytesOf(spec.file);
  const entry = {
    id, kind: spec.kind, role: "module", order: spec.order, mode: "online",
    category: "plugin", plugin: "pandoc", requiredBy: ["*"],
    bytes: data.length,
    url: `http://127.0.0.1:8080/${spec.file}`,
    integrity: sha384(data),
  };
  if (spec.factory) entry.factory = spec.factory;
  manifest.assets.push(entry);
}
manifest.plugins = {
  pandoc: {
    label: "Pandoc export", version: "0.1.0", island: "sealed", enabled: true,
    entry: "pandoc-export",
    assets: Object.keys(assets),
    contributes: {
      export: [
        {id: "docx", label: "Word (.docx)…"},
        {id: "typ", label: "Typst (.typ)…"},
        {id: "md", label: "Markdown (.md)…"},
        {id: "pdf", label: "PDF (typeset)…"},
      ],
    },
  },
};
html = html.replace(MANIFEST_RE, (_, open, _json, close) => open + JSON.stringify(manifest) + close);

/* The title the document reports, so the exported .md/.docx is not called "Standalone HTML Doc". */
html = html.replace(/(<input[^>]*data-title[^>]*value=")[^"]*(")/, "$1Recombinase systems$2");
html = html.replace(/<title>[^<]*<\/title>/, "<title>Recombinase systems</title>");
html = html.replace(/<article id="content"[^>]*>[\s\S]*?<\/article>/, `<article id="content" contenteditable="true" spellcheck="true">
        <h1>Recombinase systems</h1>
        <p>A working note on <b>site-specific</b> recombination — written to be exported.</p>
        <h2>What we measured</h2>
        <p>Three substrates, two temperatures, one afternoon:</p>
        <ul><li>pRX1 — 41 % excision at 37 °C</li><li>pRX2 — 8 %</li><li>pRX3 — no product</li></ul>
        <figure class="figure" data-kind="image" data-figure-id="f1" data-w="0.8" contenteditable="false">
          <div class="figure-frame"></div>
          <figcaption contenteditable="false">Gel, lane 2: the 1.4 kb product.</figcaption>
        </figure>
        <div class="page-spacer"></div>
        <h2>Notes on method</h2>
        <blockquote><p>Recombination was scored from a single gel.</p></blockquote>
        <pre>product = lane &gt; 1;</pre>
      </article>`);

const store = {version: 1, figures: {f1: {
  kind: "image", src: figure, width: 180, height: 120, caption: "Gel, lane 2", scale: 0.8,
}}};
html = html.replace(/<script id="figure-store" type="application\/json">[\s\S]*?<\/script>/,
  `<script id="figure-store" type="application/json">${JSON.stringify(store)}</script>`);

fs.mkdirSync(path.dirname(OUT), {recursive: true});
fs.writeFileSync(OUT, html);
console.log(`demo: .test-tmp/plugin-demo.html (${(html.length / 1024).toFixed(1)} KB)`);
console.log("");
console.log("  npm run dev &");
console.log("  open http://127.0.0.1:8080/.test-tmp/plugin-demo.html");
console.log("");
console.log("  Save as… ▸ Word (.docx)…   ·   Save as… ▸ PDF (typeset)…");
