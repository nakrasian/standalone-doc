/* Page planning: gaps as margins, and (behind a session flag) fragments inside a block.
 *
 * The lab's conclusions, in the order they constrain this file:
 *
 *   - **The page gap is a margin, not a node.** `.page-spacer` was removed and inserted
 *     under a live caret; every engine then scrolled the block a page while keeping the
 *     caret's offset (+882 / +490 / +1097 px). It was also a node inside a cross-block
 *     selection, so all three engines reported it as a 948 px selection rect. A
 *     `margin-block-start` on the first block of a page has neither problem: the plan is
 *     identical by construction (`measureH()` excludes margins), and there is nothing in
 *     the flow to remove.
 *
 *   - **A page break inside a paragraph is a `display:block` span inside the same `<p>`**,
 *     never two `<p>`s. One paragraph before and after, `textContent` unchanged, and the
 *     tail pushable by any amount. The export path unwraps the span, so pandoc sees the
 *     paragraph the author wrote.
 *
 *   - **Measurement happens on the merged document**, because a fragmented block is
 *     taller than the text it holds; planning over fragments plans its own output.
 *
 *   - **A pass states its post-conditions and reports them** (`checkPass()` below). The
 *     origin bug (§12.1) passed every appearance test and was caught only by comparing
 *     the tail's measured top with the page top the plan named.
 *
 * The split point is chosen by geometry only (line boxes → binary search on range rects),
 * never hit testing: `plan()` must be able to measure a block below the fold.
 *
 * **What a block *is* lives in one table** (`DEFAULT_STRATEGIES` / `strategyForTag`): a
 * paragraph is lines, a heading is whole, a figure is atomic, a blockquote is lines only
 * when its children are inline. A plugin can override an entry with `defineBlock()`; the
 * planner asks `strategy(el)` rather than carrying a Set. `keepWithNext` is a property now,
 * not a policy: nothing enforces it yet, and a heading may be the last block on a page.
 */

/* ------------------------------------------------------------------ pure: the cut */

/**
 * Back an offset up to the start of the word it lands in, so a page never breaks
 * mid-word. `offset` is the first character of the tail; the character before it is the
 * last character of the head. Text with no whitespace before the cut (a URL, CJK prose)
 * keeps the geometric offset: there is no word boundary to move to, and a cut is better
 * than a page of white space.
 */
export function wordBoundary(text, offset) {
  const start = Math.max(1, Math.min(offset, text.length));
  let at = start;
  while (at > 1 && !/\s/.test(text[at - 1])) at -= 1;
  return at > 1 ? at : start;
}

/**
 * The last line index whose bottom fits in `room`, or -1 when the block must move whole.
 * Pure: `lines` are `{top, bottom}` in layout px, already sorted and measured.
 *
 * `minLines` is a widow guard. A one-line head is a page with a line at the top and white
 * space below it; moving the block whole is the lesser evil, and it is what the shipped
 * planner did for every block.
 */
export function lineForRoom(lines, blockTop, room, minLines = 2) {
  if (!lines || lines.length < minLines) return -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].bottom - blockTop <= room - 1) last = i;
  }
  if (last < minLines - 1) return -1;
  if (last === lines.length - 1) return -1;
  return last;
}

/**
 * Choose the cut for a block that overflows `room`.
 *
 * `lineTopAt(offset)` and `lineBottomAt(offset)` are the geometry half (the DOM supplies
 * them); the choice itself is pure so it can be fuzzed in node. `lineTopAt` is the top of
 * the last line the prefix `[0, offset)` reaches — monotonic in every engine the lab
 * measured — which is what makes the binary search valid without hit testing.
 *
 * Returns `{offset, headHeight, headBottom, cutLine}` or null. The head height is
 * **recomputed after the word-boundary back-off**: back-off moves the cut earlier, so the
 * head loses a word (sometimes a whole line), and a plan that kept the pre-back-off
 * height would under-count the tail and place the following blocks too high. That was a
 * live bug in the lab version, invisible until a page had a word straddling its edge.
 */
