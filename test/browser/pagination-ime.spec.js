import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* A real input-method composition, driven through Chromium's CDP.
 *
 * A synthetic CompositionEvent proves the guard; it does not prove that the browser's
 * uncommitted composition string — which lives in the DOM and owns the caret — survives a
 * pagination pass. `Input.imeSetComposition` creates that state and `Input.insertText`
 * commits it. Chromium-only because the CDP domain is; the synthetic composition test in
 * pagination.spec.js runs in all three engines.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LONG = ("The phrase this comment is about sits here, in the middle of a paragraph that keeps "
  + "going, because a page break has to fall somewhere and the interesting case is the one that "
  + "splits a reader's attention rather than a block. ").repeat(50);

test("a real IME composition at the seam commits and re-paginates", async ({page, context}) => {
  await page.goto("file://" + path.join(ROOT, "index.html"));
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, {timeout: 15_000});

  const before = await page.evaluate((LONG) => {
    const content = document.getElementById("content");
    const make = (tag, text) => {
      const el = document.createElement(tag);
      el.textContent = text;
      return el;
    };
    content.replaceChildren(make("p", "A lead paragraph."), make("p", LONG), make("p", "A closing paragraph."));
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.setFragmenting(true);
    pag.refresh();
    const cut = pag.diagnostics().splits[0].offset;
    const block = content.querySelector("[data-frag]").parentElement;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let remaining = cut + 1;
    let node = walker.nextNode();
    while (node && remaining > node.nodeValue.length) {
      remaining -= node.nodeValue.length;
      node = walker.nextNode();
    }
    const range = document.createRange();
    range.setStart(node, remaining);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    content.focus();
    return {text: content.textContent.length, cut};
  }, LONG);

  const client = await context.newCDPSession(page);
  await client.send("Input.imeSetComposition", {text: "に", selectionStart: 1, selectionEnd: 1});
  await page.waitForTimeout(180);
  const during = await page.evaluate(() => ({
    composing: globalThis.StandaloneDoc.modules.signals.composing,
    text: document.getElementById("content").textContent.length,
    cut: globalThis.StandaloneDoc.modules.pagination.diagnostics().splits[0]?.offset ?? null,
  }));
  expect(during.composing, "the IME composition did not reach the guard").toBe(true);
  expect(during.text, "the composition string was not inserted").toBe(before.text + 1);

  await client.send("Input.insertText", {text: "に"});
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    return {
      text: content.textContent.length,
      composing: globalThis.StandaloneDoc.modules.signals.composing,
      fragments: pag.diagnostics().fragments,
      check: pag.diagnostics().check,
      kept: pag.diagnostics().selectionKept,
    };
  });
  expect(after.composing, "the composition did not end").toBe(false);
  expect(after.text).toBe(before.text + 1);
  expect(after.fragments, "the paragraph lost its fragments").toBeGreaterThan(0);
  expect(after.check.ok, JSON.stringify(after.check?.failures)).toBe(true);
});
