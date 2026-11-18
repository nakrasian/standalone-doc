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
