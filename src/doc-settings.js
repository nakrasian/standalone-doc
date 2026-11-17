export function createDocSettings(deps = {}) {
  const {settings, env} = deps;
  const {document} = env;

  /* Behaviour the browser cannot express in CSS, and therefore the loader's job.
     Everything here is derived from the document's own #doc-settings block, never
     from the markup: a copy whose markup was edited by hand must not be able to
     claim it is editable when the file says otherwise. */
  function apply() {
    const root = document.documentElement;
    root.dataset.mode = settings.mode;
    /* Chrome visibility is a setting of its own, not a consequence of the mode: a
       read-only copy may still want the toolbar for print or zoom. */
    root.dataset.toolbar = settings.toolbar ? "on" : "off";

    const content = document.getElementById("content");
    if (!content) return;
    if (settings.editable) content.setAttribute("contenteditable", "true");
    else content.setAttribute("contenteditable", "false");
  }

  /* Construction-time, like editor and figures: the lock is in place before any
     module that could act on the content is built. */
  apply();

  return {apply};
}
