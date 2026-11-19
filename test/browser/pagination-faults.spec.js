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


test("CJK prose with no spaces fragments without losing a character", async ({page}) => {
  const cjk = "これは日本語の文章です。ページの境界で分割されても、文字が失われてはいけません。".repeat(160);
  const state = await load(page, [
    {tag: "p", text: "A lead paragraph."},
    {tag: "p", text: cjk},
    {tag: "p", text: "A closing paragraph."},
  ]);
  expect(state.fragments, "the CJK paragraph must cross a page").toBeGreaterThan(0);
  expectTailOnPage(state);
});

test("hyphenation does not break the fragment contract", async ({page}) => {
  await page.goto(fileUrl());
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, {timeout: 15_000});
  await page.addStyleTag({content: "#content > p { hyphens: auto; }"});
  const state = await page.evaluate((LONG) => {
    const content = document.getElementById("content");
    const make = (tag, text) => {
      const el = document.createElement(tag);
      el.textContent = text;
      return el;
    };
    content.replaceChildren(make("p", "A lead paragraph."), make("p", LONG), make("p", "A closing paragraph."));
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.setFragmenting(false);
    pag.refresh();
    pag.setFragmenting(true);
    pag.refresh();
    const d = pag.diagnostics();
    return {authored: content.textContent, text: content.textContent, fragments: d.fragments, splits: d.splits, check: d.check};
  }, "Hyphenation encourages the browser to break long words at their syllable boundaries, which is exactly the kind of line break a page cut must not imitate in the text stream. ".repeat(120));
  expect(state.fragments).toBeGreaterThan(0);
  expectTailOnPage(state);
});

test("a cut inside nested inline markup preserves the text and the markup", async ({page}) => {
  await page.goto(fileUrl());
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, {timeout: 15_000});
  const state = await page.evaluate((LONG) => {
    const content = document.getElementById("content");
    const make = (tag, text, html) => {
      const el = document.createElement(tag);
      if (html != null) el.innerHTML = html;
      else el.textContent = text;
      return el;
    };
    /* The cut lands inside an `<a>` inside an `<em>`; the anchor has no id, so a split is
       allowed, and `Range.extractContents` is what has to carry both wrappers across. */
    content.replaceChildren(
      make("p", "A lead paragraph."),
      make("p", null, `<em><a href="#note">${LONG}</a></em>`),
      make("p", "A closing paragraph."),
    );
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.setFragmenting(false);
    pag.refresh();
    pag.setFragmenting(true);
    pag.refresh();
    const d = pag.diagnostics();
    const block = content.children[1];
    const tail = block.querySelector("[data-frag]");
    return {
      authored: content.textContent,
      text: content.textContent,
      fragments: d.fragments,
      splits: d.splits,
      check: d.check,
      tailLinks: tail ? tail.querySelectorAll("a[href='#note']").length : 0,
      tailEmphasis: tail ? tail.querySelectorAll("em").length : 0,
    };
  }, LONG);
  expect(state.fragments).toBeGreaterThan(0);
  expect(state.tailLinks, "the tail lost the link it was cut inside").toBe(1);
  expect(state.tailEmphasis, "the tail lost the emphasis it was cut inside").toBe(1);
  expectTailOnPage(state);
});

test("an RTL selection across a cut keeps its endpoints", async ({page}) => {
  await page.goto(fileUrl());
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, {timeout: 15_000});
  const rtl = "זהו משפט ארוך בעברית שממשיך וממשיך, כי שבירת עמוד חייבת ליפול איפשהו בתוך פסקה. ".repeat(110);
  const state = await page.evaluate((rtl) => {
    const content = document.getElementById("content");
    const make = (tag, text) => {
      const el = document.createElement(tag);
      el.textContent = text;
      return el;
    };
    content.replaceChildren(make("p", "פתיחה."), make("p", rtl), make("p", "סוף."));
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.setFragmenting(false);
    pag.refresh();
    pag.setFragmenting(true);
    pag.refresh();
    const cut = pag.diagnostics().splits[0].offset;
    const block = content.querySelector("[data-frag]").parentElement;
    const point = (at) => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let remaining = at;
      let node = walker.nextNode();
      while (node && remaining > node.nodeValue.length) { remaining -= node.nodeValue.length; node = walker.nextNode(); }
      return {node, offset: remaining};
    };
    const a = point(cut - 30);
    const b = point(cut + 30);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    globalThis.StandaloneDoc.modules.selection.restore(content, {
      start: {block: 1, offset: cut - 30},
      end: {block: 1, offset: cut + 30},
      collapsed: false,
    });
    const before = globalThis.StandaloneDoc.modules.selection.capture(content);
    pag.refresh();
    const after = globalThis.StandaloneDoc.modules.selection.capture(content);
    const d = pag.diagnostics();
    return {before, after, kept: d.selectionKept, check: d.check, fragments: d.fragments, text: content.textContent};
  }, rtl);
  expect(state.fragments).toBeGreaterThan(0);
  expect(state.before, "the RTL selection was not capturable").not.toBeNull();
  expect(state.after.start).toEqual(state.before.start);
  expect(state.after.end).toEqual(state.before.end);
  expect(state.kept, "a pass lost the RTL selection").toBe(true);
  expect(state.check.ok, JSON.stringify(state.check?.failures)).toBe(true);
});

