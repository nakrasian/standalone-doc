import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* The viewer's bar: what a read-only document can honestly offer.
 *
 *   - a folio that is a *real* page number (pagination owns it; the editor's minimal bar
 *     reads the same [data-folio])
 *   - a save, because a viewer cannot write the file it came from — it downloads a copy
 *   - settings a reader can act on: mode, pages, the pinned runtime, zoom
 *   - and the reason it exists: a repaired viewer can keep the repair (6a's card says
 *     "save the file" only because a [data-save] exists)
 *
 * Promoted from lab/010, which measured the same things by hand first.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fileUrl = (name) => "file://" + path.join(ROOT, name);
const VIEWER = fileUrl("dist/viewer.html");
const EDITOR = fileUrl("dist/editor.html");
const SLUG = `vbar-${process.pid}`;
const FIX = `.test-tmp/${SLUG}`;
const ORIGIN = "http://127.0.0.1:8080";
const HEALTHY = `${ORIGIN}/dist/cdn`;
const STALE = `${ORIGIN}/${FIX}/stale/@v0.3.0/dist/cdn`;
const CATALOG = `${ORIGIN}/${FIX}/catalog/runtime.json`;
const SLIM = fs.readFileSync(path.join(ROOT, "dist/slim.html"), "utf8");
const PUBLISHED = /"cdnBase":"([^"]*)"/.exec(SLIM)[1];

const manifestOf = (html) => JSON.parse(/<script id="asset-manifest" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
const write = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, rel), body);
};

/** A *saving* viewer: mode and materialisation are independent, so this is what a
 *  viewer looks like after someone saved a slim document as read-only. */
function slimViewer() {
  return SLIM.split(PUBLISHED).join(STALE)
    .replace(/(<script id="doc-settings" type="application\/json">)([\s\S]*?)(<\/script>)/,
      (whole, open, json, close) => open + JSON.stringify({ ...JSON.parse(json), mode: "view", editable: false, toolbar: true }) + close)
    .replace(/(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/,
      (whole, open, json, close) => {
        const doc = JSON.parse(json);
        doc.catalog = CATALOG;
        /* One fetched hash wrong: the pin no longer resolves. */
        doc.assets.find((asset) => asset.id === "signals").integrity = "sha384-" + "A".repeat(64);
        return open + JSON.stringify(doc) + close;
      });
}

test.beforeAll(() => {
  /* The stale release serves the tree's bytes with one module moved, so `signals` fails
     verification and everything else still parses. */
  const cdn = path.join(ROOT, "dist/cdn");
  for (const name of fs.readdirSync(cdn)) {
    write(`${FIX}/stale/@v0.3.0/dist/cdn/${name}`, fs.readFileSync(path.join(cdn, name)));
  }
  fs.appendFileSync(path.join(ROOT, `${FIX}/stale/@v0.3.0/dist/cdn/signals.js`), "\n/* stale release */\n");

  /* The release a broken document may re-pin to: the healthy tree, described. */
  const release = {
    schema: 1,
    tag: "v0.4.1",
    base: HEALTHY,
    assets: manifestOf(SLIM).assets
      .filter((asset) => asset.role !== "infra")
      .map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        bytes: asset.bytes,
        sha384: asset.integrity,
        url: `${HEALTHY}/${asset.id}.${asset.kind === "css" ? "css" : asset.kind === "html" ? "html" : "js"}`,
        requiredBy: asset.requiredBy || ["*"],
      })),
  };
  write(`${FIX}/catalog/runtime/v0.4.1.json`, JSON.stringify(release, null, 2) + "\n");
  write(`${FIX}/catalog/runtime.json`, JSON.stringify({
    schema: 1,
    latest: "v0.4.1",
    releases: [{ tag: "v0.4.1", date: "2026-11-17", base: HEALTHY, assets: release.assets.length, manifest: "runtime/v0.4.1.json" }],
  }, null, 2) + "\n");
  write(`${FIX}/broken-viewer.html`, slimViewer());
});

test.afterAll(() => {
  fs.rmSync(path.join(ROOT, FIX), { recursive: true, force: true });
});

async function load(page, url) {
  const problems = [];
  page.on("console", (message) => { if (message.type() === "error") problems.push(message.text()); });
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    () => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state),
    null,
    { timeout: 20_000 },
  );
  return problems;
}

