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

test("a paragraph taller than a page is cut into page-sized fragments", async ({page}) => {
  await boot(page);
  const state = await loadDoc(page, [
    {tag: "p", text: "A lead paragraph."},
    {tag: "p", text: LONG.repeat(12)},
    {tag: "p", text: "A closing paragraph."},
  ], {fragment: true});
  expect(state.fragments, "a long paragraph must need more than one cut").toBeGreaterThan(1);
  expect(state.text, "fragmentation must not change a character").toBe(state.authored);
  expect(state.check.ok, JSON.stringify(state.check?.failures)).toBe(true);
  for (const split of state.splits) {
    expect(
      Math.abs(split.fragTopAfter - split.targetTop),
      `cut at ${split.offset}: tail ${split.fragTopAfter}, target ${split.targetTop}`,
    ).toBeLessThanOrEqual(2);
  }
  /* The cut block's page items are contiguous and in order. */
  const byBlock = new Map();
  for (const item of state.items.flat()) {
    if (!byBlock.has(item.block)) byBlock.set(item.block, []);
    byBlock.get(item.block).push(item);
  }
  const multi = [...byBlock.values()].find((items) => items.length > 2);
  expect(multi, "no block was placed on three or more pages").toBeTruthy();
  expect(multi[0].from).toBe(0);
  expect(multi[multi.length - 1].to).toBeNull();
  for (let i = 0; i < multi.length - 1; i++) {
    expect(multi[i].to, `item ${i} has no to-offset`).not.toBeNull();
    expect(multi[i + 1].from, `from/to do not meet at item ${i}`).toBe(multi[i].to);
  }
});

test("an atomic block taller than a page keeps its own page and is not cut", async ({page}) => {
  await boot(page);
  const code = Array.from({length: 300}, (_, i) => `line ${i + 1} of a code block`).join("\n");
  const state = await loadDoc(page, [
    {tag: "p", text: "A lead paragraph."},
    {tag: "pre", text: code},
    {tag: "p", text: "A closing paragraph."},
  ], {fragment: true});
  expect(state.text, "the code block's text is untouched").toBe(state.authored);
  expect(state.check.ok, JSON.stringify(state.check?.failures)).toBe(true);
  const inside = await page.evaluate(() => document.querySelector("#content > pre").querySelectorAll("[data-frag]").length);
  expect(inside, "a pre is atomic; it must not be cut").toBe(0);
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

test("a mutation is re-planned before the next paint", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const result = await page.evaluate(async () => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.refresh();
    const block = content.querySelector("[data-frag]").parentElement;
    const before = {pages: pag.pageCount(), cuts: pag.diagnostics().splits.map((split) => split.offset)};
    /* Text at the start of the head shifts the cut by exactly this many characters. */
    const inserted = "Extra words at the start of the paragraph. ".repeat(30);
    const first = block.firstChild;
    if (first.nodeType === Node.TEXT_NODE) first.insertData(0, inserted);
    else block.insertBefore(document.createTextNode(inserted), first);
    /* The pass runs in the MutationObserver callback, before paint. One task turn is
       enough; no animation frame is needed, which is exactly the guarantee. */
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      before,
      after: {pages: pag.pageCount(), cuts: pag.diagnostics().splits.map((split) => split.offset)},
      inserted: inserted.length,
      check: pag.diagnostics().check,
    };
  });
  /* The inserted text changes which line fits, so the cut is not simply old + inserted;
     it must have moved, and the plan must be valid. */
  expect(
    result.after.cuts[0] === result.before.cuts[0] && result.after.pages === result.before.pages,
    `cut ${result.before.cuts[0]} → ${result.after.cuts[0]} after inserting ${result.inserted} chars (pages ${result.before.pages} → ${result.after.pages})`,
  ).toBe(false);
  expect(result.check.ok, JSON.stringify(result.check?.failures)).toBe(true);
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

test("a no-op pass on an N-cut paragraph writes nothing", async ({page}) => {
  await boot(page);
  await loadDoc(page, [
    {tag: "p", text: "A lead paragraph."},
    {tag: "p", text: LONG.repeat(12)},
    {tag: "p", text: "A closing paragraph."},
  ], {fragment: true});
  const result = await page.evaluate(async () => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.refresh();
    const records = [];
    const observer = new MutationObserver((list) => records.push(...list));
    observer.observe(content, {subtree: true, childList: true, characterData: true, attributes: true});
    pag.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();
    return {
      count: records.length,
      kinds: records.map((record) => `${record.type}:${record.target.nodeName}`),
      splits: pag.diagnostics().splits,
    };
  });
  expect(result.splits.length, "the paragraph must need more than one cut").toBeGreaterThan(1);
  expect(result.count, `a no-op N-cut pass touched the flow: ${JSON.stringify(result.kinds)}`).toBe(0);
  expect(result.splits.every((split) => split.reused), "an unchanged N-cut was re-split").toBe(true);
});

