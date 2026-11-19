export function createDocBar(deps = {}) {
  const {pagination, zoom, figures, signals, session, settings, env} = deps;
  const comments = deps.optional("comments");
  const {document} = env;
  const registry = env.StandaloneDoc;

  const bar = document.getElementById("doc-bar");
  if (!bar) return {save: () => null, sync: () => {}};

  const panel = bar.querySelector("[data-doc-panel]");
  const panelButton = bar.querySelector("[data-doc-settings]");
  const commentsPanel = bar.querySelector("[data-comments-panel]");
  const commentsButton = bar.querySelector("[data-comments-toggle]");
  const commentsCount = bar.querySelector("[data-comments-count]");
  const addButton = bar.querySelector("[data-comment-add]");
  const adoptButton = bar.querySelector("[data-doc-adopt]");
  const kindChip = bar.querySelector("[data-doc-kind]");
  const kindNote = bar.querySelector("[data-doc-kind-note]");
  const modeText = bar.querySelector("[data-doc-mode]");
  const titleEl = bar.querySelector("[data-doc-title]");
  const pagesEl = bar.querySelector("[data-doc-pages]");
  const pinEl = bar.querySelector("[data-doc-pin]");
  const restoreButton = bar.querySelector("[data-doc-restore]");

  const caps = settings.capabilities || {};
  /* Writing is a capability of the *file*; the mode decides whether the text is yours to
     change, and a review copy's text is not. */
  const canComment = () => caps.comments === "write" && settings.mode !== "view";

  const manifest = () => {
    try {
      return JSON.parse(document.getElementById("asset-manifest").textContent);
    } catch {
      return {};
    }
  };

  /* The selection is the only thing that decides whether "Add comment" can act, and it
     changes without a click. Coalesce to one frame: a `selectionchange` per keystroke is
     the flicker lab/016 measured. */
  let selectionFrame = 0;
  const hasSelection = () => {
    const selection = globalThis.getSelection?.();
    const content = document.getElementById("content");
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0);
    return Boolean(content && content.contains(range.startContainer) && content.contains(range.endContainer));
  };

  function syncSelection() {
    if (selectionFrame) return;
    selectionFrame = requestAnimationFrame(() => {
      selectionFrame = 0;
      if (!addButton) return;
      const ready = hasSelection();
      addButton.disabled = !ready;
      addButton.title = ready ? "Comment on the selected text" : "Select some text to comment on";
    });
  }

  /** What this document is. The folio is pagination's; the rest is the file's own. */
  function sync() {
    if (titleEl) titleEl.textContent = document.title;
    if (pagesEl) pagesEl.textContent = String(pagination.pageCount());
    if (pinEl) {
      const base = String(manifest().cdnBase || "");
      pinEl.textContent = /@([^/]+)\//.exec(base)?.[1] ?? "inline";
      pinEl.title = base;
    }
    bar.dataset.kind = settings.mode;
    bar.dataset.comments = caps.comments || "off";
    /* A review copy says what it is, once, where the reader is already looking. */
    if (kindChip) kindChip.hidden = settings.mode !== "comment";
    if (kindNote) kindNote.hidden = settings.mode !== "comment";
    if (modeText) modeText.textContent = settings.mode === "comment" ? "comment — comments only" : "view — read only";
    if (addButton) {
      addButton.hidden = !canComment();
      addButton.disabled = addButton.hidden || !hasSelection();
    }
    /* "May take an editable copy" is the copy's own promise (`capabilities.edit`); the
       button exists only where the copy carries the editor's address. */
    if (adoptButton) adoptButton.hidden = !(caps.edit === "copy" && settings.mode !== "edit");
    const count = comments()?.counts?.() || {total: 0, unresolved: 0};
    if (commentsCount) commentsCount.textContent = String(count.unresolved || count.total);
    if (commentsButton) {
      commentsButton.hidden = !(count.total > 0 || canComment());
      commentsButton.setAttribute("aria-label", `${count.total} comment${count.total === 1 ? "" : "s"}`);
    }
    if (commentsPanel && !commentsPanel.hidden) comments()?.panel?.(commentsPanel);
    pagination.syncFolio();
  }

  /**
   * A copy's save is a download: a read-only document cannot write the file it came from.
   * Same act as the editor's Save, minus the policy — the manifest already says what
   * travels. Both paths strip the same list (`session.js`), which is what keeps a file
   * identical whichever flavour saved it.
   */
  function save() {
    const clone = document.documentElement.cloneNode(true);
    session.strip(clone);
    figures?.prepareClone(clone);

    const name = (document.title || "document").trim().toLowerCase().replace(/[^\w.-]+/g, "-") || "document";
    const href = URL.createObjectURL(new Blob(["<!doctype html>\n" + clone.outerHTML], {type: "text/html"}));
    const link = document.createElement("a");
    link.href = href;
    link.download = `${name}.html`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 2000);
    return link.download;
  }

  /* Hiding is this session's: no setting is written, and a saved copy carries the bar
     back. The restore button is inside the bar and excluded from the collapse, so the
     reader can always undo it. */
  function setHidden(hidden) {
    if (hidden) bar.dataset.sessionHidden = "";
    else delete bar.dataset.sessionHidden;
    if (restoreButton) restoreButton.hidden = !hidden;
    if (hidden) {
      openPanel(false);
      openComments(false);
    }
  }

  const isHidden = () => bar.hasAttribute("data-session-hidden");

  function openPanel(open) {
    if (!panel) return;
    panel.hidden = !open;
    panelButton?.setAttribute("aria-expanded", String(open));
    if (open) {
      openComments(false);
      sync();
      zoom.syncUI();
    }
  }

  function openComments(open) {
    if (!commentsPanel || !commentsButton) return;
    if (open) comments()?.panel?.(commentsPanel);
    commentsPanel.hidden = !open;
    commentsButton.setAttribute("aria-expanded", String(open));
    if (open) openPanel(false);
  }

  bar.addEventListener("click", (event) => {
    if (event.target.closest("[data-save]")) {
      save();
      openPanel(false);
      openComments(false);
      return;
    }
    if (event.target.closest("[data-doc-hide]")) {
      setHidden(true);
      return;
    }
    if (event.target.closest("[data-doc-restore]")) {
      setHidden(false);
      openPanel(true);
      return;
    }
    if (event.target.closest("[data-doc-settings]")) {
      openPanel(panel ? panel.hidden : false);
      return;
    }
    if (event.target.closest("[data-comments-toggle]")) {
      openComments(commentsPanel ? commentsPanel.hidden : false);
      return;
    }
    if (event.target.closest("[data-doc-adopt]")) {
      adopt();
      return;
    }
    if (event.target.closest("[data-comment-add]")) {
      const result = comments()?.begin?.();
      if (result && !result.ok && addButton) addButton.title = result.reason;
      return;
    }
    const row = event.target.closest("[data-comment-id]");
    if (row && commentsPanel?.contains(row)) {
      const comment = comments()?.list?.().find((candidate) => candidate.id === row.dataset.commentId);
      if (comment) {
        comments()?.focus?.(comment);
        openComments(false);
      }
      return;
    }
    const zoomButton = event.target.closest("[data-zoom]");
    if (zoomButton) {
      zoom.command(zoomButton.dataset.zoom);
      return;
    }
    if (panel && !panel.hidden && !panel.contains(event.target)) openPanel(false);
    if (commentsPanel && !commentsPanel.hidden && !commentsPanel.contains(event.target)) openComments(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (panel && !panel.hidden) openPanel(false);
    else if (commentsPanel && !commentsPanel.hidden) openComments(false);
  });

  /* Build the other mode into this copy. It is a download, not a save: the file the
     reader received is untouched, and the result is a new file with no library. */
  async function adopt() {
    const registry = env.StandaloneDoc;
    if (!adoptButton || adoptButton.disabled || !registry?.adopt) return null;
    adoptButton.disabled = true;
    const label = adoptButton.textContent;
    adoptButton.textContent = "Building the editor…";
    try {
      const result = await registry.adopt("edit");
      adoptButton.textContent = label;
      return result;
    } catch (error) {
      /* Fail closed for the mode, open for the document: the copy still reads, and the
         button says why it stays a copy. */
      adoptButton.textContent = label;
      adoptButton.title = error && error.message ? error.message : "The editor could not be built from this copy.";
      return null;
    } finally {
      adoptButton.disabled = false;
    }
  }

  /* A button click moves the caret out of the document, which takes the selection with
     it — and the selection is the whole input to "Add comment". Cancel the mousedown so
     the range is still live when the click handler runs; the click itself still fires. */
  bar.addEventListener("mousedown", (event) => {
    if (event.target.closest("[data-comment-add]")) event.preventDefault();
  });

  document.addEventListener("selectionchange", syncSelection);

  comments()?.onChange?.(sync);
  signals.on("layout", sync);
  sync();

  return {save, sync, openPanel, openComments, setHidden, isHidden};
}
