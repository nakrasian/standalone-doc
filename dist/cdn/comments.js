/* Comments are content, not a mode.
 *
 * `#comments` and the block ids it names travel in every file and every export, the way
 * `#figure-store` already does. The mode decides only which chrome exists and who may
 * write; it never decides whether the record survives (PLAN-comments.md §1).
 *
 * Two halves, deliberately:
 *
 *   this half — the store, the anchor, the merge — is pure functions over plain objects,
 *               so `npm test` exercises the parts that lose data without a browser.
 *   the DOM half — block ids on `#content`'s children, the marker overlay, the thread
 *               renderer — is below `createComments()`, and it is the only thing that
 *               touches a node.
 *
 * The anchor is **one range over the document's text stream** (A2 in lab/016), with
 * per-block segments *derived* for rendering. The lab's four-shape matrix is the reason:
 * endpoint pairs (A3) report success while silently pointing at different words in four
 * of eight edits, and per-block segments (A1) put a conflict inside a single comment. A
 * stream range repairs as one thing: exact, then a unique quote, then block-level, then
 * orphan. Nothing here is fuzzy — a quote that occurs twice degrades rather than guesses.
 */

export const SEP = "\n\n";
export const QUOTE_MAX = 40;
/* The block's id is `comment-store`, not `comments`, and that is the same collision the
   repo already paid for once (`doc-bar`: an asset's block carries `id="<assetId>"`, so a
   data block named `comments` would be shadowed by the module's own `<script>` — and
   `getElementById("comments")` would hand a parser the module's source). `figure-store` /
   `figures` is the same pair, for the same reason. */
export const STORE_ID = "comment-store";

/** The comparable form of a string: whitespace collapsed, ends trimmed. */
export const norm = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/**
 * `normalized` is what a quote is matched against; `map[i]` is the raw index of the
 * character that produced it, so a match can be reported in the offsets the anchor
 * stores. Collapsing whitespace without this map is how a `pre` block's quote resolves
 * to a position that is not where the words are.
 */
export function normalizeWithMap(text) {
  const raw = String(text ?? "");
  let normalized = "";
  const map = [];
  let pendingSpace = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      if (normalized) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      normalized += " ";
      map.push(i - 1);
      pendingSpace = false;
    }
    normalized += ch;
    map.push(i);
  }
  return {normalized, map};
}

/**
 * The document as one string plus the block map both directions.
 * `blocks` is `[{id, text}]` — a block's text content, in document order.
 */
export function textIndex(blocks) {
  const spans = [];
  let text = "";
  for (const block of blocks) {
    if (text) text += SEP;
    const start = text.length;
    text += String(block.text ?? "");
    spans.push({id: block.id, start, end: text.length});
  }
  const byId = new Map(spans.map((span) => [span.id, span]));
  return {
    text,
    spans,
    sep: SEP,
    spanOf: (id) => byId.get(id) || null,
    /** The block-span containing a stream offset, clamped to the last block. */
    spanAt(offset) {
      for (const span of spans) if (offset <= span.end) return span;
      return spans[spans.length - 1] || null;
    },
    /** Stream offset → {blockId, offset within the block}. */
    local(offset) {
      const span = this.spanAt(offset);
      if (!span) return null;
      return {blockId: span.id, offset: Math.max(0, Math.min(offset - span.start, span.end - span.start))};
    },
    /** {blockId, offset} → stream offset, or null when the block is gone. */
    stream(blockId, offset) {
      const span = byId.get(blockId);
      if (!span) return null;
      return span.start + Math.max(0, Math.min(offset, span.end - span.start));
    },
  };
}

/** The anchor for a stream range: one coordinate, plus the blocks and a repair hint. */
export function anchorOf(index, from, to) {
  const start = Math.max(0, Math.min(from, to, index.text.length));
  const end = Math.max(start, Math.min(Math.max(from, to), index.text.length));
  const blocks = [];
  for (const span of index.spans) {
    if (span.end <= start || span.start >= end) continue;
    if (!blocks.includes(span.id)) blocks.push(span.id);
  }
  return {from: start, to: end, quote: norm(index.text.slice(start, end)).slice(0, QUOTE_MAX), blocks};
}

/** A range → the per-block segments the overlay paints (derived, never stored). */
export function segmentsOf(index, from, to) {
  const out = [];
  for (const span of index.spans) {
    if (span.end <= from || span.start >= to) continue;
    out.push({
      blockId: span.id,
      from: Math.max(0, from - span.start),
      to: Math.min(span.end - span.start, to - span.start),
    });
  }
  return out;
}

/** How many times `needle` occurs in `haystack`, capped at 2 — ambiguity is the only
 *  distinction the repair rule needs. */
export function occurrences(haystack, needle) {
  if (!needle) return {count: 0, at: -1};
  const at = haystack.indexOf(needle);
  if (at < 0) return {count: 0, at: -1};
  return {count: haystack.indexOf(needle, at + 1) < 0 ? 1 : 2, at};
}

/** A block-level anchor on a block that still exists, or null. */
export function blockLevel(index, anchor) {
  const wanted = anchor.blocks || [];
  const blockId = wanted.find((id) => index.spanOf(id)) || index.spans[0]?.id || null;
  return blockId ? {from: index.spanOf(blockId).start, to: index.spanOf(blockId).start, quote: "", blocks: [blockId]} : null;
}

/**
 * Resolve a stored anchor against the current document.
 *
 *   exact   — the stored coordinate still holds the quote
 *   shifted — the quote survived, once, inside the blocks it named (or the document,
 *             when none of those blocks do) and the coordinate moved to it
 *   block   — degraded to a marker on a block: the words are gone or ambiguous
 *   orphan  — every block it named is gone. The comment is kept and listed, never
 *             dropped (invariant 29)
 *
 * A repair preserves the range's **length**, not the quote's: a 40-character quote
 * restored as a 40-character range would turn a two-block comment into a one-block one.
 */
