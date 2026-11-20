/* --------------------------------------------------------------- the block model
 *
 * `docs/EDITING-MODEL.md` is the contract; this is its implementation. Two jobs, one rule:
 *
 *   - `normalizeContent()` restores the invariant "every child of #content is a block";
 *   - `sanitizeHtml()` turns clipboard HTML into blocks, with the source's styles gone.
 *
 * Both are exported so a browser test can drive them directly and a plugin cannot invent
 * a third answer. They are DOM-only on purpose: the model's failures are layout failures,
 * and jsdom cannot measure layout. Everything here is idempotent — a second pass writes
 * nothing, which is what lets it run at construction without marking a document dirty.
 */

/** A block that holds text and can be the target of a caret. */
export const TEXT_BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6"]);

/** Everything the strategy table knows, plus the wrappers normalization removes. */
export const BLOCK_TAGS = new Set([
  ...TEXT_BLOCKS, "blockquote", "pre", "ul", "ol", "figure", "table", "hr", "div", "section",
]);

/** Elements that mean "a container someone else wrote". They unwrap when they hold blocks
    and become a paragraph when they do not. */
export const WRAPPER_TAGS = new Set([
  "div", "section", "article", "header", "footer", "main", "aside", "nav", "details",
  "summary", "form", "fieldset", "address", "hgroup", "dl", "dt", "dd",
]);

/** Semantic renames. `b`/`i` are presentational, and the document stores meaning. */
export const RENAME = {b: "strong", i: "em", strike: "s", tt: "code"};

export const KEEP_TAGS = new Set([
  ...TEXT_BLOCKS, "blockquote", "pre", "ul", "ol", "li", "table", "thead", "tbody", "tfoot",
  "tr", "td", "th", "caption", "figure", "figcaption", "hr", "br", "img", "a", "strong",
  "em", "u", "s", "code",
  "sub", "sup", "mark", "abbr", "cite", "q", "time", "var", "kbd", "samp", "dfn", "small",
  "del", "ins", "span",
]);

/** Tags that can execute, fetch, or submit. Removed with their contents. */
export const DROP_TAGS = new Set([
  "script", "style", "link", "meta", "base", "title", "head", "noscript", "iframe",
  "object", "embed", "form", "input", "button", "select", "textarea", "option", "svg",
  "canvas", "math", "template", "video", "audio", "source", "track", "map", "area",
]);

/** The only attributes that survive. Everything else is the source's presentation. */
export const KEEP_ATTRS = {
  a: ["href", "title"],
  img: ["src", "alt", "width", "height"],
  ol: ["start"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
};

export const SAFE_HREF = /^(?:#|\.{0,2}\/|https?:|mailto:|tel:)/i;
export const SAFE_SRC = /^(?:https?:|data:image\/)/i;

export function isElement(node) {
  return Boolean(node) && node.nodeType === Node.ELEMENT_NODE;
}

/** True when the element contains a block, at any depth. A `<span>` around `<p>`s does. */
export function hasBlockDescendant(el) {
  for (const child of el.children) {
    if (BLOCK_TAGS.has(child.localName) || hasBlockDescendant(child)) return true;
  }
  return false;
}

export function unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  el.remove();
}

export function wrapParagraph(node, doc) {
  const p = doc.createElement("p");
  node.replaceWith(p);
  p.append(node);
  return p;
}

export function renameTag(el, tag) {
  const doc = el.ownerDocument;
  const next = doc.createElement(tag);
  for (const attr of [...el.attributes]) next.setAttribute(attr.name, attr.value);
  while (el.firstChild) next.append(el.firstChild);
  el.replaceWith(next);
  return next;
}

/**
 * A text block that contains blocks is not a text block: the text runs stay (as clones of
 * the block's tag) and the nested blocks become siblings, in document order. This is the
 * `<p><ul>…</ul></p>` repair.
 */
export function flattenTextBlock(el) {
  const doc = el.ownerDocument;
  const tag = el.localName;
  const groups = [];
  let run = null;
  for (const node of [...el.childNodes]) {
    if (isElement(node) && (BLOCK_TAGS.has(node.localName) || node.localName === "li")) {
      run = null;
      groups.push(node);
      continue;
    }
    if (!run) {
      run = doc.createElement(tag === "div" ? "p" : tag);
      groups.push(run);
    }
    run.append(node);
  }
  for (const group of groups) {
    if (isElement(group) && group !== el && TEXT_BLOCKS.has(group.localName)
      && !group.textContent.trim() && !group.querySelector("img, br, hr")) {
      group.remove();
      continue;
    }
    el.before(group);
  }
  el.remove();
}

/** A list is `li` and nothing else. Inline runs become an item; empty items get a `<br>`. */
export function normalizeList(list) {
  const doc = list.ownerDocument;
  let run = null;
  for (const node of [...list.childNodes]) {
    if (isElement(node) && node.localName === "li") {
      run = null;
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE && !node.nodeValue.trim()) {
      node.remove();
      continue;
    }
    if (!run) {
      run = doc.createElement("li");
      node.before(run);
    }
    run.append(node);
  }
  for (const li of list.children) {
    if (li.localName !== "li") continue;
    if (!li.firstChild || (!li.textContent.trim() && !li.querySelector("img, br, ul, ol, pre, blockquote"))) {
      if (!li.querySelector("br")) li.append(doc.createElement("br"));
    }
  }
}

/**
 * A table is rows of cells and nothing else, and an empty cell needs a `<br>` or the caret
 * has nowhere to land. This is the table counterpart of `normalizeList`, with the same rule:
 * structure, not presentation.
 */
export function normalizeTable(table) {
  const doc = table.ownerDocument;
  for (const row of table.querySelectorAll("tr")) {
    let run = null;
    for (const node of [...row.childNodes]) {
      if (isElement(node) && (node.localName === "td" || node.localName === "th")) {
        run = null;
        continue;
      }
      if (node.nodeType === Node.TEXT_NODE && !node.nodeValue.trim()) {
        node.remove();
        continue;
      }
      if (!run) {
        run = doc.createElement("td");
        node.before(run);
      }
      run.append(node);
    }
  }
  for (const cell of table.querySelectorAll("td, th")) {
    if (!cell.firstChild || (!cell.textContent.trim() && !cell.querySelector("img, br, ul, ol, p"))) {
      if (!cell.querySelector("br")) cell.append(doc.createElement("br"));
    }
  }
  return table;
}

export function normalizePass(content) {
  const doc = content.ownerDocument;
  let changed = false;

  for (const node of [...content.childNodes]) {
    if (node.nodeType === Node.COMMENT_NODE) {
      node.remove();
      changed = true;
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.nodeValue.trim()) node.remove();
      else wrapParagraph(node, doc);
      changed = true;
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      node.remove();
      changed = true;
      continue;
    }

    const tag = node.localName;

    /* An `li` on its own becomes a list: a run of them is one list, so the loop restarts
       the run at the first one and the next pass sees the siblings already in it. */
    if (tag === "li") {
      const list = doc.createElement("ul");
      node.before(list);
      let next = node;
      while (next && next.nodeType === Node.ELEMENT_NODE && next.localName === "li") {
        const after = next.nextSibling;
        list.append(next);
        next = after;
      }
      normalizeList(list);
      changed = true;
      continue;
    }

    if (tag === "ul" || tag === "ol") {
      normalizeList(node);
      continue;
    }

    /* Anything that is not a block at the top level is a wrapper: a `div` someone else
       wrote, or a `span`/`b`/`a`/`img` that never should have been here. A container's
       blocks are the document's blocks; inline content becomes a paragraph.

       An authored block keeps its identity: a plugin's `<section id="bibliography"
       data-generated>` is a block the document *means*, and unwrapping it would delete the
       id the plugin (and a reader without the plugin) finds it by. Identity is `id` or
       `data-generated` — paste sanitization removes both before this runs, so a foreign
       wrapper can never claim one. */
    if (WRAPPER_TAGS.has(tag) || !BLOCK_TAGS.has(tag)) {
      const authored = node.id || node.hasAttribute("data-generated");
      if (authored && hasBlockDescendant(node) && (tag === "div" || tag === "section")) {
        continue;
      }
      if (hasBlockDescendant(node)) unwrap(node);
      else renameTag(node, "p");
      changed = true;
      continue;
    }

    if (!KEEP_TAGS.has(tag)) {
      /* Unknown element: keep its content, never its tag. */
      if (hasBlockDescendant(node)) unwrap(node);
      else wrapParagraph(node, doc);
      changed = true;
      continue;
    }

    if (TEXT_BLOCKS.has(tag) && hasBlockDescendant(node)) {
      flattenTextBlock(node);
      changed = true;
      continue;
    }
  }

  /* Every list in the document, nested ones included: a pasted `<ul><p>` can be nested
     inside an `li` and the top-level sweep never sees it. */
  for (const list of content.querySelectorAll("ul, ol")) normalizeList(list);
  for (const table of content.querySelectorAll("table")) normalizeTable(table);

  for (const el of content.querySelectorAll("[data-indent]")) {
    const level = Number(el.getAttribute("data-indent"));
    if (!Number.isInteger(level) || level < 1 || level > 8) el.removeAttribute("data-indent");
  }
  return changed;
}

