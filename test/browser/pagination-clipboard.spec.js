import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* Copy and cut across a page cut, with the real clipboard.
 *
 * The browser serialises a `display:block` fragment as a paragraph break in text/plain and
 * as a `data-frag` element carrying the page push in text/html. Copying across a cut used
 * to paste back a line break and a 216 px gap the reader never saw. The editor now owns the
 * payload when a selection crosses a seam, so these are asserted against the clipboard
 * itself rather than the DOM.
 *
 * Chromium only: Playwright grants clipboard permissions to a page context, and the other
 * two engines need platform clipboard plumbing that headless CI does not have. The spec is
 * excluded from their projects in playwright.config.mjs, like the PDF and IME specs.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const served = "http://127.0.0.1:8080/index.html";
const modifier = process.platform === "darwin" ? "Meta" : "Control";

const LONG = "The phrase this comment is about sits here, in the middle of a paragraph that keeps "
  + "going, because a page break has to fall somewhere and the interesting case is the one that "
  + "splits a reader's attention rather than a block. ";

test.use({permissions: ["clipboard-read", "clipboard-write"]});

async function boot(page) {
  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  await page.goto(served);
  await page.waitForFunction(
    () => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state),
    null,
    {timeout: 15_000},
  );
  expect(await page.evaluate(() => globalThis.StandaloneDoc.state), problems.join(" | ")).toBe("ready");
}

/** A fragmented paragraph with unique tokens, so a diff names the exact character. */
async function load(page) {
  return page.evaluate((LONG) => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const tokens = Array.from({length: 2200}, (_, i) => `w${String(i).padStart(4, "0")}`).join(" ");
    const make = (tag, text) => {
      const el = document.createElement(tag);
      el.textContent = text;
      return el;
    };
    content.replaceChildren(make("p", "Lead."), make("p", tokens), make("p", "Tail block."));
    pag.setFragmenting(false);
    pag.refresh();
    pag.setFragmenting(true);
    pag.refresh();
    return {cut: pag.diagnostics().splits[0].offset, text: content.children[1].textContent, pages: pag.pageCount()};
  }, LONG);
}

async function selectAcrossCut(page, before, after) {
  return page.evaluate(({before, after}) => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const block = content.querySelector("[data-frag]").parentElement;
    const cut = pag.diagnostics().splits[0].offset;
    const point = (at) => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let remaining = at;
      let node = walker.nextNode();
      while (node && remaining > node.nodeValue.length) { remaining -= node.nodeValue.length; node = walker.nextNode(); }
      return {node, offset: remaining};
    };
    const a = point(cut - before);
    const b = point(cut + after);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    content.focus();
    return {cut, selected: range.toString()};
  }, {before, after});
}

async function placeCaret(page, at) {
  return page.evaluate((at) => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const block = content.querySelector("[data-frag]").parentElement;
    const cut = pag.diagnostics().splits[0].offset;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let remaining = cut + at;
    let node = walker.nextNode();
    while (node && remaining > node.nodeValue.length) { remaining -= node.nodeValue.length; node = walker.nextNode(); }
    const range = document.createRange();
    range.setStart(node, remaining);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    content.focus();
    return {cut, at: cut + at};
  }, at);
}

async function clipboard(page) {
  return page.evaluate(async () => {
    const out = {};
    for (const item of await navigator.clipboard.read()) {
      for (const type of item.types) out[type] = await (await item.getType(type)).text();
    }
    return out;
  });
}

test("copying across a cut carries no page furniture", async ({page}) => {
  await boot(page);
  const doc = await load(page);
  const selection = await selectAcrossCut(page, 20, 20);
  expect(selection.cut).toBeLessThan(doc.cut + 1000);
  await page.keyboard.press(`${modifier}+C`);

  const data = await clipboard(page);
  expect(data["text/plain"]).toBe(selection.selected);
  expect(data["text/plain"]).not.toContain("\n");
  expect(data["text/html"]).toBeTruthy();
  expect(data["text/html"], "the page push travelled with the copy").not.toContain("data-frag");
  expect(data["text/html"], "the page gap travelled with the copy").not.toContain("margin-block-start");
  expect(data["text/html"], "a page-start marker travelled with the copy").not.toContain("data-page-start");
});

test("pasting across a cut inserts characters, not a paragraph break", async ({page}) => {
  await boot(page);
  const doc = await load(page);
  const selection = await selectAcrossCut(page, 20, 20);
  await page.keyboard.press(`${modifier}+C`);
  const at = await placeCaret(page, 200);
  await page.keyboard.press(`${modifier}+V`);

  const after = await page.evaluate(() => {
    const content = document.getElementById("content");
    const block = content.children[1];
    const pag = globalThis.StandaloneDoc.modules.pagination;
    return {
      text: block.textContent,
      fragments: pag.diagnostics().fragments,
      pages: pag.pageCount(),
      check: pag.diagnostics().check,
    };
  });
  const expected = doc.text.slice(0, at.at) + selection.selected + doc.text.slice(at.at);
  expect(after.text, "the paste did not land as one continuous paragraph").toBe(expected);
  expect(after.fragments, "the paragraph lost its fragments").toBeGreaterThan(0);
  expect(after.pages).toBe(doc.pages);
  expect(after.check.ok, JSON.stringify(after.check?.failures)).toBe(true);
});

test("cutting across a cut removes exactly the selection", async ({page}) => {
  await boot(page);
  const doc = await load(page);
  const selection = await selectAcrossCut(page, 20, 20);
  await page.keyboard.press(`${modifier}+X`);

  const after = await page.evaluate(() => {
    const content = document.getElementById("content");
    const block = content.children[1];
    const pag = globalThis.StandaloneDoc.modules.pagination;
    return {
      text: block.textContent,
      total: content.textContent.length,
      fragments: pag.diagnostics().fragments,
      check: pag.diagnostics().check,
      caret: globalThis.StandaloneDoc.modules.selection.capture(content),
    };
  });
  const expected = doc.text.slice(0, selection.cut - 20) + doc.text.slice(selection.cut + 20);
  expect(after.text, "the cut removed the wrong characters").toBe(expected);
  expect(after.total).toBe(doc.text.length + "Lead.".length + "Tail block.".length - selection.selected.length);
  expect(after.fragments).toBeGreaterThan(0);
  expect(after.check.ok, JSON.stringify(after.check?.failures)).toBe(true);
  expect(after.caret, "the cut lost the caret").not.toBeNull();
  expect(after.caret.start.offset, "the caret is not where the cut started").toBe(selection.cut - 20);
  const data = await clipboard(page);
  expect(data["text/plain"]).toBe(selection.selected);
});
