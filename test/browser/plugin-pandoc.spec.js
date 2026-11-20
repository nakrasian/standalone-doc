import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { entries } from "../../tools/reproducible.mjs";
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
/* The second stage: typst's wasm compiler and its bundle, from the devDependencies. */
const TYPST_BUNDLE = "node_modules/@myriaddreamin/typst.ts/dist/esm/contrib/all-in-one-lite.bundle.js";
const TYPST_WASM = "node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm";
const WASM = "node_modules/pandoc-wasm/src/pandoc.wasm";
/* A real PNG, built byte by byte: typst is stricter than a browser about a malformed deflate
   stream, and a fixture that only one of the two accepts is a trap for the next person. */
function png(width, height, pixel) {
  const crcTable = Array.from({length: 256}, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
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
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, {level: 9})),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG = "data:image/png;base64," + png(48, 32, (x, y) =>
  (Math.abs(y - (x * 32) / 48) < 2 ? [47, 111, 237] : [246, 248, 250])).toString("base64");

/** An editor document with the plugin pinned, and one figure for it to capture. */
function makeDoc({ figure = true, long = false, fragmented = false } = {}) {
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
    asset("typst-bundle", "bin", TYPST_BUNDLE, 330),
    asset("typst-compiler", "bin", TYPST_WASM, 331),
    {
      ...asset("pandoc-export", "js", PLUGIN, 320),
      factory: "createPandocExport",
    },
  );
  manifest.plugins = {
    pandoc: {
      label: "Pandoc export", version: "0.1.0", island: "sealed", enabled: true,
      entry: "pandoc-export",
      assets: ["pandoc", "wasi-shim", "sd-export-lua", "sd-template-typ", "sd-reference",
        "typst-bundle", "typst-compiler", "pandoc-export"],
      contributes: {
        export: [
          { id: "docx", label: "Word (.docx)…" },
          { id: "typ", label: "Typst (.typ)…" },
          { id: "md", label: "Markdown (.md)…" },
          { id: "pdf", label: "PDF (typeset)…" },
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
        ${long ? Array.from({length: 12}, (_, i) => `<p>Paragraph ${i + 1}. ${"A sentence long enough to take a line, repeated so the document ends up on several pages. ".repeat(6)}</p>`).join("\n") : ""}
        ${fragmented ? `<p>${"A long sentence that keeps going, because a page break has to fall somewhere inside it. ".repeat(300)}</p><p>After the long paragraph.</p>` : ""}
        ${figureHtml}
      </article>`);
  const store = figure
    ? {version: 1, figures: {f1: {kind: "image", src: PNG, width: 400, height: 300, caption: "Gel, lane 2", scale: 0.8}}}
    : {version: 1, figures: {}};
  html = html.replace(/<script id="figure-store" type="application\/json">[\s\S]*?<\/script>/,
    `<script id="figure-store" type="application/json">${JSON.stringify(store)}</script>`);

  fs.mkdirSync(TMP, {recursive: true});
  const name = `.test-tmp/plugin-pandoc-${process.pid}-${figure ? "figure" : "plain"}${long ? "-long" : ""}${fragmented ? "-fragmented" : ""}.html`;
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

/** The .docx body as text, from the real plugin button. */
async function exportDocument(page) {
  const [download] = await Promise.all([
    page.waitForEvent("download", {timeout: 180_000}),
    page.evaluate(() => document.querySelector('[data-plugin-export="pandoc:docx"]').click()),
  ]);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const docx = Buffer.concat(chunks);
  return entries(docx).find((entry) => entry.name === "word/document.xml").data.toString("utf8");
}

test("a page-start block becomes a page break in the .docx", async ({ page }) => {
  test.slow(); /* 58.6 MB over the loopback and a wasm compile */
  const problems = await load(page, makeDoc({figure: false, long: true}));
  await page.waitForSelector('[data-plugin-export="pandoc:docx"]', {state: "attached", timeout: 30_000});
  /* The number the .docx must match: both spellings of a page boundary on screen. A page
     that starts with a block carries `data-page-start`; a page that continues a fragmented
     paragraph starts at a `data-frag` cut, and the export writes each as a break. */
  const live = await page.evaluate(() => ({
    pages: globalThis.StandaloneDoc.modules.pagination.pageCount(),
    starts: document.querySelectorAll("#content > [data-page-start]").length,
    cuts: document.querySelectorAll("#content [data-frag]").length,
  }));
  const document = await exportDocument(page);
  const breaks = (document.match(/w:type="page"/g) || []).length;
  expect(breaks, `the .docx has ${breaks} break(s) for ${live.starts} page start(s) + ${live.cuts} cut(s) on ${live.pages} pages`)
    .toBe(live.starts + live.cuts);
  expect(live.starts + live.cuts).toBeGreaterThan(0);
  expect(live.cuts, "the fixture must exercise a fragment cut now that the flag is on").toBeGreaterThan(0);
  /* The margin model writes the break as `data-page-start`; the filter turns it into the
     target's native page break. Without this the .docx silently loses every break the
     page-spacer spelling used to produce. */
  expect(document).toContain('w:type="page"');
  expect(document).not.toContain("data-page-start");
  expect(document).not.toContain("data-frag");
  expect(document).toContain("Recombinase systems");
  expect(problems).toEqual([]);
});

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

  /* …and the body must be OOXML. This is the assertion that was missing when the docx went
     out with the *Typst* template written into word/document.xml: zip magic, a media part and
     a file called document.xml were all present, so the test passed and Word refused the
     file. A container is not a document. */
  const document = entries(docx).find((entry) => entry.name === "word/document.xml").data.toString("utf8");
  expect(document.startsWith("<?xml")).toBe(true);
  expect(document).toContain("<w:document");
  expect(document).toContain("<w:pgSz");           /* the reference docx's page */
  expect(document).not.toContain("typst");         /* the template did not leak in */
  expect(document).toContain("Recombinase systems");
  expect(problems).toEqual([]);
});

test("a text target brings its figures with it", async ({ page }) => {
  test.slow();
  await load(page, makeDoc());
  await page.waitForSelector('[data-plugin-export="pandoc:md"]', {state: "attached", timeout: 30_000});

  /* A `.md` that says `![](fig-01.png)` is honest only if fig-01.png arrives too: the host
     downloads the extras after the document, so one click is still one document. */
  const downloads = [];
  page.on("download", async (download) => {
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    downloads.push({name: download.suggestedFilename(), bytes: Buffer.concat(chunks)});
  });

  await page.evaluate(() => document.querySelector('[data-plugin-export="pandoc:md"]').click());
  await expect.poll(() => downloads.length, {timeout: 180_000}).toBe(2);

  const markdown = downloads.find((file) => file.name === "document.md");
  const figure = downloads.find((file) => file.name === "fig-01.png");
  expect(markdown).toBeTruthy();
  expect(figure).toBeTruthy();
  expect(markdown.bytes.toString("utf8")).toContain("](fig-01.png)");
  expect(figure.bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
});

test("a figure with no source is refused, visibly", async ({ page }) => {
  test.slow();
  /* The figure exists in the DOM but its store entry is gone, so materialize() reports it —
     and the refusal has to be something a person can see, not a console line. */
  const url = makeDoc();
  const html = fs.readFileSync(path.join(ROOT, url.replace(/^\//, "")), "utf8")
    .replace(/<script id="figure-store" type="application\/json">[\s\S]*?<\/script>/,
      '<script id="figure-store" type="application/json">{"version":1,"figures":{}}</script>');
  fs.writeFileSync(path.join(ROOT, url.replace(/^\//, "")), html);

  await load(page, url);
  await page.waitForSelector('[data-plugin-export="pandoc:docx"]', {state: "attached", timeout: 30_000});
  await page.evaluate(() => document.querySelector('[data-plugin-export="pandoc:docx"]').click());

  const dialog = page.locator("#plugin-refusal");
  await expect(dialog).toBeVisible({timeout: 180_000});
  await expect(dialog).toContainText("no captured source");
  /* A plugin's own error carries no url, so the sentence must not grow a dangling separator:
     the address is appended only when there is one to append. */
  await expect(dialog.locator("[data-refusal-message]")).not.toContainText(" — ");
});

test("PDF with figures: .typ through the wasm typesetter", async ({ page }) => {
  test.slow();
  await load(page, makeDoc());
  await page.waitForSelector('[data-plugin-export="pandoc:pdf"]', {state: "attached", timeout: 30_000});

  const [download] = await Promise.all([
    page.waitForEvent("download", {timeout: 240_000}),
    page.evaluate(() => document.querySelector('[data-plugin-export="pandoc:pdf"]').click()),
  ]);
  expect(download.suggestedFilename()).toBe("document.pdf");
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const pdf = Buffer.concat(chunks);

  /* A real PDF from the real compiler: %PDF- magic, an object graph, and big enough to be
     a page with a figure rather than an error stub. */
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(pdf.length).toBeGreaterThan(10_000);
  expect(pdf.includes(Buffer.from("/Type /Page"))).toBe(true);
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

test("a cut inside a paragraph becomes an inline page break in the .docx", async ({ page }) => {
  test.slow(); /* 58.6 MB over the loopback and a wasm compile */
  const problems = await load(page, makeDoc({figure: false, fragmented: true}));
  await page.waitForSelector('[data-plugin-export="pandoc:docx"]', {state: "attached", timeout: 30_000});

  /* Fragment the long paragraph the way the screen planner does, then export. */
  const live = await page.evaluate(async () => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.setFragmenting(true);
    pag.refresh();
    const staticHtml = globalThis.StandaloneDoc.modules.export.buildStatic([], {media: "data-uri"});
    const doc = new DOMParser().parseFromString(staticHtml, "text/html");
    return {
      pages: pag.pageCount(),
      fragments: content.querySelectorAll("[data-frag]").length,
      starts: content.querySelectorAll("[data-page-start]").length,
      staticFragments: doc.querySelectorAll("[data-frag]").length,
      markers: doc.querySelectorAll(".page-break-inline").length,
      textLength: content.textContent.length,
      staticTextLength: doc.querySelector("#content").textContent.length,
    };
  });
  expect(live.fragments, "the fixture must produce cuts inside the paragraph").toBeGreaterThan(0);
  expect(live.staticFragments, "buildStatic left a fragment in the static document").toBe(0);
  expect(live.markers, "one inline marker per cut").toBe(live.fragments);
  expect(live.staticTextLength, "the static document lost text").toBe(live.textLength);

  const document = await exportDocument(page);
  const breaks = (document.match(/w:type="page"/g) || []).length;
  expect(
    breaks,
    `the .docx has ${breaks} break(s) for ${live.fragments} cut(s) and ${live.starts} page start(s)`,
  ).toBe(live.fragments + live.starts);
  /* At least one break is inside a <w:p>, not between two: the paragraph stayed whole. */
  expect(document).toMatch(/<w:p>(?:(?!<\/w:p>)[\s\S])*?<w:br w:type="page"\/>/);
  expect(document).not.toContain("page-break-inline");
  expect(document).not.toContain("data-frag");
  expect(problems).toEqual([]);
});

test("a .docx carries the document, not the session", async ({ page }) => {
  test.slow();
  await load(page, makeDoc({figure: false}));
  await page.waitForSelector('[data-plugin-export="pandoc:docx"]', {state: "attached", timeout: 30_000});

  /* Injected at runtime, not in the fixture: a sentinel in `#sheets` before boot is a
     pagination cell, and pagination rewrites cells. These are the four things a session
     builds that a `.docx` must not inherit. */
  const live = await page.evaluate(() => {
    const content = document.getElementById("content");
    const stage = document.getElementById("stage");

    /* The real page furniture, renamed so the assertion cannot be satisfied by a folio
       that pagination simply did not draw yet. */
    const folio = document.querySelector('[data-slot="folio"]');
    if (folio) folio.textContent = "FOLIO-SENTINEL";

    const layer = document.createElement("div");
    layer.id = "comment-layer";
    layer.dataset.runtime = "ephemeral";
    layer.textContent = "COMMENT-LAYER-SENTINEL";
    stage.append(layer);

    const runtime = document.createElement("p");
    runtime.dataset.runtime = "ephemeral";
    runtime.textContent = "RUNTIME-NODE-SENTINEL";
    content.append(runtime);

    const meta = document.createElement("script");
    meta.id = "comments";
    meta.type = "application/json";
    meta.textContent = JSON.stringify({schema: 1, comments: [{body: "COMMENTS-JSON-SENTINEL"}]});
    document.body.append(meta);

    return {
      folio: Boolean(folio),
      folioText: folio && folio.textContent,
      runtime: content.textContent.includes("RUNTIME-NODE-SENTINEL"),
      layer: Boolean(document.getElementById("comment-layer")),
      comments: Boolean(document.getElementById("comments")),
    };
  });
  expect(live).toEqual({folio: true, folioText: "FOLIO-SENTINEL", runtime: true, layer: true, comments: true});

  const [download] = await Promise.all([
    page.waitForEvent("download", {timeout: 180_000}),
    page.evaluate(() => document.querySelector('[data-plugin-export="pandoc:docx"]').click()),
  ]);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const docx = Buffer.concat(chunks);
  const document = entries(docx).find((entry) => entry.name === "word/document.xml").data.toString("utf8");

  /* What the document says… */
  expect(document).toContain("Recombinase systems");
  expect(document).toContain("A paragraph, so the document is not only a figure.");
  /* …and what the session said, which must not travel. A folio is a page number the
     reader's engine invented; a runtime node and an overlay are the reader's screen; a
     comment is metadata, and PLAN-comments.md §15.3 decides it is not printed. */
  expect(document).not.toContain("FOLIO-SENTINEL");
  expect(document).not.toContain("RUNTIME-NODE-SENTINEL");
  expect(document).not.toContain("COMMENT-LAYER-SENTINEL");
  expect(document).not.toContain("COMMENTS-JSON-SENTINEL");
});
