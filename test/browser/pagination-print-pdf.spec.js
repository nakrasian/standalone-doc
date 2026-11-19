import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* The PDF half of the print gate.
 *
 * `page.pdf()` is Chromium-only in Playwright (a Firefox or WebKit call fails with "PDF
 * generation is only supported for Headless Chromium"), so this file is excluded from those
 * projects in `playwright.config.mjs` rather than skipped at test time. The print rules
 * themselves are asserted in every engine by `pagination-print.spec.js`.
 *
 * Two things are pinned here:
 *   - a block marker starts a new printed page and an inline one does not (measured: the
 *     inline form is ignored, which is why `buildStatic` emits `display:block`);
 *   - the real `buildStatic()` output prints, its page count agreeing with the plan.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const fileUrl = (name = "index.html") => "file://" + path.join(ROOT, name);
const LONG = "A sentence with enough words to take a line, and then another line after it. ".repeat(90);
const pageCount = (pdf) => (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;

async function load(page) {
  await page.goto(fileUrl());
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, {timeout: 15_000});
  return page.evaluate((LONG) => {
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
    pag.setFragmenting(true);
    pag.refresh();
    const d = pag.diagnostics();
    return {pages: d.pages, fragments: d.fragments, splits: d.splits.length};
  }, LONG);
}

test("a block marker forces a page break where its inline form does not", async ({page}) => {
  const rule = `@page{size:8.5in 11in;margin:0.9in} body{margin:0;font:11pt/1.5 Georgia} p{margin:0}`;
  const body = `<div id="content"><p>one</p><p>two<span class="page-break-inline"></span>three</p></div>`;
  const block = `${rule} .page-break-inline{display:block;height:0;margin:0;line-height:0;break-before:page}`;
  const inline = `${rule} .page-break-inline{display:inline;break-before:page}`;

  await page.setContent(`<!doctype html><style>${block}</style>${body}`);
  const blockPdf = pageCount(await page.pdf({preferCSSPageSize: true}));
  await page.setContent(`<!doctype html><style>${inline}</style>${body}`);
  const inlinePdf = pageCount(await page.pdf({preferCSSPageSize: true}));

  expect(blockPdf, "a block marker must start a new printed page").toBe(2);
  expect(inlinePdf, "an inline break-before is ignored; the test would not bite if it were 2").toBe(1);
});

test("the exported static document prints the cuts", async ({page}) => {
  const state = await load(page);
  expect(state.fragments).toBeGreaterThan(0);
  const built = await page.evaluate(() => {
    const html = globalThis.StandaloneDoc.modules.export.buildStatic([], {media: "data-uri"});
    /* Parse, never text-search: the static file carries the inline source of every
       stylesheet, and those rules mention `[data-frag]` even when no element has one. */
    const doc = new DOMParser().parseFromString(html, "text/html");
    return {
      html,
      fragments: doc.querySelectorAll("[data-frag]").length,
      markers: doc.querySelectorAll(".page-break-inline").length,
    };
  });
  expect(built.fragments, "a fragment leaked into the static document").toBe(0);
  expect(built.markers, "one inline marker per cut").toBe(state.fragments);

  fs.mkdirSync(TMP, {recursive: true});
  const file = path.join(TMP, `pagination-print-${process.pid}.html`);
  fs.writeFileSync(file, built.html);
  await page.goto("file://" + file);
  await page.emulateMedia({media: "print"});
  const computed = await page.evaluate(() => {
    const marker = document.querySelector(".page-break-inline");
    return marker ? {
      display: getComputedStyle(marker).display,
      breakBefore: getComputedStyle(marker).breakBefore,
      height: getComputedStyle(marker).height,
    } : null;
  });
  expect(computed, "the static document has no page-break marker").not.toBeNull();
  expect(computed.display).toBe("block");
  expect(computed.breakBefore).toBe("page");
  expect(computed.height).toBe("0px");

  const pdf = pageCount(await page.pdf({preferCSSPageSize: true}));
  expect(pdf, `the PDF has ${pdf} pages, the plan ${state.pages}`).toBeGreaterThanOrEqual(state.pages);
  expect(Math.abs(pdf - state.pages), `pdf ${pdf}, plan ${state.pages}`).toBeLessThanOrEqual(1);
});
