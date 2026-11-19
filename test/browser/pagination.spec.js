import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* Pagination's two mechanisms, asserted as relationships between numbers.
 *
 *   - the page gap is a `margin-block-start` on the first block of a page, not a node:
 *     no `.page-spacer`, and a cross-page selection has no rect inside the gap (the lab
 *     measured 948 px of false selection when the gap was a spacer);
 *   - an over-long paragraph is cut *inside the same `<p>`* behind a session flag:
 *     text conserved, one paragraph, the tail's top equal to the page top the plan named,
 *     and two passes that change nothing leave `#content.innerHTML` byte-identical.
 *
 * The fixture is deliberately under a page tall (lab/016): the interesting case is a block
 * that overflows the *remaining* room on a page, not an oversize block, which keeps a page
 * of its own and is never cut.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fileUrl = (name = "index.html") => "file://" + path.join(ROOT, name);

const LONG = ("The phrase this comment is about sits here, in the middle of a paragraph that keeps "
  + "going, because a page break has to fall somewhere and the interesting case is the one that "
  + "splits a reader's attention rather than a block. Cross-block selections are ordinary: a "
  + "reviewer drags from the end of one paragraph to the middle of the next, and the comment "
  + "they meant applies to both. ").repeat(9);

const FIXTURE = [
  {tag: "p", text: "First paragraph. It exists so the page has a top margin, a folio, and a block before anything interesting happens."},
  {tag: "p", text: "Second paragraph, one line of throat-clearing before the heading."},
  {tag: "h2", text: "A heading, which is a block like any other"},
  {tag: "p", text: LONG},
  {tag: "p", text: "Fourth paragraph, short."},
  {tag: "p", text: "Fifth paragraph, also short, and it sits near a page boundary on purpose."},
  {tag: "h3", text: "Another heading"},
  {tag: "p", text: "Sixth paragraph with a little more text so the following list does not start at a page top."},
  {tag: "p", text: "Seventh paragraph: the reader is now somewhere in the middle of the document, which is where a long review session happens."},
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

/**
 * Replace the document with `blocks`, run one pass, and return the state a test can assert
 * on. `before` is the same document planned whole, so a test can compare fragmentation
 * against the shipped layout instead of a hard-coded page count (window size decides that).
 */
async function loadDoc(page, blocks, {fragment = false} = {}) {
  return page.evaluate(({blocks, fragment}) => {
    const content = document.getElementById("content");
    const pagination = globalThis.StandaloneDoc.modules.pagination;
    const make = (block) => {
      const el = document.createElement(block.tag);
      if (block.html != null) el.innerHTML = block.html;
      else if (block.tag === "ul" || block.tag === "ol") {
        for (const line of block.text.split("\n")) {
          const li = document.createElement("li");
          li.textContent = line;
          el.append(li);
        }
      } else el.textContent = block.text;
      return el;
    };
    content.replaceChildren(...blocks.map(make));
    const authored = content.textContent;
    pagination.setFragmenting(false);
    pagination.refresh();
    const whole = {
      pages: pagination.pageCount(),
      fragments: content.querySelectorAll("[data-frag]").length,
      spacers: content.querySelectorAll(".page-spacer").length,
      starts: content.querySelectorAll("[data-page-start]").length,
    };
    pagination.setFragmenting(fragment);
    pagination.refresh();
    /* The fixture replaces the document after boot, so the undo baseline must be the
       fixture, not the demo content history.reset() recorded at construction. */
    globalThis.StandaloneDoc.modules.editor.history.reset();
    const d = pagination.diagnostics();
    return {
      whole,
      text: content.textContent,
      authored,
      authoredParagraphs: blocks.filter((b) => b.tag === "p").length,
      pages: d.pages,
      fragmenting: d.fragmenting,
      fragments: d.fragments,
      gaps: d.gaps,
      check: d.check,
      items: d.items,
      splits: d.splits,
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
      zoom: globalThis.StandaloneDoc.modules.zoom.value,
    };
  }, {blocks, fragment});
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

test("fragmenting conserves the text and lands the tail on the page top", async ({page}) => {
  await boot(page);
  const state = await loadDoc(page, FIXTURE, {fragment: true});

  expect(state.fragmenting).toBe(true);
  expect(state.fragments, "the fixture must produce at least one cut").toBeGreaterThan(0);
  expect(state.fragments, "one cut per split").toBe(state.splits.length);
  expect(state.text, "fragmentation must not change a character").toBe(state.authored);
  expect(state.paragraphs, "one `<p>` per authored paragraph, never two").toBe(state.authoredParagraphs);
  expect(state.check, JSON.stringify(state.check)).not.toBeNull();
  expect(state.check.ok, JSON.stringify(state.check.failures)).toBe(true);

  for (const split of state.splits) {
    expect(
      Math.abs(split.fragTopAfter - split.targetTop),
      `tail at ${split.fragTopAfter}, page top ${split.targetTop}`,
    ).toBeLessThanOrEqual(2);
  }

  /* Every cut block occupies exactly two page items, and the seam meets. */
  const cutBlocks = state.splits.length;
  if (cutBlocks) {
    const paired = state.items.flat().filter((item) => item.to != null && item.from > 0);
    for (const item of paired) {
      expect(item.from, "the second item of a cut block starts where the first ended").toBe(item.to);
    }
  }

  /* Fragmentation exists to reclaim the white space at the bottom of a page: never more
     pages than the whole-block plan produced. */
  expect(state.pages, `fragmented ${state.pages} pages, whole ${state.whole.pages}`).toBeLessThanOrEqual(state.whole.pages);
  expect(state.sheets).toBe(state.pages);
});

test("two passes that change nothing leave the document byte-identical", async ({page}) => {
  await boot(page);
  const first = await loadDoc(page, FIXTURE, {fragment: true});
  const second = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pagination = globalThis.StandaloneDoc.modules.pagination;
    const signature = () => ({
      pages: pagination.pageCount(),
      cuts: pagination.diagnostics().splits.map((split) => `${split.offset}/${split.push}`),
      html: content.innerHTML,
    });
    const before = signature();
    pagination.refresh();
    const after = signature();
    return {before, after};
  });
  expect(second.after.html, "a fragmented pass rewrote the flow").toBe(second.before.html);
  expect(second.after.pages).toBe(second.before.pages);
  expect(second.after.cuts).toEqual(second.before.cuts);
  expect(first.check.ok, JSON.stringify(first.check?.failures)).toBe(true);
});

