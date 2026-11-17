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
    const state = await page.evaluate(() => ({
      signals: typeof Signals,
      signalsApi: Object.keys(Signals).sort().join(","),
      zoom: typeof Zoom.value,
      figures: typeof Figures,
      exporter: typeof Export,
      progress: typeof ProgressDialog,
      toolbar: !!document.getElementById("app-toolbar"),
      symbols: document.querySelectorAll("symbol").length,
      sheets: document.getElementById("sheets").children.length,
    }));
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

  test("a zoom button writes --zoom and updates its label", async ({ page }) => {
    await load(page, fileUrl());
    const zoomIn = page.locator('[data-zoom="in"]:visible').first();
    await zoomIn.click();

    const after = await page.evaluate(() => ({
      value: Zoom.value,
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
      let muted = 0;
      let unmuted = 0;
      const off1 = Signals.on("mutation", () => muted++);
      Signals.mute(() => content.append(document.createElement("p")));
      await new Promise((r) => setTimeout(r, 300));
      off1();
      const off2 = Signals.on("mutation", () => unmuted++);
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
      const before = Signals;
      const dup = document.createElement("script");
      dup.textContent = document.getElementById("signals").textContent;
      document.body.append(dup);
      await new Promise((r) => setTimeout(r, 100));
      return { sameInstance: Signals === before, api: Object.keys(Signals).length };
    });
    expect(result).toEqual({ sameInstance: true, api: 4 });
    expect(problems).toEqual([]);
  });
});

test.describe("http:// (the served case)", () => {
  test("hydrates identically over http", async ({ page }) => {
    const problems = await load(page, "/index.html");
    const state = await page.evaluate(() => ({
      signals: typeof Signals,
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
      signals: typeof Signals,
      zoom: typeof Zoom.value,
      toolbar: !!document.getElementById("app-toolbar"),
    }));
    expect(state).toEqual({ signals: "object", zoom: "number", toolbar: true });
    expect(problems).toEqual([]);
  });
});
