export function createViewerBar(deps = {}) {
  const {pagination, zoom, figures, signals, env} = deps;
  const {document} = env;
  const registry = env.StandaloneDoc;

  const bar = document.getElementById("viewer-bar");
  if (!bar) return {save: () => null, sync: () => {}};

  const panel = bar.querySelector("[data-vb-panel]");
  const panelButton = bar.querySelector("[data-vb-settings]");
  const titleEl = bar.querySelector("[data-vb-title]");
  const pagesEl = bar.querySelector("[data-vb-pages]");
  const pinEl = bar.querySelector("[data-vb-pin]");

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
   * what travels. Keep the cleanup list in step with `toolbar.serialize()`: what it drops
   * is generated, and a saved file must not carry a rendering of this session.
   */
  function save() {
    const clone = document.documentElement.cloneNode(true);
    clone.removeAttribute("data-boot-state");
    clone.querySelectorAll("#sheets > *, .page-spacer, [data-emoji-menu], [data-plugin-ui]").forEach((node) => node.remove());
    clone.querySelectorAll("[data-menu-panel]").forEach((node) => node.setAttribute("hidden", ""));
    clone.querySelectorAll("dialog[open]").forEach((node) => node.removeAttribute("open"));
    const panelClone = clone.querySelector("[data-vb-panel]");
    if (panelClone) {
      panelClone.setAttribute("hidden", "");
      clone.querySelector("[data-vb-settings]")?.setAttribute("aria-expanded", "false");
    }
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

  return {save, sync, openPanel};
}