export function resolveAnchor(anchor, index) {
  const named = (anchor.blocks || []).filter((id) => index.spanOf(id));
  if (!named.length) return {how: "orphan", anchor, segments: []};
  if (!anchor.quote) {
    const fallback = blockLevel(index, anchor);
    return fallback
      ? {how: "block", anchor: {...anchor, ...fallback}, segments: []}
      : {how: "orphan", anchor, segments: []};
  }
  /* The quote is a 40-character *prefix* of the range, so "exact" asks whether the
     range still starts with it. Comparing the whole range to the quote can only ever
     succeed for a range shorter than the quote — the lab's prototype shipped that bug
     and its matrix never happened to contain an unchanged document. */
  const rangeText = norm(index.text.slice(anchor.from, anchor.to));
  if (rangeText.slice(0, anchor.quote.length) === anchor.quote) {
    return {how: "exact", anchor, segments: segmentsOf(index, anchor.from, anchor.to)};
  }
  /* The named blocks first — a block-scoped repair, which is what the plan promises —
     and only then the whole document. */
  const ranges = named.map((id) => [index.spanOf(id).start, index.spanOf(id).end]);
  for (const [start, end] of ranges) {
    const haystack = index.text.slice(start, end);
    const found = occurrences(norm(haystack), anchor.quote);
    if (found.count !== 1) continue;
    /* The normalized index → raw index, so the shift lands on the words. */
    const {normalized, map} = normalizeWithMap(haystack);
    const at = normalized.indexOf(anchor.quote);
    if (at < 0) continue;
    const rawAt = start + (map[at] ?? 0);
    const length = Math.max(1, anchor.to - anchor.from);
    const to = Math.min(index.text.length, rawAt + length);
    return {how: "shifted", anchor: {...anchor, from: rawAt, to}, segments: segmentsOf(index, rawAt, to)};
  }
  const fallback = blockLevel(index, anchor);
  return fallback
    ? {how: "block", anchor: {...anchor, ...fallback}, segments: []}
    : {how: "orphan", anchor, segments: []};
}

/* ------------------------------------------------------------------- the block */

/** An id we are willing to write: `b_` + 8 base36 characters. */
export const BID_RE = /^b_[0-9a-z]{8}$/;

export function newBid(random = globalThis.crypto) {
  const words = new Uint32Array(2);
  random.getRandomValues(words);
  return `b_${words[0].toString(36).padStart(4, "0").slice(-4)}${words[1].toString(36).padStart(4, "0").slice(-4)}`;
}

/** An id we are willing to write: `c_` + 8 base36 characters, and `r_` for a reply. */
export function newId(prefix, random) {
  return `${prefix}_${newBid(random).slice(2)}`;
}

/**
 * The stored record. Lenient on read (an unknown extra key is ignored, not fatal) and
 * strict about the fields that make an anchor addressable, because a comment with no id
 * cannot be merged and one with no anchor cannot be shown.
 */
export function validComment(comment) {
  return Boolean(
    comment
    && typeof comment.id === "string" && comment.id
    && comment.anchor && typeof comment.anchor === "object"
    && typeof comment.anchor.from === "number" && typeof comment.anchor.to === "number"
    && Array.isArray(comment.anchor.blocks)
    && comment.author && typeof comment.author.name === "string"
    && typeof comment.body === "string"
  );
}

export function parseStore(text) {
  let data;
  try {
    data = JSON.parse(text || "null");
  } catch {
    return {schema: 1, comments: []};
  }
  const comments = Array.isArray(data?.comments) ? data.comments.filter(validComment) : [];
  return {schema: 1, comments};
}

export function serializeStore(state) {
  return JSON.stringify({schema: 1, comments: state.comments || []});
}

/* -------------------------------------------------------------------- the merge */

export const later = (a, b) => String(a || "") > String(b || "");

/**
 * Pull one file's comments into another (§8.1). Pure, idempotent, and it never decides a
 * disagreement: `conflicts` is a list for a human to act on, and `next` is the local set
 * with everything that was unambiguous already applied.
 *
 *   1. unknown id, block present        → added
 *   2. unknown id, block gone           → added, counted as an orphan (kept)
 *   3. known id:
 *        - replies the local copy lacks → appended (append-only, so a prefix match)
 *        - `resolved` differs          → conflict, never last-write-wins
 *   4. the author's own record is never replaced by a reviewer's
 *
 * Idempotent by construction: merging the same file twice adds nothing, which is the
 * first unit test.
 */
export function merge(local, incoming, index) {
  const next = (local.comments || []).map((comment) => ({...comment, replies: [...(comment.replies || [])]}));
  const byId = new Map(next.map((comment) => [comment.id, comment]));
  const result = {added: 0, replies: 0, orphans: 0, unchanged: 0, conflicts: []};

  for (const candidate of incoming.comments || []) {
    if (!validComment(candidate)) continue;
    const existing = byId.get(candidate.id);
    if (!existing) {
      const copy = {...candidate, replies: [...(candidate.replies || [])]};
      next.push(copy);
      byId.set(copy.id, copy);
      /* An orphan is a comment whose block is gone: still added, still listed. The
         dialogs count it so a reviewer sees why a comment has no highlight. */
      const resolvable = (copy.anchor.blocks || []).some((id) => index.spanOf(id));
      if (resolvable) result.added += 1;
      else result.orphans += 1;
      continue;
    }

    const authorRecord = existing.author?.kind === "author" && candidate.author?.kind !== "author";
    let touched = false;

    const known = new Set((existing.replies || []).map((reply) => reply.id));
    for (const reply of candidate.replies || []) {
      if (!reply || typeof reply.id !== "string" || known.has(reply.id)) continue;
      existing.replies = [...(existing.replies || []), reply];
      known.add(reply.id);
      result.replies += 1;
      touched = true;
    }

    const wasResolved = Boolean(existing.resolved);
    const nowResolved = Boolean(candidate.resolved);
    if (wasResolved !== nowResolved && !authorRecord) {
      if (later(candidate.updatedAt, existing.updatedAt)) {
        result.conflicts.push({
          id: existing.id,
          body: existing.body,
          local: {resolved: wasResolved, updatedAt: existing.updatedAt || null},
          incoming: {resolved: nowResolved, updatedAt: candidate.updatedAt || null},
        });
      } else {
        result.unchanged += 1;
      }
    } else if (!touched) {
      result.unchanged += 1;
    }
  }

  return {next: {schema: 1, comments: next}, ...result};
}

/* ------------------------------------------------------------------- the record */

/** A new comment, authored by `author` at `now`. */
export function commentAt({anchor, body, author, now = new Date().toISOString(), random = globalThis.crypto}) {
  return {
    id: newId("c", random),
    anchor,
    author,
    createdAt: now,
    updatedAt: now,
    body: String(body || "").trim(),
    resolved: false,
    replies: [],
  };
}

/** A reply: append-only, with no edit path in v1 (invariant 29). */
export function replyTo(comment, {body, author, now = new Date().toISOString(), random = globalThis.crypto}) {
  return {
    ...comment,
    updatedAt: now,
    replies: [...(comment.replies || []), {id: newId("r", random), author, at: now, body: String(body || "").trim()}],
  };
}

/* --------------------------------------------------------------- the session */

