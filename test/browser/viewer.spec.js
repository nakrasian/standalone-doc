import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* `dist/viewer.html` is the same document in view mode: the editing capability is
   *absent* from the file, not offloaded. So it has to open from disk with no network
   at all — that is the whole point of sending someone a read-only copy. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VIEWER = "file://" + path.join(ROOT, "dist/viewer.html");

async function load(page) {
  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(VIEWER);
  await page.waitForFunction(
    () => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state),
    null,
    { timeout: 15_000 },
  );
  return problems;
}

test("the viewer opens from disk with no network and no editing modules", async ({ page }) => {
  const external = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("file://")) external.push(request.url());
  });

  const problems = await load(page);
  const state = await page.evaluate(() => ({
    state: StandaloneDoc.state,
    modules: Object.keys(StandaloneDoc.modules).sort(),
    order: StandaloneDoc.order(),
    editingBlocks: document.querySelectorAll(
      'script[id="editor"], script[id="toolbar"], script[id="export"], script[id="status"], style[id="toolbar-styles"]',
    ).length,
    editable: document.getElementById("content")?.getAttribute("contenteditable"),
    mode: document.documentElement.dataset.mode,
    toolbar: document.getElementById("app-toolbar") ? "present" : "absent",
    figures: typeof StandaloneDoc.modules.figures,
    content: (document.getElementById("content")?.textContent || "").trim().length,
    /* A build artifact materialises its modes in the manifest, so it stores no
       policy: opening it and saving again defaults to inline. */
    policy: JSON.parse(document.getElementById("doc-settings").textContent).policy ?? null,
    threshold: StandaloneDoc.settings().saveThresholdBytes,
  }));

  expect(problems).toEqual([]);
  expect(external).toEqual([]);
  expect(state.state).toBe("ready");
  /* `doc-bar` is the reader's chrome: a folio, a save, and settings. It is the one bar
     a view or review copy has, so its presence is the difference between a copy with
     chrome and a read-only file. */
  expect(state.modules).toEqual(["apply-settings", "doc-bar", "figures", "layout", "pagination", "selection", "session", "signals", "zoom"]);
  expect(state.order).toEqual(state.modules.slice().sort((a, b) => state.order.indexOf(a) - state.order.indexOf(b)));
  /* Nothing to remove at read time: the capability never came. */
  expect(state.editingBlocks).toBe(0);
  expect(state.editable).toBe("false");
  expect(state.mode).toBe("view");
  expect(state.toolbar).toBe("absent");
  expect(state.figures).toBe("object");
  expect(state.content).toBeGreaterThan(0);
  expect(state.policy).toBe(null);
  expect(state.threshold).toBe(2 * 1024 * 1024);
});

test("the viewer is substantially smaller than the editor", async ({ page }) => {
  /* The saving is the removed capability, not a network dependency. */
  await load(page);
  const sizes = await page.evaluate(() => ({
    viewer: document.documentElement.outerHTML.length,
    body: document.body.innerHTML.length,
  }));
  expect(sizes.viewer).toBeGreaterThan(50_000);
  expect(sizes.body).toBeGreaterThan(0);
});
