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
    for (const el of [...host.querySelectorAll("[data-page-start]")]) {
      el.removeAttribute("data-page-start");
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

  function init() {
    try {document.execCommand("defaultParagraphSeparator", false, "p");} catch { }
    content.addEventListener("keydown", seamDelete);
    content.addEventListener("copy", copyAcrossSeam);
    content.addEventListener("cut", cutAcrossSeam);
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

  const api = {init, exec, setBlock, setList, syncToolbar, setFontSize, openLink, remember, restore, history, blockAt, blockAtCaret, insertBlock, insertInline};

  /* What a plugin may use as `host.use("editor")`. Editing is the editor's: a plugin
     asks it to insert, not to write into #content itself. */
  const registry = env && env.StandaloneDoc;
  if (registry && typeof registry.provide === "function") {
    registry.provide("editor", {insertBlock, insertInline, exec, setBlock, blockAt});
  }

  /* Construction-time, exactly where the trailing Editor.init() ran. */
  init();
  return api;
}
