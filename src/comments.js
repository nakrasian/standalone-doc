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
 * The DOM half: block ids, the marker overlay, the thread popover.
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

  /* Both are optional in the sense that matters: a document with no `#content` has no
     document to annotate, and the module still has to return its API. */
  let layer = null;
  let popover = null;
  let store = {schema: 1, comments: []};
  let cache = new Map();
  let frame = 0;
  let focused = null;
  let composer = null;
  let pending = null;
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

  /** Every mutation ends here, so the bar can update a count without polling. */
  function changed() {
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

  /** The page content bands, in layout px, from the pass that just run. */
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

  /** Where a block-level (or orphan) marker goes: the block's first line, or the page. */
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
        /* Culling is deliberately absent: the plan's threshold is ~200 comments, and it
           should be measured before it is optimised. */
        marker(rects, comment);
      }
    }
    const orphans = [...resolved.values()].filter((result) => result.how === "orphan").length;
    if (orphans) drawOrphanPill(orphans);
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

  /* ------------------------------------------------------------------- threads */

  function thread(parent, comment, result) {
    const header = document.createElement("div");
    header.style.cssText = "display:flex;gap:8px;align-items:baseline;margin:0 0 6px";
    const who = document.createElement("strong");
    who.textContent = comment.author.name;
    const meta = document.createElement("span");
    meta.style.cssText = "color:#6b7280;font:12px system-ui";
    meta.textContent = [comment.author.kind === "author" ? "author" : "reviewer", comment.createdAt?.slice(0, 10)].filter(Boolean).join(" · ");
    header.append(who, meta);
    if (comment.resolved) {
      const badge = document.createElement("span");
      badge.textContent = "resolved";
      badge.style.cssText = "margin-left:auto;font:12px system-ui;color:#047857";
      header.append(badge);
    }

    const body = document.createElement("p");
    body.style.cssText = "margin:0 0 6px;white-space:pre-wrap";
    body.textContent = comment.body;

    parent.append(header, body);

    if (result?.anchor?.quote && result.how !== "exact") {
      const note = document.createElement("p");
      note.style.cssText = "margin:0 0 6px;font:12px system-ui;color:#92400e";
      note.textContent = result.how === "shifted" ? "Re-attached by its quotation." : "The text this was about is gone; the comment is on the paragraph.";
      parent.append(note);
    }

    if (comment.replies?.length) {
      const list = document.createElement("ol");
      list.style.cssText = "margin:6px 0 0;padding-left:18px";
      for (const reply of comment.replies) {
        const item = document.createElement("li");
        item.style.cssText = "margin:0 0 4px";
        const name = document.createElement("strong");
        name.textContent = reply.author?.name || "Reviewer";
        const text = document.createElement("span");
        text.textContent = ` ${reply.body}`;
        item.append(name, text);
        list.append(item);
      }
      parent.append(list);
    }
  }

  /**
   * A writable thread's verbs. Deliberately three: reply, resolve, and the parent's
   * delete. Editing a comment is a reply — a review history that can be rewritten is
   * not a history (invariant 29).
   */
  function actions(parent, comment, result) {
    const footer = document.createElement("div");
    footer.style.cssText = "margin-top:8px;padding-top:8px;border-top:1px solid #eef0f4;display:flex;gap:6px;flex-wrap:wrap";

    const resolve = document.createElement("button");
    resolve.type = "button";
    resolve.textContent = comment.resolved ? "Reopen" : "Resolve";
    resolve.style.cssText = "font:12px system-ui;padding:3px 8px;border:1px solid #dfe1e6;border-radius:6px;background:#fff;cursor:pointer";
    resolve.addEventListener("click", () => {
      const next = setResolved(comment.id, !comment.resolved);
      if (next) focus(next);
    });

    const replyButton = document.createElement("button");
    replyButton.type = "button";
    replyButton.textContent = "Reply";
    replyButton.style.cssText = resolve.style.cssText;
    replyButton.addEventListener("click", () => {
      const box = document.createElement("textarea");
      box.rows = 2;
      box.placeholder = "Reply…";
      box.setAttribute("aria-label", "Reply");
      box.style.cssText = "flex:1 1 100%;margin-top:6px;font:13px system-ui;padding:6px;border:1px solid #dfe1e6;border-radius:6px";
      const send = document.createElement("button");
      send.type = "button";
      send.textContent = "Send";
      send.style.cssText = resolve.style.cssText;
      const post = () => {
        const next = reply(comment.id, {body: box.value, author: writer()});
        if (next) focus(next);
      };
      send.addEventListener("click", post);
      box.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) post();
      });
      replyButton.replaceWith(box);
      footer.append(send);
      box.focus();
    });

    footer.append(resolve, replyButton);

    if (live().mode === "edit") {
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.textContent = "Delete";
      removeButton.style.cssText = resolve.style.cssText;
      removeButton.addEventListener("click", () => {
        remove(comment.id);
        blur();
      });
      footer.append(removeButton);
    }

    if (result?.how === "orphan") {
      const note = document.createElement("span");
      note.style.cssText = "font:11px system-ui;color:#92400e";
      note.textContent = "Its paragraph is gone.";
      footer.append(note);
    }

    parent.append(footer);
  }

  function placePopover(anchorEl) {
    if (!popover) return;
    const box = anchorEl?.getBoundingClientRect?.();
    const width = 320;
    const margin = 8;
    const left = box ? Math.min(window.innerWidth - width - margin, Math.max(margin, box.left)) : margin * 4;
    const top = box ? Math.min(window.innerHeight - 120, Math.max(margin, box.bottom + 6)) : margin * 8;
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function focus(comment) {
    if (!popover || !comment) return null;
    const result = cache.get(comment.id) || resolveAnchor(comment.anchor, index());
    popover.replaceChildren();
    const panel = document.createElement("div");
    panel.style.cssText = "padding:10px 12px;font:14px/1.45 system-ui;color:#1b1f24;background:#fff;border:1px solid #dfe1e6;border-radius:8px;box-shadow:0 8px 24px rgba(15,23,42,0.18);max-width:320px";
    thread(panel, comment, result);
    if (writable()) actions(panel, comment, result);
    popover.append(panel);
    popover.hidden = false;
    focused = comment.id;
    const el = layer?.querySelector(`[data-comment-id="${comment.id}"]`);
    placePopover(el);
    return comment;
  }

  function blur() {
    if (popover) popover.hidden = true;
    focused = null;
  }

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
    return comment;
  }

  function reply(id, {body, author} = {}) {
    if (!writable() || !body || !String(body).trim()) return null;
    const indexOfComment = store.comments.findIndex((comment) => comment.id === id);
    if (indexOfComment < 0) return null;
    store.comments[indexOfComment] = replyTo(store.comments[indexOfComment], {
      body,
      author: author || store.comments[indexOfComment].author,
    });
    save();
    draw();
    return store.comments[indexOfComment];
  }

  function setResolved(id, resolved = true) {
    if (!writable()) return null;
    const comment = store.comments.find((candidate) => candidate.id === id);
    if (!comment) return null;
    comment.resolved = Boolean(resolved);
    comment.updatedAt = new Date().toISOString();
    save();
    draw();
    return comment;
  }

  function remove(id) {
    if (!writable()) return false;
    const before = store.comments.length;
    store.comments = store.comments.filter((comment) => comment.id !== id);
    if (store.comments.length === before) return false;
    save();
    draw();
    return true;
  }

  const list = () => {
    const idx = index();
    return store.comments.map((comment) => ({...comment, state: resolveAnchor(comment.anchor, idx).how}));
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

  /** The thread list, unresolved first, for the bar's panel and the Comments tab. */
  function panel(container) {
    container.replaceChildren();
    const idx = index();
    const rows = [...store.comments].sort(
      (a, b) => Number(Boolean(a.resolved)) - Number(Boolean(b.resolved)) || String(a.createdAt).localeCompare(String(b.createdAt)),
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
      const flags = [comment.author.name, state === "orphan" ? "unattached" : state === "block" ? "on the paragraph" : null];
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
      const created = add({body: box.value, author: who, range: pending?.range});
      closeComposer();
      if (created) focus(created);
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
    document.addEventListener("click", (event) => {
      if (composer && !composer.hidden && !composer.contains(event.target) && !event.target.closest?.("#comment-layer")) {
        closeComposer();
      }
      if (popover?.hidden) return;
      if (popover.contains(event.target)) return;
      if (event.target.closest?.("#comment-layer")) return;
      /* The bar is chrome that opens threads, not a click "outside" them. */
      if (event.target.closest?.("#doc-bar")) return;
      blur();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (composer && !composer.hidden) closeComposer();
      else if (popover && !popover.hidden) blur();
    });
    layer?.addEventListener("click", (event) => {
      const pill = event.target.closest("#comment-orphans");
      if (pill) {
        const orphan = store.comments.find((comment) => (cache.get(comment.id) || {how: "orphan"}).how === "orphan");
        if (orphan) {
          const result = focus(orphan);
          placePopover(null);
          return result;
        }
        return;
      }
      const hit = event.target.closest("[data-comment-id]");
      if (!hit) return;
      const comment = store.comments.find((candidate) => candidate.id === hit.dataset.commentId);
      if (comment) focus(comment);
    });
    schedule();
    return {comments: store.comments.length};
  }

  /* Imports/exports are A3/A4; `merge` is here now because it is pure and tested. */
  const mergeInto = (local, incoming) => merge(local, incoming, index());

  init();

  const api = {
    init, mount, list, add, reply, resolve: setResolved, remove, focus, blur, render: draw,
    begin, counts, panel, onChange, canWrite: writable, authorName, setAuthorName, merge: mergeInto, load,
  };
  /* Offered to plugins, which must never own the store: a plugin may present comments,
     and may not become the thing that writes them (invariant 11). */
  env.StandaloneDoc?.provide?.("comments", api);
  return api;
}
