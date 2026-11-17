export function createEditor(deps = {}) {
  const {signals, status, pagination, env} = deps;
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

  function remember() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && inside(sel.anchorNode)) {
      saved = sel.getRangeAt(0).cloneRange();
    }
  }

  function restore() {
    if (!saved || !inside(saved.commonAncestorContainer)) return false;
    content.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(saved);
    return true;
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

  function childIndex(node) {
    let index = 0;
    for (let n = node.previousSibling; n; n = n.previousSibling) {
      if (!isSpacer(n)) index++;
    }
    return index;
  }

  // Paths ignore generated spacers, so they match the snapshot HTML
  // (which strips them) and survive a pagination pass.
  function pathOf(node) {
    const path = [];
    let n = node;
    while (n && n !== content) {
      const parent = n.parentNode;
      if (!parent) return null;
      path.unshift(childIndex(n));
      n = parent;
    }
    return n === content ? path : null;
  }

  function nodeAt(path) {
    let n = content;
    for (const index of path) {
      let count = 0;
      let next = null;
      for (const child of n.childNodes) {
        if (isSpacer(child)) continue;
        if (count === index) {next = child; break;}
        count++;
      }
      if (!next) return null;
      n = next;
    }
    return n;
  }

  function spacerAncestor(node) {
    if (!node) return null;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return el && el.closest ? el.closest(".page-spacer") : null;
  }

  function captureSelection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!inside(range.startContainer) || !inside(range.endContainer)) return null;
    if (spacerAncestor(range.startContainer) || spacerAncestor(range.endContainer)) return null;
    const a = pathOf(sel.anchorNode);
    const f = pathOf(sel.focusNode);
    if (!a || !f) return null;
    return {a, ao: sel.anchorOffset, f, fo: sel.focusOffset};
  }

  function applySelection(saved) {
    if (!saved) return;
    const a = nodeAt(saved.a);
    const f = nodeAt(saved.f);
    if (!a || !f) return;
    const clamp = (node, offset) => Math.max(0, Math.min(offset,
      node.nodeType === Node.TEXT_NODE ? node.data.length : node.childNodes.length));
    content.focus();
    const live = window.getSelection();
    live.setBaseAndExtent(a, clamp(a, saved.ao), f, clamp(f, saved.fo));
  }

  const history = (() => {
    const stack = [];
    const LIMIT = 50;
    let index = -1;

    function snapshot() {
      const clone = content.cloneNode(true);
      clone.querySelectorAll(".page-spacer").forEach((n) => n.remove());
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

  /* Insert an atomic block after the block at the caret. Never split the
     current text node: that is the caret rule the pagination engine is
     built on. Returns the inserted node. */
  function insertBlock(node, {after = null, select = false} = {}) {
    if (!node) return null;
    const current = after || blockAtCaret();
    if (current && current.parentElement === content) current.after(node);
    else content.append(node);

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

  function init() {
    try {document.execCommand("defaultParagraphSeparator", false, "p");} catch { }
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