/**
 * Restore the invariant. Idempotent: the second call returns 0 and writes nothing, so
 * running it at construction cannot make an opened document look dirty.
 *
 * Returns the number of passes that changed something (0 = already normal).
 */
export function normalizeContent(content) {
  let passes = 0;
  for (let i = 0; i < 8; i++) {
    if (!normalizePass(content)) break;
    passes += 1;
  }
  return passes;
}

/* Word marks its list items in a style attribute. It is the one thing read from a style,
   before every style is stripped: the marker span goes, and consecutive marked paragraphs
   become a real list. Flat on purpose — a nested Word list keeps its items and loses its
   depth, which is a smaller lie than keeping `mso-list` as anonymous spans. */
export function convertMsoLists(root, doc) {
  const marked = [...root.querySelectorAll("p, div, h1, h2, h3, h4, h5, h6")]
    .filter((el) => /mso-list\s*:/i.test(el.getAttribute("style") || ""));
  let group = null;
  for (const el of marked) {
    const style = el.getAttribute("style") || "";
    const level = Number(/level(\d)/i.exec(style)?.[1] || 1);
    const markerEl = el.querySelector('[style*="mso-list:Ignore"]');
    const marker = (markerEl?.textContent || "").trim();
    /* A numbered marker is digits or letters followed by `.` or `)`; everything else
       (Word's , a bullet glyph) is unordered. */
    const ordered = /^(?:\d+|[A-Za-z]{1,4})[.)]$/.test(marker);
    markerEl?.remove();
    /* Consecutive marked paragraphs are one list. After the first one is converted, the
       next element's previous sibling is the list we inserted, so that is the adjacency
       test; a level change starts a new (flat) list. */
    if (!group || group.level !== level || group.ordered !== ordered || el.previousElementSibling !== group.list) {
      const list = doc.createElement(ordered ? "ol" : "ul");
      el.before(list);
      group = {list, level, ordered};
    }
    const li = doc.createElement("li");
    while (el.firstChild) li.append(el.firstChild);
    group.list.append(li);
    el.remove();
  }
}

export function cleanAttributes(el) {
  const keep = KEEP_ATTRS[el.localName] || [];
  for (const attr of [...el.attributes]) {
    if (!keep.includes(attr.name)) el.removeAttribute(attr.name);
  }
  if (el.localName === "a") {
    if (!SAFE_HREF.test(el.getAttribute("href") || "")) unwrap(el);
  } else if (el.localName === "img") {
    if (!SAFE_SRC.test(el.getAttribute("src") || "")) el.remove();
  }
}

/**
 * Clipboard HTML → a DocumentFragment of canonical blocks.
 *
 * Ordered on purpose: executable tags first (so their text never reaches a marker
 * heuristic), then the one style attribute that carries structure, then renames, then
 * attributes, then normalization. Everything is parsed in a `<template>`, so nothing runs
 * and `<img>`/`<link>` never fetch while the fragment is detached.
 */
export function sanitizeHtml(html, doc = document) {
  const template = doc.createElement("template");
  template.innerHTML = String(html == null ? "" : html);
  const root = template.content;

  for (const el of [...root.querySelectorAll("*")]) {
    if (DROP_TAGS.has(el.localName)) el.remove();
  }

  convertMsoLists(root, doc);

  for (const el of [...root.querySelectorAll("*")].reverse()) {
    /* `root` is a template's content: a detached fragment, where `isConnected` is false
       for everything. Containment is the question that has an answer here. */
    if (!root.contains(el)) continue;
    const rename = RENAME[el.localName];
    if (rename) {
      const next = renameTag(el, rename);
      /* The rename replaced the node; the reversed walk still holds the old one. */
      cleanAttributes(next);
      continue;
    }
    if (!KEEP_TAGS.has(el.localName)) unwrap(el);
  }

  for (const el of root.querySelectorAll("*")) cleanAttributes(el);

  const holder = doc.createElement("div");
  holder.append(root);
  normalizeContent(holder);

  const fragment = doc.createDocumentFragment();
  fragment.append(...holder.childNodes);
  return fragment;
}

/** Plain text → the same block shape. Blank lines separate paragraphs; newlines are `<br>`. */
export function textToHtml(text) {
  const escape = (value) => String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    blocks.push(`<p>${run.map(escape).join("<br>")}</p>`);
    run = [];
  };
  for (const line of lines) {
    if (line.trim()) run.push(line);
    else flush();
  }
  flush();
  return blocks.join("") || "<p></p>";
}

/* ------------------------------------------------------------- the page's own theme
 *
 * Page geometry is CSS custom properties in the document's `#user-theme` block. It is
 * presentation, it must apply before the first paint with no module built, and every
 * consumer (pagination's probes, print's `@page`, figure sizes) already reads computed CSS.
 * One parser and one writer, so a font-size change cannot drop the margins.
 */

export const THEME_DECL = /(--[A-Za-z0-9-]+)\s*:\s*([^;}]+)/g;

export function parseTheme(text) {
  const vars = {};
  for (const match of String(text || "").matchAll(THEME_DECL)) vars[match[1]] = match[2].trim();
  return vars;
}

export function themeText(vars) {
  return `:root{${Object.entries(vars).map(([key, value]) => `${key}:${value};`).join("")}}`;
}

/** Page presets in inches. A file stores the resolved lengths, not the name. */
export const PAGE_SIZES = Object.freeze({
  letter: [8.5, 11],
  legal: [8.5, 14],
  a4: [8.27, 11.69],
  a5: [5.83, 8.27],
  tabloid: [11, 17],
});

export const INCH = {in: (v) => v, px: (v) => v / 96, pt: (v) => v / 72, cm: (v) => v / 2.54, mm: (v) => v / 25.4};

export function inches(value, fallback) {
  const match = /^(-?[\d.]+)\s*(in|px|pt|cm|mm)?$/.exec(String(value || "").trim());
  if (!match) return fallback;
  return INCH[match[2] || "in"](parseFloat(match[1]));
}

export const round2 = (value) => Math.round(Number(value) * 100) / 100;