test("a head deletion refills the page in the same pass", async ({page}) => {
  await boot(page);
  /* A block long enough to need more than one page after the deletion: the single-page
     fixture fits as soon as the head shrinks, which is a merge, not a re-cut. */
  await loadDoc(page, [
    {tag: "p", text: "A lead paragraph."},
    {tag: "p", text: LONG.repeat(2)},
    {tag: "p", text: "A closing paragraph."},
  ], {fragment: true});
  const before = await page.evaluate(async () => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const layout = globalThis.StandaloneDoc.modules.layout;
    const viewport = document.getElementById("viewport");
    const block = content.querySelector("[data-frag]").parentElement;
    const first = block.firstChild;
    if (first.nodeType !== Node.TEXT_NODE) throw new Error("the head is not a text node");
    const headBottom = () => {
      const frag = content.querySelector("[data-frag]");
      return layout.rect(frag).top - parseFloat(frag.style.marginBlockStart || "0");
    };
    viewport.scrollTop = 200;
    const cut = pag.diagnostics().splits[0].offset;
    const pages = pag.pageCount();
    const text = content.textContent.length;
    const head = headBottom();
    /* Delete 600 characters from the head. The deleted space is on page 1: the same
       pre-paint pass must re-cut and pull the tail up, not leave the page short until an
       idle reconcile (which the next keystroke used to cancel). */
    first.deleteData(0, 600);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const immediate = {
      cut: pag.diagnostics().splits[0].offset,
      pages: pag.pageCount(),
      stale: pag.diagnostics().stale,
      reused: pag.diagnostics().splits.map((split) => split.reused),
      text: content.textContent.length,
      headTop: headBottom(),
      pageBottom: pag.diagnostics().pageBottoms[0],
      check: pag.diagnostics().check,
    };
    return {cut, pages, text, head, scrollTop: viewport.scrollTop, immediate};
  });

  expect(before.immediate.text).toBe(before.text - 600);
  expect(before.immediate.pages).toBe(before.pages);
  expect(before.immediate.stale, "the re-cut happened in the pass, not after the idle pause").toBe(false);
  expect(
    before.immediate.cut,
    `the sync pass reused the short head (cut ${before.cut} → ${before.immediate.cut})`,
  ).toBeGreaterThan(before.cut - 600);
  expect(before.immediate.check.ok, JSON.stringify(before.immediate.check?.failures)).toBe(true);
  expect(
    before.immediate.pageBottom - before.immediate.headTop,
    "the head still stops short of the page bottom",
  ).toBeLessThanOrEqual(30);
  expect(
    Math.abs(before.immediate.headTop - before.head),
    "the head is not the same height it was before the deletion",
  ).toBeLessThanOrEqual(30);

  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    return {
      cut: pag.diagnostics().splits[0].offset,
      pages: pag.pageCount(),
      stale: pag.diagnostics().stale,
      text: content.textContent.length,
      check: pag.diagnostics().check,
      scrollTop: document.getElementById("viewport").scrollTop,
    };
  });
  /* The idle reconcile is the fallback for shape changes, not a second pass after every
     delete: an immediate re-cut leaves it nothing to do. */
  expect(after.stale).toBe(false);
  expect(after.text).toBe(before.immediate.text);
  expect(after.cut).toBe(before.immediate.cut);
  expect(after.pages).toBe(before.immediate.pages);
  expect(after.check.ok, JSON.stringify(after.check?.failures)).toBe(true);
  expect(
    Math.abs(after.scrollTop - before.scrollTop),
    `the idle pass moved the viewport ${Math.round(after.scrollTop - before.scrollTop)}px`,
  ).toBeLessThanOrEqual(24);
});

