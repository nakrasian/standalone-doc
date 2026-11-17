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
 */
export function createSession(deps = {}) {
  const {env} = deps;
  const {document} = env;

  /** Strip one clone (`document.documentElement.cloneNode(true)`), in place. */
  function strip(clone) {
    clone.removeAttribute("data-boot-state");

    clone.querySelectorAll("#sheets > *, .page-spacer, [data-emoji-menu], [data-plugin-ui]")
      .forEach((node) => node.remove());

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
    if (doc.querySelector("[data-emoji-menu]")) found.push("an emoji menu leaked into the file");
    if (doc.querySelector("dialog[open]")) found.push("a dialog was saved open");
    if (doc.querySelector("[data-menu-panel]:not([hidden])")) found.push("a menu panel was saved open");
    if ([...doc.querySelectorAll("[data-dirty]")].some((node) => !node.hidden)) found.push("the dirty dot was saved visible");
    return found;
  }

  return {strip, problems};
}