const bar = (page) => page.evaluate(() => {
  const el = document.getElementById("viewer-bar");
  const text = (selector) => el?.querySelector(selector)?.textContent?.trim() ?? null;
  return {
    visible: !!el?.offsetHeight,
    folio: text("[data-folio]"),
    title: text("[data-vb-title]"),
    save: text("[data-save]"),
    mode: document.documentElement.dataset.mode,
    editable: document.getElementById("content")?.getAttribute("contenteditable"),
    pages: StandaloneDoc.modules.pagination.pageCount(),
  };
});

test("a viewer carries a bar, and the folio is a real page number", async ({ page }) => {
  const problems = await load(page, VIEWER);
  const top = await bar(page);
  expect(top.visible).toBe(true);
  expect(top.mode).toBe("view");
  expect(top.editable).toBe("false");
  expect(top.title).toBe("Standalone HTML Doc");
  expect(top.save).toBe("Save a copy");
  expect(top.folio).toBe(`p. 1 / ${top.pages}`);

  /* The default document is one page; scroll it and the folio must follow. */
  if (top.pages > 1) {
    await page.evaluate(() => {
      const viewport = document.getElementById("viewport");
      viewport.scrollTop = viewport.scrollHeight;
    });
    await expect.poll(() => bar(page).then((state) => state.folio)).toBe(`p. ${top.pages} / ${top.pages}`);
  }
  expect(problems).toEqual([]);
});

test("the folio tracks the reader page by page", async ({ page }) => {
  /* A long document, so the numbers are worth reading. */
  const long = fs.readFileSync(path.join(ROOT, "dist/viewer.html"), "utf8").replace(
    /(<article id="content"[^>]*>)([\s\S]*?)(<\/article>)/,
    (whole, open, inner, close) => open + inner
      + Array.from({ length: 120 }, (_, i) => `<p>Paragraph ${i + 1} of a long document.</p>`).join("")
      + close,
  );
  write(`${FIX}/long.html`, long);
  await load(page, `${ORIGIN}/${FIX}/long.html`);

  const pages = (await bar(page)).pages;
  expect(pages).toBeGreaterThan(2);
  expect((await bar(page)).folio).toBe(`p. 1 / ${pages}`);

  await page.evaluate(() => {
    const viewport = document.getElementById("viewport");
    viewport.scrollTop = viewport.scrollHeight * 0.5;
  });
  await expect.poll(async () => {
    const text = (await bar(page)).folio ?? "";
    return Number(/p\. (\d+) \//.exec(text)?.[1] ?? 0);
  }).toBeGreaterThan(1);
  const middlePage = Number(/p\. (\d+) \//.exec((await bar(page)).folio)[1]);
  expect(middlePage).toBeLessThan(pages);

  await page.evaluate(() => {
    const viewport = document.getElementById("viewport");
    viewport.scrollTop = viewport.scrollHeight;
  });
  await expect.poll(() => bar(page).then((state) => state.folio)).toBe(`p. ${pages} / ${pages}`);
});

test("settings show what the document is, and zoom drives the real module", async ({ page }) => {
  await load(page, VIEWER);
  const panel = page.locator("[data-vb-panel]");
  await expect(panel).toBeHidden();

  await page.click("[data-vb-settings]");
  await expect(panel).toBeVisible();
  const opened = await page.evaluate(() => ({
    pin: document.querySelector("[data-vb-pin]").textContent,
    pages: document.querySelector("[data-vb-pages]").textContent,
    label: document.querySelector("[data-zoom-label]").textContent,
    expanded: document.querySelector("[data-vb-settings]").getAttribute("aria-expanded"),
  }));
  expect(opened.pin).toMatch(/^v\d+\.\d+\.\d+$/);
  expect(opened.pages).toBe(String((await bar(page)).pages));
  expect(opened.label).toBe("Zoom · 100%");
  expect(opened.expanded).toBe("true");

  await page.click('#viewer-bar [data-zoom="in"]');
  const zoomed = await page.evaluate(() => ({
    value: StandaloneDoc.modules.zoom.value,
    label: document.querySelector("[data-zoom-label]").textContent,
  }));
  expect(zoomed.value).toBeGreaterThan(1);
  expect(zoomed.label).not.toBe("Zoom · 100%");

  await page.click('#viewer-bar [data-zoom="reset"]');
  expect(await page.evaluate(() => StandaloneDoc.modules.zoom.value)).toBe(1);

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("save downloads a copy that reopens as the same viewer", async ({ page }) => {
  await load(page, VIEWER);
  const before = await bar(page);
  const target = path.join(ROOT, FIX, "saved.html");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20_000 }),
    page.click("#viewer-bar [data-save]"),
  ]);
  await download.saveAs(target);

  /* What travels: the document, not this session. */
  const text = fs.readFileSync(target, "utf8");
  expect(text).not.toContain('class="page-spacer"');
  expect(text).not.toContain('class="sheet"');
  expect(text.slice(0, text.indexOf(">") + 1)).not.toContain("data-boot-state");
  expect(text).toContain('id="viewer-bar"');

  const reopened = await page.context().newPage();
  const problems = await load(reopened, "file://" + target);
  const after = await bar(reopened);
  expect(after.visible).toBe(true);
  expect(after.mode).toBe("view");
  expect(after.editable).toBe("false");
  expect(after.folio).toBe(before.folio);
  const content = await reopened.evaluate(() => document.getElementById("content").textContent.replace(/\s+/g, " ").trim());
  expect(content.length).toBeGreaterThan(0);
  expect(problems).toEqual([]);
});

