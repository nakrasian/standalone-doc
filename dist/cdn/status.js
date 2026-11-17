export function createStatus(deps = {}) {
  const {signals, pagination} = deps;
  const content = document.getElementById("content");
  const storeEl = document.getElementById("figure-store");
  /* The exact figure-store size is figures' business, and figures is built after
     status (order 80 vs 60). It registers an estimator once it exists; until then
     count the raw store text, which is readable during construction and cannot
     throw. A late edge would throw instead: refresh() runs at the bottom of this
     factory, while figures is still unbuilt. */
  let storeBytes = () => (storeEl ? storeEl.textContent.length : 0);
  function setStoreEstimator(fn) {
    if (typeof fn === "function") storeBytes = fn;
  }
  const baseBytes = document.documentElement.outerHTML.length
    - content.outerHTML.length
    - (storeEl ? storeEl.textContent.length : 0);
  let baseline = contentHtml();
  let forced = false;
  let lastSavedBytes = null;
  let timer = null;

  function contentHtml() {
    const clone = content.cloneNode(true);
    clone.querySelectorAll(".page-spacer").forEach((n) => n.remove());
    // Runtime frames are derived; they must not make a saved document look
    // dirty the moment a lazy island mounts.
    clone.querySelectorAll("[data-runtime='ephemeral']").forEach((n) => n.replaceChildren());
    clone.querySelectorAll("figure.figure").forEach((n) => {
      n.removeAttribute("data-selected");
      n.removeAttribute("data-mounted");
      n.removeAttribute("data-missing");
    });
    return clone.innerHTML;
  }

  // Add a space at every text-node boundary so block-level elements do not
  // merge adjacent words ("line 0line 1").
  function wordCount(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let text = "";
    let node;
    while ((node = walker.nextNode())) text += node.data + " ";
    return text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).length;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  function refresh() {
    const words = wordCount(content);
    const pages = pagination.pageCount();
    const html = contentHtml();
    const bytes = storeBytes();
    // Approximation, not a serialize: the app chrome + styles + store +
    // current canonical content. Cheap enough to run on the status debounce.
    const estimated = baseBytes + html.length + bytes + 13;
    const dirty = forced || html !== baseline;
    const shown = !dirty && lastSavedBytes != null ? lastSavedBytes : estimated;
    const exact = !dirty && lastSavedBytes != null;
    document.querySelectorAll("[data-stats]").forEach((el) => {
      el.textContent = `${pages} ${pages === 1 ? "page" : "pages"} · ${words} ${words === 1 ? "word" : "words"} · ${exact ? "" : "~"}${formatBytes(shown)}`;
      el.title = exact ? "Size of the last saved file" : "Estimated saved file size";
    });
    document.querySelectorAll("[data-dirty]").forEach((el) => {
      el.hidden = !dirty;
    });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(refresh, 120);
  }

  function save(bytes = null) {
    baseline = contentHtml();
    forced = false;
    lastSavedBytes = Number.isFinite(bytes) ? bytes : null;
    refresh();
  }

  function markDirty() {
    forced = true;
    lastSavedBytes = null;
    refresh();
  }

  signals.on("mutation", schedule);
  signals.on("edit", schedule);
  signals.on("compositionend", schedule);
  signals.on("layout", refresh);
  signals.on("figures", () => {
    lastSavedBytes = null;
    schedule();
  });

  refresh();

  return {refresh, save, markDirty, setStoreEstimator};
}