test("the tail's page top survives every zoom stop", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  for (const zoom of [0.5, 1, 2, 3]) {
    const state = await page.evaluate((zoom) => {
      const zoomMod = globalThis.StandaloneDoc.modules.zoom;
      const pagination = globalThis.StandaloneDoc.modules.pagination;
      zoomMod.set(zoom);
      pagination.refresh();
      const d = pagination.diagnostics();
      return {
        zoom: zoomMod.value,
        pages: d.pages,
        splits: d.splits,
        check: d.check,
        text: document.getElementById("content").textContent,
      };
    }, zoom);
    expect(state.zoom).toBe(zoom);
    expect(state.check.ok, `zoom ${zoom}: ${JSON.stringify(state.check?.failures)}`).toBe(true);
    for (const split of state.splits) {
      expect(
        Math.abs(split.fragTopAfter - split.targetTop),
        `zoom ${zoom}: tail ${split.fragTopAfter}, target ${split.targetTop}`,
      ).toBeLessThanOrEqual(2);
    }
  }
});

test("a save carries the document, not the pagination", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const saved = await page.evaluate(async () => {
    const result = await globalThis.StandaloneDoc.modules.toolbar.serialize();
    const doc = new DOMParser().parseFromString(result.html, "text/html");
    return {
      html: result.html,
      fragments: doc.querySelectorAll("[data-frag]").length,
      starts: doc.querySelectorAll("[data-page-start]").length,
      spacers: doc.querySelectorAll(".page-spacer").length,
      margins: [...doc.querySelectorAll("[style]")]
        .filter((node) => /margin-block-start/i.test(node.getAttribute("style") || "")).length,
      paragraphs: doc.querySelectorAll("#content > p").length,
      text: doc.querySelector("#content").textContent.length,
    };
  });
  expect(saved.fragments, "a fragment leaked into the saved file").toBe(0);
  expect(saved.starts, "a page-start attribute leaked into the saved file").toBe(0);
  expect(saved.spacers, "a page spacer leaked into the saved file").toBe(0);
  expect(saved.margins, "a page margin leaked into the saved file").toBe(0);
  expect(saved.paragraphs).toBe(FIXTURE.filter((block) => block.tag === "p").length);
});

