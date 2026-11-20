import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/* The genome plugin, as a document sees it — end to end, with a stub engine.
 *
 * The engine is 1.4 MB of GenomeSpy from a CDN, and a test that downloads it is a test that
 * fails when jsDelivr does. So `genomespy` here is a 1 KB module with the same shape
 * (`embed(root, spec)` → an api with `imageExport.svg()`), which leaves everything that is
 * *this plugin's* job under test:
 *
 *   1. Insert ▸ Genome map… reads a `.spec.json`, and the figure records island, assets,
 *      exports and geometry — the contract, not just a picture;
 *   2. the island asks for both assets by name and embeds the spec it was given;
 *   3. the clamp toggle rewrites `scales.x.zoom.extent` instead of subscribing to a scale;
 *   4. the export hook returns the engine's SVG, and the host files it as `fig-01.svg`;
 *   5. a file that is not a GenomeSpy spec is refused, and no figure is produced.
 *
 * What the stub does *not* prove is that GenomeSpy renders; `lab/` measured that (29–231 ms to
 * embed in the three engines) and the demo document exercises the real pin.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
/* Per worker: three browsers run this file at once, and a shared staged file would be read
   mid-write by somebody else's page (an integrity failure that looks like a plugin bug). */
const WORKER = process.pid;
const STAGE = `http://127.0.0.1:8080/.test-tmp/genome-${WORKER}`;
const DIR = path.join(ROOT, ".test-tmp", `genome-${WORKER}`);
const MANIFEST_RE = /(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/;
const CONTENT_RE = /(<article id="content"[^>]*>)[\s\S]*?(<\/article>)/;

const plugin = fs.readFileSync(path.join(ROOT, "plugins/genome/genome.js"), "utf8");
const view = fs.readFileSync(path.join(ROOT, "plugins/genome/genome-view.js"), "utf8");
const fixture = fs.readFileSync(path.join(ROOT, "plugins/genome/fixtures/locus.spec.json"), "utf8");

const sha384 = (text) => "sha384-" + createHash("sha384").update(text, "utf8").digest("base64");
const byteLength = (text) => Buffer.byteLength(text, "utf8");

/* The stub: one `embed`, one exporter, and a report of exactly what the view handed it. */
const ENGINE = `export async function embed(root, spec) {
  const x = (spec.scales && spec.scales.x) || {};
  const extent = (x.zoom && x.zoom.extent) || null;
  const report = {
    extent,
    domain: x.domain,
    background: spec.background,
    themed: Boolean(spec.config && spec.config.axis && spec.config.axis.labelColor),
    /* The shape of the spec the view handed the engine: authored (one view, label-N bands)
       or measured (two panels, an axis title of its own). */
    panels: (spec.vconcat || []).map((view) => view.name),
    height: spec.height,
    axisTitle: spec.axes && spec.axes.x && spec.axes.x.title,
    /* Layout, not data: the rows keep their label_band field either way. */
    labelBands: Boolean(spec.layer && JSON.stringify(spec.layer).includes("label-0")),
    keepsFeatures: Boolean(spec.datasets && spec.datasets.features && spec.datasets.features.length),
    keepsGenes: Boolean(spec.datasets && spec.datasets.genes && spec.datasets.genes.length),
    labelCount: (spec.datasets && spec.datasets.features || []).filter((row) => row.label).length,
  };
  root.dataset.stub = JSON.stringify(report);
  parent.postMessage({ stub: report }, "*");
  return {
    finalize() {},
    imageExport: {
      svg: async () => ({
        blob: new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60">'
          + '<text x="10" y="30">recombinase RecT</text></svg>'], { type: "image/svg+xml" }),
      }),
    },
  };
}
`;

const BODY = "<h1>Genome map</h1><p>Insert a locus below.</p>";

/** The editor with the plugin pinned at paths this origin serves. */
function makeDoc() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "genome.js"), plugin);
  fs.writeFileSync(path.join(DIR, "genome-view.js"), view);
  fs.writeFileSync(path.join(DIR, "genomespy.js"), ENGINE);

  let html = fs.readFileSync(path.join(ROOT, "dist", "editor.html"), "utf8");
  html = html.replace(CONTENT_RE, (_, open, close) => `${open}\n${BODY}\n${close}`);
  const manifest = JSON.parse(MANIFEST_RE.exec(html)[2]);
  const asset = (id, kind, file, order, extra = {}) => Object.assign({
    id, kind, role: "module", order, mode: "online", category: "plugin", plugin: "genome",
    requiredBy: ["*"], bytes: byteLength(file), url: `${STAGE}/${id}.js`, integrity: sha384(file),
  }, extra);
  manifest.assets.push(
    asset("genome", "js", plugin, 700, {factory: "createGenome"}),
    asset("genome-view", "bin", view, 701),
    asset("genomespy", "bin", ENGINE, 800),
  );
  manifest.plugins = {
    genome: {
      label: "Genome map", version: "0.1.0", api: 3, island: "compute", enabled: true,
      entry: "genome", assets: ["genome", "genome-view", "genomespy"],
      url: `${STAGE}/genome.js`, integrity: sha384(plugin),
      contributes: { insert: [{ id: "locus", label: "Genome map…", island: "compute" }] },
    },
  };
  html = html.replace(MANIFEST_RE, (_, open, _json, close) => open + JSON.stringify(manifest) + close);
  const name = `.test-tmp/genome-plugin-${WORKER}.html`;
  fs.writeFileSync(path.join(ROOT, name), html);
  return "/" + name;
}

