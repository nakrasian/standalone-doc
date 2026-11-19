import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* Pagination's gap, asserted as relationships between numbers.
 *
 * The page gap is a `margin-block-start` on the first block of a page, not a node:
 *   - no `.page-spacer` is inserted;
 *   - a selection across a page break has no rect inside the gap (the lab measured
 *     948 px of false selection when the gap was a spacer).
 *
 * Block splitting is deliberately absent: it lives on the fragments branch until the
 * caret and history deltas land, so a document always paginates the same way.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fileUrl = (name = "index.html") => "file://" + path.join(ROOT, name);

const FIXTURE = [
  {tag: "p", text: "First paragraph. It exists so the page has a top margin, a folio, and a block before anything interesting happens."},
  {tag: "p", text: "Second paragraph, one line of throat-clearing before the heading."},
  {tag: "h2", text: "A heading, which is a block like any other"},
  {tag: "p", text: ("The phrase this comment is about sits here, in the middle of a paragraph that keeps "
    + "going, because a page break has to fall somewhere and the interesting case is the one that "
    + "splits a reader's attention rather than a block. ").repeat(20)},
  {tag: "p", text: "Fourth paragraph, short."},
  {tag: "p", text: "Fifth paragraph, also short, and it sits near a page boundary on purpose."},
  {tag: "h3", text: "Another heading"},
  {tag: "p", text: "Sixth paragraph with a little more text so the following list does not start at a page top."},
  {tag: "p", text: "Seventh paragraph: the reader is now somewhere in the middle of the document."},
  {tag: "p", text: "Eighth paragraph, closing note, short."},
];

async function boot(page) {
  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  await page.goto(fileUrl());
  await page.waitForFunction(
    () => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state),
    null,
    {timeout: 15_000},
  );
  expect(await page.evaluate(() => globalThis.StandaloneDoc.state), problems.join(" | ")).toBe("ready");
  return problems;
}

/** Replace the document with `blocks`, run one pass, and return the state to assert on. */
async function loadDoc(page, blocks) {
  return page.evaluate(({blocks}) => {
    const content = document.getElementById("content");
    const pagination = globalThis.StandaloneDoc.modules.pagination;
    const make = (block) => {
      const el = document.createElement(block.tag);
      if (block.html != null) el.innerHTML = block.html;
      else el.textContent = block.text;
      return el;
    };
    content.replaceChildren(...blocks.map(make));
    const authored = content.textContent;
    pagination.refresh();
    const d = pagination.diagnostics();
    return {
      text: content.textContent,
      authored,
      pages: d.pages,
      gaps: d.gaps,
      pageTops: d.pageTops,
      pageBottoms: d.pageBottoms,
      sheets: document.querySelectorAll("#sheets .sheet").length,
      spacers: content.querySelectorAll(".page-spacer").length,
      starts: [...content.querySelectorAll("[data-page-start]")].map((el) => ({
        margin: parseFloat(el.style.marginBlockStart || "0"),
        computed: parseFloat(getComputedStyle(el).marginBlockStart),
      })),
      paragraphs: content.querySelectorAll(":scope > p").length,
      html: content.innerHTML,
      docPages: content.querySelectorAll(":scope > *").length,
    };
  }, {blocks});
}

test("the page gap is a margin on the block, not a spacer node", async ({page}) => {
  await boot(page);
  const state = await loadDoc(page, FIXTURE);

  expect(state.pages, "the fixture must paginate").toBeGreaterThan(1);
  expect(state.spacers, "no .page-spacer may be inserted").toBe(0);
  expect(state.starts.length, `every gap starts with a block (${state.pages} pages, ${state.gaps} gaps)`).toBe(state.gaps);
  expect(state.starts.length).toBeGreaterThan(0);
  for (const start of state.starts) {
    expect(start.computed, `a page-start block with margin ${JSON.stringify(start)}`).toBeGreaterThan(0);
  }
  /* The document itself did not grow a block. */
  expect(state.docPages).toBe(FIXTURE.length);
  expect(state.text).toBe(state.authored);
});

