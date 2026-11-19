import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* Fault fixtures: the shapes the lab listed but the first suite did not cover. Each one
 * asserts the same relationships — text conserved, the tail on the page top it names —
 * instead of a screenshot, so a failure carries the numbers. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fileUrl = (name = "index.html") => "file://" + path.join(ROOT, name);
const LONG = "A sentence with enough words to take a line, and then another line after it. ".repeat(90);

async function load(page, blocks, {fragment = true} = {}) {
  await page.goto(fileUrl());
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, {timeout: 15_000});
  return page.evaluate(({blocks, fragment}) => {
    const content = document.getElementById("content");
    content.replaceChildren(...blocks.map((block) => {
      const el = document.createElement(block.tag);
      if (block.html != null) el.innerHTML = block.html;
      else el.textContent = block.text;
      return el;
    }));
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.setFragmenting(false);
    pag.refresh();
    pag.setFragmenting(fragment);
    pag.refresh();
    const d = pag.diagnostics();
    return {
      authored: content.textContent,
      text: content.textContent,
      pages: d.pages,
      fragments: d.fragments,
      splits: d.splits,
      check: d.check,
    };
  }, {blocks, fragment});
}

function expectTailOnPage(state) {
  expect(state.check.ok, JSON.stringify(state.check?.failures)).toBe(true);
  expect(state.text).toBe(state.authored);
  for (const split of state.splits) {
    expect(
      Math.abs(split.fragTopAfter - split.targetTop),
      `cut at ${split.offset}: tail ${split.fragTopAfter}, target ${split.targetTop}`,
    ).toBeLessThanOrEqual(2);
  }
}

test("RTL prose fragments without losing a character", async ({page}) => {
  const rtl = "זהו משפט ארוך בעברית שממשיך וממשיך, כי שבירת עמוד חייבת ליפול איפשהו בתוך פסקה. ".repeat(110);
  const state = await load(page, [
    {tag: "p", text: "Opening paragraph."},
    {tag: "p", text: rtl},
    {tag: "p", text: "Closing paragraph."},
  ]);
  expect(state.fragments).toBeGreaterThan(0);
  expectTailOnPage(state);
});

test("a paragraph with explicit line breaks fragments around them", async ({page}) => {
  const state = await load(page, [
    {tag: "p", text: "Leading."},
    {tag: "p", html: `${LONG.replace(/ /g, " ")}<br><br>${LONG}`},
    {tag: "p", text: "Closing."},
  ]);
  expect(state.fragments).toBeGreaterThan(0);
  expectTailOnPage(state);
});

test("a paragraph with an inline image is atomic", async ({page}) => {
  const pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
  const state = await load(page, [
    {tag: "p", text: "Leading."},
    {tag: "p", html: `<img src="${pixel}" width="12" height="12" alt=""> ${LONG}`},
    {tag: "p", text: "Closing."},
  ]);
  const info = await page.evaluate(() => ({
    kind: globalThis.StandaloneDoc.modules.pagination.strategy(document.querySelector("#content > p:nth-child(2)")).kind,
    fragments: document.querySelector("#content > p:nth-child(2)").querySelectorAll("[data-frag]").length,
  }));
  expect(info.kind).toBe("atomic");
  expect(info.fragments, "an inline replaced element makes the paragraph atomic").toBe(0);
  expect(state.text).toBe(state.authored);
});

test("fractional zoom stops keep the tail on its page top", async ({page}) => {
  await load(page, [
    {tag: "p", text: LONG},
    {tag: "p", text: LONG},
    {tag: "p", text: "Closing."},
  ]);
  for (const zoom of [0.67, 0.9, 1.25, 1.75]) {
    const state = await page.evaluate((zoom) => {
      const zoomMod = globalThis.StandaloneDoc.modules.zoom;
      const pag = globalThis.StandaloneDoc.modules.pagination;
      zoomMod.set(zoom);
      pag.refresh();
      const d = pag.diagnostics();
      return {zoom: zoomMod.value, splits: d.splits, check: d.check, text: document.getElementById("content").textContent};
    }, zoom);
    expect(state.zoom).toBe(zoom);
    expect(state.check.ok, `zoom ${zoom}: ${JSON.stringify(state.check?.failures)}`).toBe(true);
    for (const split of state.splits) {
      expect(Math.abs(split.fragTopAfter - split.targetTop), `zoom ${zoom}: ${split.fragTopAfter} vs ${split.targetTop}`).toBeLessThanOrEqual(2);
    }
  }
});

test("a font change re-plans with the tail still on the page top", async ({page}) => {
  await load(page, [
    {tag: "p", text: LONG},
    {tag: "p", text: LONG},
    {tag: "p", text: "Closing."},
  ]);
  const state = await page.evaluate(() => {
    const pag = globalThis.StandaloneDoc.modules.pagination;
    document.getElementById("user-theme").textContent = ":root{--doc-size:15pt}";
    pag.refresh();
    const d = pag.diagnostics();
    return {splits: d.splits, check: d.check, text: document.getElementById("content").textContent};
  });
  expect(state.check.ok, JSON.stringify(state.check?.failures)).toBe(true);
  for (const split of state.splits) {
    expect(Math.abs(split.fragTopAfter - split.targetTop), `${split.fragTopAfter} vs ${split.targetTop}`).toBeLessThanOrEqual(2);
  }
});

test("a viewport resize keeps the fragments consistent", async ({page}) => {
  const state = await load(page, [
    {tag: "p", text: LONG},
    {tag: "p", text: LONG},
    {tag: "p", text: "Closing."},
  ]);
  await page.setViewportSize({width: 1000, height: 700});
  const after = await page.evaluate(() => {
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.refresh();
    const d = pag.diagnostics();
    return {pages: d.pages, fragments: d.fragments, splits: d.splits, check: d.check, text: document.getElementById("content").textContent};
  });
  expect(after.check.ok, JSON.stringify(after.check?.failures)).toBe(true);
  expect(after.text).toBe(state.authored);
  for (const split of after.splits) {
    expect(Math.abs(split.fragTopAfter - split.targetTop)).toBeLessThanOrEqual(2);
  }
});

test("composition defers the pass until it ends", async ({page}) => {
  await page.goto(fileUrl());
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, {timeout: 15_000});
  const initial = await page.evaluate(() => {
    const content = document.getElementById("content");
    content.replaceChildren(...Array.from({length: 3}, (_, i) => {
      const p = document.createElement("p");
      p.textContent = `Paragraph ${i + 1}.`;
      return p;
    }));
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.setFragmenting(false);
    pag.refresh();
    return pag.pageCount();
  });
  await page.evaluate(() => {
    const content = document.getElementById("content");
    content.dispatchEvent(new CompositionEvent("compositionstart", {bubbles: true}));
    for (let i = 0; i < 30; i++) {
      const p = document.createElement("p");
      p.textContent = `${"A line of text that will need another page. ".repeat(4)}`;
      content.append(p);
    }
  });
  await page.waitForTimeout(300);
  const during = await page.evaluate(() => globalThis.StandaloneDoc.modules.pagination.pageCount());
  expect(during, "a pass ran while composing").toBe(initial);
  await page.evaluate(() => document.getElementById("content").dispatchEvent(new CompositionEvent("compositionend", {bubbles: true})));
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => globalThis.StandaloneDoc.modules.pagination.pageCount());
  expect(after, "compositionend did not schedule a pass").toBeGreaterThan(initial);
});
