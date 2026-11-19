import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* The visual gate. Off unless VISUAL=1 (the config's testIgnore removes the file from the
 * ordinary run), because a page screenshot is a platform-specific artifact: the bundled
 * font stack resolves to Charter on macOS and to a metric-compatible substitute on the
 * Linux runner, so macOS baselines cannot be compared on Ubuntu.
 *
 * The baselines are therefore generated *in Linux CI* and kept in the Actions cache, keyed
 * by engine and by the stylesheets the picture depends on. A cache miss generates the
 * current picture and passes; the next run compares against it. That is a weaker gate than
 * a committed baseline, but it is a real one, and it is the only shape that does not put
 * one platform's font rasterisation in another platform's CI.
 *
 * The fixture is fixed: same blocks, same viewport, default zoom, fonts settled. The
 * picture asserts the thing the numbers cannot — that a page boundary looks like a page
 * boundary: no text in the gap, the tail starting at the sheet's content top, the folio in
 * place.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const LONG = "The phrase this comment is about sits here, in the middle of a paragraph that keeps "
  + "going, because a page break has to fall somewhere and the interesting case is the one that "
  + "splits a reader's attention rather than a block. ";

const FIXTURE = [
  {tag: "p", text: "A lead paragraph, so the first page has a top margin and a folio."},
  {tag: "p", text: LONG.repeat(40)},
  {tag: "p", text: "A closing paragraph."},
];

test("the fragmented page and its seam", async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto("file://" + path.join(ROOT, "index.html"));
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, {timeout: 15_000});
  await page.evaluate((blocks) => {
    const content = document.getElementById("content");
    content.replaceChildren(...blocks.map((block) => {
      const el = document.createElement(block.tag);
      el.textContent = block.text;
      return el;
    }));
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.setFragmenting(false);
    pag.refresh();
    pag.setFragmenting(true);
    pag.refresh();
    document.getElementById("viewport").scrollTop = 0;
  }, FIXTURE);
  /* Fonts settle after a pass; a screenshot taken before that is a different picture. */
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);

  const viewport = page.locator("#viewport");
  await expect(viewport).toHaveScreenshot("page-1-seam.png", {animations: "disabled"});

  /* The tail, on the page it was moved to: the fragment's first line is the content top. */
  await page.evaluate(() => {
    const target = document.querySelectorAll("#sheets > .sheet")[1];
    document.getElementById("viewport").scrollTop = Math.max(0, parseFloat(target.style.top) - 40);
  });
  await page.waitForTimeout(100);
  await expect(viewport).toHaveScreenshot("page-2-tail.png", {animations: "disabled"});
});
