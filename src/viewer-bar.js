export function createViewerBar(deps = {}) {
  const {pagination, zoom, figures, signals, session, env} = deps;
  const {document} = env;
  const registry = env.StandaloneDoc;

  const bar = document.getElementById("viewer-bar");
  if (!bar) return {save: () => null, sync: () => {}};

  const panel = bar.querySelector("[data-vb-panel]");
  const panelButton = bar.querySelector("[data-vb-settings]");
  const titleEl = bar.querySelector("[data-vb-title]");
  const pagesEl = bar.querySelector("[data-vb-pages]");
  const pinEl = bar.querySelector("[data-vb-pin]");
  const restoreButton = bar.querySelector("[data-vb-restore]");

  const manifest = () => {
    try {
      return JSON.parse(document.getElementById("asset-manifest").textContent);
    } catch {
      return {};
    }
  };

  /* What this document is. The folio is pagination's (it owns [data-folio], shared with
     the editor's minimal bar); the rest is the file's own manifest and title. */
  function sync() {
    if (titleEl) titleEl.textContent = document.title;
    if (pagesEl) pagesEl.textContent = String(pagination.pageCount());
    if (pinEl) {
      const base = String(manifest().cdnBase || "");
      pinEl.textContent = /@([^/]+)\//.exec(base)?.[1] ?? "inline";
      pinEl.title = base;
    }
    pagination.syncFolio();
  }

  /**
   * A viewer's save is a download: a read-only document cannot write the file it came
   * from. Same act as the editor's Save, minus the policy — the manifest already says
   * what travels. Both paths strip the same list (`session.js`), which is what keeps a
   * file identical whichever flavour saved it.
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
    if (hidden) openPanel(false);
  }

  const isHidden = () => bar.hasAttribute("data-session-hidden");

  function openPanel(open) {
    if (!panel) return;
    panel.hidden = !open;
    panelButton?.setAttribute("aria-expanded", String(open));
    if (open) {
      sync();
      zoom.syncUI();
    }
  }

  bar.addEventListener("click", (event) => {
    if (event.target.closest("[data-save]")) {
      save();
      openPanel(false);
      return;
    }
    if (event.target.closest("[data-vb-hide]")) {
      setHidden(true);
      return;
    }
    if (event.target.closest("[data-vb-restore]")) {
      setHidden(false);
      openPanel(true);
      return;
    }
    if (event.target.closest("[data-vb-settings]")) {
      openPanel(panel ? panel.hidden : false);
      return;
    }
    const zoomButton = event.target.closest("[data-zoom]");
    if (zoomButton) {
      zoom.command(zoomButton.dataset.zoom);
      return;
    }
    if (panel && !panel.hidden && !panel.contains(event.target)) openPanel(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel && !panel.hidden) openPanel(false);
  });

  signals.on("layout", sync);
  sync();

  return {save, sync, openPanel, setHidden, isHidden};
}
