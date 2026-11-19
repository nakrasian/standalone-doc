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
export function chooseCut({text, lines, blockTop, room, lineTopAt, lineBottomAt, minLines = 2, start = 0}) {
  const last = lineForRoom(lines, blockTop, room, minLines);
  if (last < 0) return null;

  const cutTop = lines[last + 1].top - 0.5;
  /* A tail starts at `start`; the next cut must be after it. */
  let low = Math.max(1, start + 1);
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (lineTopAt(mid) >= cutTop) high = mid;
    else low = mid + 1;
  }
  const geometric = low;
  /* A word that straddles the segment start cannot be backed up past it. */
  let offset = Math.max(start + 1, wordBoundary(text, geometric));
  /* The search looks at the last line a *prefix* reaches, so it lands one character into
     the next line. When there is a space to back up to, `wordBoundary` moves to it; with no
     whitespace (CJK, a URL) the cut would keep that character and the head would include a
     line that does not fit. Step back to the line start instead. */
  if (offset === geometric && geometric > start + 1 && !/\s/.test(text[geometric - 1])) {
    offset -= 1;
  }

  if (offset <= start || offset >= text.length) return null;

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
    /* N cuts make several sibling fragments in one block; a nested fragment would make
       the page pushes compound, and a fragment in another block is a mis-split. */
    if (!parent || parent !== cut.block) failures.push(`fragment ${i}: sits in a different block`);
    if (frag.querySelector("[data-frag]")) failures.push(`fragment ${i}: is nested inside another fragment`);
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
      const cuts = applied.filter((cut) => plan.blocks.indexOf(cut.block) === blockIndex);
      const onPages = items.filter((item) => item.block === blockIndex);
      if (onPages.length !== cuts.length + 1) {
        failures.push(`block ${blockIndex}: ${onPages.length} page items for ${cuts.length} cut(s)`);
        continue;
      }
      if (onPages[0].from !== 0) failures.push(`block ${blockIndex}: the first page item starts at ${onPages[0].from}`);
      if (onPages[onPages.length - 1].to != null) failures.push(`block ${blockIndex}: the last page item has a to-offset`);
      for (let j = 0; j < onPages.length - 1; j++) {
        if (onPages[j].to == null) failures.push(`block ${blockIndex}: page item ${j} has no to-offset`);
        else if (onPages[j + 1].from !== onPages[j].to) {
          failures.push(`block ${blockIndex}: from/to do not meet at item ${j} (${onPages[j].to} vs ${onPages[j + 1].from})`);
        }
      }
    }
  }

  /* 5. No orphan margin: a block that is not a page start carries no page-start margin. */
  for (const el of content.querySelectorAll("[data-page-start]")) {
    if (!el.style.marginBlockStart) failures.push("a page-start block has no margin");
  }

  /* 6. Every whole block sits on the page the plan named, and ends inside it. A fragmented
     block spans pages by design, and an oversize atomic block gets a page as tall as itself;
     both are exempt. This is the downstream half of the cut: the tail can land correctly
     while the block after it is placed a line too high. */
  if (plan && pageTops.length) {
    const pageOf = new Map();
    plan.pages.forEach((page, pageIndex) => {
      for (const item of page.items) {
        if (item.from === 0) pageOf.set(item.block, pageIndex);
      }
    });
    for (const [blockIndex, pageIndex] of pageOf) {
      const block = plan.blocks[blockIndex];
      if (!block || block.querySelector?.("[data-frag]")) continue;
      if (plan.oversize?.includes(blockIndex)) continue;
      const box = rectOf(block);
      const top = pageTops[pageIndex];
      const bottom = pageBottoms[pageIndex];
      if (!Number.isFinite(top) || !Number.isFinite(bottom)) continue;
      if (box.top < top - tolerance) {
        failures.push(`block ${blockIndex}: starts at ${Math.round(box.top)}, above page ${pageIndex + 1}'s top ${Math.round(top)}`);
      } else if (box.bottom > bottom + tolerance) {
        failures.push(`block ${blockIndex}: bottom ${Math.round(box.bottom)} below page ${pageIndex + 1} (${Math.round(bottom)})`);
      }
    }
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

  /**
   * The cut that makes the segment starting at `start` fit in `room` layout px, or null.
   * The first cut starts at 0 and its top is the block's; a later cut starts where the
   * previous one ended, and its top is that line's top.
   */
  function planSplit(block, room, minLines = 2, start = 0) {
    const box = layout.rect(block);
    const all = lineBoxes(block);
    if (!all.length) return null;
    const segmentTop = start > 0 ? lineTopAt(block, start + 1) : box.top;
    const first = start > 0
      ? all.findIndex((line) => Math.abs(line.top - segmentTop) < 1)
      : 0;
    if (first < 0) return null;
    const lines = all.slice(first);
    const cut = chooseCut({
      text: block.textContent,
      lines,
      blockTop: segmentTop,
      room,
      lineTopAt: (offset) => lineTopAt(block, offset),
      lineBottomAt: (offset) => lineBottomAt(block, offset),
      minLines,
      start,
    });
    if (!cut) return null;
    if (anchoredAt(block, cut.offset)) return null;
    return {...cut, room, blockTop: segmentTop, blockHeight: box.height, start};
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
    /* One group per block, in plan order; a block can now need several cuts. */
    const groups = [];
    for (const split of splits) {
      const last = groups[groups.length - 1];
      if (last && last.block === split.block) last.splits.push(split);
      else groups.push({block: split.block, splits: [split]});
    }

    for (const group of groups) {
      const cuts = group.splits;
      let spans;
      if (cuts.every((cut) => cut.existing)) {
        spans = cuts.map((cut) => cut.existing);
      } else {
        if (cuts.some((cut) => cut.existing)) mergeBlock(group.block);
        const first = splitBlock(group.block, cuts[0].offset);
        spans = [first];
        let previous = cuts[0].offset;
        let tail = first;
        for (let k = 1; k < cuts.length; k++) {
          /* Split the remaining tail again, then lift the new span out to be a sibling:
             nested block spans would make the pages' margins compound. */
          const next = splitBlock(tail, cuts[k].offset - previous);
          tail.after(next);
          next.dataset.frag = String(cuts[k].offset);
          spans.push(next);
          previous = cuts[k].offset;
          tail = next;
        }
      }

      cuts.forEach((split, k) => {
        const frag = spans[k];
        if (Number(frag.dataset.frag) !== split.offset) frag.dataset.frag = String(split.offset);
        /* A reused fragment is already pushed; the target is measured from its unpushed top,
           or a no-op pass would read the push as part of the layout and erase it. */
        const fragTop = layout.rect(frag).top;
        const currentPush = inlineMargin(frag);
        const push = Math.max(0, Math.round(split.targetTop - (fragTop - currentPush)));
        if (Math.abs(currentPush - push) > 0.5) frag.style.marginBlockStart = `${push}px`;
        applied.push({
          block: split.block,
          offset: split.offset,
          push,
          targetTop: split.targetTop,
          reused: Boolean(split.existing),
          fragTopBefore: Math.round(fragTop),
          fragTopAfter: Math.round(layout.rect(frag).top),
          plan: split.plan ?? null,
          blockTopAtApply: Math.round(layout.rect(split.block).top),
          blockMargin: split.block.style.marginBlockStart || "",
          blockIsPageStart: split.block.hasAttribute("data-page-start"),
        });
      });
    }
    return applied;
  }

  const fragmentCount = () => content.querySelectorAll("[data-frag]").length;

  const inlineMargin = (el) => parseFloat(el.style.marginBlockStart || "0") || 0;

  /** Every fragment in a block, with the numbers a pass needs to reuse them. One cut or N,
      the shape is the same: a head followed by segments. */
  function fragmentState(el) {
    const frags = [...el.querySelectorAll(":scope > [data-frag]")];
    if (!frags.length) return null;
    const blockTop = layout.rect(el).top;
    const offsets = frags.map((frag) => fragmentOffset(el, frag));
    const pushes = frags.map((frag) => inlineMargin(frag));
    const heights = frags.map((frag) => layout.rect(frag).height);
    return {
      frags,
      offsets,
      pushes,
      heights,
      headHeight: layout.rect(frags[0]).top - pushes[0] - blockTop,
      push: pushes.reduce((sum, value) => sum + value, 0),
    };
  }

  /** The fragment's *current* character offset. Text inserted before it shifts the stored
      `data-frag` value; the boundary, not the number, is the truth. */
  function fragmentOffset(el, frag) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.setEnd(frag, 0);
    return range.toString().length;
  }

  function mergeBlock(el) {
    const frags = [...el.querySelectorAll("[data-frag]")];
    for (const frag of frags) {
      const parent = frag.parentNode;
      if (!parent) continue;
      while (frag.firstChild) parent.insertBefore(frag.firstChild, frag);
      frag.remove();
      parent.normalize();
    }
    return frags.length;
  }

  /** The block's semantic height while fragmented: its box minus the tail's page push. */
  function semanticH(el) {
    const state = fragmentState(el);
    return layout.measureH(el) - (state ? state.push : 0);
  }

  /* --------------------------------------------------------------- the page plan */

  function plan() {
    const g = geometry();
    const blocks = collectBlocks();

    const pages = [{top: 0, avail: g.contentH, items: []}];
    const spacers = [];
    const splits = [];
    const oversize = [];
    let cursor = 0;
    /* A reused cut can still fit while no longer being tight (text was deleted from the
       head). `stale` asks for one idle merge/re-plan; it is never set by a fresh cut. */
    let stale = false;

    for (let i = 0; i < blocks.length; i++) {
      const el = blocks[i];
      const state = fragmentState(el);
      const h = layout.measureH(el) - (state ? state.push : 0);
      const tall = h > g.contentH; // Check if larger than page height
      let page = pages[pages.length - 1];

      /* A block overflows when it does not fit the space left on the current page. A
         tall *lines* block that starts a fresh page overflows that page too, and must be
         offered to the splitter; an atomic block still gets a page as tall as itself. */
      const spec = strategy(el);
      const firstTallLines = page.items.length === 0
        && fragmenting && spec.kind === "lines" && h > page.top + page.avail;
      if ((page.items.length && cursor + h > page.top + page.avail) || firstTallLines) {
        const blockTop = layout.rect(el).top;

        if (fragmenting && spec.kind === "lines") {
          if (state) {
            /* An empty segment is never a valid cut; merging is the only repair. */
            if (state.frags.some((frag) => frag.textContent.length === 0)) return {needsMerge: true};
            /* Reuse every cut when the existing segments still fit their pages: one cut or
               N, this is the no-churn path while typing after the last one. */
            const room = page.top + page.avail - cursor;
            const ordered = state.offsets.every((offset, k) => k === 0 || offset > state.offsets[k - 1]);
            const fits = ordered
              && state.offsets[state.offsets.length - 1] < el.textContent.length
              && state.headHeight <= room - 1
              && state.heights.every((height) => height <= g.contentH + 1);
            if (fits) {
              /* Slack is measured in lines: a cut that leaves more than a line and a half
                 at the bottom of its page could move the next lines back into it. The last
                 segment is exempt — the block ends there. */
              const lines = lineBoxes(el);
              const lineHeight = lines.length
                ? Math.max(1, lines[0].bottom - lines[0].top)
                : 18;
              const slack = lineHeight * 1.5;
              if (room - state.headHeight > slack) stale = true;
              for (let k = 0; k < state.heights.length - 1; k++) {
                if (g.contentH - state.heights[k] > slack) stale = true;
              }
              let from = 0;
              let pageTop = page.top;
              let avail = page.avail;
              let cursorHere = cursor;
              state.frags.forEach((frag, k) => {
                const nextTop = pageTop + avail + g.chromeGap;
                page.items.push({block: i, from, to: state.offsets[k]});
                const tailPage = {top: nextTop, avail: g.contentH, items: []};
                pages.push(tailPage);
                splits.push({
                  block: el,
                  offset: state.offsets[k],
                  headHeight: k === 0 ? state.headHeight : state.heights[k - 1],
                  targetTop: nextTop + g.pad,
                  existing: frag,
                  plan: {reused: true},
                });
                from = state.offsets[k];
                page = tailPage;
                pageTop = nextTop;
                avail = g.contentH;
                cursorHere = nextTop;
              });
              page.items.push({block: i, from, to: null});
              const consumed = state.headHeight
                + state.heights.slice(0, -1).reduce((sum, value) => sum + value, 0);
              cursor = pageTop + (h - consumed);
              continue;
            }
            return {needsMerge: true};
          }

          /* Fresh cuts: fill this page, then as many whole pages as the block needs. A
             tall paragraph is a block like any other now; only an atomic block is not cut. */
          let from = 0;
          let consumed = 0;
          let remaining = h;
          let cuts = 0;
          let room = page.top + page.avail - cursor;
          let pageTop = page.top;
          let avail = page.avail;
          let cursorHere = cursor;
          while (cuts < 64) {
            const cut = planSplit(el, room, spec.minLines ?? 2, from);
            if (!cut || cut.offset <= from) break;
            const nextTop = pageTop + avail + g.chromeGap;
            page.items.push({block: i, from, to: cut.offset});
            const tailPage = {top: nextTop, avail: g.contentH, items: []};
            pages.push(tailPage);
            splits.push({
              block: el,
              offset: cut.offset,
              headHeight: cut.headHeight,
              targetTop: nextTop + g.pad,
              existing: null,
              plan: {
                room: Math.round(cut.room),
                start: cut.start,
                cutLine: cut.cutLine,
                lines: cut.lines,
                geometric: cut.geometric,
                blockTop: Math.round(cut.blockTop),
                blockHeight: Math.round(cut.blockHeight),
                headHeight: Math.round(cut.headHeight),
                cursor: Math.round(cursorHere),
                nextTop: Math.round(nextTop),
              },
            });
            from = cut.offset;
            consumed = cut.headBottom - blockTop;
            remaining = h - consumed;
            cuts++;
            page = tailPage;
            pageTop = nextTop;
            avail = g.contentH;
            cursorHere = nextTop;
            room = g.contentH;
            if (remaining <= g.contentH + 1) {
              tailPage.items.push({block: i, from, to: null});
              cursor = nextTop + remaining;
              break;
            }
          }
          if (cuts) {
            if (remaining > g.contentH + 1) {
              /* No further cut is possible (a one-line remainder, an anchored inline):
                 the tail goes on its page whole, as an atomic tall block does. */
              page.items.push({block: i, from, to: null});
              cursor = pageTop + remaining;
            }
            continue;
          }
        }

        /* Nothing above this block on the page: it is the page, so there is no gap to
           insert. Fall through to the tall/whole-block handling below. */
        if (page.items.length) {
          const nextTop = page.top + page.avail + g.chromeGap;
          spacers.push({
            before: el,
            height: nextTop - cursor,
          });
          page = {top: nextTop, avail: g.contentH, items: []};
          pages.push(page);
          cursor = nextTop;
        }
      }
      /* A fragment left on a block that now fits the page is stale: the block is whole
         again, and only a merge can make it so. */
      if (fragmenting && state) return {needsMerge: true};

      /* A page opened by a tall block starts below the flow; the first block on it needs a
         page-start margin. (A page opened by a normal overflow was already pushed by the
         spacer, so `cursor` is already at its top.) */
      if (!page.items.length && cursor < page.top - 0.5) {
        spacers.push({before: el, height: page.top - cursor});
        cursor = page.top;
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
        /* Leave `cursor` at the tall block's content end. The page opens below the flow, so
           the next block needs a page-start margin to reach its top; resetting cursor to
           `nextTop` here puts that block in the gap. */
      }
    }

    return {
      blocks, pages, spacers, splits, oversize, stale, ...g,
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
      /* `setAttribute` queues a mutation record even when the value is identical; a no-op
         pass must not touch the flow at all. */
      if (!block.hasAttribute("data-page-start")) block.setAttribute("data-page-start", "");
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
  let frame = 0;
  let queued = false;
  let lastRun = 0;

  // Queue up the replanning and page change event
  function schedule() {
    if (queued || applying || signals.composing) return;

    /* While fragmenting, the pass runs in the MutationObserver callback itself: that is
       after the edit and before the next paint. Deferring it by a frame (let alone 120 ms)
       paints the un-cut paragraph first — text in the page gap and over the next sheet —
       and that flash is what "not formatted properly" was. The no-churn path keeps this
       affordable: a pass that changes no cut writes nothing. */
    if (fragmenting) {
      queued = false;
      clearTimeout(timer);
      timer = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      lastRun = performance.now();
      refresh();
      return;
    }
    queued = true;

    const idle = performance.now() - lastRun > 350;

    clearTimeout(timer);
    timer = setTimeout(() => {
      requestAnimationFrame(() => {
        queued = false;
        /* The guard at scheduling time is not enough: a pass queued before composition
           started would fire in the middle of it. `compositionend` schedules again. */
        if (signals.composing) return;
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
  /* The scroll position the reader had before the pass. A page break can move the caret to
     the next page; following it would scroll a page for a change the reader did not make.
     Keeping the position is the honest default — the text under the caret may move, but the
     view does not chase it. */
  function scrollAnchor() {
    return {scrollTop: viewport.scrollTop};
  }

  function restoreScroll(anchor) {
    if (!anchor) return;
    if (Math.abs(viewport.scrollTop - anchor.scrollTop) > 0.5) {
      viewport.scrollTop = anchor.scrollTop;
    }
  }

  let reconcileTimer = null;

  /* One full merge/re-plan after a pause, only when the last plan reused a cut with room
     left to fill. Typing never waits for it; the sync pass keeps the cut stable. */
  function scheduleReconcile() {
    if (!fragmenting || signals.composing) return;
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      if (!fragmenting || signals.composing || applying) return;
      refresh({merge: true});
    }, 260);
  }

  function pass({merge = false} = {}) {
    if (applying) return;
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
    /* A manual refresh (a mode switch, a demo button) supersedes a queued one. */
    if (queued) {
      clearTimeout(timer);
      timer = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      queued = false;
    }

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
        const textBefore = (fragmenting || merge) ? content.textContent : null;
        if (merge) merged = mergeFragments();
        let p = plan();
        if (fragmenting && p.needsMerge) {
          /* One cut changed (text grew/shrunk at or before it, or the block now fits):
             merge the document and plan again. A no-op pass never takes this branch. */
          merged += mergeFragments();
          p = plan();
        }
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
        /* Convergence is a fact about two consecutive passes, not about one: the same
           pages and the same cuts. A pass that changes the text is allowed to differ from
           the pass before it; the next one must not. */
        const signature = `${p.pages.length}|${p.splits.map((split) => `${split.offset}@${Math.round(split.targetTop)}`).join(",")}`;
        lastPlan = {
          p, merged, applied, check, signature,
          converged: lastPlan?.signature === signature,
        };
        if (fragmenting && p.stale) scheduleReconcile();
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
         anchor correction should be the last word on where the reader is. The synchronous
         call handles a same-frame scroll; WebKit and Firefox can reveal the caret on a
         later frame, so the correction runs again just before the next paints. */
      restoreScroll(anchor);
      if (anchor) {
        requestAnimationFrame(() => {
          restoreScroll(anchor);
          requestAnimationFrame(() => restoreScroll(anchor));
        });
      }
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
      converged: lastPlan?.converged ?? null,
      stale: lastPlan?.p?.stale ?? false,
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
        reused: applied.reused,
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
    strategy, defineBlock, planSplit,
    plan: () => lastPlan?.p ?? null,
  };
}
