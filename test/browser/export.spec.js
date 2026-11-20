import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* The materialized document: what `buildStatic()` hands to a reader, and now to an
 * exporter. Four things are pinned here because a format conversion depends on each:
 *
 *   1. the authored figure width survives as `width="80%"` — it is the one attribute
 *      pandoc, a printer and a browser all understand;
 *   2. a captured figure is a data URL by default, and a flat `fig-01.png` when the
 *      caller asked for files (LaTeX drops data URIs; wasm has no directories);
 *   3. `figureFiles()` names files exactly as the HTML references them;
 *   4. a figure that could not be captured keeps `data-missing`, and validateStatic
 *      reports it — so a caller whose contract is "fail" can refuse the export.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fileUrl = (name) => "file://" + path.join(ROOT, name);

/* 1×1 PNG: a real data URL, so the mime-derived extension is exercised, not assumed. */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A document with one captured figure in it, in the shape figures.js builds. */
async function loadDoc(page) {
  await page.goto(fileUrl("dist/editor.html"));
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, { timeout: 20_000 });
  await page.evaluate(() => {
    document.getElementById("content").innerHTML =
      "<h1>Recombinase systems</h1>"
      + "<p>One paragraph, so the document is not only a figure.</p>"
      + '<figure class="figure" data-kind="image" data-figure-id="f1" data-w="0.8">'
      + '<div class="figure-frame" data-runtime="ephemeral"></div>'
      + "<figcaption>Gel, lane 2.</figcaption>"
      + "</figure>";
  });
}

const capture = { id: "f1", ok: true, dataUrl: PNG };

test("a captured figure keeps its authored width, as a data URL", async ({ page }) => {
  await loadDoc(page);
  const state = await page.evaluate((captures) => {
    const ex = globalThis.StandaloneDoc.modules.export;
    const html = ex.buildStatic(captures);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const figure = doc.querySelector("#content figure.figure");
    const img = figure.querySelector(".figure-frame img");
    return {
      width: img.getAttribute("width"),
      isDataUrl: (img.getAttribute("src") || "").startsWith("data:image/png;base64,"),
      missing: figure.hasAttribute("data-missing"),
      leakedRuntime: figure.querySelector(".figure-frame").hasAttribute("data-runtime"),
      problems: ex.validateStatic(html),
    };
  }, [capture]);

  expect(state.width).toBe("80%");
  expect(state.isDataUrl).toBe(true);
  expect(state.missing).toBe(false);
  expect(state.leakedRuntime).toBe(false);
  expect(state.problems).toEqual([]);
});

test("media: \"files\" references a flat file, and figureFiles names it", async ({ page }) => {
  await loadDoc(page);
  const state = await page.evaluate((captures) => {
    const ex = globalThis.StandaloneDoc.modules.export;
    const html = ex.buildStatic(captures, { media: "files" });
    const doc = new DOMParser().parseFromString(html, "text/html");
    const img = doc.querySelector("#content figure.figure .figure-frame img");
    return {
      src: img.getAttribute("src"),
      width: img.getAttribute("width"),
      files: ex.figureFiles(captures),
      problems: ex.validateStatic(html, { media: "files" }),
      /* The two must agree, or a caller writes a file nothing references. */
      dataUriProblems: ex.validateStatic(html),
    };
  }, [capture]);

  expect(state.src).toBe("fig-01.png");
  expect(state.width).toBe("80%");
  expect(state.files).toHaveLength(1);
  expect(state.files[0].name).toBe("fig-01.png");
  expect(state.files[0].mime).toBe("image/png");
  expect(state.files[0].dataUrl).toBe(PNG);
  expect(state.problems).toEqual([]);
  /* Same HTML, the other contract: a relative name is not a data URL. */
  expect(state.dataUriProblems).toContain("figure 1 image is not a data URL");
});

test("materialize is the plugin's door: it reports problems instead of throwing", async ({ page }) => {
  await loadDoc(page);
  const state = await page.evaluate(async () => {
    const ex = globalThis.StandaloneDoc.modules.export;
    /* A figure with no store entry cannot be captured — the materializer must come back
       with a problem, not an exception, because whether that is fatal is the caller's
       contract (`onMissing: fail`). */
    const out = await ex.materialize({format: "png", media: "files"});
    return {hasHtml: typeof out.html === "string" && out.html.length > 0, files: out.files, problems: out.problems};
  });

  expect(state.hasHtml).toBe(true);
  expect(state.files).toEqual([]);
  expect(state.problems).toContain("figure 1 has no captured source");
});

test("a figure with no capture is reported, not silently shipped", async ({ page }) => {
  await loadDoc(page);
  const state = await page.evaluate(() => {
    const ex = globalThis.StandaloneDoc.modules.export;
    const html = ex.buildStatic([]);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const figure = doc.querySelector("#content figure.figure");
    return {
      missing: figure.hasAttribute("data-missing"),
      problems: ex.validateStatic(html),
      files: ex.figureFiles([]),
    };
  });

  expect(state.missing).toBe(true);
  expect(state.problems).toContain("figure 1 has no captured source");
  expect(state.files).toEqual([]);
});

