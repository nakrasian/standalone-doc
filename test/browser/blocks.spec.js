import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* An asset block is found *by its id* — `script[id="<assetId>"]` in the loader, the
 * `<!-- @asset -->` markers in the build — and a markup asset may give its own root the
 * same id. `viewer-bar` did: the `<header>` and the compiled `<script>` shared it, so
 * `#viewer-bar { display: flex }` matched the script too, outranked the UA sheet, and
 * painted the whole module's source below the toolbar — in `index.html`, in every viewer
 * file, and in every copy either one saved.
 *
 * Two rules keep that from coming back, and this spec is the one place that asserts both:
 *   - `page-styles.css` says `script, style { display: none !important }`, so no sheet can
 *     make source text of a block;
 *   - `viewer-bar-styles.css` qualifies its selectors `header#viewer-bar`, so its own
 *     `display: flex` never lands on the block to begin with.
 *
 * The second assertion of every case (the bar still paints at 34px) is what stops the fix
 * from being "hide the chrome".
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fileUrl = (name) => "file://" + path.join(ROOT, name);
const FIX = `.test-tmp/blocks-${process.pid}`;

async function load(page, url) {
  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    () => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state),
    null,
    { timeout: 15_000 },
  );
  return problems;
}

/** Every block, the box it paints, and what the reader can actually read. */
const audit = (page) =>
  page.evaluate(() => {
    const blocks = [...document.querySelectorAll("script[id], style[id]")];
    const text = document.body.innerText;
    const bar = document.getElementById("viewer-bar");
    return {
      blocks: blocks.length,
      painted: blocks
        .filter((block) => getComputedStyle(block).display !== "none")
        .map((block) => `${block.tagName.toLowerCase()}#${block.id} · ${getComputedStyle(block).display}`),
      /* The provenance header is line 1 of every compiled block; `export function` is the
         body. Either one being readable means a block is on the page as text. */
      leaks: [
        text.includes("@compiled-from") && "a compiled-from header",
        text.includes("export function") && "module source",
        text.includes("StandaloneDoc.register(") && "a registration line",
      ].filter(Boolean),
      barDisplay: bar ? getComputedStyle(bar).display : null,
      barHeight: bar ? Math.round(bar.getBoundingClientRect().height) : null,
    };
  });

test("no block in the source document paints its own text", async ({ page }) => {
  const problems = await load(page, fileUrl("index.html"));
  const found = await audit(page);
  expect(problems).toEqual([]);
  expect(found.blocks).toBeGreaterThan(15);
  expect(found.painted).toEqual([]);
  expect(found.leaks).toEqual([]);
});

test("a viewer paints its bar and none of its blocks", async ({ page }) => {
  const problems = await load(page, fileUrl("dist/viewer.html"));
  const found = await audit(page);
  expect(problems).toEqual([]);
  expect(found.painted).toEqual([]);
  expect(found.leaks).toEqual([]);
  /* The bar is a `<header>`: `header#viewer-bar` is what the sheet targets now. */
  expect(found.barDisplay).toBe("flex");
  expect(found.barHeight).toBe(34);
});

test("a saved copy carries the block but not its text", async ({ page }) => {
  await load(page, fileUrl("dist/viewer.html"));
  const target = path.join(ROOT, FIX, "saved.html");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20_000 }),
    page.click("#viewer-bar [data-save]"),
  ]);
  await download.saveAs(target);

  const reopened = await page.context().newPage();
  const problems = await load(reopened, "file://" + target);
  const found = await audit(reopened);
  expect(problems).toEqual([]);
  /* Both halves of the collision travelled: the block is still there, unwritten as text. */
  expect(found.blocks).toBeGreaterThan(5);
  expect(found.painted).toEqual([]);
  expect(found.leaks).toEqual([]);
  expect(found.barDisplay).toBe("flex");
  await reopened.close();
});

test("an id shared by a block and a markup root cannot paint source", async ({ page }) => {
  /* The regression itself, reproduced deliberately: give a block the id a stylesheet
     styles as page furniture. The invariant must hold even when the qualifier is gone. */
  await load(page, fileUrl("index.html"));
  const found = await page.evaluate(() => {
    const block = document.getElementById("figures");
    block.setAttribute("id", "app-toolbar");
    /* Stand in for `#app-toolbar { display: flex }` landing on the block. */
    const sheet = document.createElement("style");
    sheet.textContent = "#app-toolbar { display: flex; height: 34px; }";
    document.head.append(sheet);
    const out = {
      display: getComputedStyle(block).display,
      leaks: document.body.innerText.includes("export function"),
      realBar: getComputedStyle(document.querySelector("header#app-toolbar")).display,
    };
    block.setAttribute("id", "figures");
    sheet.remove();
    return out;
  });
  expect(found.display).toBe("none");
  expect(found.leaks).toBe(false);
  /* And the qualifier is why the real toolbar is untouched by this: it is a header. */
  expect(found.realBar).toBe("flex");
});