export function chooseCut({text, lines, blockTop, room, lineTopAt, lineBottomAt, minLines = 2}) {
  const last = lineForRoom(lines, blockTop, room, minLines);
  if (last < 0) return null;

  const cutTop = lines[last + 1].top - 0.5;
  let low = 1;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (lineTopAt(mid) >= cutTop) high = mid;
    else low = mid + 1;
  }
  const geometric = low;
  const offset = wordBoundary(text, geometric);

  if (offset <= 0 || offset >= text.length) return null;

  const headBottom = lineBottomAt(offset);
  if (!Number.isFinite(headBottom)) return null;
  /* A cut that would leave the head taller than the room is not a cut. */
  if (headBottom - blockTop > room + 1) return null;
  /* Back-off must not shrink the head below the widow guard. */
  if (headBottom < lines[minLines - 1].bottom - 1) return null;

  return {
    offset,
    geometric,
    headHeight: headBottom - blockTop,
    headBottom,
    cutLine: last + 1,
    lines: lines.length,
  };
}

/* --------------------------------------------------- pure: post-conditions of a pass */

/**
 * What a fragmenting pass must prove. Every failure carries the numbers that disagreed:
 * "tail at 1050, target 1168 (off by -118)" is a bug report; "geometry wrong" is a shrug.
 *
 * `rectOf(el)` returns layout px — `layout.rect`. Passing it in (rather than importing a
 * DOM) is what lets the rules be tested without a browser.
 */
export function checkPass({
  content,
  applied = [],
  plan = null,
  pageTops = [],
  pageBottoms = [],
  textBefore = null,
  rectOf,
  tolerance = 1.5,
}) {
  const failures = [];
  const notes = [];
  const frags = [...content.querySelectorAll("[data-frag]")];

  /* 1. Fragmenting moves nodes; it never edits them. `textBefore` is captured *before*
     the merge, so a merge that loses a character is caught too. */
  if (textBefore != null && content.textContent !== textBefore) {
    failures.push(`text changed by ${content.textContent.length - textBefore.length} characters`);
  }

  /* 2. One fragment per cut, in plan order, carrying the offset the plan chose. */
  if (frags.length !== applied.length) {
    failures.push(`${frags.length} fragment(s) for ${applied.length} cut(s)`);
  }
  for (const [i, cut] of applied.entries()) {
    const frag = frags[i];
    if (!frag) continue;
    if (Number(frag.dataset.frag) !== cut.offset) {
      failures.push(`fragment ${i}: carries offset ${frag.dataset.frag}, plan said ${cut.offset}`);
    }
    const parent = frag.parentElement;
    if (!parent || parent.querySelectorAll(":scope > [data-frag]").length > 1) {
      failures.push(`fragment ${i}: more than one fragment in one block`);
    }
    if (!frag.textContent.length) failures.push(`fragment ${i}: is empty`);
  }

  /* 3. Geometry: the tail sits at the page content top the plan named. */
  for (const [i, cut] of applied.entries()) {
    const frag = frags[i];
    if (!frag) continue;
    const box = rectOf(frag);
    if (Math.abs(box.top - cut.targetTop) > tolerance) {
      failures.push(`fragment ${i}: tail at ${Math.round(box.top)}, target ${Math.round(cut.targetTop)} (off by ${Math.round(box.top - cut.targetTop)})`);
    }
    if (!pageTops.some((top) => Math.abs(top - cut.targetTop) <= tolerance)) {
      failures.push(`fragment ${i}: target ${Math.round(cut.targetTop)} is not a page content top (${pageTops.map((t) => Math.round(t)).join(", ")})`);
    }
    const headBottom = box.top - parseFloat(frag.style.marginBlockStart || "0");
    const pageIndex = pageBottoms.findIndex((bottom) => bottom + tolerance >= headBottom);
    if (pageIndex < 0) failures.push(`fragment ${i}: head ends below every page (${Math.round(headBottom)})`);
    else if (headBottom < pageTops[pageIndex] - tolerance) failures.push(`fragment ${i}: head ends above page ${pageIndex + 1}'s content top`);
    else notes.push(`fragment ${i}: head ${Math.round(headBottom)}→tail ${Math.round(box.top)} of page ${pageIndex + 2}`);
  }

  /* 4. The plan is internally consistent: a cut block has exactly two items, and they
     meet at the offset. This is the `from/to` seam that made `continued` always false. */
  if (plan) {
    const items = plan.pages.flatMap((page) => page.items);
    const cutBlocks = new Set(applied.map((cut) => plan.blocks.indexOf(cut.block)));
    for (const blockIndex of cutBlocks) {
      if (blockIndex < 0) continue;
      const onPages = items.filter((item) => item.block === blockIndex);
      if (onPages.length !== 2) failures.push(`block ${blockIndex}: ${onPages.length} page items after a cut, expected 2`);
      else if (onPages[0].to == null) failures.push(`block ${blockIndex}: the first page item has no to-offset`);
      else if (onPages[1].from !== onPages[0].to) failures.push(`block ${blockIndex}: from/to do not meet (${onPages[0].to} vs ${onPages[1].from})`);
    }
  }

  /* 5. No orphan margin: a block that is not a page start carries no page-start margin. */
  for (const el of content.querySelectorAll("[data-page-start]")) {
    if (!el.style.marginBlockStart) failures.push("a page-start block has no margin");
  }

  return {ok: failures.length === 0, failures, notes};
}