test("one deleted character at the seam keeps the page full", async ({page}) => {
  await boot(page);
  await loadDoc(page, [
    {tag: "p", text: "A lead paragraph."},
    {tag: "p", text: LONG.repeat(2)},
    {tag: "p", text: "A closing paragraph."},
  ], {fragment: true});
  const measure = () => page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const layout = globalThis.StandaloneDoc.modules.layout;
    const d = pag.diagnostics();
    const frag = content.querySelector("[data-frag]");
    return {
      cut: d.splits[0]?.offset,
      pages: d.pages,
      text: content.textContent.length,
      headTop: layout.rect(frag).top - parseFloat(frag.style.marginBlockStart || "0"),
      pageBottom: d.pageBottoms[0],
      reused: d.splits.map((split) => split.reused),
      stale: d.stale,
      check: d.check,
    };
  });
  const before = await measure();
  await caretAtCut(page);
  await page.keyboard.press("Backspace");
  const after = await measure();

  expect(after.text, "one Backspace at the seam removed one character").toBe(before.text - 1);
  expect(after.pages).toBe(before.pages);
  /* The deleted character is the last of the head: the same pass re-cuts and pulls the
     next word up from the tail, so the head still ends where it did. */
  expect(after.reused.some(Boolean), "the cut was reused; the short head was not refilled").toBe(false);
  expect(after.stale).toBe(false);
  expect(
    Math.abs(after.headTop - before.headTop),
    `the head moved ${Math.round(after.headTop - before.headTop)}px instead of staying full`,
  ).toBeLessThanOrEqual(1.5);
  expect(
    before.pageBottom - after.headTop,
    "the head no longer reaches the page bottom",
  ).toBeLessThanOrEqual(30);
  expect(after.check.ok, JSON.stringify(after.check?.failures)).toBe(true);
});

test("deleting at a middle seam refills every page of an N-cut paragraph", async ({page}) => {
  await boot(page);
  await loadDoc(page, [
    {tag: "p", text: "A lead paragraph."},
    {tag: "p", text: LONG.repeat(5)},
    {tag: "p", text: "A closing paragraph."},
  ], {fragment: true});
  const holes = () => page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const layout = globalThis.StandaloneDoc.modules.layout;
    const d = pag.diagnostics();
    const block = content.querySelector("[data-frag]").parentElement;
    const frags = [...block.querySelectorAll(":scope > [data-frag]")];
    return frags.map((frag) => {
      const box = layout.rect(frag);
      const naturalTop = box.top - parseFloat(frag.style.marginBlockStart || "0");
      const page = d.pageTops.findIndex((top) => Math.abs(top - box.top) <= 1.5);
      return page > 0 ? Math.round(d.pageBottoms[page - 1] - naturalTop) : null;
    });
  });
  const before = await holes();
  expect(before.length, "the paragraph must need several cuts").toBeGreaterThan(2);
  expect(before.every((hole) => hole != null && hole <= 33), `pages were not full to begin with: ${before}`).toBe(true);

  /* Delete at the second seam: the middle page is now short, and every later segment has
     to move up to keep each page full. */
  const cut = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const target = pag.diagnostics().splits[1].offset;
    const block = content.querySelector("[data-frag]").parentElement;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let remaining = target;
    let node = walker.nextNode();
    while (node && remaining > node.nodeValue.length) { remaining -= node.nodeValue.length; node = walker.nextNode(); }
    const range = document.createRange();
    range.setStart(node, remaining);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    content.focus();
    return {offset: target, text: content.textContent.length};
  });
  await page.keyboard.press("Backspace");
  const after = await holes();
  const text = await page.evaluate(() => document.getElementById("content").textContent.length);
  expect(text).toBe(cut.text - 1);
  expect(after.length).toBe(before.length);
  expect(
    after.every((hole) => hole != null && hole <= 33),
    `a page was left short after the delete: before ${before}, after ${after}`,
  ).toBe(true);
  const check = await page.evaluate(() => globalThis.StandaloneDoc.modules.pagination.diagnostics().check);
  expect(check.ok, JSON.stringify(check?.failures)).toBe(true);
});

