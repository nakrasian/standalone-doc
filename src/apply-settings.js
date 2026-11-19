export function createApplySettings(deps = {}) {
  const {settings, env} = deps;
  const {document} = env;

  /* Behaviour the browser cannot express in CSS, and therefore the loader's job.
     Everything here is derived from the document's own #doc-settings block, never
     from the markup: a copy whose markup was edited by hand must not be able to
     claim it is editable when the file says otherwise. */
  function apply() {
    const root = document.documentElement;
    root.dataset.mode = settings.mode;
    /* Which chrome the file was saved in. Presentation, applied before anything
       paints, so a minimal file never flashes its ribbon. */
    if (settings.ui) document.body.dataset.ui = settings.ui;
    /* Chrome visibility is a setting of its own, not a consequence of the mode: a
       read-only copy may still want the toolbar for print or zoom. */
    root.dataset.toolbar = settings.toolbar ? "on" : "off";
    /* Where this file saves, announced for the same reason: chrome reads it, and no menu
       item should have to re-parse the settings block to decide whether to exist. A file
       says `off` before the first paint, so the File menu never offers a library it does
       not have. */
    root.dataset.cloud = settings.cloud ? "on" : "off";
    /* Which comment affordances this file has. `off` is the default for every document
       that never declared a capability, and it is what CSS reads to hide a marker layer
       whose module was not built. Presentation only: the loader decided what exists. */
    root.dataset.comments = settings.capabilities?.comments || "off";

    /* A built flavour carries only the chrome its mode builds, but `index.html` is the
       source of all of them and a hand-edited copy can carry a block it never runs. Paint
       the chrome this mode owns, and only that — one bar serves a viewer and a reviewer. */
    const bar = document.getElementById("doc-bar");
    if (bar) bar.hidden = settings.mode !== "view" && settings.mode !== "comment";
    /* The same rule the other way round, and it is not symmetry for its own sake: a
       document saved with its editor inline and then switched to view mode carries the
       ribbon's markup without the module that drives it. Dead furniture is worse than
       absent furniture, and a view-mode file has a bar of its own to paint. */
    const ribbon = document.getElementById("app-toolbar");
    if (ribbon) ribbon.hidden = settings.mode !== "edit";

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