/* ------------------------------------------------------- pure: block strategies */

export const ATOMIC_STRATEGY = Object.freeze({kind: "atomic", keepWithNext: false});

/**
 * What a block type means to the planner:
 *
 *   lines            a sequence of line boxes; a cut may enter it
 *   atomic           one box; it moves whole and may be taller than a page
 *   whole            not cut, and eligible for `keepWithNext`
 *   lines-if-inline  `lines` only when every child is inline — a blockquote of `<p>`s is a
 *                    container, and a `display:block` span holding `<p>`s would be invalid
 *                    HTML
 *
 * `keepWithNext` is recorded, not enforced: the planner does not separate a heading from its
 * next block today. Default false, headings included — a heading may be a page's last block.
 */
export const DEFAULT_STRATEGIES = Object.freeze({
  p: Object.freeze({kind: "lines", minLines: 2, keepWithNext: false}),
  blockquote: Object.freeze({kind: "lines-if-inline", minLines: 2, keepWithNext: false}),
  h1: Object.freeze({kind: "whole", keepWithNext: false}),
  h2: Object.freeze({kind: "whole", keepWithNext: false}),
  h3: Object.freeze({kind: "whole", keepWithNext: false}),
  h4: Object.freeze({kind: "whole", keepWithNext: false}),
  h5: Object.freeze({kind: "whole", keepWithNext: false}),
  h6: Object.freeze({kind: "whole", keepWithNext: false}),
  pre: ATOMIC_STRATEGY,
  table: ATOMIC_STRATEGY,
  figure: ATOMIC_STRATEGY,
  hr: ATOMIC_STRATEGY,
  ul: ATOMIC_STRATEGY,
  ol: ATOMIC_STRATEGY,
  li: ATOMIC_STRATEGY,
  div: ATOMIC_STRATEGY,
  section: ATOMIC_STRATEGY,
});

/**
 * The pure resolver: tag plus two facts about the element's children. The DOM wrapper in
 * `createPagination()` supplies those facts, so this can be tested in node.
 */
export function strategyForTag(tag, {blockChildren = false, replaced = false} = {}) {
  const base = DEFAULT_STRATEGIES[tag] || ATOMIC_STRATEGY;
  if (base.kind === "lines-if-inline") {
    return blockChildren ? ATOMIC_STRATEGY : {...base, kind: "lines"};
  }
  if (base.kind === "lines" && replaced) return ATOMIC_STRATEGY;
  return base;
}

/* --------------------------------------------------------------- the pagination engine */