test("deleting at the seam stays cheap on a long document", async ({page}) => {
  await boot(page);
  const measured = await page.evaluate((LONG) => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const make = (tag, text) => { const el = document.createElement(tag); el.textContent = text; return el; };
    const blocks = [];
    for (let i = 0; i < 500; i++) blocks.push(make("p", `Paragraph ${i}, a line of ordinary prose in a long document.`));
    blocks.push(make("p", LONG));
    for (let i = 0; i < 500; i++) blocks.push(make("p", `Paragraph ${i + 500}, a line of ordinary prose in a long document.`));
    content.replaceChildren(...blocks);
    pag.setFragmenting(false);
    pag.refresh();
    pag.setFragmenting(true);
    pag.refresh();

    const placeAtSeam = () => {
      const block = content.querySelector("[data-frag]").parentElement;
      const cut = pag.diagnostics().splits[0].offset;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let remaining = cut;
      let node = walker.nextNode();
      while (node && remaining > node.nodeValue.length) { remaining -= node.nodeValue.length; node = walker.nextNode(); }
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      content.focus();
    };
    const times = [];
    const textBefore = content.textContent.length;
    /* Measure the synchronous pass a delete starts, not the driver's latency. */
    for (let i = 0; i < 8; i++) {
      placeAtSeam();
      const t0 = performance.now();
      content.dispatchEvent(new KeyboardEvent("keydown", {key: "Backspace", bubbles: true, cancelable: true}));
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const noop = [];
    for (let i = 0; i < 8; i++) {
      const t0 = performance.now();
      pag.refresh();
      noop.push(performance.now() - t0);
    }
    noop.sort((a, b) => a - b);
    return {
      blocks: content.children.length,
      pages: pag.pageCount(),
      median: times[4],
      max: times[times.length - 1],
      noop: noop[4],
      removed: textBefore - content.textContent.length,
      check: pag.diagnostics().check,
    };
  }, LONG);
  expect(measured.blocks).toBe(1001);
  expect(measured.removed, "the measured deletes did not happen").toBe(8);
  expect(measured.check.ok, JSON.stringify(measured.check?.failures)).toBe(true);
  /* A delete merges one block, re-plans and re-splits it. Measured at ~3ms on a three-block
     document and ~12ms here on CI-class hardware; the budget is generous enough to catch a
     pass that re-walks the document per keystroke, not a slow machine. */
  expect(measured.median, `median ${measured.median.toFixed(1)}ms (no-op ${measured.noop.toFixed(1)}ms)`).toBeLessThan(150);
});

test("a deletion that makes the paragraph fit drops the page in the same pass", async ({page}) => {
  await boot(page);
  await loadDoc(page, [
    {tag: "p", text: "A lead paragraph."},
    {tag: "p", text: LONG.repeat(2)},
    {tag: "p", text: "A closing paragraph."},
  ], {fragment: true});
  const before = await page.evaluate(async () => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const block = content.querySelector("[data-frag]").parentElement;
    const pages = pag.pageCount();
    const text = content.textContent.length;
    /* Enough of the head to make the whole paragraph fit one page. A head text node can be
       shorter than the cut: deleting past its end is clamped, so the test names what it
       actually removed. */
    const remove = Math.min(4300, block.firstChild.length);
    block.firstChild.deleteData(0, remove);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const d = pag.diagnostics();
    return {
      pages, text, remove,
      immediate: {pages: d.pages, fragments: d.fragments, splits: d.splits.length, stale: d.stale, text: content.textContent.length, check: d.check},
    };
  });
  expect(before.immediate.text).toBe(before.text - before.remove);
  expect(before.pages, "the fixture must start on more than one page").toBeGreaterThan(1);
  expect(before.immediate.pages, "the page the deleted text freed is still there").toBe(before.pages - 1);
  expect(before.immediate.fragments, "a block that fits must be merged, not cut").toBe(0);
  expect(before.immediate.splits).toBe(0);
  expect(before.immediate.stale).toBe(false);
  expect(before.immediate.check.ok, JSON.stringify(before.immediate.check?.failures)).toBe(true);

  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    const pag = globalThis.StandaloneDoc.modules.pagination;
    return {pages: pag.pageCount(), stale: pag.diagnostics().stale, text: document.getElementById("content").textContent.length};
  });
  expect(after.pages).toBe(before.immediate.pages);
  expect(after.text).toBe(before.immediate.text);
  expect(after.stale, "the idle reconcile ran again after an immediate re-cut").toBe(false);
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