test("a selection across a page break has no rect inside the page gap", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE);

  const result = await page.evaluate(() => {
    const content = document.getElementById("content");
    const layout = globalThis.StandaloneDoc.modules.layout;
    const diagnostics = globalThis.StandaloneDoc.modules.pagination.diagnostics();
    const next = content.querySelector("[data-page-start]");
    const previous = next && next.previousElementSibling;
    if (!previous) return {error: "no block before the first page start"};
    const range = document.createRange();
    range.setStart(previous.firstChild, Math.max(0, previous.textContent.length - 4));
    range.setEnd(next.firstChild, Math.min(4, next.textContent.length));
    const rects = [...range.getClientRects()];
    const origin = layout.origin();
    const gapTop = origin.top + diagnostics.pageBottoms[0] * origin.scale;
    const gapBottom = origin.top + diagnostics.pageTops[1] * origin.scale;
    const inside = rects.reduce((sum, rect) => sum
      + Math.max(0, Math.min(rect.bottom, gapBottom) - Math.max(rect.top, gapTop)), 0);
    return {
      gap: Math.round(gapBottom - gapTop),
      heights: rects.map((rect) => Math.round(rect.height)),
      inside: Math.round(inside),
      pageTops: diagnostics.pageTops.map((top) => Math.round(top)),
      pageBottoms: diagnostics.pageBottoms.map((bottom) => Math.round(bottom)),
    };
  });

  expect(result.error, JSON.stringify(result)).toBeUndefined();
  expect(result.gap, `the page gap must be real: ${JSON.stringify(result)}`).toBeGreaterThan(20);
  expect(result.inside, `a selection rect covers the page gap: ${JSON.stringify(result)}`).toBeLessThanOrEqual(1);
  /* The margin is not a node, so the browser reports one rect per block, not a page-tall
     rect in between (the lab's 948 px phantom). */
  expect(Math.max(...result.heights), JSON.stringify(result)).toBeLessThan(result.gap);
});

test("a pass that changes nothing changes nothing", async ({page}) => {
  await boot(page);
  const first = await loadDoc(page, FIXTURE);
  const second = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pagination = globalThis.StandaloneDoc.modules.pagination;
    const before = {pages: pagination.pageCount(), html: content.innerHTML};
    pagination.refresh();
    const after = {pages: pagination.pageCount(), html: content.innerHTML};
    return {before, after};
  });
  expect(second.after.html, "a no-op pass rewrote the flow").toBe(second.before.html);
  expect(second.after.pages).toBe(second.before.pages);
  expect(first.spacers).toBe(0);
});

test("a save carries the document, not the pagination", async ({page}) => {
  await boot(page);
  const state = await loadDoc(page, FIXTURE);
  const saved = await page.evaluate(async () => {
    const result = await globalThis.StandaloneDoc.modules.toolbar.serialize();
    const doc = new DOMParser().parseFromString(result.html, "text/html");
    return {
      starts: doc.querySelectorAll("[data-page-start]").length,
      spacers: doc.querySelectorAll(".page-spacer").length,
      margins: [...doc.querySelectorAll("[style]")]
        .filter((node) => /margin-block-start/i.test(node.getAttribute("style") || "")).length,
      paragraphs: doc.querySelectorAll("#content > p").length,
      text: doc.querySelector("#content").textContent.length,
    };
  });
  expect(saved.starts, "a page-start attribute leaked into the saved file").toBe(0);
  expect(saved.spacers, "a page spacer leaked into the saved file").toBe(0);
  expect(saved.margins, "a page margin leaked into the saved file").toBe(0);
  expect(saved.paragraphs).toBe(FIXTURE.filter((block) => block.tag === "p").length);
  expect(saved.text).toBe(state.text.length);
});
