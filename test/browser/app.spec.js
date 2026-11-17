import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* Tier 2: the behavioural contract, in a real browser, from the real file.
   These are the specs Phase 3-5 extend (offline archival, CDN failure modes,
   plugin activation), so the helpers here are deliberately reusable. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fileUrl = (name = "index.html") => "file://" + path.join(ROOT, name);

/** Load a page and return every console error and uncaught exception. */
async function load(page, url) {
  const problems = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  await page.goto(url);
  await page.waitForSelector("#app-toolbar", { state: "attached" });
  /* boot() is async: wait until it has either finished or failed. */
  await page.waitForFunction(
    () => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state),
    null,
    { timeout: 15_000 },
  );
  return problems;
}

test.describe("file:// (the archival case)", () => {
  test("loads with no console errors or uncaught exceptions", async ({ page }) => {
    const problems = await load(page, fileUrl());
    await page.waitForTimeout(500); // let pagination and status settle
    expect(problems).toEqual([]);
  });

  test("every module binding exists and the UI is fully rendered", async ({ page }) => {
    await load(page, fileUrl());
    const state = await page.evaluate(() => {
      const m = StandaloneDoc.modules;
      return {
        signals: typeof m.signals,
        signalsApi: Object.keys(m.signals).sort().join(","),
        zoom: typeof m.zoom.value,
        figures: typeof m.figures,
        exporter: typeof m.export,
        progress: typeof m.progress,
        toolbar: !!document.getElementById("app-toolbar"),
        symbols: document.querySelectorAll("symbol").length,
        sheets: document.getElementById("sheets").children.length,
        /* The legacy bindings are gone: only the registry may leak out. */
        legacyGlobals: ["Signals", "Zoom", "Figures", "Export", "ProgressDialog", "Editor", "Toolbar", "Status", "Pagination"]
          .filter((name) => name in globalThis),
      };
    });
    expect(state).toEqual({
      signals: "object",
      signalsApi: "composing,emit,mute,on",
      zoom: "number",
      figures: "object",
      exporter: "object",
      progress: "object",
      toolbar: true,
      symbols: 23,
      sheets: expect.any(Number),
      legacyGlobals: [],
    });
    expect(state.sheets).toBeGreaterThan(0);
  });

  test("typing updates the status line", async ({ page }) => {
    await load(page, fileUrl());
    const stats = page.locator("[data-stats]").first();
    const words = (text) => Number(/(\d+) words?/.exec(text ?? "")?.[1] ?? 0);
    const before = words(await stats.textContent());
    expect(before).toBeGreaterThan(0);

    /* Put the caret at the end of the document, then type one new word. */
    await page.evaluate(() => {
      const content = document.getElementById("content");
      const range = document.createRange();
      range.selectNodeContents(content);
      range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      content.focus();
    });
    await page.keyboard.type(" zebra");

    await expect.poll(async () => words(await stats.textContent())).toBe(before + 1);
    // Pagination is driven by the same Signals observers.
    await expect(stats).toContainText(/\d+ pages?/);
    expect(await page.locator("#content").textContent()).toContain("zebra");
  });

  test("a figure can be inserted, resized and removed", async ({ page }) => {
    /* These three paths called Pagination/Status through a global, so nothing
       noticed when the globals were removed. Insert an island, resize it, remove
       it: every figure mutation ends up in pagination.schedule(). */
    const problems = await load(page, fileUrl());
    const result = await page.evaluate(async () => {
      const figures = StandaloneDoc.modules.figures;
      const file = new File(['<!doctype html><meta charset="utf-8"><p>island</p>'], "island.html", { type: "text/html" });
      const [figure] = await figures.insertFiles([file], { kindHint: "html" });
      const id = figure?.dataset.figureId;
      const inserted = !!figure && figure.isConnected && document.body.contains(figure);
      const stored = !!(id && figures.store.figures[id]);
      figures.setDimension(figure, "w", 0.8);
      const width = figure.style.getPropertyValue("--figure-w");
      figures.remove(figure);
      return { inserted, stored, width, removed: !document.querySelector(`[data-figure-id="${id}"]`) };
    });
    expect(result).toEqual({ inserted: true, stored: true, width: "0.8", removed: true });
    expect(problems).toEqual([]);
  });

  test("a zoom button writes --zoom and updates its label", async ({ page }) => {
    await load(page, fileUrl());
    const zoomIn = page.locator('[data-zoom="in"]:visible').first();
    await zoomIn.click();

    const after = await page.evaluate(() => ({
      value: StandaloneDoc.modules.zoom.value,
      cssVar: getComputedStyle(document.getElementById("stage")).getPropertyValue("--zoom").trim(),
      label: document.querySelector("[data-zoom-label]")?.textContent ?? "",
    }));
    expect(after.value).toBeGreaterThan(1);
    expect(Number(after.cssVar)).toBeCloseTo(after.value, 5);
    expect(after.label).toContain("Zoom");
  });

  test("Signals.mute suppresses the mutation event; an unmuted edit fires once", async ({ page }) => {
    await load(page, fileUrl());
    const result = await page.evaluate(async () => {
      const content = document.getElementById("content");
      const signals = StandaloneDoc.modules.signals;
      let muted = 0;
      let unmuted = 0;
      const off1 = signals.on("mutation", () => muted++);
      signals.mute(() => content.append(document.createElement("p")));
      await new Promise((r) => setTimeout(r, 300));
      off1();
      const off2 = signals.on("mutation", () => unmuted++);
      content.append(document.createElement("p"));
      await new Promise((r) => setTimeout(r, 300));
      off2();
      return { muted, unmuted };
    });
    expect(result).toEqual({ muted: 0, unmuted: 1 });
  });

  test("re-executing a compiled block reuses the instance", async ({ page }) => {
    const problems = await load(page, fileUrl());
    const result = await page.evaluate(async () => {
      const before = StandaloneDoc.modules.signals;
      const factory = StandaloneDoc.factories.signals;
      /* The block is a module script now (it keeps its `export`), so the copy
         has to be a module too. The trailing flag makes execution observable. */
      const dup = document.createElement("script");
      dup.type = "module";
      dup.textContent = document.getElementById("signals").textContent + "\nglobalThis.__dupRan = true;\n";
      document.body.append(dup);
      for (let i = 0; i < 100 && !globalThis.__dupRan; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return {
        ran: globalThis.__dupRan === true,
        sameInstance: StandaloneDoc.modules.signals === before,
        sameFactory: StandaloneDoc.factories.signals === factory,
        api: Object.keys(StandaloneDoc.modules.signals).length,
      };
    });
    expect(result).toEqual({ ran: true, sameInstance: true, sameFactory: true, api: 4 });
    expect(problems).toEqual([]);
  });
});

test.describe("http:// (the served case)", () => {
  test("hydrates identically over http", async ({ page }) => {
    const problems = await load(page, "/index.html");
    const state = await page.evaluate(() => ({
      signals: typeof StandaloneDoc.modules.signals,
      toolbar: !!document.getElementById("app-toolbar"),
      sheets: document.getElementById("sheets").children.length,
    }));
    expect(state.signals).toBe("object");
    expect(state.toolbar).toBe(true);
    expect(state.sheets).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});

test.describe("dist/ (what ships)", () => {
  test("the built artifact behaves like the source", async ({ page }) => {
    const problems = await load(page, fileUrl("dist/editor.html"));
    const state = await page.evaluate(() => ({
      signals: typeof StandaloneDoc.modules.signals,
      zoom: typeof StandaloneDoc.modules.zoom.value,
      toolbar: !!document.getElementById("app-toolbar"),
    }));
    expect(state).toEqual({ signals: "object", zoom: "number", toolbar: true });
    expect(problems).toEqual([]);
  });
});