test("a caret that moves to a new page does not drag the viewport with it", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const placed = await page.evaluate(() => {
    const content = document.getElementById("content");
    const viewport = document.getElementById("viewport");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const last = content.lastElementChild;
    const range = document.createRange();
    range.setStart(last.firstChild, Math.min(1, last.textContent.length));
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    content.focus();
    /* The reader is at the top of the document; the caret is below, out of view. */
    viewport.scrollTop = 200;
    return {
      scrollTop: viewport.scrollTop,
      pages: pag.pageCount(),
      caretBlock: [...content.children].indexOf(last),
    };
  });
  const after = await page.evaluate((placed) => new Promise((resolve) => {
    const content = document.getElementById("content");
    const viewport = document.getElementById("viewport");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const caretBlock = content.children[placed.caretBlock];
    /* Insert a page of content above the caret: it moves to a new page, which is the
       situation that used to scroll the viewport to the caret. */
    for (let i = 0; i < 30; i++) {
      const p = document.createElement("p");
      p.textContent = `Inserted paragraph ${i + 1}. ${"Words that take a line. ".repeat(4)}`;
      content.insertBefore(p, caretBlock);
    }
    setTimeout(() => resolve({
      scrollTop: viewport.scrollTop,
      pages: pag.pageCount(),
      caretBlock: [...content.children].indexOf(caretBlock),
      selection: globalThis.StandaloneDoc.modules.selection.capture(content),
    }), 150);
  }), placed);
  expect(after.pages, `pages ${placed.pages} → ${after.pages}`).toBeGreaterThan(placed.pages);
  expect(after.caretBlock, "the caret's block did not move down").toBe(placed.caretBlock + 30);
  expect(
    Math.abs(after.scrollTop - placed.scrollTop),
    `the viewport moved ${Math.round(after.scrollTop - placed.scrollTop)}px when the caret moved to a new page`,
  ).toBeLessThanOrEqual(24);
  expect(after.selection, "the caret was lost").not.toBeNull();
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
    /* While fragmenting, the editor's schedule is a pre-paint pass, so the semantic
       snapshot is re-fragmented inside exec("undo") — there is no observable unfragmented
       frame. What must hold is that the typing is gone, the text is the snapshot's, and
       the paragraph is still one paragraph with a cut. */
    pag.refresh();
    return {
      typed,
      restored,
      fragmentsAfterPass: content.querySelectorAll("[data-frag]").length,
      paragraphs: content.querySelectorAll(":scope > p").length,
      kept: pag.diagnostics().selectionKept,
      text: content.textContent.length,
    };
  }, placed);
  expect(result.typed).toBe(placed.text + 3);
  expect(result.restored, "undo did not remove the typing").toBe(placed.text);
  expect(result.fragmentsAfterPass, "the next pass did not re-fragment").toBeGreaterThan(0);
  expect(result.kept, "the caret was not restored across undo + re-fragment").toBe(true);
});

test("a click in a fragment's first line lands in the tail", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  await page.waitForTimeout(100); /* pending scroll corrections from the load pass */
  await page.evaluate(() => document.querySelector("[data-frag]").scrollIntoView({block: "center"}));
  /* Scroll-into-view can be followed by a pass or a scroll correction; measure after it
     settles or the click lands where the head used to be. */
  await page.waitForTimeout(80);
  const target = await page.evaluate(() => {
    const content = document.getElementById("content");
    const frag = content.querySelector("[data-frag]");
    const block = frag.parentElement;
    const cut = globalThis.StandaloneDoc.modules.pagination.diagnostics().splits[0].offset;
    const box = frag.getBoundingClientRect();
    return {x: box.left + 10, y: box.top + 6, block: [...content.children].indexOf(block), cut};
  });
  await page.mouse.click(target.x, target.y);
  const selection = await page.evaluate(readSelection);
  expect(selection.block, "the click left the paragraph").toBe(target.block);
  expect(selection.offset, `caret ${selection.offset}, cut ${target.cut}`).toBeGreaterThanOrEqual(target.cut);
});

test("ArrowDown from the head moves into the tail, not the gap", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const before = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const cut = pag.diagnostics().splits[0].offset;
    const block = content.querySelector("[data-frag]").parentElement;
    const target = cut - 1;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let remaining = target;
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
    return {block: [...content.children].indexOf(block), offset: target};
  });
  await page.keyboard.press("ArrowDown");
  const after = await page.evaluate(readSelection);
  const moved = after.block > before.block
    || (after.block === before.block && after.offset > before.offset);
  expect(moved, `ArrowDown stayed at ${after.block}@${after.offset} (head ${before.block}@${before.offset})`).toBe(true);
});

