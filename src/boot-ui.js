/* The boot shell. Owns no state: it subscribes to the registry's events and
   renders them. Loaded before any asset, so it may not depend on core CSS, and
   it resolves the dialog lazily so markup order cannot break it. */
(function () {
  "use strict";

  const registry = globalThis.StandaloneDoc;
  const SHOW_DELAY = 150; /* a card that flashes for 60ms is worse than none */

  /* Presentation only: registration ids are technical. */
  const LABELS = {
    signals: "Signals",
    zoom: "Zoom",
    pagination: "Pagination",
    status: "Status line",
    editor: "Editor",
    figures: "Figures",
    toolbar: "Toolbar",
    progress: "Progress dialog",
    export: "Export",
  };
  const label = (id) => LABELS[id] || id.charAt(0).toUpperCase() + id.slice(1);

  let ui = null;
  let showTimer = null;
  let lastStart = {order: [], total: 0};
  const failures = [];

  function ensure() {
    if (ui) return ui;
    const dialog = document.getElementById("boot-dialog");
    if (!dialog) return null;
    ui = {
      dialog,
      title: dialog.querySelector("[data-boot-title]"),
      sub: dialog.querySelector("[data-boot-sub]"),
      bar: dialog.querySelector("[data-boot-bar]"),
      fill: dialog.querySelector("[data-boot-fill]"),
      rows: dialog.querySelector("[data-boot-rows]"),
      error: dialog.querySelector("[data-boot-error]"),
      errorTitle: dialog.querySelector("[data-boot-error-title]"),
      errorBody: dialog.querySelector("[data-boot-error-body]"),
      diag: dialog.querySelector("[data-boot-diag]"),
      retry: dialog.querySelector("[data-boot-retry]"),
      copy: dialog.querySelector("[data-boot-copy]"),
      toggle: dialog.querySelector("[data-boot-toggle]"),
    };
    wire(ui);
    return ui;
  }

  function setBar(fraction) {
    const el = ensure();
    if (!el) return;
    el.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, fraction)).toFixed(3)})`;
    const pct = Math.round(fraction * 100);
    el.bar.setAttribute("aria-valuenow", String(pct));
    el.bar.setAttribute("aria-valuetext", el.sub.textContent || `${pct}%`);
  }

  function open() {
    const el = ensure();
    if (!el || el.dialog.open) return;
    el.dialog.showModal();
  }

  function scheduleOpen() {
    clearTimeout(showTimer);
    showTimer = setTimeout(open, SHOW_DELAY);
  }

  function close() {
    clearTimeout(showTimer);
    const el = ensure();
    if (el?.dialog.open) el.dialog.close();
  }

  function renderRows(order) {
    const el = ensure();
    if (!el) return;
    el.rows.replaceChildren();
    for (const id of order) {
      const row = document.createElement("li");
      row.className = "boot-row";
      row.dataset.state = "pending";
      row.dataset.id = id;
      row.innerHTML = '<span class="boot-dot" aria-hidden="true"></span><span class="boot-name"></span><span class="boot-detail"></span>';
      row.querySelector(".boot-name").textContent = label(id);
      el.rows.append(row);
    }
  }

  function reset() {
    const el = ensure();
    failures.length = 0;
    if (!el) return;
    el.error.hidden = true;
    el.retry.hidden = true;
    el.toggle.hidden = true;
    el.diag.hidden = true;
    el.diag.textContent = "";
    el.dialog.dataset.phase = "booting";
    el.title.textContent = "Starting the editor";
    el.sub.textContent = "";
    setBar(0);
  }

  function diagnosticsText() {
    const el = ensure();
    const lines = [
      "standalone-doc boot",
      `state:    ${registry.state}`,
      `document: ${location.href}`,
      `modules:  ${(lastStart.order || []).join(", ") || "—"}`,
      "",
    ];
    for (const failure of failures) {
      lines.push(`[${failure.kind || failure.phase}] ${failure.id}: ${failure.message}`);
      if (failure.url) lines.push(`url: ${failure.url}`);
      if (failure.expected) lines.push(`expected ${failure.expected}`, `actual   ${failure.actual}`);
      if (failure.stack) lines.push(failure.stack);
      lines.push("");
    }
    lines.push(`user agent: ${navigator.userAgent}`);
    return lines.join("\n");
  }

  /* One card per failure mode: the copy is the product here. */
  function copyFor(failure) {
    const name = label(failure.id);
    switch (failure.kind) {
      case "offline":
        return { title: "You appear to be offline", body: `${name} could not be downloaded. Reconnect, then retry — nothing has been changed.` };
      case "unreachable":
        return { title: "The CDN is unreachable", body: `${name} could not be downloaded. Your connection is working, so this is usually temporary or a proxy blocking the CDN.` };
      case "http":
        return { title: "An asset is missing from the CDN", body: `${name} returned HTTP ${failure.status}. This document pins one runtime version; that file was not published at it.` };
      case "timeout":
        return { title: "Loading timed out", body: `${name} did not finish downloading in time. Slow connections usually succeed on retry.` };
      case "integrity":
        return { title: "This document's code has been altered", body: `The bytes served for ${name} do not match the hash recorded when this document was saved. It was not run.` };
      case "import":
        return { title: "A module could not start", body: `${name} downloaded but failed to evaluate.` };
      case "missing":
        return { title: "An asset is not loaded", body: `${name}: ${failure.message}` };
      default:
        /* Never lose the actual message: it is the actionable part. */
        return { title: "The editor failed to start", body: `${name} threw while starting: ${failure.message}` };
    }
  }

  function renderFailure(failure) {
    const el = ensure();
    if (!el) return;
    failures.push(failure);
    const copy = copyFor(failure);
    el.dialog.dataset.phase = "failed";
    el.title.textContent = copy.title;
    el.sub.textContent = "Aborted — nothing has been changed on disk";
    /* Mark the row that failed: the registry emits "active" and then aborts, so
       without this the last row would sit on "starting…" forever. */
    const failedRow = el.rows.querySelector(`.boot-row[data-id="${failure.id}"]`);
    if (failedRow) {
      failedRow.dataset.state = "failed";
      failedRow.querySelector(".boot-detail").textContent = "failed";
    }
    el.error.hidden = false;
    el.errorTitle.textContent = label(failure.id);
    el.errorBody.textContent = copy.body;
    el.diag.textContent = diagnosticsText();
    el.retry.hidden = false;
    el.toggle.hidden = false;
    el.copy.hidden = false;
    /* Errors are never delayed: the faster they appear, the less it feels hung. */
    clearTimeout(showTimer);
    open();
    el.retry.focus();
  }

  function wire(el) {
    el.dialog.addEventListener("cancel", (event) => event.preventDefault());

    el.retry.addEventListener("click", () => {
      reset();
      open();
      try {
        registry.retry();
      } catch {
        /* retry() re-emits "failed", which renders the card again. */
      }
    });

    el.toggle.addEventListener("click", () => {
      const opening = el.diag.hidden;
      el.diag.hidden = !opening;
      el.toggle.textContent = opening ? "Hide diagnostics" : "Diagnostics";
    });

    el.copy.addEventListener("click", async () => {
      const text = diagnosticsText();
      try {
        await navigator.clipboard.writeText(text);
        el.copy.textContent = "Copied";
      } catch {
        el.diag.hidden = false;
        el.diag.textContent = text;
        el.copy.textContent = "Select and copy";
      }
      setTimeout(() => (el.copy.textContent = "Copy diagnostics"), 1400);
    });
  }

  /* Never leave the document hidden forever: if boot never settles (a broken
     registry block, a parse error), reveal it and say so. */
  setTimeout(() => {
    if (document.documentElement.dataset.bootState !== "booting") return;
    document.documentElement.dataset.bootState = "failed";
    const el = ensure();
    if (!el) return;
    el.dialog.dataset.phase = "failed";
    el.title.textContent = "The editor did not start";
    el.sub.textContent = "Nothing has been changed on disk";
    el.error.hidden = false;
    el.errorTitle.textContent = "Boot never finished";
    el.errorBody.textContent = "The runtime did not report ready or failed. Copy the diagnostics and send them to the author.";
    el.retry.hidden = false;
    el.toggle.hidden = false;
    el.copy.hidden = false;
    el.diag.textContent = diagnosticsText();
    open();
  }, 20_000);

  if (!registry) return;

  registry.on("start", (detail) => {
    lastStart = detail;
    reset();
    renderRows(detail.order);
    const el = ensure();
    if (el) {
      const assets = registry.manifest().assets || [];
      const online = assets.filter((asset) => asset.mode === "online").length;
      const version = /@([^/]+)\//.exec(registry.manifest().cdnBase || "")?.[1];
      el.sub.textContent = online
        ? `${detail.total} modules · ${online} fetched from the CDN${version ? ` · ${version}` : ""}`
        : `${detail.total} modules · everything embedded in this file`;
    }
    scheduleOpen();
  });

  registry.on("construct", (detail) => {
    const el = ensure();
    if (!el) return;
    /* A plugin builds long after the dialog closed, with its own small asset list.
       The boot progress is about this document's modules, so it stays out of it. */
    if (detail.lazy) return;
    const row = el.rows.querySelector(`.boot-row[data-id="${detail.id}"]`);
    if (row) {
      row.dataset.state = detail.state;
      row.querySelector(".boot-detail").textContent = detail.state === "ok" ? "ready" : "starting…";
    }
    const done = detail.state === "ok" ? detail.index + 1 : detail.index;
    setBar(0.95 * (done / Math.max(1, detail.total)));
  });

  registry.on("ready", (detail) => {
    const el = ensure();
    setBar(1);
    if (!el) return;
    el.dialog.dataset.phase = "ready";
    el.sub.textContent = `Ready · ${detail.count} modules`;
    close();
  });

  registry.on("failed", (detail) => renderFailure(detail.error));
})();
