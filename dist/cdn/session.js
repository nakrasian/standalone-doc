/**
 * What a document must not carry out of the session that rendered it.
 *
 * Two save paths exist — the editor's `serialize()` and a viewer's bar — and they drifted
 * once in each direction (the viewer dropped the boot phase and closed dialogs, the editor
 * kept them), so the same document differed by which flavour saved it. One list, two
 * callers; `toolbar.validate()` checks the same ground on the output.
 *
 * **Removed** is what the session *built*: a sheet, an emoji menu, a plugin's panel, a page
 * spacer. **Reset** is what the file owns but whose state is the session's: a menu panel is
 * structural markup and belongs there hidden, a dialog's `open` is transient, the toolbar's
 * resize flag is mid-animation truth. Figures are `figures.prepareClone()`'s business.
 *
 * **Unwrapped** is pagination's split of one paragraph into two visual fragments: the span
 * is the session's, the paragraph is the author's, so the children move up and the wrapper
 * goes away. The gap on a page-start block is a margin (no node), and it is cleared here
 * for the same reason a spacer was removed: a saved file carries no page geometry.
 */
export function createSession(deps = {}) {
  const {env} = deps;
  const {document} = env;

  /** Strip one clone (`document.documentElement.cloneNode(true)`), in place. */
  function strip(clone) {
    clone.removeAttribute("data-boot-state");

    clone.querySelectorAll("#sheets > *, .page-spacer, [data-emoji-menu], [data-plugin-ui]")
      .forEach((node) => node.remove());

    /* Pagination never reaches the file. A fragment is a wrapper, not content: move its
       children out, then drop it, so pandoc and a reader see one paragraph. */
    clone.querySelectorAll("[data-frag]").forEach((frag) => {
      while (frag.firstChild) frag.parentNode.insertBefore(frag.firstChild, frag);
      frag.remove();
    });
    clone.querySelectorAll("[data-page-start]").forEach((node) => {
      node.removeAttribute("data-page-start");
      node.style.marginBlockStart = "";
      if (!node.getAttribute("style")) node.removeAttribute("style");
    });

    clone.querySelectorAll("[data-menu-panel], [data-vb-panel]").forEach((node) => node.setAttribute("hidden", ""));
    clone.querySelectorAll("[data-vb-settings]").forEach((node) => node.setAttribute("aria-expanded", "false"));
    clone.querySelectorAll("[data-submenu-trigger]").forEach((node) => node.setAttribute("aria-expanded", "false"));
    clone.querySelectorAll("dialog[open]").forEach((node) => node.removeAttribute("open"));
    clone.querySelectorAll(".menu").forEach((menu) => {
      menu.classList.remove("menu-flip");
      menu.removeAttribute("style");
    });
    clone.querySelector("#app-toolbar")?.classList.remove("is-resizing");
    clone.querySelector("#stage")?.removeAttribute("style");

    /* A viewer's bar can be tucked away while reading; the file keeps it. */
    const bar = clone.querySelector("#viewer-bar");
    bar?.removeAttribute("data-session-hidden");
    clone.querySelector("[data-vb-restore]")?.setAttribute("hidden", "");

    /* `status.refresh()` sets a title as well as text, so resetting the text alone would
       make a second save differ from the first. */
    clone.querySelectorAll("[data-stats]").forEach((node) => {
      node.textContent = "—";
      node.removeAttribute("title");
    });
    clone.querySelectorAll("[data-dirty]").forEach((node) => {node.hidden = true;});

    return clone;
  }

  /** The same rules, checked against parsed output rather than a clone. */
  function problems(doc) {
    const found = [];
    if (doc.documentElement.hasAttribute("data-boot-state")) found.push("the boot phase leaked into the file");
    if (doc.querySelector("#sheets > *")) found.push("the sheet layer is not empty");
    if (doc.querySelector(".page-spacer")) found.push("a page spacer leaked into the file");
    if (doc.querySelector("[data-page-start]")) found.push("a page-start block leaked into the file");
    if (doc.querySelector("[data-frag]")) found.push("a pagination fragment leaked into the file");
    /* The margin travels with `data-page-start` (strip clears both), so the attribute is
       the marker. A generic `[style*=margin-block-start]` scan would call an author's own
       inline margin a leak. */
    if (doc.querySelector("[data-emoji-menu]")) found.push("an emoji menu leaked into the file");
    if (doc.querySelector("dialog[open]")) found.push("a dialog was saved open");
    if (doc.querySelector("[data-menu-panel]:not([hidden])")) found.push("a menu panel was saved open");
    if ([...doc.querySelectorAll("[data-dirty]")].some((node) => !node.hidden)) found.push("the dirty dot was saved visible");
    return found;
  }

  return {strip, problems};
}
