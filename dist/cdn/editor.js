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
    if (!blocks.length) return;
    const first = blocks[0];
    const last = blocks[blocks.length - 1];
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
    const sel = window.getSelection();
    content.focus();
    sel.removeAllRanges();
    sel.addRange(range);
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
      clone.querySelectorAll("[data-page-start]").forEach((n) => {
        n.removeAttribute("data-page-start");
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

    function restore(snap) {
      figures().unmountAll();
      signals.mute(() => {content.innerHTML = snap.html;});
      applySelection(snap.sel);
      remember();
      syncToolbar();
      status.refresh();
      pagination.schedule();
      figures().scan();
    }

    function undo() {
      if (index <= 0) return false;
      index--;
      restore(stack[index]);
      return true;
    }

    function redo() {
      if (index >= stack.length - 1) return false;
      index++;
      restore(stack[index]);
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

  function setBlock(tag) {
    exec("formatBlock", `<${tag}>`);
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

  /* Leave a text block below an atomic block, reusing the paragraph that is
     already there when the block lands mid-document — so a figure dropped
     between two paragraphs does not grow an empty one. */
  function ensureTextAfter(node) {
    if (!isAtomic(node) || editableAfter(node)) return null;
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
    document.getElementById("user-theme").textContent = `:root{--doc-size:${size}}`;
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

  /* Backspace at the start of a fragment. The tail is a block-level span inside the same
     paragraph, and Chromium treats that boundary as a block join: one Backspace there
     deletes two characters. The visible document has no boundary, so delete exactly the
     character before the caret and let the planner re-cut on the next frame. */
  function fragmentStartsAt(block, offset) {
    for (const frag of block.querySelectorAll(":scope > [data-frag]")) {
      if (selection.offsetIn(block, frag, 0) === offset) return true;
    }
    return false;
  }

  function backspaceAtSeam(event) {
    if (event.key !== "Backspace" || event.altKey || event.metaKey || event.ctrlKey) return;
    const caret = selection.capture(content);
    if (!caret || !caret.collapsed) return;
    const block = content.children[caret.start.block];
    if (!block || caret.start.offset <= 0) return;
    if (!fragmentStartsAt(block, caret.start.offset)) return;

    const from = selection.pointAt(block, caret.start.offset - 1);
    const to = selection.pointAt(block, caret.start.offset);
    if (!from || !to) return;
    event.preventDefault();
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    range.deleteContents();
    block.normalize();
    selection.restore(content, {
      start: {block: caret.start.block, offset: caret.start.offset - 1},
      end: {block: caret.start.block, offset: caret.start.offset - 1},
      collapsed: true,
    });
    remember();
    flushTyping();
    history.record();
    status.markDirty();
    pagination.schedule();
    syncToolbar();
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

  function init() {
    try {document.execCommand("defaultParagraphSeparator", false, "p");} catch { }
    content.addEventListener("keydown", backspaceAtSeam);
    content.addEventListener("keydown", enterAtSeam);
    content.addEventListener("click", tripleClick);
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

  const api = {init, exec, setBlock, setList, syncToolbar, setFontSize, openLink, remember, restore, history, blockAt, blockAtCaret, insertBlock};

  /* What a plugin may use as `host.use("editor")`. Editing is the editor's: a plugin
     asks it to insert, not to write into #content itself. */
  const registry = env && env.StandaloneDoc;
  if (registry && typeof registry.provide === "function") {
    registry.provide("editor", {insertBlock, exec, setBlock, blockAt});
  }

  /* Construction-time, exactly where the trailing Editor.init() ran. */
  init();
  return api;
}