test("a block taller than a page keeps its own page and is not cut", async ({page}) => {
  await boot(page);
  const tall = "x".repeat(4000);
  const state = await loadDoc(page, [
    {tag: "p", text: tall},
    {tag: "p", text: "A short paragraph after the tall one, so the plan has something to measure."},
    {tag: "p", text: "Another short paragraph, near the end."},
  ], {fragment: true});
  expect(state.text, "a tall block's text is untouched").toBe(state.authored);
  expect(state.check.ok, JSON.stringify(state.check?.failures)).toBe(true);
  const insideTall = await page.evaluate(() => {
    const first = document.getElementById("content").firstElementChild;
    return first.querySelectorAll("[data-frag]").length;
  });
  expect(insideTall, "a block taller than a page must not be fragmented").toBe(0);
});

test("a long unbreakable token is cut at a word boundary when one exists", async ({page}) => {
  await boot(page);
  /* A very long word near the bottom of a page: the geometric cut lands inside it, and the
     back-off must move the cut to the space before it rather than mid-token. */
  const text = `${"A sentence with ordinary words. ".repeat(24)}${"Z".repeat(900)} tail words after the long token.`;
  const state = await loadDoc(page, [
    {tag: "p", text},
    {tag: "p", text: "A closing paragraph so the long one is not the last block."},
  ], {fragment: true});
  expect(state.text).toBe(state.authored);
  for (const split of state.splits) {
    const offset = split.offset;
    if (offset <= 1 || offset >= text.length) continue;
    const whitespaceBefore = text.slice(0, offset).includes(" ") || text.slice(0, offset).includes("\n");
    const atBoundary = /\s/.test(text[offset - 1]);
    expect(
      atBoundary || !whitespaceBefore,
      `cut at ${offset} is mid-word and a boundary exists: ${JSON.stringify(text.slice(offset - 12, offset + 12))}`,
    ).toBe(true);
  }
  expect(state.check.ok, JSON.stringify(state.check?.failures)).toBe(true);
});

test("a cut inside inline markup keeps the markup and the text", async ({page}) => {
  await boot(page);
  const plain = LONG;
  const start = Math.floor(plain.length / 2);
  const html = `${plain.slice(0, start)}<em>${plain.slice(start, start + 120)}</em><a href="#note">${plain.slice(start + 120, start + 240)}</a>${plain.slice(start + 240)}`;
  const state = await loadDoc(page, [
    {tag: "p", text: "Opening paragraph."},
    {tag: "p", html},
    {tag: "p", text: "Closing paragraph."},
  ], {fragment: true});
  expect(state.text).toBe(state.authored);
  const markup = await page.evaluate(() => {
    const content = document.getElementById("content");
    return {
      em: content.querySelectorAll("em").length,
      links: content.querySelectorAll("a").length,
      linksWithHref: [...content.querySelectorAll("a")].filter((a) => a.getAttribute("href") === "#note").length,
      paragraphs: content.querySelectorAll(":scope > p").length,
    };
  });
  expect(markup.em, "the <em> survived the split").toBeGreaterThan(0);
  expect(markup.links, "the <a> survived the split").toBeGreaterThan(0);
  expect(markup.linksWithHref, "the link kept its href").toBe(markup.links);
  expect(markup.paragraphs, "still one paragraph per authored paragraph").toBe(3);
  expect(state.check.ok, JSON.stringify(state.check?.failures)).toBe(true);
});

test("a list at a page boundary moves whole", async ({page}) => {
  await boot(page);
  const items = Array.from({length: 12}, (_, i) => `List item ${i + 1} with enough text to occupy a line.`).join("\n");
  const state = await loadDoc(page, [
    {tag: "p", text: "A paragraph before the list, long enough to move the list near a page edge. ".repeat(6)},
    {tag: "ul", text: items},
    {tag: "p", text: "A paragraph after the list."},
  ], {fragment: true});
  const insideList = await page.evaluate(() => {
    const list = document.querySelector("#content > ul");
    return {
      fragments: list ? list.querySelectorAll("[data-frag]").length : -1,
      items: list ? list.children.length : -1,
    };
  });
  expect(insideList.items).toBe(12);
  expect(insideList.fragments, "a list is not split in v1").toBe(0);
  expect(state.text).toBe(state.authored);
  expect(state.check.ok, JSON.stringify(state.check?.failures)).toBe(true);
});