export function createPagination(deps = {}) {
  const {signals, zoom, layout, selection, env = globalThis} = deps;
  const {document} = env;

  /** Phrasing children. An unknown tag counts as block: safer than cutting a structure. */
  const INLINE_TAGS = new Set([
    "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del", "dfn", "em", "i",
    "img", "ins", "kbd", "mark", "math", "q", "rp", "rt", "ruby", "s", "samp", "small",
    "span", "strong", "sub", "sup", "time", "u", "var", "wbr", "svg", "audio", "video",
    "iframe", "object", "embed",
  ]);

  const content = document.getElementById("content");
  const sheets = document.getElementById("sheets");
  const stage = document.getElementById("stage");
  const viewport = document.getElementById("viewport");

  /* Calculate the height, pitch, and padding of the probe element. The probes are outside
     `#stage`, so these are layout px already; dividing again would make a zoomed view
     re-paginate. */
  const prContent = document.getElementById("probe-content-h");
  const prPitch = document.getElementById("probe-pitch");
  const prPad = document.getElementById("probe-pad");

  /* One table for what a block is, shared with plugins (see DEFAULT_STRATEGIES). */
  const strategies = new Map(Object.entries(DEFAULT_STRATEGIES));
  const hasBlockChildren = (el) => [...el.children]
    .some((child) => !INLINE_TAGS.has(child.localName));
  const hasReplaced = (el) => Boolean(el.querySelector(
    "img, iframe, video, audio, svg, object, embed, [data-runtime]",
  ));

  function strategy(el) {
    const base = strategies.get(el.localName) || ATOMIC_STRATEGY;
    if (base.kind === "lines-if-inline") {
      return hasBlockChildren(el) ? ATOMIC_STRATEGY : {...base, kind: "lines"};
    }
    if (base.kind === "lines" && hasReplaced(el)) return ATOMIC_STRATEGY;
    return base;
  }

  /** A plugin's seam: replace what a tag means without a new asset or a rebuild. */
  function defineBlock(tag, spec) {
    strategies.set(tag, {...spec});
    return strategies.get(tag);
  }

  /* Session-only, never persisted: a document never carries a fragment. `setFragmenting()`
     exists so a mode can decide (PLAN-comments §9's open question) and so tests can drive
     both paths without a build. The default is off until the caret/history deltas land. */
  let fragmenting = deps.fragment === true;

  function geometry() {
    const px = (el) => el.getBoundingClientRect().height;

    const contentH = px(prContent);
    const pitch = px(prPitch);
    const pad = px(prPad);

    return {
      contentH,
      pitch,
      pad,
      chromeGap: pitch - contentH,
    };
  }

  function collectBlocks() {
    return [...content.children].filter(
      (el) => !el.classList.contains("page-spacer")
    );
  }

  /* ---------------------------------------------------------- fragments (DOM side) */

  /** One line box per visual line, in layout px. Docs live inside the zoomed stage, and
      a range rect carries the stage's client origin just like an element's does. */
  function lineBoxes(block) {
    const o = layout.origin();
    const range = document.createRange();
    range.selectNodeContents(block);
    const lines = [];
    for (const rect of range.getClientRects()) {
      const top = (rect.top - o.top) / o.scale;
      const bottom = (rect.bottom - o.top) / o.scale;
      const last = lines[lines.length - 1];
      /* Inline children can return two rects on the same line; a line is one box. */
      if (last && Math.abs(last.top - top) < 1) {
        last.bottom = Math.max(last.bottom, bottom);
        continue;
      }
      lines.push({top, bottom});
    }
    return lines;
  }

  /** {node, offset} for a character offset within a block's text content. */
  function pointAt(block, offset) {
    let remaining = Math.max(0, offset);
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let last = null;
    while (node) {
      last = node;
      if (remaining <= node.nodeValue.length) return {node, offset: remaining};
      remaining -= node.nodeValue.length;
      node = walker.nextNode();
    }
    return last ? {node: last, offset: last.nodeValue.length} : {node: block, offset: 0};
  }

  /** The top of the last line a prefix `[0, offset)` reaches, or -Infinity. */
  function lineTopAt(block, offset) {
    const o = layout.origin();
    const point = pointAt(block, offset);
    const range = document.createRange();
    range.setStart(block, 0);
    try {
      range.setEnd(point.node, point.offset);
    } catch {
      return -Infinity;
    }
    const rects = range.getClientRects();
    return rects.length ? (rects[rects.length - 1].top - o.top) / o.scale : -Infinity;
  }

  /** The bottom of the head `[0, offset)`. Max, not last: a hanging space can report a
      zero-height rect on the next line. Zero-height rects cannot extend it. */
  function lineBottomAt(block, offset) {
    const o = layout.origin();
    const point = pointAt(block, offset);
    const range = document.createRange();
    range.setStart(block, 0);
    try {
      range.setEnd(point.node, point.offset);
    } catch {
      return -Infinity;
    }
    let bottom = -Infinity;
    for (const rect of range.getClientRects()) {
      if (rect.height > 0.5) bottom = Math.max(bottom, (rect.bottom - o.top) / o.scale);
    }
    return bottom;
  }

  /** True when the cut point sits inside an element an author may have linked to. Splitting
      there would clone the element and duplicate its `id` (Range.extractContents), so the
      block moves whole instead. */
  function anchoredAt(block, offset) {
    const point = pointAt(block, offset);
    let node = point.node;
    while (node && node !== block) {
      if (node.nodeType === Node.ELEMENT_NODE && node.id) return true;
      node = node.parentNode;
    }
    return false;
  }

  /** The cut that makes this block fit in `room` layout px, or null. */
  function planSplit(block, room, minLines = 2) {
    const box = layout.rect(block);
    const lines = lineBoxes(block);
    const cut = chooseCut({
      text: block.textContent,
      lines,
      blockTop: box.top,
      room,
      lineTopAt: (offset) => lineTopAt(block, offset),
      lineBottomAt: (offset) => lineBottomAt(block, offset),
      minLines,
    });
    if (!cut) return null;
    if (anchoredAt(block, cut.offset)) return null;
    return {...cut, room, blockTop: box.top, blockHeight: box.height};
  }

  /**
   * Cut the block at `offset` and group everything after it into a block-level span.
   * `Range.extractContents()` is used rather than node shuffling so nested inline markup
   * (a link, an `<em>`) survives the move.
   */
  function splitBlock(block, offset) {
    const point = pointAt(block, offset);
    const range = document.createRange();
    range.setStart(point.node, point.offset);
    range.setEnd(block, block.childNodes.length);
    const frag = document.createElement("span");
    frag.setAttribute("data-frag", String(offset));
    frag.style.display = "block";
    frag.append(range.extractContents());
    block.append(frag);
    return frag;
  }

  /** Undo every split: measurement must always see the semantic document. */
  function mergeFragments() {
    const frags = [...content.querySelectorAll("[data-frag]")];
    for (const frag of frags) {
      const parent = frag.parentNode;
      if (!parent) continue;
      while (frag.firstChild) parent.insertBefore(frag.firstChild, frag);
      frag.remove();
      /* Adjacent text nodes are re-merged here, not only at the top level: a fragment can
         sit inside a nested block after an edit, and a half-normalised parent makes the
         next `pointAt()` produce a different cut. */
      parent.normalize();
    }
    return frags.length;
  }

  /**
   * Realise a plan's splits: each tail must start at its next page's content top.
   * Returns the measured pushes so a report can show what happened.
   */
  function applyFragments(splits) {
    const applied = [];
    for (const split of splits) {
      const frag = splitBlock(split.block, split.offset);
      const fragTop = layout.rect(frag).top;
      const push = Math.max(0, Math.round(split.targetTop - fragTop));
      frag.style.marginBlockStart = `${push}px`;
      applied.push({
        block: split.block,
        offset: split.offset,
        push,
        targetTop: split.targetTop,
        fragTopBefore: Math.round(fragTop),
        fragTopAfter: Math.round(layout.rect(frag).top),
        plan: split.plan ?? null,
        blockTopAtApply: Math.round(layout.rect(split.block).top),
        blockMargin: split.block.style.marginBlockStart || "",
        blockIsPageStart: split.block.hasAttribute("data-page-start"),
      });
    }
    return applied;
  }

  const fragmentCount = () => content.querySelectorAll("[data-frag]").length;

  /* --------------------------------------------------------------- the page plan */

  function plan() {
    const g = geometry();
    const blocks = collectBlocks();

    const pages = [{top: 0, avail: g.contentH, items: []}];
    const spacers = [];
    const splits = [];
    const oversize = [];
    let cursor = 0;

    for (let i = 0; i < blocks.length; i++) {
      const el = blocks[i];
      const h = layout.measureH(el);
      const tall = h > g.contentH; // Check if larger than page height
      let page = pages[pages.length - 1];

      // Check if block overflows and adds page + gap
      if (page.items.length && cursor + h > page.top + page.avail) {
        const nextTop = page.top + page.avail + g.chromeGap;

        /* A block that is not atomic may be cut at its last line that fits. Its tail must
           itself fit one page: a single cut cannot make a two-page block one page, and a
           tail that overflows would paint outside the sheet. (N cuts is the next step; a
           tall block still takes a page of its own, unchanged.) */
        const room = page.top + page.avail - cursor;
        const spec = strategy(el);
        const cut = fragmenting && !tall && spec.kind === "lines"
          ? planSplit(el, room, spec.minLines ?? 2)
          : null;

        if (cut && h - cut.headHeight <= g.contentH) {
          page.items.push({block: i, from: 0, to: cut.offset});
          pages.push({top: nextTop, avail: g.contentH, items: [{block: i, from: cut.offset, to: null}]});
          splits.push({
            block: el,
            offset: cut.offset,
            headHeight: cut.headHeight,
            targetTop: nextTop + g.pad,
            plan: {
              room: Math.round(cut.room),
              blockTop: Math.round(cut.blockTop),
              lines: cut.lines,
              cutLine: cut.cutLine,
              geometric: cut.geometric,
              blockHeight: Math.round(cut.blockHeight),
              headHeight: Math.round(cut.headHeight),
              cursor: Math.round(cursor),
              nextTop: Math.round(nextTop),
            },
          });
          cursor = nextTop + (h - cut.headHeight);
          continue;
        }

        spacers.push({
          before: el,
          height: nextTop - cursor,
        });

        page = {top: nextTop, avail: g.contentH, items: []};
        pages.push(page);
        cursor = nextTop;
      }
      // Resizes page size to size of oversized block
      if (tall) {
        page.avail = h;
        oversize.push(i);
      }

      page.items.push({block: i, from: 0, to: null});
      cursor += h;

      if (tall && i < blocks.length - 1) {
        const nextTop = page.top + page.avail + g.chromeGap;
        page = {top: nextTop, avail: g.contentH, items: []};
        pages.push(page);
        cursor = nextTop;
      }
    }

    return {
      blocks, pages, spacers, splits, oversize, ...g,
      /* Page content edges in layout px, the coordinate everything else must agree with. */
      pageTops: pages.map((page) => layout.pageContentTop(page, g.pad)),
      pageBottoms: pages.map((page) => layout.pageContentBottom(page, g.pad)),
    };
  }

  // The page gap lives on the block that starts the page, not in a node before it.
  // `plan()` already names exactly those blocks (`p.spacers[].before`), so the arithmetic
  // does not change — only how the gap is realised.
  function applyGaps(p) {
    /* A spacer from an older session is removed, never added. No file the current save
       path writes carries one; this is the one-way migration for a live DOM. */
    for (const sp of [...content.querySelectorAll(".page-spacer")]) sp.remove();

    const wanted = new Map(p.spacers.map((s) => [s.before, Math.round(s.height)]));

    // Anything that no longer starts a page loses its margin, in this pass, not later.
    for (const el of [...content.querySelectorAll("[data-page-start]")]) {
      if (wanted.has(el)) continue;
      el.style.marginBlockStart = "";
      el.removeAttribute("data-page-start");
      if (!el.getAttribute("style")) el.removeAttribute("style");
    }

    for (const [block, height] of wanted) {
      block.setAttribute("data-page-start", "");
      const current = parseFloat(block.style.marginBlockStart || "0");
      if (Math.abs(current - height) > 0.5) block.style.marginBlockStart = height + "px";
    }
  }

  // Use the plan to create sheets, pages, and blocks
  function buildModel(p) {
    return p.pages.map((page, k) => {
      const first = page.items[0];

      return {
        head: "", // intentionally empty for now; not derived from headings
        folio: `${k + 1} / ${p.pages.length}`,
        recto: k % 2 === 0,
        continued: !!first && first.from > 0,
      };
    });
  }

  // Render sheets based off of plan
  function renderSheets(p, model) {
    const need = p.pages.length;
    const cells = [...sheets.children];

    // Removes sheets that don't have page content
    while (cells.length > need) cells.pop().remove();

    while (cells.length < need) {
      const sheet = document.createElement("div");
      sheet.className = "sheet";

      // Adds elements for headers and footers
      for (const slot of ["head", "folio"]) {
        const box = document.createElement("div");
        box.className = "sheet-margin";
        box.dataset.slot = slot;
        sheet.append(box);
      }

      sheets.append(sheet);
      cells.push(sheet);
    }

    cells.forEach((sheet, k) => {
      const pg = p.pages[k];
      const m = model[k];

      sheet.style.top = pg.top + "px";
      sheet.style.height = (pg.avail + 2 * p.pad) + "px"; // Pages height + padding

      sheet.dataset.page = String(k + 1);
      sheet.dataset.side = m.recto ? "recto" : "verso";
      sheet.toggleAttribute("data-first", k === 0);
      sheet.toggleAttribute("data-continued", m.continued);

      sheet.querySelector('[data-slot="head"]').textContent = m.head || "";
      sheet.querySelector('[data-slot="folio"]').textContent = m.folio || "";
    });

    const last = p.pages[need - 1];
    stage.style.minHeight = (last.top + last.avail + 2 * p.pad) + "px";
  }

  // Rendering/reformatting logic:
  let applying = false;
  let timer = null;
  let queued = false;
  let lastRun = 0;

  // Queue up the replanning and page change event
  function schedule() {
    if (queued || applying || signals.composing) return;

    queued = true;
    const idle = performance.now() - lastRun > 350;

    clearTimeout(timer);
    timer = setTimeout(() => {
      requestAnimationFrame(() => {
        queued = false;
        lastRun = performance.now();
        refresh();
      });
    }, idle ? 0 : 120);
  }

  signals.on("mutation", () => schedule());
  signals.on("resize", schedule);
  signals.on("compositionend", schedule);

  (document.fonts ? document.fonts.ready : Promise.resolve()).then(schedule);

  // Refresh setup starting from Plan to rendering sheets
  let lastPlan = null;

  function pageCount() {
    return lastPlan && lastPlan.p ? lastPlan.p.pages.length : 1;
  }

  /* The page under the reader's eye: the sheet covering the centre of the viewport.
     Centre, not top — a tall figure can fill the top of the screen while the reader is
     still on the page above. Layout px, so the zoomed scroll offset is divided out,
     exactly as measureH() does. */
  function pageAt(clientY = viewport.clientHeight / 2) {
    const pages = lastPlan?.p?.pages;
    if (!pages || !pages.length) return 1;
    const y = layout.viewportY(clientY);
    for (let i = 0; i < pages.length; i++) {
      if (y < pages[i].top + pages[i].avail) return i + 1;
    }
    return pages.length;
  }

  /* Every `[data-folio]` in the document, the way zoom.syncUI() owns [data-zoom-label].
     Page numbers are written in one place because two bars show them: the editor's
     minimal chrome and a viewer's bar. A scroll tick, not a signal — pagination does not
     mutate while the reader scrolls. */
  let folioFrame = 0;

  function syncFolio() {
    folioFrame = 0;
    const nodes = document.querySelectorAll("[data-folio]");
    if (!nodes.length) return;
    const text = `p. ${pageAt()} / ${pageCount()}`;
    for (const node of nodes) {
      if (node.textContent !== text) node.textContent = text;
    }
  }

  /* The viewport anchor: the selected block's client top before a pass, restored after.
     The page model can move content when the plan changes (a page added or removed); the
     reader is looking at the caret, so that block must stay put within a line. */
  function scrollAnchor() {
    const saved = selection.capture(content);
    if (!saved) return null;
    const block = content.children[saved.start.block];
    if (!block) return null;
    return {block, top: block.getBoundingClientRect().top};
  }

  function restoreScroll(anchor) {
    if (!anchor || !anchor.block.isConnected) return;
    const delta = anchor.block.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 0.5) viewport.scrollTop += delta;
  }

  function pass({merge = false} = {}) {
    if (applying) return;

    applying = true;
    let merged = 0;
    let applied = [];
    let check = null;
    let selectionKept = null;
    const anchor = scrollAnchor();
    try {
      const outcome = selection.preserve(content, () => signals.mute(() => {
        /* Measurement must see the semantic document: a fragmented block is taller than
           the text it holds, so planning over fragments would plan its own output. The
           text is captured *before* the merge so a merge that loses characters fails the
           post-condition instead of hiding in it. */
        const mustMerge = fragmenting || merge;
        const textBefore = mustMerge ? content.textContent : null;
        if (mustMerge) merged = mergeFragments();
        const p = plan();
        applyGaps(p);
        if (fragmenting) applied = applyFragments(p.splits);
        const model = buildModel(p);
        renderSheets(p, model);
        if (fragmenting) {
          check = checkPass({
            content,
            applied,
            plan: p,
            pageTops: p.pageTops,
            pageBottoms: p.pageBottoms,
            textBefore,
            rectOf: layout.rect,
          });
          if (!check.ok) {
            const message = `pagination: ${check.failures.join("; ")}`;
            if (deps.strict) throw new Error(message);
            console.warn(message);
          }
        }
        lastPlan = {p, merged, applied, check};
      }));
      selectionKept = outcome.kept;
      lastPlan.selectionKept = selectionKept;
    } catch (err) {
      /* Transactional: a broken pass must never leave a half-fragmented document on
         screen. Merge, leave the plan alone, and let the caller see the error. */
      if (fragmenting) {
        try { mergeFragments(); } catch { /* nothing left to salvage */ }
      }
      throw err;
    } finally {
      applying = false;
      /* After the selection is back: a browser may scroll to reveal the caret, and the
         anchor correction should be the last word on where the reader is. */
      restoreScroll(anchor);
    }
    signals.emit("layout", {pages: pageCount(), check});
  }

  function refresh(options = {}) {
    pass(options);
  }

  /** Session-only: fragment inside paragraphs, or keep blocks whole. Not persisted. */
  function setFragmenting(next) {
    const wanted = next === true;
    if (wanted === fragmenting) {
      refresh();
      return fragmenting;
    }
    fragmenting = wanted;
    /* Turning it off must also remove what it left, but the merge has to happen *inside*
       the pass: it reflows the document, and the selection and scroll anchors must be
       captured before it, not after. A pass without fragmentation does not merge by
       itself, so it is asked to. */
    refresh({merge: !wanted});
    return fragmenting;
  }

  /* What a pass did, for a report, a test, or the next phase's comment layer. */
  function diagnostics() {
    const p = lastPlan?.p ?? null;
    return {
      pages: pageCount(),
      fragmenting,
      fragments: fragmenting ? fragmentCount() : 0,
      gaps: p ? p.spacers.length : 0,
      mergedLastPass: lastPlan?.merged ?? 0,
      selectionKept: lastPlan?.selectionKept ?? null,
      check: lastPlan?.check ?? null,
      pageTops: p?.pageTops ?? [],
      pageBottoms: p?.pageBottoms ?? [],
      items: p ? p.pages.map((page) => page.items.map((item) => ({block: item.block, from: item.from, to: item.to}))) : [],
      splits: (lastPlan?.applied ?? []).map((applied) => ({
        offset: applied.offset,
        push: applied.push,
        targetTop: applied.targetTop,
        fragTopBefore: applied.fragTopBefore,
        fragTopAfter: applied.fragTopAfter,
        blockMargin: applied.blockMargin,
        blockIsPageStart: applied.blockIsPageStart,
        plan: applied.plan,
      })),
    };
  }

  /* The reader moves; the pages do not. One rAF-throttled tick per scroll burst. */
  viewport.addEventListener("scroll", () => {
    if (!folioFrame) folioFrame = requestAnimationFrame(syncFolio);
  }, {passive: true});
  signals.on("layout", syncFolio);

  // Render once immediately, then again after fonts settle.
  refresh();
  syncFolio();
  return {
    schedule, pageCount, pageAt, syncFolio, refresh, setFragmenting, diagnostics,
    strategy, defineBlock,
    plan: () => lastPlan?.p ?? null,
  };
}
