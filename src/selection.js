/* One coordinate for the caret, the undo snapshot and pagination: `{block, textOffset}`.
 *
 * The lab measured why a node path is not good enough (`lab/016` §11): wrapping a
 * paragraph's tail in a `display:block` span moves the text one level deeper, so a path
 * captured before a pass points at a different node after it. A character offset in the
 * block's text stream survives the wrap, the merge and a re-split — which is exactly what
 * `Range.extractContents()` preserves.
 *
 * The block is addressed by its index in `#content.children`. A fragment is a child of the
 * block, never a sibling, so the index is stable across a pass. The lab's prototype also
 * accepted a `data-bid`; comments will introduce one, and this is the place to prefer it
 * when it exists (a saved anchor must not depend on document order).
 *
 * This module is the production form of `lab/016-comment-spans/selection.mjs`. It is
 * deliberately DOM-only and dependency-free: pagination and the editor both consume it,
 * and a unit test cannot fake a live Selection.
 */

export function createSelection() {
  /** The block a node belongs to, as an index in `#content.children`. */
  function blockOf(content, node) {
    if (node === content) return null;
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    const block = el?.closest?.("#content > *") || null;
    if (!block || !content.contains(block)) return null;
    const index = [...content.children].indexOf(block);
    return index < 0 ? null : {block, index};
  }

  /** Character offset of a (node, offset) pair inside its block. */
  function offsetIn(block, node, nodeOffset) {
    /* An element-anchored endpoint (`range.setEnd(el, childIndex)`) has no text node to
       find; a range from the block start counts the text before it. */
    if (node.nodeType === Node.ELEMENT_NODE && block.contains(node)) {
      const range = document.createRange();
      range.setStart(block, 0);
      try {range.setEnd(node, nodeOffset);} catch {return 0;}
      return range.toString().length;
    }
    let total = 0;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text) {
      if (text === node) return total + Math.min(nodeOffset, text.nodeValue.length);
      total += text.nodeValue.length;
      text = walker.nextNode();
    }
    return total;
  }

  /** {node, offset} for a character offset in a block, or null when it has no text. */
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
    return last ? {node: last, offset: last.nodeValue.length} : null;
  }

  /** One endpoint in the fragment-proof coordinate. */
  function endpoint(content, node, nodeOffset) {
    /* Select-all (or a caret in the empty area) anchors on #content itself. Map it to the
       first or last block so the coordinate still names a text position. */
    if (node === content) {
      const blocks = [...content.children];
      if (!blocks.length) return null;
      const atEnd = nodeOffset > 0;
      const index = atEnd ? blocks.length - 1 : 0;
      return {block: index, offset: atEnd ? blocks[index].textContent.length : 0};
    }
    const found = blockOf(content, node);
    if (!found) return null;
    return {block: found.index, offset: offsetIn(found.block, node, nodeOffset)};
  }

  function samePoint(a, b) {
    return Boolean(a && b && a.block === b.block && a.offset === b.offset);
  }

  function same(a, b) {
    return Boolean(a && b && samePoint(a.start, b.start) && samePoint(a.end, b.end));
  }

  /** Capture the live selection, or null when it is outside `content`. */
  function capture(content) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return null;
    const start = endpoint(content, range.startContainer, range.startOffset);
    const end = endpoint(content, range.endContainer, range.endOffset);
    if (!start || !end) return null;
    return {start, end, collapsed: range.collapsed};
  }

  /** Resolve a captured endpoint in the current DOM. */
  function resolve(content, point) {
    const block = content.children[point.block];
    if (!block) return null;
    return pointAt(block, point.offset);
  }

  /** Put a captured selection back. False when the document can no longer hold it. */
  function restore(content, saved) {
    if (!saved) return false;
    const start = resolve(content, saved.start);
    const end = resolve(content, saved.end);
    if (!start || !end) return false;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const sel = window.getSelection();
    /* `setBaseAndExtent` restores the range without the scroll-into-view that `addRange`
       performs. The browser revealing a caret is welcome when the reader moves it and
       unwanted when a pass moved the text under it. */
    sel.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
    return true;
  }

  /**
   * Run `fn` (a pagination pass) with the selection protected, and report whether it still
   * names the same characters. Restores only when the selection actually changed: a
   * `removeAllRanges()` on every pass fires a `selectionchange` per keystroke, which is its
   * own source of flicker (lab/016 §13).
   */
  function preserve(content, fn) {
    const before = capture(content);
    let result;
    try {
      result = fn();
    } finally {
      if (before) {
        const live = capture(content);
        if (!same(live, before)) restore(content, before);
      }
    }
    const after = capture(content);
    return {result, before, after, kept: Boolean(before && after && same(after, before))};
  }

  return {capture, restore, preserve, offsetIn, pointAt};
}