test("a viewport resize keeps a live selection across the cut", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const before = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const cut = pag.diagnostics().splits[0].offset;
    const block = content.querySelector("[data-frag]").parentElement;
    const point = (at) => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let remaining = at;
      let node = walker.nextNode();
      while (node && remaining > node.nodeValue.length) {
        remaining -= node.nodeValue.length;
        node = walker.nextNode();
      }
      return {node, offset: remaining};
    };
    const start = point(cut - 20);
    const end = point(cut + 20);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    content.focus();
    return {block: [...content.children].indexOf(block), start: cut - 20, end: cut + 20};
  });
  await page.setViewportSize({width: 1000, height: 700});
  await page.evaluate(() => globalThis.StandaloneDoc.modules.pagination.refresh());
  const after = await page.evaluate(readSelection);
  expect(after.block).toBe(before.block);
  expect(after.offset, `start ${after.offset}, expected ${before.start}`).toBe(before.start);
  expect(after.endOffset, `end ${after.endOffset}, expected ${before.end}`).toBe(before.end);
});

test("a no-op pass fires no selectionchange", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const count = await page.evaluate(async () => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const block = content.querySelector("[data-frag]").parentElement;
    const range = document.createRange();
    range.setStart(block.firstChild, 2);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    content.focus();
    /* `selectionchange` from our own addRange is delivered later; let it fire before the
       listener starts counting, or the test measures itself. */
    await new Promise((resolve) => setTimeout(resolve, 20));
    let fired = 0;
    const listener = () => { fired += 1; };
    document.addEventListener("selectionchange", listener);
    pag.refresh();
    await new Promise((resolve) => setTimeout(resolve, 50));
    document.removeEventListener("selectionchange", listener);
    return fired;
  });
  expect(count, "a no-op pass restored a selection that had not moved").toBe(0);
});


/* --------------------------------------------------------------- editing at the seam */

async function caretAtCut(page) {
  return page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const cut = pag.diagnostics().splits[0].offset;
    const block = content.querySelector("[data-frag]").parentElement;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let remaining = cut;
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
    return {block: [...content.children].indexOf(block), offset: cut, text: content.textContent.length};
  });
}

test("Backspace at the seam keeps the document and the fragments valid", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const before = await caretAtCut(page);
  for (let i = 0; i < 5; i++) await page.keyboard.press("Backspace");
  const after = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.refresh();
    const d = pag.diagnostics();
    return {
      text: content.textContent.length,
      fragments: d.fragments,
      check: d.check,
      kept: d.selectionKept,
    };
  });
  expect(after.text, "five Backspaces at the seam did not remove five characters").toBe(before.text - 5);
  expect(after.fragments, "the paragraph lost its fragments").toBeGreaterThan(0);
  expect(after.check.ok, JSON.stringify(after.check?.failures)).toBe(true);
  expect(after.kept, "the caret was not restored across the delete").toBe(true);
});

test("every deletion gesture that touches the seam removes exactly its range", async ({page}) => {
  /* The engines treat the fragment's block-box start as a paragraph boundary. Measured in
     all three: Backspace one character before the seam deletes two, Chromium and WebKit
     delete two for Delete at or just before it, and a selection whose range reaches the
     seam loses an extra character. The editor owns those ranges now; this table is the
     contract, with unique tokens so a wrong character cannot hide in repeated prose. */
  const cases = [
    {key: "Backspace", caret: -1, from: -2, to: -1},
    {key: "Backspace", caret: 0, from: -1, to: 0},
    {key: "Delete", caret: -2, from: -2, to: -1},
    {key: "Delete", caret: -1, from: -1, to: 0},
    {key: "Delete", caret: 0, from: 0, to: 1},
    {key: "Backspace", sel: [-1, 0], from: -1, to: 0},
    {key: "Backspace", sel: [0, 1], from: 0, to: 1},
    {key: "Backspace", sel: [-1, 1], from: -1, to: 1},
    {key: "Delete", sel: [-1, 1], from: -1, to: 1},
    {key: "Backspace", sel: [-2, 2], from: -2, to: 2},
  ];
  const tokens = (n) => Array.from({length: n}, (_, i) => `w${String(i).padStart(4, "0")}`).join(" ");

  for (const item of cases) {
    await boot(page);
    const before = await loadDoc(page, [
      {tag: "p", text: "Lead."},
      {tag: "p", text: tokens(2200)},
      {tag: "p", text: "Tail block."},
    ], {fragment: true});
    const placed = await page.evaluate(({caret, sel}) => {
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
      const [a, b] = sel ? sel : [caret, caret];
      const start = point(cut + a);
      const end = point(cut + b);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      content.focus();
      return {cut, text: block.textContent};
    }, item);

    await page.keyboard.press(item.key);
    const after = await page.evaluate(() => {
      const content = document.getElementById("content");
      const pag = globalThis.StandaloneDoc.modules.pagination;
      const block = content.children[1];
      return {
        text: block.textContent,
        total: content.textContent.length,
        fragments: pag.diagnostics().fragments,
        check: pag.diagnostics().check,
        caret: globalThis.StandaloneDoc.modules.selection.capture(content),
      };
    });

    const expected = placed.text.slice(0, placed.cut + item.from) + placed.text.slice(placed.cut + item.to);
    const label = `${item.key} ${JSON.stringify(item)}`;
    expect(after.text, `${label}: deleted the wrong text`).toBe(expected);
    expect(before.fragments, `${label}: the fixture was not fragmented`).toBeGreaterThan(0);
    expect(after.total, `${label}: the wrong number of characters left the document`)
      .toBe(before.text.length - (item.to - item.from));
    /* The paragraph is still fragmented and the document still conserves its text. */
    expect(after.fragments, `${label}: the paragraph lost its fragments`).toBeGreaterThan(0);
    expect(after.check.ok, `${label}: ${JSON.stringify(after.check?.failures)}`).toBe(true);
    expect(after.caret, `${label}: no caret after the delete`).not.toBeNull();
    expect(after.caret.start.block, `${label}: the caret left the paragraph`).toBe(1);
    expect(after.caret.start.offset, `${label}: the caret is not at the deletion point`).toBe(placed.cut + item.from);
  }
});

