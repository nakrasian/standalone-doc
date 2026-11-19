import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* The print gate, in every engine.
 *
 * The live editor prints itself: `[data-frag]` and `[data-page-start]` are block boxes and
 * the print stylesheet turns them into page breaks. This spec asserts the computed print
 * media rules rather than generating a PDF — `page.pdf()` is implemented only for headless
 * Chromium in Playwright, so the PDF half lives in `pagination-print-pdf.spec.js`, which the
 * WebKit and Firefox projects exclude in `playwright.config.mjs`.
 *
 * The rules are the browser's print rules either way: the same stylesheet the print dialog
 * uses. What differs is only who drives the paginator.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fileUrl = (name = "index.html") => "file://" + path.join(ROOT, name);
const LONG = "A sentence with enough words to take a line, and then another line after it. ".repeat(90);

async function boot(page) {
  await page.goto(fileUrl());
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, {timeout: 15_000});
}

async function load(page, {fragment = true} = {}) {
  await boot(page);
  return page.evaluate(({LONG, fragment}) => {
    const content = document.getElementById("content");
    const make = (tag, text) => {
      const el = document.createElement(tag);
      el.textContent = text;
      return el;
    };
    content.replaceChildren(
      make("p", "A lead paragraph."),
      make("p", LONG),
      make("p", LONG),
      make("p", "A closing paragraph."),
    );
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.setFragmenting(fragment);
    pag.refresh();
    const d = pag.diagnostics();
    return {pages: d.pages, fragments: d.fragments, splits: d.splits.length};
  }, {LONG, fragment});
}

test("the live document's print stylesheet breaks at fragments", async ({page}) => {
  await load(page);
  await page.emulateMedia({media: "print"});
  const styles = await page.evaluate(() => {
    const frag = document.querySelector("[data-frag]");
    return frag ? {
      display: getComputedStyle(frag).display,
      breakBefore: getComputedStyle(frag).breakBefore,
      marginStart: getComputedStyle(frag).marginBlockStart,
      sheets: getComputedStyle(document.getElementById("sheets")).display,
    } : null;
  });
  expect(styles, "the fixture must be fragmented").not.toBeNull();
  expect(styles.display, JSON.stringify(styles)).toBe("block");
  expect(styles.breakBefore).toBe("page");
  expect(styles.marginStart).toBe("0px");
  expect(styles.sheets).toBe("none");
});

test("a page-start block prints as a break, with its gap reset", async ({page}) => {
  await load(page, {fragment: false});
  await page.emulateMedia({media: "print"});
  const start = await page.evaluate(() => {
    const el = document.querySelector("[data-page-start]");
    return el ? {
      breakBefore: getComputedStyle(el).breakBefore,
      marginStart: getComputedStyle(el).marginBlockStart,
    } : null;
  });
  expect(start, "the whole-block plan must have a page start").not.toBeNull();
  expect(start.breakBefore).toBe("page");
  expect(start.marginStart).toBe("0px");
});