test("a blockquote with block children is atomic, with inline children it is lines", async ({page}) => {
  await boot(page);
  await loadDoc(page, [
    {tag: "p", text: LONG},
    {tag: "blockquote", html: `<p>${LONG.slice(0, 900)}</p><p>${LONG.slice(900, 1800)}</p>`},
    {tag: "blockquote", text: "An inline quotation, which is a sequence of lines."},
    {tag: "p", text: "A closing paragraph."},
  ], {fragment: true});
  const kinds = await page.evaluate(() => {
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const quotes = [...document.querySelectorAll("#content > blockquote")];
    return {
      blockChildren: pag.strategy(quotes[0]).kind,
      inlineChildren: pag.strategy(quotes[1]).kind,
      fragmentsInsideBlockquote: [...document.querySelectorAll("#content > blockquote [data-frag]")].length,
    };
  });
  /* A display:block span holding <p> children would be invalid HTML, so the container moves
     whole; a quotation with inline children is a normal line block. */
  expect(kinds.blockChildren).toBe("atomic");
  expect(kinds.inlineChildren).toBe("lines");
  expect(kinds.fragmentsInsideBlockquote).toBe(0);
});

test("a plugin can redefine a block strategy, and the planner obeys it", async ({page}) => {
  await boot(page);
  const result = await page.evaluate(() => {
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const content = document.getElementById("content");
    content.replaceChildren(...[1, 2, 3].map((n) => {
      const p = document.createElement("p");
      p.textContent = `${n}. ${"A paragraph long enough to cross a page when the plan says so. ".repeat(40)}`;
      return p;
    }));
    const first = content.firstElementChild;
    const before = pag.strategy(first).kind;
    pag.defineBlock("p", {kind: "atomic"});
    const after = pag.strategy(first).kind;
    pag.setFragmenting(true);
    pag.refresh();
    return {before, after, fragments: content.querySelectorAll("[data-frag]").length};
  });
  expect(result.before).toBe("lines");
  expect(result.after).toBe("atomic");
  expect(result.fragments, "an atomic paragraph must not be cut").toBe(0);
});

test("a continuation fragment is not indented by an inherited text-indent", async ({page}) => {
  await boot(page);
  /* A document that indents first lines. `text-indent` is inherited, so without the
     [data-frag] rule the tail's first line would be indented twice. `::first-letter` is not
     inherited; a rule scoped to `#content > p` cannot reach the fragment. */
  await page.addStyleTag({content: "#content > p { text-indent: 2em; }"});
  const state = await loadDoc(page, [
    {tag: "p", text: LONG},
    {tag: "p", text: LONG},
    {tag: "p", text: "A closing paragraph."},
  ], {fragment: true});
  const indents = await page.evaluate(() => {
    const p = [...document.querySelectorAll("#content > p")].find((el) => el.querySelector("[data-frag]"));
    if (!p) return {error: "no fragment"};
    const frag = p.querySelector("[data-frag]");
    return {
      head: getComputedStyle(p).textIndent,
      tail: getComputedStyle(frag).textIndent,
    };
  });
  expect(indents.error, JSON.stringify(indents)).toBeUndefined();
  expect(indents.head).not.toBe("0px");
  expect(indents.tail, "the continuation line must not inherit the paragraph indent").toBe("0px");
  expect(state.check.ok, JSON.stringify(state.check?.failures)).toBe(true);
});

/* --------------------------------------------------------------- caret and viewport */

/** Read the live selection as {block, offset, endBlock, endOffset} in text coordinates. */
const readSelection = () => {
  const content = document.getElementById("content");
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const point = (node, nodeOffset) => {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const block = el.closest("#content > *");
    const index = [...content.children].indexOf(block);
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let total = 0;
    let text = walker.nextNode();
    while (text) {
      if (text === node) return {block: index, offset: total + Math.min(nodeOffset, text.nodeValue.length)};
      total += text.nodeValue.length;
      text = walker.nextNode();
    }
    return {block: index, offset: total};
  };
  const start = point(range.startContainer, range.startOffset);
  const end = point(range.endContainer, range.endOffset);
  return {...start, endBlock: end.block, endOffset: end.offset, text: content.textContent.length};
};