test("Enter at the seam leaves a document the planner can re-paginate", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const before = await caretAtCut(page);
  await page.keyboard.press("Enter");
  const after = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const text = content.textContent.length;
    const blocks = content.children.length;
    pag.refresh();
    const d = pag.diagnostics();
    return {text, blocks, fragments: d.fragments, check: d.check, paragraphs: content.querySelectorAll(":scope > p").length};
  });
  /* Enter may split the paragraph (one more block), insert a <br>, or add no character;
     what must hold is that the plan still describes the document. */
  expect(after.blocks).toBeGreaterThanOrEqual(before.block + 1);
  expect(after.check.ok, JSON.stringify(after.check?.failures)).toBe(true);
  expect(after.text).toBeGreaterThanOrEqual(before.text);
});

test("Select All and a pass preserve the whole-document selection", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const modifier = process.platform === "darwin" ? "Meta+A" : "Control+A";
  /* The shortcut selects the focused editable, not the page: focus #content first. */
  await page.evaluate(() => document.getElementById("content").focus());
  await page.keyboard.press(modifier);
  const before = await page.evaluate(() => {
    const content = document.getElementById("content");
    return globalThis.StandaloneDoc.modules.selection.capture(content);
  });
  expect(before, "Select All produced no capturable selection").not.toBeNull();
  const after = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.refresh();
    return {
      selection: globalThis.StandaloneDoc.modules.selection.capture(content),
      kept: pag.diagnostics().selectionKept,
      check: pag.diagnostics().check,
    };
  });
  expect(after.selection).not.toBeNull();
  expect(after.selection.start.block).toBe(before.start.block);
  expect(after.selection.start.offset).toBe(before.start.offset);
  expect(after.selection.end.block).toBe(before.end.block);
  expect(after.selection.end.offset).toBe(before.end.offset);
  expect(after.kept, "the pass lost Select All").toBe(true);
  expect(after.check.ok, JSON.stringify(after.check?.failures)).toBe(true);
});

test("Bold across the seam keeps the text and re-fragments", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const before = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const cut = pag.diagnostics().splits[0].offset;
    const block = content.querySelector("[data-frag]").parentElement;
    const point = (at) => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let remaining = at;
      let node = walker.nextNode();
      while (node && remaining > node.nodeValue.length) {
        remaining -= node.nodeValue.length;
        node = walker.nextNode();
      }
      return {node, offset: remaining};
    };
    const start = point(cut - 20);
    const end = point(cut + 20);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    content.focus();
    return {text: content.textContent.length};
  });
  await page.evaluate(() => globalThis.StandaloneDoc.modules.editor.exec("bold"));
  const after = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.refresh();
    return {
      text: content.textContent.length,
      bold: content.querySelectorAll("b, strong").length,
      fragments: pag.diagnostics().fragments,
      check: pag.diagnostics().check,
    };
  });
  expect(after.text, "Bold changed the text").toBe(before.text);
  expect(after.bold, "Bold did not produce a bold run").toBeGreaterThan(0);
  expect(after.fragments, "the paragraph was not re-fragmented").toBeGreaterThan(0);
  expect(after.check.ok, JSON.stringify(after.check?.failures)).toBe(true);
});