test("a broken viewer repairs itself and saves the repair", async ({ page }) => {
  await load(page, `${ORIGIN}/${FIX}/broken-viewer.html`);
  const broken = await page.evaluate(() => ({
    state: StandaloneDoc.state,
    errors: StandaloneDoc.errors.map((error) => `${error.kind} · ${error.id}`),
    base: JSON.parse(document.getElementById("asset-manifest").textContent).cdnBase,
  }));
  expect(broken.state).toBe("failed");
  expect(broken.errors).toEqual(["integrity · signals"]);

  const go = page.locator("[data-boot-update-go]");
  await expect(go).toBeVisible();
  await go.click();
  await expect.poll(() => page.evaluate(() => StandaloneDoc.state), { timeout: 20_000 }).toBe("ready");

  /* The card tells the truth because the bar's Save is a [data-save]: a repaired viewer
     can keep its repair, so "this session only" would be wrong. */
  const repaired = await page.evaluate(() => ({
    title: document.querySelector("[data-boot-title]").textContent,
    note: document.querySelector("[data-boot-update-text]").textContent,
    base: JSON.parse(document.getElementById("asset-manifest").textContent).cdnBase,
  }));
  expect(repaired.title).toBe("Updated to v0.4.1");
  expect(repaired.note).toMatch(/save the file/i);
  expect(repaired.base).toBe(HEALTHY);

  await page.click("[data-boot-continue]");
  const target = path.join(ROOT, FIX, "repaired.html");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20_000 }),
    page.click("#viewer-bar [data-save]"),
  ]);
  await download.saveAs(target);

  const reopened = await page.context().newPage();
  await load(reopened, "file://" + target);
  const saved = await bar(reopened);
  expect(saved.visible).toBe(true);
  expect(saved.mode).toBe("view");
  expect(await reopened.evaluate(() => JSON.parse(document.getElementById("asset-manifest").textContent).cdnBase)).toBe(HEALTHY);
});

test("a figure is not selectable in a viewer, and still is in the editor", async ({ page }) => {
  await load(page, VIEWER);
  const viewer = await page.evaluate(() => {
    const figure = document.createElement("figure");
    figure.className = "figure";
    figure.dataset.figureId = "spec";
    figure.dataset.kind = "image";
    document.getElementById("content").append(figure);
    figure.click();
    return figure.hasAttribute("data-selected");
  });
  expect(viewer).toBe(false);

  await load(page, EDITOR);
  const editor = await page.evaluate(() => {
    const figure = document.createElement("figure");
    figure.className = "figure";
    figure.dataset.figureId = "spec";
    figure.dataset.kind = "image";
    document.getElementById("content").append(figure);
    figure.click();
    return figure.hasAttribute("data-selected");
  });
  /* Editing owns selection: #figure-tools is edit-only, and this is where it lives. */
  expect(editor).toBe(true);
});