test("a data-runtime child of #content is a block, not a fragment", async ({page}) => {
  await page.goto(fileUrl());
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, {timeout: 15_000});
  const state = await page.evaluate((LONG) => {
    const content = document.getElementById("content");
    const make = (tag, text) => {
      const el = document.createElement(tag);
      el.textContent = text;
      return el;
    };
    const runtime = document.createElement("div");
    runtime.setAttribute("data-runtime", "ephemeral");
    runtime.textContent = "a live runtime block";
    content.replaceChildren(make("p", "A lead paragraph."), make("p", LONG), runtime, make("p", "A closing paragraph."));
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.setFragmenting(false);
    pag.refresh();
    pag.setFragmenting(true);
    pag.refresh();
    const d = pag.diagnostics();
    return {
      authored: content.textContent,
      text: content.textContent,
      fragments: d.fragments,
      splits: d.splits,
      check: d.check,
      kind: pag.strategy(runtime).kind,
      runtimeFragments: runtime.querySelectorAll("[data-frag]").length,
    };
  }, LONG);
  expect(state.kind, "a runtime block must not be offered to the splitter").toBe("atomic");
  expect(state.runtimeFragments).toBe(0);
  expect(state.fragments).toBeGreaterThan(0);
  expectTailOnPage(state);
});

test("Thai prose with no spaces fragments without joining or losing characters", async ({page}) => {
  await page.goto(fileUrl());
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, {timeout: 15_000});
  const thai = "นี่คือข้อความภาษาไทยที่ไม่มีช่องว่างระหว่างคำ การแบ่งหน้าต้องไม่ทำให้ตัวอักษรหายหรือติดกัน ".repeat(90);
  const state = await page.evaluate((thai) => {
    const content = document.getElementById("content");
    const make = (tag, text) => {
      const el = document.createElement(tag);
      el.textContent = text;
      return el;
    };
    content.replaceChildren(make("p", "ย่อหน้าแรก"), make("p", thai), make("p", "ย่อหน้าสุดท้าย"));
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.setFragmenting(false);
    pag.refresh();
    pag.setFragmenting(true);
    pag.refresh();
    const d = pag.diagnostics();
    return {authored: content.textContent, text: content.textContent, fragments: d.fragments, splits: d.splits, check: d.check};
  }, thai);
  expect(state.fragments).toBeGreaterThan(0);
  expectTailOnPage(state);
});

test("a resize does not loop inside the ResizeObserver delivery", async ({page}) => {
  /* The pass changes margins and heights, which is itself a resize. Running it inside the
     ResizeObserver callback earned WebKit's "loop completed with undelivered
     notifications" (and that was a console error in an unrelated export test). The pass is
     scheduled one frame later; this is the behaviour that keeps the observer quiet. */
  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  await page.goto(fileUrl());
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, {timeout: 15_000});
  await page.evaluate((LONG) => {
    const content = document.getElementById("content");
    const make = (tag, text) => {
      const el = document.createElement(tag);
      el.textContent = text;
      return el;
    };
    content.replaceChildren(make("p", "A lead paragraph."), make("p", LONG.repeat(2)), make("p", "A closing paragraph."));
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.setFragmenting(true);
    pag.refresh();
  }, LONG);
  for (const width of [1100, 980, 1040]) {
    await page.setViewportSize({width, height: 820});
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(300);
  expect(problems.filter((text) => /ResizeObserver loop/.test(text))).toEqual([]);
  const state = await page.evaluate(() => {
    const pag = globalThis.StandaloneDoc.modules.pagination;
    return {
      fragments: pag.diagnostics().fragments,
      check: pag.diagnostics().check,
      converged: pag.diagnostics().converged,
    };
  });
  expect(state.fragments).toBeGreaterThan(0);
  expect(state.check.ok, JSON.stringify(state.check?.failures)).toBe(true);
  expect(state.converged, "the resize never settled").toBe(true);
});