test("a second pass converges on the same pages and cuts", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const result = await page.evaluate(() => {
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const first = pag.diagnostics();
    pag.refresh();
    const second = pag.diagnostics();
    return {
      first: {pages: first.pages, cuts: first.splits.map((split) => split.offset)},
      second: {pages: second.pages, cuts: second.splits.map((split) => split.offset)},
      converged: second.converged,
    };
  });
  expect(result.converged, JSON.stringify(result)).toBe(true);
  expect(result.second.pages).toBe(result.first.pages);
  expect(result.second.cuts).toEqual(result.first.cuts);
});

test("a no-op pass performs no DOM write in #content", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const result = await page.evaluate(async () => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.refresh(); /* settle the state the observer will watch */
    const records = [];
    const observer = new MutationObserver((list) => records.push(...list));
    observer.observe(content, {subtree: true, childList: true, characterData: true, attributes: true});
    pag.refresh();
    /* MutationObserver callbacks are microtasks; one turn is enough to collect them. */
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();
    return {
      count: records.length,
      kinds: records.map((record) => `${record.type}:${record.target.nodeName}`),
      reused: pag.diagnostics().splits.map((split) => split.reused),
    };
  });
  expect(result.count, `a no-op pass touched the flow: ${JSON.stringify(result.kinds)}`).toBe(0);
  expect(result.reused.every(Boolean), "an unchanged cut was re-split instead of reused").toBe(true);
});

test("typing at the cut keeps the caret across a pass", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const placed = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const offset = pag.diagnostics().splits[0].offset;
    const frag = content.querySelector("[data-frag]");
    const block = frag.parentElement;
    const index = [...content.children].indexOf(block);
    const target = offset - 8;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let remaining = target;
    let node = walker.nextNode();
    while (node) {
      if (remaining <= node.nodeValue.length) break;
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
    return {block: index, target, text: block.textContent.length};
  });
  await page.keyboard.type("x");
  const after = await page.evaluate((placed) => {
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.refresh();
    return {
      selection: (() => {
        const content = document.getElementById("content");
        const sel = window.getSelection();
        const range = sel.getRangeAt(0);
        const el = range.startContainer.nodeType === Node.ELEMENT_NODE
          ? range.startContainer : range.startContainer.parentElement;
        const block = el.closest("#content > *");
        const index = [...content.children].indexOf(block);
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let total = 0;
        let node = walker.nextNode();
        while (node) {
          if (node === range.startContainer) break;
          total += node.nodeValue.length;
          node = walker.nextNode();
        }
        return {block: index, offset: total + range.startOffset, text: block.textContent.length};
      })(),
      diagnostics: pag.diagnostics(),
    };
  }, placed);

  expect(after.selection.block, "the caret moved to another block").toBe(placed.block);
  expect(after.selection.offset, `caret at ${after.selection.offset}, typed at ${placed.target}`).toBe(placed.target + 1);
  expect(after.selection.text).toBe(placed.text + 1);
  expect(after.diagnostics.fragments, "the edited block is still fragmented").toBeGreaterThan(0);
  expect(after.diagnostics.selectionKept, JSON.stringify(after.diagnostics.check?.failures)).toBe(true);
});

test("a selection across a cut survives ten passes", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const before = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const offset = pag.diagnostics().splits[0].offset;
    const block = content.querySelector("[data-frag]").parentElement;
    const point = (at) => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let remaining = at;
      let node = walker.nextNode();
      while (node) {
        if (remaining <= node.nodeValue.length) return {node, offset: remaining};
        remaining -= node.nodeValue.length;
        node = walker.nextNode();
      }
      return {node: block, offset: block.childNodes.length};
    };
    const start = point(offset - 20);
    const end = point(offset + 20);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    content.focus();
    const blockIndex = [...content.children].indexOf(block);
    return {block: blockIndex, start: offset - 20, end: offset + 20};
  });
  for (let i = 0; i < 10; i++) {
    const state = await page.evaluate(() => {
      const pag = globalThis.StandaloneDoc.modules.pagination;
      pag.refresh();
      return {kept: pag.diagnostics().selectionKept, check: pag.diagnostics().check};
    });
    expect(state.kept, `pass ${i + 1} lost the selection: ${JSON.stringify(state.check?.failures)}`).toBe(true);
  }
  const after = await page.evaluate(() => {
    const content = document.getElementById("content");
    const block = content.querySelector("[data-frag]").parentElement;
    const index = [...content.children].indexOf(block);
    const sel = window.getSelection();
    const range = sel.getRangeAt(0);
    const point = (node, nodeOffset) => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let total = 0;
      let text = walker.nextNode();
      while (text) {
        if (text === node) return total + Math.min(nodeOffset, text.nodeValue.length);
        total += text.nodeValue.length;
        text = walker.nextNode();
      }
      return total;
    };
    return {
      block: index,
      start: point(range.startContainer, range.startOffset),
      end: point(range.endContainer, range.endOffset),
    };
  });
  expect(after.block).toBe(before.block);
  expect(after.start, `start at ${after.start}, expected ${before.start}`).toBe(before.start);
  expect(after.end, `end at ${after.end}, expected ${before.end}`).toBe(before.end);
});