/**
 * The DOM half: block ids, the marker overlay, the rail (or a popover when there is no
 * room for it) and the composer.
 *
 * Markers are **not** wrapped around text. Wrapping mutates `#content`, which is the
 * caret, the undo stack, `figures.prepareClone()` and pagination's own measurement —
 * every entry on lab/016's arson list. The overlay is a sibling of `#content` inside
 * `#stage`, so it never reflows a paragraph, never changes a page height and never
 * reaches a save (`session.strip()` removes `[data-runtime="ephemeral"]`).
 *
 * Geometry is text-node rects, clipped to the plan's page boxes. Both halves of that are
 * measured: `range.getClientRects()` across a page break returns the gap as one **948 px**
 * rect in all three engines, and clipping alone still paints a page-height lie because
 * the rect exists at all. A text-node rect cannot span the gap.
 *
 * The rail is the list a reader lives in: cards beside the page, in document order, with
 * the resolved ones kept below them. Hovering a highlight previews its card; clicking
 * pins it until the reader clicks away. A comment that has been resolved paints **no**
 * highlight — the record is still there, in the list, to reopen or delete.
 */
export function createComments(deps = {}) {
  const {signals, pagination, layout, selection, settings, env} = deps;
  const status = deps.optional("status");
  const {document} = env;

  const content = document.getElementById("content");
  const stage = document.getElementById("stage");

  /* The injected snapshot is what the loader built; the block is what the file says now.
     The Document panel edits `author` during the session, and a comment authored after
     that has to use the name the sheet just wrote. */
  const live = () => env.StandaloneDoc?.settings?.() || settings;
  const writable = () => live().capabilities?.comments === "write" && live().mode !== "view";

  let layer = null;
  let rail = null;
  let railTab = null;
  let popover = null;
  let composer = null;
  let store = {schema: 1, comments: []};
  let cache = new Map();
  let frame = 0;
  let focused = null;
  let pending = null;
  let railMode = false;
  let railOpen = true;
  let pinned = null;
  let hovered = null;
  let railDirty = true;
  const flashTimers = new Map();
  const listeners = new Set();

  /* Who is writing. The author's name is the document's (it is what a reviewer replies
     to); a reviewer's name is this browser's, keyed by the document, and never written
     into a file — a reviewer cannot sign for the author (decision 2). A `file://` copy
     has no library id, so the key falls back to its path and title: the same reviewer
     re-opening the same copy keeps their name. */
  const docKey = () => {
    const id = live().cloud?.id;
    const where = globalThis.location?.pathname || "";
    return `sd:reviewer:${id || `${where}#${document.title}`}`;
  };

  function authorName() {
    try {
      return globalThis.localStorage?.getItem(docKey()) || "";
    } catch {
      /* A private window or a blocked origin: an unnamed reviewer is still a reviewer. */
      return "";
    }
  }

  function setAuthorName(name) {
    const trimmed = String(name || "").trim();
    if (!trimmed) return "";
    try {
      globalThis.localStorage?.setItem(docKey(), trimmed);
    } catch {
      /* Storage is a convenience, not a requirement. */
    }
    return trimmed;
  }

  /** Who a record is attributed to: the author in edit mode, a reviewer everywhere else. */
  function writer(name) {
    return live().mode === "edit"
      ? {name: live().author || name || "Author", kind: "author"}
      : {name: name || authorName() || "Reader", kind: "reviewer"};
  }

  /** Every mutation ends here, so the chrome can update without polling. */
  function changed() {
    railDirty = true;
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* A listener is chrome; its failure must not lose the edit that fired it. */
      }
    }
  }

  /* ------------------------------------------------------------------ storage */

  function load() {
    const block = document.getElementById(STORE_ID);
    return block ? parseStore(block.textContent) : {schema: 1, comments: []};
  }

  function save() {
    let block = document.getElementById(STORE_ID);
    if (!store.comments.length) {
      /* Absent means "no comments". An empty array is a change to the file for nothing. */
      block?.remove();
      status()?.markDirty();
      changed();
      return;
    }
    if (!block) {
      block = document.createElement("script");
      block.id = STORE_ID;
      block.type = "application/json";
      document.body.append(block);
    }
    block.textContent = serializeStore(store);
    status()?.markDirty();
    changed();
  }

  /* ------------------------------------------------------------------- blocks */

  /** Top-level blocks, in document order, with their text and id (if assigned). */
  function blocks() {
    return [...(content?.children || [])].map((el) => {
      const id = el.dataset?.bid;
      return {el, id: id && BID_RE.test(id) ? id : null, text: el.textContent ?? ""};
    });
  }

  function index() {
    const list = blocks();
    const index = textIndex(list);
    /* `spans[i]` and `list[i]` are the same block: the stream index preserves order. */
    index.list = list;
    return index;
  }

  /**
   * The same index, with a temporary name for every block that has no `data-bid` yet.
   *
   * Authoring has to be able to compute an anchor *before* deciding which blocks deserve
   * an id — the answer is "the ones the range touches". The temporary name lives in this
   * object only: `blocks()` re-reads the DOM, so nothing is written until `realIdFor()`
   * chooses to. Text and offsets are unaffected, so the final anchor is the same range.
   */
  function provisionalIndex() {
    const list = blocks();
    let n = 0;
    for (const block of list) {
      if (!block.id) block.id = `tmp_${n++}`;
    }
    const index = textIndex(list);
    index.list = list;
    return index;
  }

  /** A provisional block name → the id the file will carry, assigning it if needed. */
  function realIdFor(name, list) {
    const block = list.find((candidate) => candidate.id === name);
    if (!block) return name;
    if (BID_RE.test(name)) return name;
    if (!block.el.dataset.bid) block.el.dataset.bid = newBid();
    return block.el.dataset.bid;
  }

  /* ----------------------------------------------------------------- geometry */

  /** The page content bands, in layout px, from the pass that just ran. */
  function pageBands() {
    const plan = pagination.plan();
    if (!plan || !plan.pageTops?.length) return null;
    return plan.pageTops.map((top, i) => [top, plan.pageBottoms[i]]);
  }

  /** A client rect → stage-local layout px. `layout.rect()` takes an *element*, and a
   *  range's rect is not one, so the arithmetic it owns is repeated here from one origin
   *  read per draw — never per rect. */
  function toLayout(box, origin) {
    const scale = origin.scale || 1;
    return {
      left: (box.left - origin.left) / scale,
      top: (box.top - origin.top) / scale,
      right: (box.right - origin.left) / scale,
      bottom: (box.bottom - origin.top) / scale,
      width: box.width / scale,
      height: box.height / scale,
    };
  }

  /**
   * Rects for a text range inside one block, in the overlay's coordinate space, keeping
   * only what a page actually shows.
   */
  function rectsFor(blockEl, from, to, origin) {
    const rects = [];
    const bands = pageBands();
    let offset = 0;
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const length = node.nodeValue.length;
      const start = Math.max(from, offset);
      const end = Math.min(to, offset + length);
      if (end > start) {
        const range = document.createRange();
        try {
          range.setStart(node, start - offset);
          range.setEnd(node, end - offset);
        } catch {
          offset += length;
          node = walker.nextNode();
          continue;
        }
        for (const box of range.getClientRects()) {
          if (!(box.width > 0) || !(box.height > 0)) continue;
          const rect = toLayout(box, origin);
          /* A page gap is not text. Per-node rects rarely straddle one; this keeps the
             rule true for the one that does instead of painting a page of white space. */
          if (bands && !bands.some(([top, bottom]) => rect.bottom > top && rect.top < bottom)) continue;
          rects.push(rect);
        }
      }
      offset += length;
      node = walker.nextNode();
    }
    return rects;
  }

  /** Where a block-level (or orphan) marker goes: the block's first line. */
  function blockRect(blockEl) {
    const rect = layout.rect(blockEl);
    return [{left: Math.max(0, rect.right - 10), top: rect.top + 2, width: 8, height: 8}];
  }

  /* ------------------------------------------------------------------ markers */

  function resolveAll(idx) {
    const next = new Map();
    for (const comment of store.comments) {
      next.set(comment.id, resolveAnchor(comment.anchor, idx));
    }
    cache = next;
    return next;
  }

  const stateOf = (comment) => (cache.get(comment.id) || {how: "orphan"}).how;

  function clearLayer() {
    if (!layer) return;
    layer.replaceChildren();
  }

  function marker(rects, comment, {block = false} = {}) {
    for (const rect of rects) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = block ? "comment-mark is-block" : "comment-mark";
      el.dataset.commentId = comment.id;
      el.setAttribute("aria-label", `Comment by ${comment.author.name}`);
      el.title = comment.body.length > 80 ? `${comment.body.slice(0, 80)}…` : comment.body;
      el.style.cssText = [
        "position:absolute",
        "pointer-events:auto",
        "margin:0",
        "padding:0",
        "border:0",
        block ? "border-radius:50%" : "border-radius:2px",
        block ? "background:#f59e0b" : "background:rgba(245,158,11,0.28)",
        block ? "box-shadow:0 0 0 1px rgba(120,53,15,0.5)" : "box-shadow:inset 2px 0 0 #f59e0b",
        "cursor:pointer",
        `left:${rect.left}px`,
        `top:${rect.top}px`,
        `width:${Math.max(2, rect.width)}px`,
        `height:${Math.max(2, rect.height)}px`,
      ].join(";");
      if (comment.id === hovered) el.dataset.hover = "";
      if (comment.id === pinned) el.dataset.pinned = "";
      layer.append(el);
    }
  }

  function draw() {
    if (!layer || !content) return;
    clearLayer();
    const idx = index();
    const origin = layout.origin();
    const resolved = resolveAll(idx);
    for (const comment of store.comments) {
      const result = resolved.get(comment.id);
      if (!result) continue;
      /* Resolved means done: no highlight in the text. The record stays in the list, to
         reopen or delete. */
      if (comment.resolved) continue;
      if (result.how === "orphan") continue;
      if (result.how === "block") {
        const blockId = result.anchor.blocks?.[0];
        const block = idx.list.find((candidate) => candidate.id === blockId);
        if (!block) continue;
        marker(blockRect(block.el), comment, {block: true});
        continue;
      }
      for (const segment of result.segments) {
        const block = idx.list.find((candidate) => candidate.id === segment.blockId);
        if (!block || segment.to <= segment.from) continue;
        const rects = rectsFor(block.el, segment.from, segment.to, origin);
        if (!rects.length) {
          /* The phrase is on no page (it is in a hidden or collapsed block): a block
             marker is more honest than no marker at all. */
          marker(blockRect(block.el), comment, {block: true});
          continue;
        }
        marker(rects, comment);
      }
    }
    const orphans = [...resolved.values()].filter((result) => result.how === "orphan").length;
    if (orphans) drawOrphanPill(orphans);
    /* The layout decides whether a rail exists at all, so it must be known before the
       cards are built: the first draw runs before any `layout` signal has been seen. It
       reports a transition (shown, or shown-but-empty after a zoom) so the cards are
       rebuilt rather than left in a visible, empty column. */
    const needsRail = layoutRail();
    if (railDirty || needsRail) {
      renderRail();
      railDirty = false;
    } else {
      applyState();
    }
  }

  function drawOrphanPill(count) {
    const el = document.createElement("button");
    el.type = "button";
    el.id = "comment-orphans";
    el.dataset.orphans = String(count);
    el.textContent = `${count} unattached`;
    el.title = "Comments whose text is no longer in this document";
    el.style.cssText = "position:absolute;right:8px;top:8px;pointer-events:auto;font:12px system-ui;padding:2px 8px;border:1px solid #d97706;border-radius:999px;background:#fffbeb;color:#92400e;cursor:pointer";
    layer.append(el);
  }

  /* --------------------------------------------------------------------- rail */

  const byPosition = (a, b) => (a.comment.anchor.from ?? 0) - (b.comment.anchor.from ?? 0);

  function rows() {
    const idx = index();
    resolveAll(idx);
    const items = store.comments.map((comment) => ({comment, state: stateOf(comment)}));
    return {
      open: items.filter((item) => !item.comment.resolved).sort(byPosition),
      done: items.filter((item) => item.comment.resolved).sort(byPosition),
    };
  }

  function layoutRail() {
    if (!rail) return false;
    const viewport = document.getElementById("viewport");
    const sheet = stage?.getBoundingClientRect?.();
    const box = viewport?.getBoundingClientRect?.();
    const has = store.comments.length > 0;
    /* The page stays centred, and the rail lives in the margin beside it when there is
       one. When there is not — a zoom, a narrower window — it **overlays** the page instead
       of disappearing, and that is the only time its blur has text behind it to soften. A
       viewport too narrow for a column at all falls back to the popover. */
    const margin = sheet && box ? Math.round(box.right - sheet.right - 6) : 0;
    const viewportWidth = box?.width ?? 0;
    const fits = margin >= 214;
    const wide = viewportWidth >= 760;
    const wasShown = railMode && railOpen && !rail.hidden && rail.childElementCount > 0;
    railMode = wide;
    const shown = wide && railOpen && has;
    rail.hidden = !shown;
    if (railTab) railTab.hidden = !(wide && !railOpen && has);
    if (!shown) {
      rail.replaceChildren();
      delete rail.dataset.overlay;
      return false;
    }
    const width = fits
      ? Math.min(324, Math.max(200, margin - 8))
      : Math.min(324, Math.max(240, viewportWidth - 32));
    if (fits) delete rail.dataset.overlay;
    else rail.dataset.overlay = "";
    rail.style.left = "auto";
    rail.style.right = "8px";
    rail.style.width = `${width}px`;
    rail.style.top = `${Math.round((box?.top ?? 0) + 6)}px`;
    rail.style.maxHeight = `${Math.max(180, Math.round((box?.height ?? 600) - 12))}px`;
    if (railTab) {
      /* Cheap on purpose: `layoutRail()` runs on every pass, and resolving anchors for a
         label would make a pagination pass walk the document again. */
      const total = store.comments.length;
      const unresolved = store.comments.filter((comment) => !comment.resolved).length;
      railTab.textContent = `Comments ${unresolved || total}`;
    }
    return !wasShown;
  }

  function quoteOf(comment) {
    return comment.anchor.quote || "";
  }

  function card(comment, state) {
    const el = document.createElement("article");
    el.className = "comment-card";
    el.dataset.commentCard = "";
    el.dataset.commentId = comment.id;
    if (comment.resolved) el.dataset.resolved = "";
    if (state === "orphan") el.dataset.orphan = "";
    if (comment.id === pinned) el.dataset.pinned = "";
    if (comment.id === hovered) el.dataset.hover = "";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "comment-card-head";
    head.dataset.cardHead = "";
    const author = document.createElement("span");
    author.className = "comment-card-author";
    author.textContent = comment.author.name;
    const meta = document.createElement("span");
    meta.className = "comment-card-meta";
    meta.textContent = [comment.author.kind === "author" ? "author" : "reviewer", comment.createdAt?.slice(0, 10)].filter(Boolean).join(" · ");
    head.append(author, meta);
    if (comment.resolved) {
      const badge = document.createElement("span");
      badge.className = "comment-card-badge";
      badge.textContent = "resolved";
      head.append(badge);
    }
    el.append(head);

    const quote = quoteOf(comment);
    if (quote) {
      const p = document.createElement("p");
      p.className = "comment-quote";
      p.textContent = `“${quote}”`;
      el.append(p);
    }

    const body = document.createElement("p");
    body.className = "comment-body";
    body.textContent = comment.body;
    el.append(body);

    if (state === "orphan") {
      const note = document.createElement("p");
      note.className = "comment-note";
      note.textContent = "Its paragraph is gone. The comment is kept here.";
      el.append(note);
    } else if (state === "block") {
      const note = document.createElement("p");
      note.className = "comment-note";
      note.textContent = "The words moved; this is on the paragraph now.";
      el.append(note);
    }

    if (comment.replies?.length) {
      const list = document.createElement("ol");
      list.className = "comment-replies";
      for (const reply of comment.replies) {
        const item = document.createElement("li");
        const name = document.createElement("strong");
        name.textContent = reply.author?.name || "Reviewer";
        const text = document.createElement("span");
        text.textContent = ` ${reply.body}`;
        item.append(name, text);
        list.append(item);
      }
      el.append(list);
    }

    if (writable()) {
      const actions = document.createElement("div");
      actions.className = "comment-actions";

      const resolve = document.createElement("button");
      resolve.type = "button";
      resolve.dataset.resolveComment = "";
      resolve.textContent = comment.resolved ? "Reopen" : "Resolve";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.deleteComment = "";
      remove.dataset.danger = "";
      remove.textContent = "Delete";
      actions.append(resolve, remove);
      el.append(actions);

      const reply = document.createElement("form");
      reply.className = "comment-reply";
      reply.dataset.replyForm = "";
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = `Reply as ${live().mode === "edit" ? live().author || "the author" : authorName() || "a reviewer"}…`;
      input.setAttribute("aria-label", "Reply");
      const send = document.createElement("button");
      send.type = "submit";
      send.textContent = "Send";
      reply.append(input, send);
      el.append(reply);
    }

    return el;
  }

  function notifyRail() {
    document.dispatchEvent(new CustomEvent("comments:rail"));
  }

  function railShown() {
    return railMode && railOpen && store.comments.length > 0;
  }

  /** The column's own header: what is in it, and the way to put it away. */
  function railHeader() {
    const head = document.createElement("p");
    head.className = "comment-rail-head";
    const title = document.createElement("span");
    title.textContent = "Comments";
    const count = document.createElement("span");
    count.className = "comment-rail-count";
    const total = store.comments.length;
    const unresolved = store.comments.filter((comment) => !comment.resolved).length;
    count.textContent = String(unresolved || total);
    count.title = `${unresolved} open · ${total} total`;
    const hide = document.createElement("button");
    hide.type = "button";
    hide.dataset.railClose = "";
    hide.setAttribute("aria-label", "Hide comments");
    hide.title = "Hide comments";
    hide.textContent = "×";
    hide.addEventListener("click", () => {
      railOpen = false;
      layoutRail();
      notifyRail();
    });
    head.append(title, count, hide);
    return head;
  }

  function renderRail() {
    if (!rail || !railMode) return;
    const keep = rail.scrollTop;
    rail.replaceChildren();
    rail.append(railHeader());
    const {open, done} = rows();
    const addGroup = (label) => {
      const el = document.createElement("p");
      el.className = "comment-group";
      el.textContent = label;
      rail.append(el);
    };
    if (open.length || !done.length) {
      for (const row of open) rail.append(card(row.comment, row.state));
    }
    if (done.length) {
      if (open.length) addGroup("Resolved");
      for (const row of done) rail.append(card(row.comment, row.state));
    }
    /* Re-rendering must not undo the reader's place in the list. */
    rail.scrollTop = keep;
  }

  function railCard(id) {
    return rail?.querySelector(`[data-comment-card][data-comment-id="${id}"]`) || null;
  }

  function applyState() {
    if (!rail) return;
    for (const el of rail.querySelectorAll("[data-comment-card]")) {
      const id = el.dataset.commentId;
      if (id === pinned) el.dataset.pinned = "";
      else delete el.dataset.pinned;
      if (id === hovered) el.dataset.hover = "";
      else delete el.dataset.hover;
    }
    if (popover && !popover.hidden) {
      for (const el of popover.querySelectorAll("[data-comment-card]")) {
        if (el.dataset.commentId === pinned) el.dataset.pinned = "";
      }
    }
    for (const el of layer?.querySelectorAll("[data-comment-id]") || []) {
      const id = el.dataset.commentId;
      if (id === pinned) el.dataset.pinned = "";
      else delete el.dataset.pinned;
      if (id === hovered) el.dataset.hover = "";
      else delete el.dataset.hover;
    }
  }

  function flash(id) {
    if (!layer) return;
    for (const el of layer.querySelectorAll("[data-comment-id]")) {
      if (el.dataset.commentId !== id) continue;
      el.dataset.flash = "";
      clearTimeout(flashTimers.get(el));
      flashTimers.set(el, setTimeout(() => {
        delete el.dataset.flash;
        flashTimers.delete(el);
      }, 1100));
    }
  }

  function hover(id) {
    if (hovered === id) return;
    hovered = id;
    applyState();
    if (!id) return;
    const el = railCard(id);
    /* Do not move the rail on every mouse move; only when the card is out of view. */
    if (el && rail && (el.offsetTop < rail.scrollTop || el.offsetTop + el.offsetHeight > rail.scrollTop + rail.clientHeight)) {
      el.scrollIntoView({block: "nearest"});
    }
  }

  function pin(id, {scroll = true} = {}) {
    pinned = id;
    hovered = null;
    applyState();
    if (!id || !scroll || !rail || !railMode) return;
    const el = railCard(id);
    if (!el) return;
    /* Its own scroll container, by hand: `scrollIntoView` on a fixed element is a
       document scroll waiting to happen. */
    const top = el.offsetTop;
    if (top < rail.scrollTop) rail.scrollTop = top;
    else if (top + el.offsetHeight > rail.scrollTop + rail.clientHeight) {
      rail.scrollTop = top + el.offsetHeight - rail.clientHeight;
    }
  }

  function unpin() {
    if (!pinned) return;
    pinned = null;
    applyState();
  }

  /** Show the reader where a comment is: pin it, bring its marker into view, flash it. */
  /** Bring an element into view only when it is not already there: opening a comment
   *  should not move a page the reader can already see. */
  function ensureVisible(el) {
    if (!el) return;
    const viewport = document.getElementById("viewport");
    const box = viewport?.getBoundingClientRect?.();
    const rect = el.getBoundingClientRect?.();
    if (!box || !rect) return;
    if (rect.top < box.top + 56 || rect.bottom > box.bottom - 24) {
      el.scrollIntoView({block: "nearest", behavior: "smooth"});
    }
  }

  function navigate(comment) {
    if (!comment) return null;
    pin(comment.id, {scroll: true});
    const hits = layer ? [...layer.querySelectorAll(`[data-comment-id="${comment.id}"]`)] : [];
    if (hits.length) {
      ensureVisible(hits[0]);
    } else {
      /* A resolved comment has no highlight; its paragraph is still the place to look. */
      const result = cache.get(comment.id) || resolveAnchor(comment.anchor, index());
      const blockId = result.anchor?.blocks?.[0];
      const block = blockId ? index().list.find((candidate) => candidate.id === blockId) : null;
      ensureVisible(block?.el);
    }
    flash(comment.id);
    return comment;
  }

  function onCardEvent(event) {
    const cardEl = event.target.closest?.("[data-comment-card]");
    if (!cardEl) return;
    const id = cardEl.dataset.commentId;
    const comment = store.comments.find((candidate) => candidate.id === id);
    if (!comment) return;

    if (event.target.closest("[data-resolve-comment]")) {
      /* Resolving is bookkeeping, not navigation: the reader is already looking at it. */
      setResolved(id, !comment.resolved);
      return;
    }
    if (event.target.closest("[data-delete-comment]")) {
      remove(id);
      return;
    }
    if (event.target.closest("[data-reply-form]")) {
      if (event.type === "submit") {
        event.preventDefault();
        const input = event.target.querySelector("input");
        reply(id, {body: input?.value, author: writer()});
      }
      return;
    }
    if (event.type === "click") {
      /* Clicking anywhere on the card goes to the words — except the controls that mean
         something else (reply, resolve, delete). Hover already works the other way. */
      if (event.target.closest("[data-reply-form], .comment-actions, input, textarea, select, a")) return;
      navigate(comment);
    }
  }

  /* ------------------------------------------------------------------- threads */

  function placePopover(anchorEl) {
    if (!popover) return;
    const box = anchorEl?.getBoundingClientRect?.();
    const width = 340;
    const margin = 8;
    const left = box ? Math.min(globalThis.innerWidth - width - margin, Math.max(margin, box.left)) : margin * 4;
    const top = box ? Math.min(globalThis.innerHeight - 160, Math.max(margin, box.bottom + 6)) : margin * 8;
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function focus(comment) {
    if (!comment) return null;
    focused = comment.id;
    if (railMode) return navigate(comment);
    if (!popover) return null;
    const result = cache.get(comment.id) || resolveAnchor(comment.anchor, index());
    popover.replaceChildren(card(comment, result.how));
    popover.hidden = false;
    const el = layer?.querySelector(`[data-comment-id="${comment.id}"]`);
    placePopover(el);
    return comment;
  }

  function blur() {
    if (popover) popover.hidden = true;
    focused = null;
  }

  function toggleList() {
    if (!railMode) return {rail: false, open: false};
    railOpen = !railOpen;
    layoutRail();
    if (railOpen) {
      railDirty = true;
      renderRail();
    }
    notifyRail();
    return {rail: true, open: railOpen};
  }

  const railActive = () => railMode;

  /* ---------------------------------------------------------------- authoring */

  /** The selection as stream offsets, or null when it is collapsed or outside. */
  function selectedRange(idx = index()) {
    const caught = selection.capture(content);
    if (!caught || caught.collapsed) return null;
    const at = (point) => {
      const span = point.id ? idx.spanOf(point.id) : idx.spans[point.block];
      return span ? span.start + point.offset : null;
    };
    const from = at(caught.start);
    const to = at(caught.end);
    if (from == null || to == null || to <= from) return null;
    return {from, to};
  }

  /**
   * Add a comment on the current selection.
   *
   * The anchor is computed first, over a provisional index; then the blocks the range
   * actually touches get a `data-bid`, and the anchor is stored with those ids. That is
   * the only place a document grows an attribute — never on load, never on save — so a
   * document with no comments stays byte-identical to one written before this module
   * existed.
   */
  function add({body, author, range: captured} = {}) {
    if (!writable() || !content || !body || !String(body).trim()) return null;
    const idx = provisionalIndex();
    /* The composer takes focus, which takes the selection: `begin()` captures the range
       first and hands it over, so what is commented on is what was selected. */
    const range = captured || selectedRange(idx);
    if (!range) return null;
    const draft = anchorOf(idx, range.from, range.to);
    if (!draft.blocks.length) return null;
    const ids = draft.blocks.map((name) => realIdFor(name, idx.list));
    const anchor = {...draft, blocks: ids};
    const comment = commentAt({anchor, body, author: author || writer()});
    store.comments.push(comment);
    save();
    draw();
    /* No navigation: adding a comment should not move the page under the writer. The
       card appears in the rail; opening it is a separate act. */
    return comment;
  }

  function reply(id, {body, author} = {}) {
    if (!writable() || !body || !String(body).trim()) return null;
    const at = store.comments.findIndex((comment) => comment.id === id);
    if (at < 0) return null;
    store.comments[at] = replyTo(store.comments[at], {
      body,
      author: author || store.comments[at].author,
    });
    save();
    draw();
    return store.comments[at];
  }

  function setResolved(id, resolved = true) {
    if (!writable()) return null;
    const comment = store.comments.find((candidate) => candidate.id === id);
    if (!comment) return null;
    comment.resolved = Boolean(resolved);
    comment.updatedAt = new Date().toISOString();
    if (comment.resolved && pinned === id) pinned = null;
    save();
    draw();
    return comment;
  }

  function remove(id) {
    if (!writable()) return false;
    const before = store.comments.length;
    store.comments = store.comments.filter((comment) => comment.id !== id);
    if (store.comments.length === before) return false;
    if (pinned === id) pinned = null;
    if (focused === id) blur();
    save();
    draw();
    return true;
  }

  const list = () => {
    const idx = index();
    resolveAll(idx);
    return store.comments.map((comment) => ({...comment, state: stateOf(comment)}));
  };

  /** How the bar labels itself: unresolved first, because that is the work left. */
  function counts() {
    const idx = index();
    let unresolved = 0;
    let orphans = 0;
    for (const comment of store.comments) {
      if (!comment.resolved) unresolved += 1;
      if (resolveAnchor(comment.anchor, idx).how === "orphan") orphans += 1;
    }
    return {total: store.comments.length, unresolved, orphans};
  }

  /** The list in the settings panel: the same rows, without the rail's room. */
  function panel(container) {
    container.replaceChildren();
    const idx = index();
    const rows = [...store.comments].sort(
      (a, b) => Number(Boolean(a.resolved)) - Number(Boolean(b.resolved)) || (a.anchor.from ?? 0) - (b.anchor.from ?? 0),
    );
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "doc-empty";
      empty.textContent = writable() ? "No comments yet. Select text, then Add comment." : "No comments in this copy.";
      container.append(empty);
      return container;
    }
    for (const comment of rows) {
      const state = resolveAnchor(comment.anchor, idx).how;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "doc-comment";
      button.dataset.commentId = comment.id;
      if (comment.resolved) button.dataset.resolved = "";
      const body = document.createElement("span");
      body.className = "doc-comment-body";
      body.textContent = comment.body.length > 96 ? `${comment.body.slice(0, 96)}…` : comment.body;
      const meta = document.createElement("span");
      meta.className = "doc-comment-meta";
      const flags = [comment.author.name, comment.resolved ? "resolved" : null, state === "orphan" ? "unattached" : state === "block" ? "on the paragraph" : null];
      if (comment.replies?.length) flags.push(`${comment.replies.length} ${comment.replies.length === 1 ? "reply" : "replies"}`);
      meta.textContent = flags.filter(Boolean).join(" · ");
      button.append(body, meta);
      container.append(button);
    }
    return container;
  }

  /* ------------------------------------------------------------------ composer */

  function closeComposer() {
    if (composer) composer.hidden = true;
    pending = null;
  }

  /** The document's own author, written where the Document panel would have written it. */
  function setDocumentAuthor(name) {
    const block = document.getElementById("doc-settings");
    if (!block) return "";
    const trimmed = String(name || "").trim();
    if (!trimmed) return "";
    try {
      const next = JSON.parse(block.textContent || "{}");
      next.author = trimmed;
      block.textContent = JSON.stringify(next);
      status()?.markDirty();
    } catch {
      return "";
    }
    return trimmed;
  }

  function openComposer(range, anchorEl) {
    if (!composer) return null;
    const editing = live().mode === "edit";
    pending = {range};
    /* Who is signing: the file's author in edit mode, this browser's name for a reviewer.
       Either way the question is asked at most once. */
    const named = editing ? Boolean(live().author) : Boolean(authorName());
    composer.replaceChildren();
    const form = document.createElement("form");
    form.style.cssText = "display:block;padding:10px 12px;font:14px/1.45 system-ui;color:#1b1f24;background:#fff;border:1px solid #dfe1e6;border-radius:8px;box-shadow:0 8px 24px rgba(15,23,42,0.18);width:320px";
    const heading = document.createElement("p");
    heading.style.cssText = "margin:0 0 6px;font:12px system-ui;color:#6b7280";
    heading.textContent = editing ? "Comment as the author" : "Comment as a reviewer";
    const box = document.createElement("textarea");
    box.rows = 3;
    box.required = true;
    box.placeholder = "What is wrong, or what is good?";
    box.setAttribute("aria-label", "Comment");
    box.style.cssText = "width:100%;box-sizing:border-box;font:13px/1.4 system-ui;padding:6px 8px;border:1px solid #dfe1e6;border-radius:6px;resize:vertical";
    const name = document.createElement("input");
    name.type = "text";
    name.value = editing ? (live().author || "") : authorName();
    name.placeholder = editing ? "Your name (saved in this file)" : "Your name (kept in this browser)";
    name.setAttribute("aria-label", "Your name");
    name.autocomplete = "nickname";
    name.style.cssText = "width:100%;box-sizing:border-box;margin-top:6px;font:13px system-ui;padding:5px 8px;border:1px solid #dfe1e6;border-radius:6px";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;justify-content:flex-end;margin-top:8px";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.style.cssText = "font:12px system-ui;padding:4px 10px;border:1px solid #dfe1e6;border-radius:6px;background:#fff;cursor:pointer";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Comment";
    submit.style.cssText = "font:12px system-ui;padding:4px 10px;border:1px solid #2f6fed;border-radius:6px;background:#2f6fed;color:#fff;cursor:pointer";
    form.append(heading, box);
    /* The author signs for themselves; a reviewer may be asked once. */
    if (!named) form.append(name);
    row.append(cancel, submit);
    form.append(row);
    composer.append(form);
    cancel.addEventListener("click", closeComposer);
    box.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeComposer();
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) form.requestSubmit();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!named && !name.value.trim()) {
        name.focus();
        return;
      }
      const typed = !named ? String(name.value).trim() : "";
      const who = editing
        ? writer(setDocumentAuthor(typed))
        : writer(setAuthorName(typed));
      add({body: box.value, author: who, range: pending?.range});
      closeComposer();
    });
    /* Shown on the next frame: the click that opened it is still propagating, and the
       outside-click handler would otherwise see a visible composer and close it. */
    requestAnimationFrame(() => {
      if (!composer || pending == null) return;
      composer.hidden = false;
      box.focus();
    });
    const box_ = anchorEl?.getBoundingClientRect?.();
    const width = 340;
    const margin = 8;
    const left = box_ ? Math.min(globalThis.innerWidth - width - margin, Math.max(margin, box_.left)) : margin * 4;
    const top = box_ ? Math.min(globalThis.innerHeight - 200, Math.max(margin, box_.bottom + 6)) : margin * 8;
    composer.style.left = `${Math.round(left)}px`;
    composer.style.top = `${Math.round(top)}px`;
    return composer;
  }

  /**
   * Start a comment on the current selection. Returns `{ok, reason}`: a button that can
   * only fail silently is a button that teaches nothing.
   */
  function begin() {
    if (!writable()) return {ok: false, reason: "This copy does not take comments."};
    const idx = provisionalIndex();
    const range = selectedRange(idx);
    if (!range) return {ok: false, reason: "Select the text you want to comment on first."};
    const selectionRange = globalThis.getSelection?.()?.rangeCount ? globalThis.getSelection().getRangeAt(0) : null;
    const rect = selectionRange?.getBoundingClientRect?.();
    openComposer(range, rect ? {getBoundingClientRect: () => rect} : null);
    return {ok: true};
  }

  /** Replace the whole store: what an import does once a human has accepted the list. */
  function replace(next) {
    const comments = Array.isArray(next?.comments) ? next.comments.filter(validComment) : [];
    store = {schema: 1, comments};
    pinned = null;
    save();
    draw();
    return store.comments.length;
  }

  /** Subscribe to "the store changed" — the bar's count, a panel's list. */
  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /* ------------------------------------------------------------------ session */

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  function mount() {
    if (!content || !stage) return null;
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "comment-layer";
      layer.dataset.runtime = "ephemeral";
      layer.setAttribute("aria-hidden", "false");
      layer.style.cssText = "position:absolute;inset:0;z-index:2;pointer-events:none;contain:layout style";
      stage.append(layer);
    }
    if (!rail) {
      rail = document.createElement("aside");
      rail.id = "comment-rail";
      rail.dataset.pluginUi = "";
      rail.setAttribute("aria-label", "Comments");
      document.body.append(rail);
    }
    if (!railTab) {
      railTab = document.createElement("button");
      railTab.type = "button";
      railTab.id = "comment-rail-tab";
      railTab.dataset.pluginUi = "";
      railTab.textContent = "Comments";
      railTab.hidden = true;
      railTab.addEventListener("click", () => {
        railOpen = true;
        layoutRail();
        railDirty = true;
        renderRail();
        notifyRail();
      });
      document.body.append(railTab);
    }
    if (!popover) {
      popover = document.createElement("div");
      popover.id = "comment-popover";
      popover.dataset.pluginUi = "";
      popover.hidden = true;
      /* Fixed, not stage-local: a thread has to stay readable at 200 % zoom, and it is
         session chrome — it never travels. */
      popover.style.cssText = "position:fixed;z-index:60;pointer-events:auto";
      document.body.append(popover);
    }
    if (!composer) {
      composer = document.createElement("div");
      composer.id = "comment-composer";
      composer.dataset.pluginUi = "";
      composer.hidden = true;
      composer.style.cssText = "position:fixed;z-index:61;pointer-events:auto";
      document.body.append(composer);
    }
    draw();
    return layer;
  }

  function init() {
    if (!content || !stage) return {comments: 0};
    store = load();
    mount();
    signals.on("layout", schedule);
    signals.on("mutation", schedule);
    signals.on("resize", schedule);
    document.fonts?.ready.then(schedule).catch(() => {});

    /* Hover previews, click pins, and a click anywhere else lets go. The rail and the
       page are one surface: hovering either side lights the other. */
    layer?.addEventListener("pointerover", (event) => {
      const hit = event.target.closest?.("[data-comment-id]");
      if (hit) hover(hit.dataset.commentId);
    });
    layer?.addEventListener("pointerout", (event) => {
      if (!event.relatedTarget?.closest?.("#comment-layer")) hover(null);
    });
    layer?.addEventListener("click", (event) => {
      const pill = event.target.closest("#comment-orphans");
      if (pill) {
        const orphan = store.comments.find((comment) => stateOf(comment) === "orphan");
        if (orphan) return focus(orphan);
        return;
      }
      const hit = event.target.closest("[data-comment-id]");
      if (!hit) return;
      const comment = store.comments.find((candidate) => candidate.id === hit.dataset.commentId);
      if (comment) focus(comment);
    });
    rail?.addEventListener("pointerover", (event) => {
      const hit = event.target.closest?.("[data-comment-card]");
      if (hit) hover(hit.dataset.commentId);
    });
    rail?.addEventListener("pointerleave", () => hover(null));
    rail?.addEventListener("click", onCardEvent);
    rail?.addEventListener("submit", onCardEvent);
    popover?.addEventListener("click", onCardEvent);
    popover?.addEventListener("submit", onCardEvent);
    railTab?.addEventListener("pointerenter", () => hover(null));

    document.addEventListener("click", (event) => {
      const inChrome = event.target.closest?.("#comment-rail, #comment-layer, #comment-popover, #comment-composer, #doc-bar, #app-toolbar, #doc-settings-dialog, #import-dialog");
      if (composer && !composer.hidden && !composer.contains(event.target) && !inChrome) closeComposer();
      if (popover && !popover.hidden && !popover.contains(event.target) && !inChrome) blur();
      if (pinned && !inChrome) unpin();
    });
    document.addEventListener("keydown", (event) => {
      /* Cmd/Ctrl+Alt+M starts a comment from the selection, in every mode: the editor
         has the ribbon's action, a review copy has this one. */
      if ((event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey && event.key.toLowerCase() === "m") {
        if (!writable()) return;
        event.preventDefault();
        begin();
        return;
      }
      if (event.key !== "Escape") return;
      if (composer && !composer.hidden) closeComposer();
      else if (pinned) unpin();
      else if (popover && !popover.hidden) blur();
    });
    /* A CSS `zoom` scales the box without changing its reported border box, so neither a
       ResizeObserver nor a pagination pass is guaranteed. The rail's geometry is in client
       pixels, so it has to hear about the change itself. */
    if (stage) {
      new MutationObserver(() => schedule()).observe(stage, {attributes: true, attributeFilter: ["style"]});
    }
    globalThis.addEventListener?.("resize", schedule);

    schedule();
    return {comments: store.comments.length};
  }

  /* Imports/exports are A3/A4; `merge` is here now because it is pure and tested. */
  const mergeInto = (local, incoming) => merge(local, incoming, index());

  init();

  /* A fresh comment id, for "Keep both" during an import: the store owns the namespace. */
  function newCommentId() {
    return newId("c");
  }

  const api = {
    init, mount, list, add, reply, resolve: setResolved, remove, focus, navigate, blur, render: draw,
    begin, counts, panel, onChange, toggleList, railActive, railShown, canWrite: writable, authorName, setAuthorName,
    merge: mergeInto, replace, load, newCommentId,
  };
  /* Offered to plugins, which must never own the store: a plugin may present comments,
     and may not become the thing that writes them (invariant 11). */
  env.StandaloneDoc?.provide?.("comments", api);
  return api;
}