export function createEditor(deps = {}) {
  const {signals, status, pagination, selection, env} = deps;
  /* A back-edge: figures (80) is built after editor (70). Only restore() reads
     it, and restore() is reachable from undo/redo, never from construction. */
  const figures = deps.late("figures");
  const content = document.getElementById("content");
  const STATE = ["bold", "italic", "underline", "strikeThrough",
    "superscript", "subscript", "insertUnorderedList", "insertOrderedList"];
  const BLOCKS = ["h1", "h2", "h3", "blockquote", "pre"];
  let saved = null;

  const inside = (node) => !!node && content.contains(node);
  const isSpacer = (n) => n.nodeType === Node.ELEMENT_NODE
    && n.classList.contains("page-spacer");

  // Resolve a block even when anchorNode is #content (Cmd+A, triple-click,
  // or a caret in the empty area below the last block).
  function blockAt(node, offset) {
    if (!node) return null;
    if (node === content) {
      const kids = [...content.childNodes].filter((n) => !isSpacer(n));
      const index = Math.max(0, Math.min(offset, kids.length - 1));
      const child = kids[index];
      if (!child) return null;
      if (child.nodeType === Node.ELEMENT_NODE) return child;
      const el = child.parentElement;
      return el && el.closest("#content > *");
    }
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el || !inside(el)) return null;
    return el.closest("#content > *");
  }

  function blockAtCaret() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    return blockAt(range.startContainer, range.startOffset)
      || blockAt(range.endContainer, range.endOffset);
  }

  function blocksInRange(range) {
    return [...content.children].filter((el) => {
      if (isSpacer(el)) return false;
      try {return range.intersectsNode(el);} catch {return false;}
    });
  }

  function listItemsInRange(range) {
    const list = listAtCaret();
    if (!list) return [];
    return [...list.children].filter((li) => {
      if (li.localName !== "li") return false;
      try {return range.intersectsNode(li);} catch {return false;}
    });
  }

  /* The bookmark a toolbar action restores is the same coordinate undo and pagination use:
     `{block, textOffset}`. A live Range cannot survive a fragment pass, because the text it
     points at moves into a block-level span. */
  function remember() {
    const next = selection.capture(content);
    if (next) saved = next;
  }

  function restore() {
    if (!saved) return false;
    content.focus();
    return selection.restore(content, saved);
  }

  function caretToEnd() {
    content.focus();
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function ensureSelection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !inside(sel.anchorNode)) {
      if (!restore()) caretToEnd();
    }
  }

  function selectNode(node) {
    const range = document.createRange();
    range.selectNode(node);
    const sel = window.getSelection();
    content.focus();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function listAtCaret() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    for (const [node, offset] of [
      [range.startContainer, range.startOffset],
      [range.endContainer, range.endOffset],
    ]) {
      const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (!el || !inside(el)) continue;
      const direct = el.closest("ul, ol");
      if (direct) return direct;
      const block = blockAt(node, offset);
      if (block && (block.localName === "ul" || block.localName === "ol")) return block;
      const nested = block && block.querySelector(":scope > ul, :scope > ol");
      if (nested) return nested;
    }
    return null;
  }

  // Chrome nests a native list inside the current <p>/<h*>/<blockquote>.
  // Switching the block to <div> first yields a valid list block instead.
  function setList(type) {
    ensureSelection();
    history.syncSelection();
    const cmd = type === "ul" ? "insertUnorderedList" : "insertOrderedList";
    const sel = window.getSelection();
    const range = sel.getRangeAt(0);
    const list = listAtCaret();

    if (list) {
      const items = listItemsInRange(range);
      if (list.localName === type) {
        // A direct DOM transform is clean and history makes it undoable.
        unwrapItems(items.length ? items : [...list.children]);
      } else {
        // ul <-> ol is native and mutually exclusive. A partial selection
        // converts the whole list so markers stay consistent.
        selectNode(list);
        document.execCommand("styleWithCSS", false, false);
        document.execCommand(cmd);
      }
    } else {
      const blocks = blocksInRange(range);
      if (blocks.length > 1) {
        const full = document.createRange();
        full.setStartBefore(blocks[0]);
        full.setEndAfter(blocks[blocks.length - 1]);
        sel.removeAllRanges();
        sel.addRange(full);
      }
      const block = blockAtCaret();
      if (!block) return;
      if (block.localName !== "div") {
        document.execCommand("formatBlock", false, "<div>");
      }
      document.execCommand("styleWithCSS", false, false);
      document.execCommand(cmd);
    }
    remember();
    flushTyping();
    history.record();
    syncToolbar();
  }

  const BLOCK_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6",
    "BLOCKQUOTE", "PRE", "UL", "OL", "DIV", "TABLE", "FIGURE", "HR"]);

  // Remove one <li> while keeping the surrounding items in lists.
  function unwrapListItem(li) {
    const list = li.parentElement;
    if (!list) return null;
    const items = [...list.children].filter((n) => n.localName === "li");
    const index = items.indexOf(li);
    const before = items.slice(0, index);
    const after = items.slice(index + 1);
    // <p> cannot legally contain a nested list; use <div> in that case.
    const hasBlock = [...li.children].some((n) => BLOCK_TAGS.has(n.nodeName));
    const block = document.createElement(hasBlock ? "div" : "p");
    while (li.firstChild) block.append(li.firstChild);
    const fragment = document.createDocumentFragment();
    if (before.length) {
      const ul = list.cloneNode(false);
      before.forEach((item) => ul.append(item));
      fragment.append(ul);
    }
    fragment.append(block);
    if (after.length) {
      const ul = list.cloneNode(false);
      /* Splitting an `<ol>` restarts numbering unless the tail says where it continues.
         The removed item occupied `start + index`; the tail begins at the next number. */
      if (list.localName === "ol") {
        const start = Number(list.getAttribute("start") || 1);
        ul.setAttribute("start", String(start + index + 1));
      }
      after.forEach((item) => ul.append(item));
      fragment.append(ul);
    }
    list.replaceWith(fragment);
    return block;
  }

  function unwrapItems(items) {
    const blocks = [];
    for (const li of [...items].reverse()) {
      if (li.localName !== "li" || !li.parentElement) continue;
      const block = unwrapListItem(li);
      if (block) blocks.unshift(block);
    }
    if (!blocks.length) return blocks;
    const first = blocks[0];
    const last = blocks[blocks.length - 1];
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
    const sel = window.getSelection();
    content.focus();
    sel.removeAllRanges();
    sel.addRange(range);
    return blocks;
  }

  /* ---- undo/redo -------------------------------------------------- */

  /* Undo and the toolbar bookmark share one coordinate, owned by src/selection.js.
     A path would be invalidated by a fragment wrapper; an offset is not. */
  function captureSelection() {
    return selection.capture(content);
  }

  function applySelection(saved) {
    if (!saved) return false;
    content.focus();
    return selection.restore(content, saved);
  }

  const history = (() => {
    const stack = [];
    const LIMIT = 50;
    let index = -1;

    function snapshot() {
      const clone = content.cloneNode(true);
      clone.querySelectorAll(".page-spacer").forEach((n) => n.remove());
      /* A pagination fragment is the session's wrapper, not the author's paragraph. Undo
         restores the semantic document; the next pass re-fragments it where the text now
         needs a break (lab/016 §11). */
      clone.querySelectorAll("[data-frag]").forEach((frag) => {
        while (frag.firstChild) frag.parentNode.insertBefore(frag.firstChild, frag);
        frag.remove();
      });
      clone.querySelectorAll("[data-page-start], [data-page-break]").forEach((n) => {
        n.removeAttribute("data-page-start");
        n.removeAttribute("data-page-break");
        n.style.marginBlockStart = "";
        if (!n.getAttribute("style")) n.removeAttribute("style");
      });
      // Runtime bytes are derived. Keeping an iframe (or its blob: URL) in
      // an undo snapshot would restore a dead frame and pin the blob.
      clone.querySelectorAll("[data-runtime='ephemeral']").forEach((n) => n.replaceChildren());
      clone.querySelectorAll("figure.figure").forEach((n) => {
        n.removeAttribute("data-selected");
        n.removeAttribute("data-mounted");
        n.removeAttribute("data-missing");
      });
      return {html: clone.innerHTML, sel: captureSelection()};
    }

    function record() {
      const snap = snapshot();
      if (index >= 0 && stack[index].html === snap.html) {
        stack[index].sel = snap.sel;
        return false;
      }
      stack.splice(index + 1);
      stack.push(snap);
      if (stack.length > LIMIT) stack.shift();
      index = stack.length - 1;
      return true;
    }

    // Keep the current snapshot's caret fresh without creating an entry.
    function syncSelection() {
      if (index < 0) return;
      const sel = captureSelection();
      if (sel) stack[index].sel = sel;
    }

    function restore(snap, cause = "undo") {
      figures().unmountAll();
      signals.mute(() => {content.innerHTML = snap.html;});
      applySelection(snap.sel);
      remember();
      syncToolbar();
      status.refresh();
      pagination.schedule();
      figures().scan();
      /* The DOM was replaced under a muted observer, so nothing that renders *from* the
         document — a plugin's derived labels, a reference list — has heard about it. This is
         the event it listens for (`host.on("restore")`), and it is emitted after the restore
         is complete rather than during it: a listener that writes is a content change, and it
         must land on the restored document, not inside the muted block. */
      env?.StandaloneDoc?.emit?.("restore", {cause});
    }

    function undo() {
      if (index <= 0) return false;
      index--;
      restore(stack[index], "undo");
      return true;
    }

    function redo() {
      if (index >= stack.length - 1) return false;
      index++;
      restore(stack[index], "redo");
      return true;
    }

    return {
      reset() {stack.length = 0; index = -1; record();},
      record,
      syncSelection,
      undo,
      redo,
      get canUndo() {return index > 0;},
      get canRedo() {return index < stack.length - 1;},
    };
  })();

  // A typing burst is one undo step: record only after 400ms of no input.
  let typingTimer = null;

  function flushTyping() {
    if (typingTimer) {
      clearTimeout(typingTimer);
      typingTimer = null;
    }
  }

  function scheduleTyping() {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      typingTimer = null;
      history.record();
    }, 400);
  }

  function exec(name, value = null) {
    if (name === "insertUnorderedList") return setList("ul");
    if (name === "insertOrderedList") return setList("ol");
    if (name === "undo") return history.undo();
    if (name === "redo") return history.redo();
    ensureSelection();
    history.syncSelection();
    document.execCommand("styleWithCSS", false, false);
    let ok = false;
    try {ok = document.execCommand(name, false, value);}
    catch (err) {console.warn("execCommand failed:", name, err);}
    remember();
    flushTyping();
    history.record();
    syncToolbar();
    return ok;
  }

  /**
   * Change the block tag. A list is not a paragraph: converting an item with `formatBlock`
   * produced `<p><ul>…</ul></p>` (invalid, and the planner then treated the whole list as
   * lines). The item is unwrapped into a real block first, and the rest of the list
   * survives around it.
   */
  function setBlock(tag) {
    ensureSelection();
    const list = listAtCaret();
    if (list) {
      const caret = selection.capture(content);
      pagination.merge();
      if (caret) selection.restore(content, caret);
      history.syncSelection();
      const range = window.getSelection().getRangeAt(0);
      const items = listItemsInRange(range);
      const blocks = unwrapItems(items.length ? items : [...list.children]);
      for (const block of blocks) {
        if (block.localName !== tag) renameBlock(block, tag);
      }
      afterStructural();
      return;
    }
    /* `exec` already recorded the undo step and marked the document dirty; the command's
       output only needs the model's repair, not a second history entry. */
    exec("formatBlock", `<${tag}>`);
    normalizeContent(content);
    remember();
    syncToolbar();
  }

  /** Replace a block's tag without asking the engine, keeping its content in place. */
  function renameBlock(el, tag) {
    const next = document.createElement(tag);
    for (const attr of [...el.attributes]) {
      if (attr.name === "data-page-start" || attr.name === "style") continue;
      next.setAttribute(attr.name, attr.value);
    }
    while (el.firstChild) next.append(el.firstChild);
    el.replaceWith(next);
    return next;
  }

  /* An atomic block cannot hold a caret: the browser will not put one inside
     a contenteditable="false" element, so if nothing editable follows it the
     space below is unreachable and the document effectively ends there. */
  const isAtomic = (node) => node.nodeType === Node.ELEMENT_NODE
    && node.getAttribute("contenteditable") === "false";

  /* The nearest sibling a caret can live in, skipping generated spacers.
     Nothing after the block counts as unreachable. */
  function editableAfter(node) {
    let next = node.nextSibling;
    while (next && isSpacer(next)) next = next.nextSibling;
    return next && !isAtomic(next) ? next : null;
  }

  /* Leave a text block below a block the caret cannot continue from, reusing the paragraph
     that is already there when the block lands mid-document — so a figure dropped between
     two paragraphs does not grow an empty one. A table is editable inside its cells but has
     no "after": typing below it needs a paragraph, the same reason a figure does. */
  const needsTextAfter = (node) => isAtomic(node) || node.localName === "table";

  function ensureTextAfter(node) {
    if (!needsTextAfter(node) || editableAfter(node)) return null;
    const paragraph = document.createElement("p");
    paragraph.append(document.createElement("br"));
    node.after(paragraph);
    return paragraph;
  }

  /* Insert an atomic block after the block at the caret. Never split the
     current text node: that is the caret rule the pagination engine is
     built on. An inserted atomic block keeps a text block below it, so the
     reader can always type under a figure. Returns the inserted node. */
  function insertBlock(node, {after = null, select = false} = {}) {
    if (!node) return null;
    const current = after || blockAtCaret();
    if (current && current.parentElement === content) current.after(node);
    else content.append(node);
    ensureTextAfter(node);

    flushTyping();
    history.record();
    syncToolbar();
    status.markDirty();
    if (select && node.nodeType === Node.ELEMENT_NODE) selectNode(node);
    pagination.schedule();
    return node;
  }

  /**
   * Insert an inline atomic at the caret, optionally consuming the text that opened it.
   *
   * The inline twin of `insertBlock`, and the reason it exists: a plugin that inserts a
   * citation mark (lab/017) must not do its own DOM surgery, because the three duties a
   * content change owes this document are the editor's — **one history entry**, the dirty
   * flag, and a repagination. A plugin that remembers two of the three is a bug report.
   *
   * `removeBefore` is how a typed trigger is spent: the picker that opened on `@@` passes
   * `2`, and the trigger never reaches the file. The caret lands in a text node *after* the
   * node, because a `contenteditable` region cannot hold a caret inside an atomic inline
   * element — the same rule `insertBlock` follows at block level, and the rule that makes
   * `ensureTextAfter` necessary above.
   *
   * Returns the inserted node, or null when the caret is not in the content.
   */
  function insertInline(node, {removeBefore = 0} = {}) {
    if (!node) return null;
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!inside(range.startContainer) || !range.collapsed) return null;

    /* The trigger is deleted first, so its characters are not part of the inserted node's
       neighbourhood and the mark lands exactly where the last keystroke was. */
    if (removeBefore > 0 && range.startContainer.nodeType === Node.TEXT_NODE) {
      const start = Math.max(0, range.startOffset - removeBefore);
      range.setStart(range.startContainer, start);
      range.deleteContents();
      range.collapse(true);
    }

    range.insertNode(node);

    /* A fresh text node rather than reusing the split half: when the caret was at the end
       of a text node there is no right half, and typing has to have somewhere to go. */
    let tail = node.nextSibling;
    if (!tail || tail.nodeType !== Node.TEXT_NODE) {
      tail = document.createTextNode("");
      node.after(tail);
    }
    const at = document.createRange();
    at.setStart(tail, 0);
    at.collapse(true);
    selection.removeAllRanges();
    selection.addRange(at);

    flushTyping();
    history.record();
    syncToolbar();
    status.markDirty();
    pagination.schedule();
    return node;
  }

  function syncToolbar() {
    for (const cmd of STATE) {
      let on = false;
      try {on = document.queryCommandState(cmd);} catch { }
      document.querySelectorAll(`[data-cmd="${cmd}"]`).forEach((btn) => {
        btn.setAttribute("aria-pressed", String(on));
      });
    }

    document.querySelectorAll('[data-cmd="undo"]').forEach((btn) => {
      btn.disabled = !history.canUndo;
    });
    document.querySelectorAll('[data-cmd="redo"]').forEach((btn) => {
      btn.disabled = !history.canRedo;
    });

    const block = blockAtCaret();
    if (!block) return;
    const value = BLOCKS.includes(block.localName) ? block.localName : "p";
    document.querySelectorAll("[data-block]").forEach((el) => {
      if (el.value !== value) el.value = value;
    });
    document.querySelectorAll("[data-block-set]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.blockSet === value));
    });
  }

  function setFontSize(size) {
    /* Through the merge, not by replacing the block: the theme also carries page geometry,
       and a font size must not delete the margins. */
    setThemeVars({"--doc-size": size});
    document.querySelectorAll("[data-fontsize]").forEach((el) => {el.value = size;});
    status.markDirty();
    pagination.schedule();
  }

  function openLink() {
    if (!restore()) caretToEnd();
    history.syncSelection();
    const sel = window.getSelection();
    let node = sel.anchorNode;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const anchor = node && node.closest ? node.closest("a") : null;
    const url = window.prompt("Link URL", anchor ? anchor.getAttribute("href") || "" : "");
    if (url === null) return;
    if (!restore()) caretToEnd();
    if (!url.trim()) document.execCommand("unlink");
    else if (anchor) anchor.setAttribute("href", url.trim());
    else document.execCommand("createLink", false, url.trim());
    remember();
    flushTyping();
    history.record();
    syncToolbar();
  }

  /* Deletion at the start of a fragment. The tail is a block-level span inside the same
     paragraph, and the engines treat that box boundary as a block join: measured in all
     three, Backspace one character *before* the seam deletes two characters, and Chromium
     and WebKit also delete two for Delete at or just before it. A selection whose range
     touches the seam loses one extra character the same way. The visible document has no
     boundary, so the editor deletes exactly the range the gesture names and lets the
     planner re-cut (a deleted head re-cuts in the same pre-paint pass). */
  function fragmentStarts(block) {
    return [...block.querySelectorAll(":scope > [data-frag]")]
      .map((frag) => selection.offsetIn(block, frag, 0));
  }

  function fragmentStartsAt(block, offset) {
    return fragmentStarts(block).includes(offset);
  }

  /* The engines' error reaches one character past the deleted range on either side, so
     the range is widened by one before it is compared with a seam. A cross-block range
     contains every seam between its endpoints. */
  function nearFragmentStart(from, to) {
    const first = content.children[from.block];
    const last = content.children[to.block];
    if (!first || !last) return false;
    if (first === last) {
      return fragmentStarts(first).some((seam) => seam >= from.offset - 1 && seam <= to.offset + 1);
    }
    for (let i = from.block + 1; i < to.block; i++) {
      const middle = content.children[i];
      if (middle && fragmentStarts(middle).length) return true;
    }
    return fragmentStarts(first).some((seam) => seam >= from.offset - 1)
      || fragmentStarts(last).some((seam) => seam <= to.offset + 1);
  }

  function seamDelete(event) {
    if (event.key !== "Backspace" && event.key !== "Delete") return;
    if (event.altKey || event.metaKey || event.ctrlKey || event.isComposing) return;
    const caret = selection.capture(content);
    if (!caret) return;
    const block = content.children[caret.start.block];
    if (!block) return;

    const back = event.key === "Backspace";
    let from = caret.start;
    let to = caret.end;
    if (caret.collapsed) {
      const offset = caret.start.offset;
      if (back ? offset <= 0 : offset >= block.textContent.length) return;
      from = {block: caret.start.block, offset: back ? offset - 1 : offset};
      to = {block: caret.start.block, offset: back ? offset : offset + 1};
    }
    if (!nearFragmentStart(from, to)) return;

    event.preventDefault();
    /* A selection is deleted from the live range so nested inline markup and a cross-block
       span behave as the browser would have (with the right character count). A collapsed
       deletion is one character, built from the offset coordinate. */
    const sel = window.getSelection();
    let range = null;
    if (!caret.collapsed && sel && sel.rangeCount) {
      range = sel.getRangeAt(0);
    } else {
      const a = selection.pointAt(block, from.offset);
      const b = selection.pointAt(block, to.offset);
      if (!a || !b) return;
      range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
    }
    deleteRange(caret, from, to, range);
  }

  /* Delete exactly `range`, leave the caret at `from`, and record one undo step. Shared by
     the seam guard and a cut that crosses a seam. */
  function deleteRange(caret, from, to, range) {
    range.deleteContents();
    const low = Math.min(caret.start.block, caret.end.block);
    const high = Math.max(caret.start.block, caret.end.block);
    for (let i = low; i <= high; i++) content.children[i]?.normalize();
    selection.restore(content, {start: from, end: from, collapsed: true});
    remember();
    flushTyping();
    history.record();
    status.markDirty();
    pagination.schedule();
    syncToolbar();
  }

  /* A copy that crosses a fragment boundary carries page furniture if the browser is left
     to serialise it: text/plain gets a line break where the block-level span starts, and
     text/html gets a `data-frag` element with the page push as an inline margin. Pasting
     that into the same document inserted a paragraph break and a 216 px gap that the
     reader never saw (lab/016 §15). The payload is rebuilt from the text coordinate with
     the fragments unwrapped. */
  function spansFragment(caret) {
    const first = content.children[caret.start.block];
    const last = content.children[caret.end.block];
    if (!first || !last) return false;
    if (first === last) {
      return fragmentStarts(first).some((seam) => seam >= caret.start.offset && seam <= caret.end.offset);
    }
    if (fragmentStarts(first).some((seam) => seam >= caret.start.offset)) return true;
    if (fragmentStarts(last).some((seam) => seam <= caret.end.offset)) return true;
    for (let i = caret.start.block + 1; i < caret.end.block; i++) {
      if (fragmentStarts(content.children[i]).length) return true;
    }
    return false;
  }

  function clipboardOf(caret) {
    const sel = window.getSelection();
    const host = document.createElement("div");
    if (sel && sel.rangeCount) host.append(sel.getRangeAt(0).cloneContents());
    for (const frag of [...host.querySelectorAll("[data-frag]")]) {
      while (frag.firstChild) frag.parentNode.insertBefore(frag.firstChild, frag);
      frag.remove();
    }
    for (const el of [...host.querySelectorAll("[data-page-start], [data-page-break]")]) {
      el.removeAttribute("data-page-start");
      el.removeAttribute("data-page-break");
      el.style.marginBlockStart = "";
      if (!el.getAttribute("style")) el.removeAttribute("style");
    }
    host.normalize();

    /* Paragraphs meet with a blank line in the engines' own clipboard text; inside one
       paragraph the slice must not invent a break at the seam. */
    const first = content.children[caret.start.block];
    const last = content.children[caret.end.block];
    let text = "";
    if (first && last) {
      if (first === last) text = first.textContent.slice(caret.start.offset, caret.end.offset);
      else {
        const parts = [first.textContent.slice(caret.start.offset)];
        for (let i = caret.start.block + 1; i < caret.end.block; i++) parts.push(content.children[i]?.textContent ?? "");
        parts.push(last.textContent.slice(0, caret.end.offset));
        text = parts.join("\n\n");
      }
    }
    return {text, html: host.innerHTML};
  }

  function copyAcrossSeam(event) {
    if (!event.clipboardData) return;
    const caret = selection.capture(content);
    if (!caret || caret.collapsed || !spansFragment(caret)) return;
    event.preventDefault();
    const payload = clipboardOf(caret);
    event.clipboardData.setData("text/plain", payload.text);
    event.clipboardData.setData("text/html", payload.html);
  }

  function cutAcrossSeam(event) {
    if (!event.clipboardData) return;
    const caret = selection.capture(content);
    if (!caret || caret.collapsed || !spansFragment(caret)) return;
    event.preventDefault();
    const payload = clipboardOf(caret);
    event.clipboardData.setData("text/plain", payload.text);
    event.clipboardData.setData("text/html", payload.html);
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    deleteRange(caret, caret.start, caret.end, sel.getRangeAt(0));
  }

  /* Enter at the start of a fragment. Firefox deletes a character at the block-box
     boundary before splitting, so the same guard applies: unwrap the fragments, split the
     paragraph at the caret, and let the next pass cut the new block. */
  function enterAtSeam(event) {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.isComposing) return;
    const caret = selection.capture(content);
    if (!caret || !caret.collapsed) return;
    const block = content.children[caret.start.block];
    if (!block || caret.start.offset <= 0) return;
    if (!fragmentStartsAt(block, caret.start.offset)) return;

    event.preventDefault();
    for (const frag of [...block.querySelectorAll("[data-frag]")]) {
      while (frag.firstChild) frag.parentNode.insertBefore(frag.firstChild, frag);
      frag.remove();
    }
    block.normalize();
    const point = selection.pointAt(block, caret.start.offset);
    if (!point) return;
    const range = document.createRange();
    range.setStart(point.node, point.offset);
    range.setEnd(block, block.childNodes.length);
    const tail = range.extractContents();
    const tag = /^h[1-6]$/i.test(block.localName) ? "p" : block.localName;
    const next = document.createElement(tag === "div" ? "p" : tag);
    next.append(tail);
    if (!next.firstChild) next.append(document.createElement("br"));
    block.after(next);
    const index = [...content.children].indexOf(next);
    selection.restore(content, {
      start: {block: index, offset: 0},
      end: {block: index, offset: 0},
      collapsed: true,
    });
    remember();
    flushTyping();
    history.record();
    status.markDirty();
    pagination.schedule();
    syncToolbar();
  }

  /* Triple-click selects the paragraph in the engines' native selection, but a
     block-level fragment span ends the selection at the cut: the tail is left out. The
     paragraph is one block to the author, so select the whole block after the gesture. */
  function tripleClick(event) {
    if (event.detail !== 3) return;
    const el = event.target.nodeType === Node.ELEMENT_NODE ? event.target : event.target.parentElement;
    const block = el?.closest?.("#content > *");
    if (!block || !block.querySelector("[data-frag]")) return;
    const index = [...content.children].indexOf(block);
    if (index < 0) return;
    selection.restore(content, {
      start: {block: index, offset: 0},
      end: {block: index, offset: block.textContent.length},
      collapsed: false,
    });
    remember();
    syncToolbar();
  }

  /* ------------------------------------------------------ theme and page geometry */

  const themeEl = () => document.getElementById("user-theme");

  function themeVars() {
    return parseTheme(themeEl()?.textContent || "");
  }

  /** Merge declarations into the document's theme block. `null`/`""` removes one. */
  function setThemeVars(patch) {
    const vars = themeVars();
    for (const [key, value] of Object.entries(patch || {})) {
      if (value == null || value === "") delete vars[key];
      else vars[key] = String(value);
    }
    if (themeEl()) themeEl().textContent = themeText(vars);
    return vars;
  }

  /** What the page looks like right now, in the units an author thinks in. */
  function pageState() {
    const cs = getComputedStyle(document.documentElement);
    const width = inches(cs.getPropertyValue("--sheet-w"), 8.5);
    const height = inches(cs.getPropertyValue("--sheet-h"), 11);
    const margins = {
      top: round2(inches(cs.getPropertyValue("--pad-top"), 0.9)),
      right: round2(inches(cs.getPropertyValue("--pad-right"), 0.9)),
      bottom: round2(inches(cs.getPropertyValue("--pad-bottom"), 0.9)),
      left: round2(inches(cs.getPropertyValue("--pad-left"), 0.9)),
    };
    const size = Object.entries(PAGE_SIZES)
      .find(([, [w, h]]) => {
        const short = Math.min(w, h);
        const long = Math.max(w, h);
        return Math.abs(short - Math.min(width, height)) < 0.02
          && Math.abs(long - Math.max(width, height)) < 0.02;
      })?.[0] || "custom";
    return {
      size,
      width: round2(width),
      height: round2(height),
      orientation: width > height ? "landscape" : "portrait",
      margins,
      leading: round2(parseFloat(cs.getPropertyValue("--doc-leading")) || 1.5),
    };
  }

  /**
   * Write page geometry and re-plan. Geometry is an input to the plan, not a decoration:
   * the pass has to run before the next paint or the sheets disagree with the text.
   *
   * A uniform margin writes `--pad` and removes the four side overrides, so the file keeps
   * the smallest true description of itself; an asymmetric one writes the four and removes
   * `--pad`, so there is exactly one answer in the block.
   */
  function applyPage(patch = {}) {
    const current = pageState();
    const preset = PAGE_SIZES[patch.size] || [current.width, current.height];
    let width = preset[0];
    let height = preset[1];
    const orientation = patch.orientation || (width > height ? "landscape" : "portrait");
    if (orientation === "landscape") [width, height] = [Math.max(width, height), Math.min(width, height)];
    else [width, height] = [Math.min(width, height), Math.max(width, height)];

    const margins = {...current.margins, ...(patch.margins || {})};
    for (const side of ["top", "right", "bottom", "left"]) {
      const value = Number(margins[side]);
      if (!Number.isFinite(value) || value < 0) margins[side] = current.margins[side];
    }

    const next = {"--sheet-w": `${round2(width)}in`, "--sheet-h": `${round2(height)}in`};
    const uniform = ["top", "right", "bottom", "left"].every((side) => Math.abs(margins[side] - margins.top) < 0.005);
    if (uniform) {
      next["--pad"] = `${round2(margins.top)}in`;
      next["--pad-top"] = "";
      next["--pad-right"] = "";
      next["--pad-bottom"] = "";
      next["--pad-left"] = "";
    } else {
      next["--pad"] = "";
      next["--pad-top"] = `${round2(margins.top)}in`;
      next["--pad-right"] = `${round2(margins.right)}in`;
      next["--pad-bottom"] = `${round2(margins.bottom)}in`;
      next["--pad-left"] = `${round2(margins.left)}in`;
    }

    const leading = Number(patch.leading);
    if (Number.isFinite(leading) && leading > 0) next["--doc-leading"] = String(round2(leading));

    setThemeVars(next);
    pagination.refresh({merge: true});
    status.markDirty();
    status.refresh();
    return pageState();
  }

  /** The whole theme block, with the current font size stamped in — one writer for save. */
  function themeWith(fontSize) {
    const vars = themeVars();
    if (fontSize) vars["--doc-size"] = String(fontSize);
    return themeText(vars);
  }

  /* --------------------------------------------------------------- structural edits */

  /**
   * Run a DOM move with the caret protected. Chromium resets the selection to the parent
   * element when the node holding it is moved with `append()` — measured: the caret in
   * "two" became `UL@1` after indenting the item. The coordinate survives the move, so
   * capture it first and put it back before anything reads the selection.
   */
  function structural(fn) {
    const caret = selection.capture(content);
    const result = fn();
    if (caret) selection.restore(content, caret);
    afterStructural();
    return result;
  }

  /** Every structural edit ends the same way: normalize, one undo step, one pass. */
  function afterStructural() {
    normalizeContent(content);
    remember();
    flushTyping();
    history.record();
    status.markDirty();
    pagination.schedule();
    syncToolbar();
  }

  function currentLi() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    let node = sel.getRangeAt(0).startContainer;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const li = node?.closest?.("li");
    return li && inside(li) ? li : null;
  }

  function setCaret(node, offset = 0) {
    if (!node) return;
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function caretAtStart(el) {
    const point = selection.pointAt(el, 0);
    if (point) return setCaret(point.node, point.offset);
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function caretAtEnd(el) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * The caret as a position *inside an item*, which is the coordinate a list move preserves.
   *
   * The block offset is ambiguous after a move: nesting an empty item or one at offset 0
   * leaves the block's text unchanged but puts the boundary before the nested list, so the
   * restore lands at the end of the parent item (measured in all three engines). The item
   * node itself survives `append()`, so its own offset is stable and unambiguous.
   */
  function liPoint(li) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed || !li.contains(range.startContainer)) return null;
    return {li, offset: selection.offsetIn(li, range.startContainer, range.startOffset)};
  }

  function restoreLiPoint(point) {
    if (!point || !point.li.isConnected) return;
    const at = selection.pointAt(point.li, point.offset);
    if (at) setCaret(at.node, at.offset);
    else caretAtStart(point.li); /* an empty item has no text node to point at */
  }

  function indentItem() {
    const li = currentLi();
    if (!li) return false;
    const list = li.parentElement;
    if (!list || (list.localName !== "ul" && list.localName !== "ol")) return false;
    const previous = li.previousElementSibling;
    if (!previous || previous.localName !== "li") return false;
    const caret = liPoint(li);
    pagination.merge();
    restoreLiPoint(caret);
    let nested = [...previous.children].find((child) => child.localName === list.localName);
    if (!nested) {
      nested = document.createElement(list.localName);
      previous.append(nested);
    }
    nested.append(li);
    restoreLiPoint(caret);
    afterStructural();
    return true;
  }

  function outdentItem() {
    const li = currentLi();
    if (!li) return false;
    const list = li.parentElement;
    if (!list) return false;
    const caret = liPoint(li);
    pagination.merge();
    restoreLiPoint(caret);
    const outer = list.parentElement && list.parentElement.localName === "li" ? list.parentElement : null;
    if (outer) {
      outer.after(li);
      if (![...list.children].some((child) => child.localName === "li")) list.remove();
      restoreLiPoint(caret);
    } else {
      /* At the top level, outdent means "stop being a list item", which is what the list
         toggle already does to one item. */
      unwrapListItem(li);
    }
    afterStructural();
    return true;
  }

  function currentCell() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    let node = sel.getRangeAt(0).startContainer;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const cell = node?.closest?.("td, th");
    return cell && inside(cell) ? cell : null;
  }

  /**
   * Tab walks the cells; Tab in the last one appends a row (the document grows, so this is
   * one history entry and one pass). Shift-Tab on the first cell leaves the table to the
   * browser, which is where focus should go.
   */
  function tableTab(event, cell) {
    const table = cell.closest("table");
    if (!table) return;
    const cells = [...table.querySelectorAll("td, th")];
    const index = cells.indexOf(cell);
    if (index < 0) return;
    const next = index + (event.shiftKey ? -1 : 1);
    if (next < 0) return; /* let Shift-Tab move focus out of the table */
    event.preventDefault();
    if (next < cells.length) {
      caretAtStart(cells[next]);
      return;
    }
    const body = table.tBodies[0] || table;
    const last = body.rows[body.rows.length - 1];
    const row = document.createElement("tr");
    for (const source of [...(last?.cells ?? [])]) {
      const copy = document.createElement(source.localName === "th" ? "td" : source.localName);
      copy.append(document.createElement("br"));
      row.append(copy);
    }
    if (!row.cells.length) {
      const columns = cells.length / Math.max(1, table.rows.length);
      for (let i = 0; i < columns; i++) {
        const copy = document.createElement("td");
        copy.append(document.createElement("br"));
        row.append(copy);
      }
    }
    body.append(row);
    caretAtStart(row.cells[0]);
    afterStructural();
  }

  /** Insert a table after the block at the caret, with the caret in its first cell. */
  function insertTable({rows = 3, cols = 3, header = true} = {}) {
    const rowCount = Math.max(1, Math.min(50, Math.round(Number(rows) || 3)));
    const colCount = Math.max(1, Math.min(12, Math.round(Number(cols) || 3)));
    const makeRow = (tag) => {
      const tr = document.createElement("tr");
      for (let i = 0; i < colCount; i++) {
        const cell = document.createElement(tag);
        cell.append(document.createElement("br"));
        tr.append(cell);
      }
      return tr;
    };
    const table = document.createElement("table");
    if (header) {
      const head = document.createElement("thead");
      head.append(makeRow("th"));
      table.append(head);
    }
    const body = document.createElement("tbody");
    for (let i = 0; i < (header ? rowCount - 1 : rowCount); i++) body.append(makeRow("td"));
    table.append(body);

    const current = blockAtCaret();
    if (current && current.parentElement === content) current.after(table);
    else content.append(table);
    ensureTextAfter(table);
    const first = table.querySelector("th, td");
    if (first) caretAtStart(first);
    flushTyping();
    history.record();
    status.markDirty();
    pagination.schedule();
    syncToolbar();
    return table;
  }

  function tabKey(event) {
    if (event.key !== "Tab" || event.altKey || event.metaKey || event.ctrlKey) return;
    const li = currentLi();
    if (li) {
      event.preventDefault();
      if (event.shiftKey) outdentItem();
      else indentItem();
      return;
    }
    const cell = currentCell();
    if (cell) tableTab(event, cell);
    /* Outside a list and a table, Tab is the browser's focus order. */
  }

  /* ---------------------------------------------------------- markdown-style lists
   Typing `- `, `* ` or `+ ` at the start of a paragraph starts a bulleted list; `1. ` or
   `1) ` starts a numbered one, at the number typed. The conversion happens on the space's
   `beforeinput`, so the marker never reaches the document, there is no flash of a paragraph
   becoming a list, and the whole thing is one undo step.

   Only a top-level text block whose *entire* text is the marker qualifies. `a - ` at the end
   of a sentence is a dash, and a marker inside a list item is just text in that item.
   */
  function listShortcut(event) {
    /* A space can arrive as a non-breaking space (end of a line, some layouts). The marker
       check below is what decides, so accepting both costs nothing and removes a way for
       the shortcut to work "sometimes". */
    if (event.inputType !== "insertText" || (event.data !== " " && event.data !== "\u00a0")) return;
    if (event.isComposing) return;
    const caret = selection.capture(content);
    if (!caret || !caret.collapsed) return;
    /* Inside a list item a marker is text in that item, not a new list. */
    if (currentLi()) return;

    const host = markerHost();
    if (!host) return;
    const marker = host.textContent;
    const bullet = marker === "-" || marker === "*" || marker === "+";
    const numbered = /^(\d{1,9})[.)]$/.exec(marker);
    if (!bullet && !numbered) return;
    const range = window.getSelection().getRangeAt(0);
    const at = selection.offsetIn(host, range.startContainer, range.startOffset);
    if (at !== marker.length) return;

    event.preventDefault();
    convertMarker(host, bullet ? "ul" : "ol", numbered ? Number(numbered[1]) : 1);
  }

  /**
   * The innermost element the marker is typed into. Not just a direct child of `#content`:
   * a legacy `<div>`, a plugin's container, and a `<blockquote>` are all places a caret can
   * be, and the first version silently ignored them — which is why the shortcut "worked
   * sometimes". A container is never the host: convert the text block inside it and let
   * normalization lift the result out.
   */
  function markerHost() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const node = sel.getRangeAt(0).startContainer;
    let el = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    while (el && el !== content && inside(el)) {
      const line = TEXT_BLOCKS.has(el.localName)
        || el.localName === "div"
        || el.localName === "blockquote";
      if (line && !hasBlockDescendant(el)) return el;
      el = el.parentElement;
    }
    /* A caret anchored on `#content` (after Cmd+A or a click in the empty area): the last
       block is the only sensible host. */
    const last = [...content.children].filter((child) => !isSpacer(child)).pop();
    if (!last) return null;
    const allowed = TEXT_BLOCKS.has(last.localName) || last.localName === "div" || last.localName === "blockquote";
    return allowed && !hasBlockDescendant(last) ? last : null;
  }

  /** Replace the marker block with a one-item list, caret inside the item. */
  function convertMarker(block, kind, start) {
    const list = document.createElement(kind);
    if (kind === "ol" && start !== 1) list.setAttribute("start", String(start));
    const li = document.createElement("li");
    const text = document.createTextNode("");
    li.append(text, document.createElement("br"));
    list.append(li);
    /* Inside a quote, the list belongs in the quote: replacing the blockquote would delete
       the quote the reader is typing in. Every other host is replaced by the list, and a
       normalization pass lifts it out of a container if one remains. */
    if (block.localName === "blockquote") block.replaceChildren(list);
    else block.replaceWith(list);
    setCaret(text, 0);
    afterStructural();
    return true;
  }

  /**
   * Backspace in an empty item: delete that line, split the list around it, and leave a
   * paragraph where the item was. The native engine behaviour is to merge the empty item
   * into the previous one, which resurrects the previous item's text and leaves no place to
   * type outside the list.
   *
   * The paragraph is the "line" the item became; the list before and the list after are
   * separate elements, and the tail of an `<ol>` carries `start` so numbering continues.
   */
  function backspaceEmptyItem(event) {
    if (event.key !== "Backspace" || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) return;
    const li = currentLi();
    if (!li) return;
    if (li.textContent.trim() || li.querySelector("img, table, pre, ul, ol, figure, hr")) return;
    const caret = selection.capture(content);
    if (!caret || !caret.collapsed) return;
    event.preventDefault();
    pagination.merge();
    const block = unwrapListItem(li);
    if (!block) return;
    if (!block.textContent.trim() && !block.querySelector("br, img")) block.append(document.createElement("br"));
    caretAtStart(block);
    afterStructural();
  }

  /* A click in the empty area below the last block, or below a short list, belongs to a new
     paragraph. Without this the caret lands at the end of the last `<li>` and typing
     continues the list — the "my edits get rerouted into the list" report. */
  function belowClick(event) {
    if (event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target?.closest?.("#content > *") || target?.closest?.("#app-toolbar")) return;
    const last = [...content.children].filter((el) => !isSpacer(el)).pop();
    const contentBox = content.getBoundingClientRect();
    if (event.clientX < contentBox.left - 40 || event.clientX > contentBox.right + 40) return;
    if (last) {
      const box = last.getBoundingClientRect();
      if (event.clientY <= box.bottom) return;
    }
    event.preventDefault();
    const paragraph = document.createElement("p");
    paragraph.append(document.createElement("br"));
    if (last) last.after(paragraph);
    else content.append(paragraph);
    setCaret(paragraph, 0);
    afterStructural();
  }

  /** Merge fragments, then insert blocks at the caret. Returns true when it inserted. */
  function insertBlocks(nodes) {
    const blocks = [...nodes].filter((node) => node.nodeType === Node.ELEMENT_NODE);
    if (!blocks.length) return false;
    /* The caret is a coordinate, and a merge moves the text it points at. Capture, merge,
       restore: the next capture is then the caret the reader actually had. */
    const before = selection.capture(content);
    pagination.merge();
    if (before) selection.restore(content, before);
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !inside(sel.anchorNode)) return false;
    if (!sel.isCollapsed) sel.getRangeAt(0).deleteContents();
    const caret = selection.capture(content);
    if (!caret) return false;

    const block = content.children[caret.start.block];
    if (!block) {
      for (const node of blocks) content.append(node);
      return finishInsert();
    }

    const li = currentLi();
    if (li) return insertIntoList(li, caret, blocks);

    if (!TEXT_BLOCKS.has(block.localName)) {
      let ref = block;
      for (const node of blocks) {
        ref.after(node);
        ref = node;
      }
      caretAtEnd(ref);
      return finishInsert();
    }

    const point = selection.pointAt(block, caret.start.offset);
    if (!point) return false;

    /* One paragraph of inline content is an inline insert: a paste into the middle of a
       sentence must not split the paragraph. */
    const inline = blocks.length === 1
      && blocks[0].localName === "p"
      && !hasBlockDescendant(blocks[0])
      && !blocks[0].querySelector("img, figure, table, hr");
    if (inline) {
      const range = document.createRange();
      range.setStart(point.node, point.offset);
      range.collapse(true);
      const tail = document.createTextNode("");
      range.insertNode(tail);
      const fragment = document.createDocumentFragment();
      fragment.append(...blocks[0].childNodes);
      tail.before(fragment);
      setCaret(tail, 0);
      return finishInsert();
    }

    /* Blocks split the paragraph: the head keeps the block's identity, the tail is a new
       block below, and the payload sits between them. A heading's tail becomes a paragraph,
       because a heading that continues after pasted body text is not a heading. */
    const range = document.createRange();
    range.setStart(point.node, point.offset);
    range.setEnd(block, block.childNodes.length);
    const tail = document.createElement("p");
    tail.append(range.extractContents());
    const hasTail = Boolean(tail.textContent.trim()) || Boolean(tail.querySelector("img, br, hr"));
    let ref = block;
    if (hasTail && tail.textContent.trim()) {
      block.after(tail);
      for (const node of blocks) {
        ref.after(node);
        ref = node;
      }
      caretAtStart(tail);
    } else {
      /* Nothing followed the caret: the paste continues the document where it stood, and
         the caret goes to its end. An empty paragraph nobody typed in is not content. */
      tail.remove();
      for (const node of blocks) {
        ref.after(node);
        ref = node;
      }
      caretAtEnd(ref);
    }
    return finishInsert();
  }

  function insertIntoList(li, caret, blocks) {
    const block = content.children[caret.start.block];
    const list = li.parentElement;
    if (!list || (list.localName !== "ul" && list.localName !== "ol")) return false;
    const start = selection.offsetIn(block, li, 0);
    const point = selection.pointAt(li, Math.max(0, caret.start.offset - start));
    if (!point) return false;

    const range = document.createRange();
    range.setStart(point.node, point.offset);
    range.setEnd(li, li.childNodes.length);
    const tail = document.createElement("li");
    tail.append(range.extractContents());
    const hasTail = Boolean(tail.textContent.trim()) || Boolean(tail.querySelector("img, br, ul, ol"));
    li.after(tail);

    const sameList = blocks.length === 1 && blocks[0].localName === list.localName;
    if (sameList) {
      let ref = li;
      for (const child of [...blocks[0].children]) {
        if (child.localName !== "li") continue;
        ref.after(child);
        ref = child;
      }
      blocks[0].remove();
      if (hasTail) {
        caretAtStart(tail);
      } else {
        /* The paste ended the item: an empty item after it would be a bullet nobody asked
           for, and the caret belongs at the end of what was pasted. */
        tail.remove();
        caretAtEnd(ref);
      }
    } else if (!hasTail) {
      /* Nothing followed the caret: the payload simply continues after the list, and the
         caret goes to its end. An empty trailing item would be a bullet nobody asked for. */
      tail.remove();
      let ref = list;
      for (const node of blocks) {
        ref.after(node);
        ref = node;
      }
      caretAtEnd(ref);
    } else {
      const tailList = list.cloneNode(false);
      let node = tail;
      while (node) {
        const next = node.nextElementSibling;
        tailList.append(node);
        node = next;
      }
      list.after(tailList);
      let ref = list;
      for (const node of blocks) {
        ref.after(node);
        ref = node;
      }
      caretAtStart(tail);
    }
    return finishInsert();
  }

  function finishInsert() {
    normalizeContent(content);
    remember();
    flushTyping();
    history.record();
    status.markDirty();
    pagination.schedule();
    syncToolbar();
    return true;
  }

  function ingestClipboard(data) {
    if (!data) return false;
    if (data.files && data.files.length) return false; /* figures owns the file path */
    const html = data.getData?.("text/html") || "";
    const text = data.getData?.("text/plain") || "";
    if (!html && !text) return false;
    const fragment = html ? sanitizeHtml(html) : sanitizeHtml(textToHtml(text));
    return insertBlocks([...fragment.childNodes]);
  }

  function onPaste(event) {
    if (!event.clipboardData) return;
    const handled = ingestClipboard(event.clipboardData);
    if (handled) event.preventDefault();
  }

  function onDrop(event) {
    const data = event.dataTransfer;
    if (!data) return;
    const types = [...(data.types || [])];
    if (types.includes("Files")) return;
    if (!types.includes("text/html") && !types.includes("text/plain")) return;
    const point = document.caretRangeFromPoint?.(event.clientX, event.clientY)
      || (() => {
        const position = document.caretPositionFromPoint?.(event.clientX, event.clientY);
        if (!position) return null;
        const range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
        range.collapse(true);
        return range;
      })();
    if (!point) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(point);
    if (ingestClipboard(data)) event.preventDefault();
  }

  function init() {
    try {document.execCommand("defaultParagraphSeparator", false, "p");} catch { }
    content.addEventListener("keydown", seamDelete);
    content.addEventListener("copy", copyAcrossSeam);
    content.addEventListener("cut", cutAcrossSeam);
    content.addEventListener("keydown", enterAtSeam);
    content.addEventListener("click", tripleClick);
    /* Structure-aware commands and ingestion. All of them end in `afterStructural()`. */
    content.addEventListener("keydown", tabKey);
    content.addEventListener("beforeinput", listShortcut);
    content.addEventListener("keydown", backspaceEmptyItem);
    content.addEventListener("paste", onPaste);
    content.addEventListener("drop", onDrop);
    content.addEventListener("mousedown", belowClick);
    /* An opened document is normalized once, before anything captures a baseline; a
       legacy wrapper (a pasted `<div>`) must not be a permanent second kind of block. */
    normalizeContent(content);
    status.rebase?.();
    /* Print preview can lay the document out at the preview's size; when the dialog
       closes, re-plan at the real viewport rather than leaving the screen with the
       preview's page boxes. */
    window.addEventListener("afterprint", () => {
      requestAnimationFrame(() => pagination.refresh());
    });
    document.addEventListener("selectionchange", () => {
      remember();
      syncToolbar();
      history.syncSelection();
    });
    signals.on("beforeinput", () => history.syncSelection());
    signals.on("edit", scheduleTyping);
    signals.on("compositionend", () => {
      flushTyping();
      history.record();
    });
    content.addEventListener("blur", () => {
      flushTyping();
      history.record();
    });
    history.reset();
  }

  const api = {init, exec, setBlock, setList, syncToolbar, setFontSize, openLink, remember, restore, history, blockAt, blockAtCaret, insertBlock, insertInline, insertTable, applyPage, pageState, themeWith};

  /* What a plugin may use as `host.use("editor")`. Editing is the editor's: a plugin
     asks it to insert, not to write into #content itself. */
  const registry = env && env.StandaloneDoc;
  if (registry && typeof registry.provide === "function") {
    registry.provide("editor", {
      insertBlock, insertInline, insertTable, exec, setBlock, blockAt,
      /* Structural edits a plugin may need without writing into #content itself. */
      insertBlocks, normalize: () => normalizeContent(content), applyPage, pageState,
    });
  }

  /* Construction-time, exactly where the trailing Editor.init() ran. */
  init();
  return api;
}