/* ---- a figure that is its own export ------------------------------------
 *
 * Two things here are host promises, not figure behaviour:
 *
 *   1. **A sealed island can be captured.** The rasterizer is code, so a profile that
 *      denies eval is mounted with the serializer inlined into its srcdoc (`captureAll`).
 *      Before that, every sealed HTML figure exported as a placeholder, because the only
 *      way in was `(0, eval)(lib)` inside the island.
 *   2. **A figure may draw its own vector output.** `exports` is stored on the store
 *      entry; the host asks the island through `window.__figureExport` and only falls back
 *      to a raster. The caller decides which formats it will accept, because an `.svg` is
 *      right for a page and a print job and not obviously right for every writer.
 */

/** A figure inserted through the host's own path, so the store entry is real. */
async function loadIsland(page, { html, island, exports = null, width = null, height = null }) {
  await page.goto(fileUrl("dist/editor.html"));
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, { timeout: 20_000 });
  await page.evaluate((options) => {
    globalThis.StandaloneDoc.modules.figures.insertHTML(options.html, {
      caption: "Locus",
      island: options.island,
      exports: options.exports,
      width: options.width,
      height: options.height,
    });
  }, { html, island, exports, width, height });
}

test("a sealed island is captured, which is only possible with the serializer inlined", async ({ page }) => {
  await loadIsland(page, {
    island: "sealed",
    html: '<body style="margin:0"><div style="width:120px;height:60px;background:#0b64c8"></div></body>',
  });

  const state = await page.evaluate(async () => {
    const ex = globalThis.StandaloneDoc.modules.export;
    const out = await ex.materialize({ format: "png", media: "files" });
    return { problems: out.problems, files: out.files };
  });

  /* Success *is* the assertion: a sealed island cannot eval, so an island that eval'd its
     serializer would fail here rather than produce a png. The capture mounts its own copy
     with the code inlined, which is the only reason this comes back with a file. */
  expect(state.problems).toEqual([]);
  expect(state.files).toHaveLength(1);
  expect(state.files[0].name).toBe("fig-01.png");
  expect(state.files[0].dataUrl.startsWith("data:image/png")).toBe(true);
});

test("a declared svg export is asked before the rasterizer, and names a .svg file", async ({ page }) => {
  const html = `<body style="margin:0">
<script>
window.__figureExport = async ({format}) => ({
  format,
  text: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50">'
    + '<rect width="200" height="50" fill="#eee"/><text x="10" y="30">RecT</text></svg>',
});
</scr` + `ipt></body>`;

  await loadIsland(page, { html, island: "compute", exports: ["svg"], width: 1, height: 0.26 });
  await page.waitForSelector("figure.figure iframe");

  const state = await page.evaluate(async () => {
    const figures = globalThis.StandaloneDoc.modules.figures;
    const ex = globalThis.StandaloneDoc.modules.export;
    const figure = document.querySelector("figure.figure");
    const captured = await figures.snapshot(figure, { formats: ["svg"] });
    const html = ex.buildStatic([captured], { media: "data-uri" });
    const doc = new DOMParser().parseFromString(html, "text/html");
    const img = doc.querySelector("#content figure.figure .figure-frame img");
    return {
      engine: captured.engine,
      dataUrl: captured.dataUrl || "",
      file: ex.figureFiles([captured])[0],
      stored: figure.dataset.w + "x" + figure.dataset.h,
      width: img.getAttribute("width"),
      src: img.getAttribute("src") || "",
      problems: ex.validateStatic(html),
    };
  });

  expect(state.engine).toBe("figure-export:svg");
  expect(state.dataUrl.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  expect(state.file.name).toBe("fig-01.svg");
  expect(state.file.mime).toBe("image/svg+xml");
  /* The authored geometry travelled: 1 x 0.26, and `width="100%"` in the static copy. */
  expect(state.stored).toBe("1x0.26");
  expect(state.width).toBe("100%");
  expect(state.src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  expect(state.problems).toEqual([]);
});

test("a declared exporter that fails costs quality, not the figure", async ({ page }) => {
  const html = `<body style="margin:0"><div style="width:80px;height:40px;background:#333"></div>
<script>
window.__figureExport = async () => { throw new Error("no vector today"); };
</scr` + `ipt></body>`;

  await loadIsland(page, { html, island: "compute", exports: ["svg"] });
  await page.waitForSelector("figure.figure iframe");

  const state = await page.evaluate(async () => {
    const ex = globalThis.StandaloneDoc.modules.export;
    /* The real export path, so the rasterizer gets the serializer it needs. */
    const out = await ex.materialize({ format: "png", media: "files", formats: ["svg"] });
    return { problems: out.problems, file: out.files[0] };
  });

  /* The rasterizer is the fallback, so the figure still ships. */
  expect(state.problems).toEqual([]);
  expect(state.file.name).toBe("fig-01.png");
});