test("a triple-click selects the paragraph across a cut", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const target = await page.evaluate(() => {
    const content = document.getElementById("content");
    const frag = content.querySelector("[data-frag]");
    const block = frag.parentElement;
    block.scrollIntoView({block: "center"});
    return {block: [...content.children].indexOf(block), length: block.textContent.length};
  });
  await page.waitForTimeout(80);
  const box = await page.evaluate((index) => {
    const content = document.getElementById("content");
    const block = content.children[index];
    const viewport = document.getElementById("viewport");
    const frame = viewport.getBoundingClientRect();
    /* A line that is actually visible below the overlay toolbar: the block spans a page
       boundary, and its first line can sit under the toolbar after scrolling. */
    const range = document.createRange();
    range.selectNodeContents(block);
    const line = [...range.getClientRects()]
      .find((rect) => rect.height > 0 && rect.top > frame.top + 140 && rect.bottom < frame.bottom - 100);
    if (!line) throw new Error("no visible line in the paragraph");
    return {x: line.left + 30, y: line.top + 8};
  }, target.block);
  await page.mouse.click(box.x, box.y, {clickCount: 3});
  const selection = await page.evaluate(() => globalThis.StandaloneDoc.modules.selection.capture(
    document.getElementById("content"),
  ));
  expect(selection, "the triple-click produced no selection").not.toBeNull();
  expect(selection.start.block, "the selection did not start in the paragraph").toBe(target.block);
  expect(selection.start.offset, "the selection did not start at the paragraph start").toBe(0);
  expect(selection.end.block, "the selection did not end in the paragraph").toBe(target.block);
  expect(selection.end.offset, "the selection did not reach the paragraph end").toBe(target.length);

  const after = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    pag.refresh();
    return {selection: globalThis.StandaloneDoc.modules.selection.capture(content), kept: pag.diagnostics().selectionKept};
  });
  expect(after.selection?.start.offset).toBe(0);
  expect(after.selection?.end.offset).toBe(target.length);
  expect(after.kept, "a pass lost the paragraph selection").toBe(true);
});

test("ArrowUp from the tail returns to the head, not the gap", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const before = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    const cut = pag.diagnostics().splits[0].offset;
    const block = content.querySelector("[data-frag]").parentElement;
    const target = cut + 1;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let remaining = target;
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
    return {block: [...content.children].indexOf(block), cut};
  });
  await page.keyboard.press("ArrowUp");
  const after = await page.evaluate(readSelection);
  const movedUp = after.block < before.block
    || (after.block === before.block && after.offset < before.cut);
  expect(movedUp, `ArrowUp stayed at ${after.block}@${after.offset} (cut ${before.cut})`).toBe(true);
});

test("a composition at the seam commits and paginates after it ends", async ({page}) => {
  await boot(page);
  await loadDoc(page, FIXTURE, {fragment: true});
  const before = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
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
    content.dispatchEvent(new CompositionEvent("compositionstart", {bubbles: true}));
    document.execCommand("insertText", false, "に");
    return {
      text: content.textContent.length,
      composing: globalThis.StandaloneDoc.modules.signals.composing,
      cut,
      block: [...content.children].indexOf(block),
    };
  });
  expect(before.composing, "compositionstart did not reach signals").toBe(true);
  await page.waitForTimeout(120);
  const during = await page.evaluate(() => ({
    text: document.getElementById("content").textContent.length,
    cut: globalThis.StandaloneDoc.modules.pagination.diagnostics().splits[0]?.offset ?? null,
  }));
  expect(during.text, "the composition string was lost").toBe(before.text);
  await page.evaluate(() => document.getElementById("content")
    .dispatchEvent(new CompositionEvent("compositionend", {bubbles: true})));
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pag = globalThis.StandaloneDoc.modules.pagination;
    return {
      text: content.textContent.length,
      fragments: pag.diagnostics().fragments,
      check: pag.diagnostics().check,
      kept: pag.diagnostics().selectionKept,
    };
  });
  expect(after.text).toBe(before.text);
  expect(after.fragments, "the paragraph lost its fragments after composition").toBeGreaterThan(0);
  expect(after.check.ok, JSON.stringify(after.check?.failures)).toBe(true);
});