async function boot(page) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.addInitScript(() => {
    globalThis.__stub = [];
    addEventListener("message", (event) => {
      if (event.data && event.data.stub) globalThis.__stub.push(event.data.stub);
    });
  });
  await page.goto(makeDoc(), { waitUntil: "load" });
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, { timeout: 20_000 });
  await page.waitForSelector("[data-plugin-insert]", { state: "attached" });
  return problems;
}

/**
 * Run the contribution, and answer its file picker.
 *
 * Driven through the plugin's own `[data-genome-input]` rather than a FileChooser event: the
 * input is a persistent hidden element (the same arrangement the editor's Import comments…
 * uses), so the test sets files where a human's dialog would — and does not depend on a
 * synthetic `input.click()` being treated as a trusted user gesture.
 */
async function insert(page, { text = fixture, name = "locus.spec.json" } = {}) {
  await page.evaluate(() => document.querySelector("[data-plugin-insert]").click());
  await page.waitForSelector("[data-genome-input]", { state: "attached" });
  await page.setInputFiles("[data-genome-input]", {
    name, mimeType: "application/json", buffer: Buffer.from(text, "utf8"),
  });
}

/** Wait until the island has *settled*, and fail with the island's own words if it failed. */
async function settledMap(page, timeout = 20_000) {
  const frame = page.frameLocator("figure.figure iframe");
  await frame.locator(".gmap[data-state='ready'], .gmap[data-state='failed']").first().waitFor({ timeout });
  const gmap = frame.locator(".gmap");
  const state = await gmap.evaluate((node) => ({
    state: node.dataset.state,
    message: node.querySelector(".gmap-msg")?.textContent || "",
  }));
  expect(state.state, state.message).toBe("ready");
  return gmap;
}

const entryOf = (page) => page.evaluate(() => {
  const element = document.querySelector("figure.figure");
  if (!element) return null;
  const entry = globalThis.StandaloneDoc.modules.figures.store.figures[element.dataset.figureId];
  return {
    caption: element.querySelector("figcaption")?.textContent,
    geometry: element.dataset.w + "x" + element.dataset.h,
    kind: entry.kind,
    island: entry.island,
    assets: entry.assets,
    exports: entry.exports,
    pluginId: entry.plugin?.id,
    hasIntegrity: typeof entry.plugin?.integrity === "string",
    sourceKB: Math.round(new TextEncoder().encode(entry.src).length / 1024),
    mentionsLoaders: entry.src.includes("__figureBytes(\"genome-view\")"),
  };
});

test("Insert ▸ Genome map… records the figure's own contract", async ({ page }) => {
  const problems = await boot(page);
  await insert(page);
  await page.waitForSelector("figure.figure[data-kind='html']");

  const entry = await entryOf(page);
  expect(entry.kind).toBe("html");
  /* The window is clamped by default, because the spec declares a contig to zoom out to. */
  expect(entry.caption).toContain("Xanthobacter versatilis Py2");
  expect(entry.geometry).toBe("1x0.32");
  expect(entry.island).toBe("compute");
  expect(entry.assets).toEqual(["genome-view", "genomespy"]);
  expect(entry.exports).toEqual(["svg"]);
  expect(entry.pluginId).toBe("genome");
  expect(entry.hasIntegrity).toBe(true);
  /* The whole figure is the spec plus a loader — the engine is not copied into it. */
  expect(entry.sourceKB).toBeGreaterThan(20);
  expect(entry.sourceKB).toBeLessThan(40);
  expect(entry.mentionsLoaders).toBe(true);
  expect(problems).toEqual([]);
});

test("the island draws the spec with the authored window, clamped to the locus", async ({ page }) => {
  await boot(page);
  await insert(page);
  const frame = await settledMap(page);

  const report = await page.evaluate(() => globalThis.__stub.at(-1));
  /* The authored window, unchanged: the view re-lays the labels, never the data or the
     window. With measured labels the x channel is numeric (the grammar's `index` scale), so
     the domain is the same window in base pairs. */
  expect(report.domain).toEqual([4244867, 4253874]);
  /* Clamped, the zoom extent is the locus itself — you cannot leave it. */
  expect(report.extent).toEqual([4244867, 4253874]);
  /* The view owns the theme, so a figure's paper does not depend on the document's. */
  expect(report.background).toBe("#ffffff");
  expect(report.themed).toBe(true);
  /* The engine is in the island, not in the document. */
  expect(await page.evaluate(() => document.querySelector("figure.figure iframe").contentDocument)).toBe(null);
});