test("a pass keeps the caret's block at the same viewport position", async ({page}) => {
  await boot(page);
  await loadDoc(page, [
    ...FIXTURE,
    {tag: "p", text: LONG},
    {tag: "p", text: "A final paragraph."},
  ], {fragment: true});
  const placed = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const viewport = document.getElementById("viewport");
    /* A block after the fragmented paragraph, with content below it: merging the fragment
       changes the page plan above the caret (the reflow the anchor exists for), and there
       is still room to scroll down to keep it put. The very last block cannot be kept at
       the same viewport top — the document ends. */
    const block = content.children[content.children.length - 3];
    block.scrollIntoView({block: "center"});
    const index = [...content.children].indexOf(block);
    const range = document.createRange();
    range.setStart(block.firstChild, Math.min(5, block.textContent.length));
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    content.focus();
    return {block: index, top: block.getBoundingClientRect().top, scrollTop: viewport.scrollTop, fragments: content.querySelectorAll("[data-frag]").length};
  });
  expect(placed.fragments, "the fixture must be fragmented to begin with").toBeGreaterThan(0);
  const after = await page.evaluate((placed) => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const viewport = document.getElementById("viewport");
    /* Turning fragmentation off merges the paragraph and re-plans: the page gap that was
       inside it disappears, so every later block moves. */
    pag.setFragmenting(false);
    const block = content.children[placed.block];
    return {
      top: block.getBoundingClientRect().top,
      scrollTop: viewport.scrollTop,
      fragments: content.querySelectorAll("[data-frag]").length,
      selectionKept: pag.diagnostics().selectionKept,
    };
  }, placed);
  const delta = after.top - placed.top;
  expect(after.fragments, "the merge did not happen").toBe(0);
  expect(Math.abs(delta), `the caret block moved ${Math.round(delta)}px; scrollTop ${placed.scrollTop} → ${after.scrollTop}`).toBeLessThanOrEqual(24);
});

test("undo restores the unfragmented snapshot and the next pass re-fragments", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const placed = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const offset = pag.diagnostics().splits[0].offset;
    const block = content.querySelector("[data-frag]").parentElement;
    const index = [...content.children].indexOf(block);
    const point = (at) => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let remaining = at;
      let node = walker.nextNode();
      while (node) {
        if (remaining <= node.nodeValue.length) return {node, offset: remaining};
        remaining -= node.nodeValue.length;
        node = walker.nextNode();
      }
      return {node: block, offset: block.childNodes.length};
    };
    const at = point(offset - 8);
    const range = document.createRange();
    range.setStart(at.node, at.offset);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    content.focus();
    return {block: index, offset: offset - 8, text: content.textContent.length};
  });
  await page.keyboard.type("abc");
  await page.waitForTimeout(500); /* the typing burst becomes one history entry */
  const result = await page.evaluate((placed) => {
    const content = document.getElementById("content");
    const editor = globalThis.StandaloneDoc.modules.editor;
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const typed = content.textContent.length;
    editor.exec("undo");
    const restored = content.textContent.length;
    const fragmentsBeforePass = content.querySelectorAll("[data-frag]").length;
    pag.refresh();
    return {
      typed,
      restored,
      fragmentsBeforePass,
      fragmentsAfterPass: content.querySelectorAll("[data-frag]").length,
      kept: pag.diagnostics().selectionKept,
      text: content.textContent.length,
    };
  }, placed);
  expect(result.typed).toBe(placed.text + 3);
  expect(result.restored, "undo did not remove the typing").toBe(placed.text);
  expect(result.fragmentsBeforePass, "the undo snapshot still carried a fragment").toBe(0);
  expect(result.fragmentsAfterPass, "the next pass did not re-fragment").toBeGreaterThan(0);
  expect(result.kept, "the caret was not restored across undo + re-fragment").toBe(true);
});