test("the toggle frees the window to the contig, and back", async ({ page }) => {
  await boot(page);
  await insert(page);
  const frame = await settledMap(page);

  const box = frame.locator(".gmap-toggle input");
  await expect(box).toBeChecked();
  await box.uncheck();
  await page.waitForFunction(() => (globalThis.__stub || []).length >= 2, null, { timeout: 20_000 });
  expect(await page.evaluate(() => globalThis.__stub.at(-1).extent)).toEqual([0, 5309182]);

  await box.check();
  await page.waitForFunction(() => (globalThis.__stub || []).length >= 3, null, { timeout: 20_000 });
  const back = await page.evaluate(() => globalThis.__stub.at(-1));
  expect(back.extent).toEqual([4244867, 4253874]);
  /* Re-centres, rather than leaving the reader wherever the free view ended up. */
  expect(back.domain).toEqual([4244867, 4253874]);
});

test("the figure answers the export hook, and the host files it as SVG", async ({ page }) => {
  await boot(page);
  await insert(page);
  await settledMap(page);

  const state = await page.evaluate(async () => {
    const figures = globalThis.StandaloneDoc.modules.figures;
    const ex = globalThis.StandaloneDoc.modules.export;
    const figure = document.querySelector("figure.figure");
    const captured = await figures.snapshot(figure, { formats: ["svg"] });
    const doc = new DOMParser().parseFromString(
      ex.buildStatic([captured], { media: "data-uri" }), "text/html");
    return {
      engine: captured.engine,
      isSvg: (captured.dataUrl || "").startsWith("data:image/svg+xml;charset=utf-8,"),
      decoded: decodeURIComponent((captured.dataUrl || "").replace(/^data:[^,]+,/, "")),
      files: ex.figureFiles([captured]).map((file) => file.name),
      img: doc.querySelector("figure.figure .figure-frame img")?.getAttribute("src") || "",
      problems: ex.validateStatic(ex.buildStatic([captured])),
    };
  });

  /* The declared exporter won: this is the engine's vector, not a raster of a canvas. */
  expect(state.engine).toBe("figure-export:svg");
  expect(state.isSvg).toBe(true);
  expect(state.decoded).toContain("recombinase RecT");
  expect(state.files).toEqual(["fig-01.svg"]);
  expect(state.img.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  expect(state.problems).toEqual([]);
});

test("a file that is not a GenomeSpy spec is refused, and no figure appears", async ({ page }) => {
  await boot(page);
  await insert(page, { text: JSON.stringify({ hello: "world" }), name: "notes.json" });
  await page.waitForFunction(() => /GenomeSpy spec/.test(document.getElementById("plugin-refusal")?.textContent || ""));
  const state = await page.evaluate(() => ({
    figures: document.querySelectorAll("figure.figure").length,
    dialog: document.getElementById("plugin-refusal")?.textContent,
  }));
  expect(state.figures).toBe(0);
  expect(state.dialog).toContain("scales");
});

/* ---- label layout -------------------------------------------------------
 *
 * The document column is narrower than the width spec.py measured rows for, so baked label
 * rows crowd. The view adopts GenomeSpy's own gene-map grammar instead: measure at the current
 * width, sort by left edge, pile into collision-free lanes. Data, palette and tooltips are the
 * author's; only the layout is recomputed. A spec that wants its authored rows back says so.
 */
const withLabels = (value) => {
  const spec = JSON.parse(fixture);
  spec.config = Object.assign({}, spec.config, { genome: { labels: value } });
  return JSON.stringify(spec);
};

test("a locus spec is re-laid at render width, keeping the data and the palette", async ({ page }) => {
  await boot(page);
  await insert(page);
  await settledMap(page);
  const report = await page.evaluate(() => globalThis.__stub.at(-1));

  /* Two panels: measured labels above, the gene track below. */
  expect(report.panels).toEqual(["labelPanel", "arrowPanel"]);
  expect(report.height).toBe("container");
  expect(report.axisTitle).toBe("Genome position (bp)");
  /* The baked rows are gone; the rows themselves are not. */
  expect(report.labelBands).toBe(false);
  expect(report.keepsFeatures).toBe(true);
  expect(report.keepsGenes).toBe(true);
  expect(report.labelCount).toBe(18);
});

test("a spec may keep its authored label rows", async ({ page }) => {
  await boot(page);
  await insert(page, { text: withLabels("authored") });
  await settledMap(page);
  const report = await page.evaluate(() => globalThis.__stub.at(-1));

  /* One view, the bands spec.py wrote, the authored axis. The opt-out is a spec decision,
     stored with the data, so a document that needs the tuned rows keeps them. */
  expect(report.panels).toEqual([]);
  expect(report.labelBands).toBe(true);
  expect(report.keepsFeatures).toBe(true);
});
