/* The boot shell. Owns no state: it subscribes to the registry's events and
   renders them. Loaded before any asset, so it may not depend on core CSS, and
   it resolves the dialog lazily so markup order cannot break it. */
(function () {
  "use strict";

  const registry = globalThis.StandaloneDoc;
  const SHOW_DELAY = 150; /* a card that flashes for 60ms is worse than none */

  /* Presentation only: registration ids are technical. The name travels in the manifest,
     so a document can rename an asset without touching the boot UI. */
  const label = (id) => {
    const assets = (registry && registry.manifest && registry.manifest().assets) || [];
    const asset = assets.find((candidate) => candidate.id === id);
    return (asset && asset.label) || id.charAt(0).toUpperCase() + id.slice(1);
  };

  let ui = null;
  let showTimer = null;
  let lastStart = {order: [], total: 0};
  /* The plan this boot is executing, and the rows that show it. `plan.fetched`/`built` are
     what the bar is made of: the fetch is the slow half and it used to own no part of it. */
  let plan = {byId: new Map(), byUrl: new Map(), fetched: 0, fetchedDone: 0, modules: 0, built: 0};
  const rows = new Map();
  let timelineFrame = 0;
  const failures = [];
  /* The recovery flow. `offered` is the release this card proposed; `updating` is the tag
     being applied, set before retry() so the "ready" handler knows the boot was a repair
     rather than an ordinary start. */
  /* Soft failures recorded during boot. They do not stop the document, but they are the
     reason the card says "ready — with limitations" instead of closing silently. */
  const degraded = [];
  let offered = null;
  let updating = null;
  /* An offer can still be in flight when a retry lands; without this the answer to a
     question nobody is asking any more would paint itself onto the new card. */
  let offersAllowed = true;

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
      update: dialog.querySelector("[data-boot-update]"),
      updateText: dialog.querySelector("[data-boot-update-text]"),
      updateGo: dialog.querySelector("[data-boot-update-go]"),
      continue: dialog.querySelector("[data-boot-continue]"),
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

  /* Presentation only, like the label: bytes are the document's, not the wire's. A pin says
     what this file carries, and a brotli figure would be a second truth nobody can check. */
  const sizeOf = (asset) => {
    const bytes = Number(asset.bytes) || 0;
    if (!bytes) return "";
    return bytes < 2048 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`;
  };

  /* One row per asset this document boots, not one per module: `order` is 13 modules, and a
     slim document fetches 19 files — the three slowest are a stylesheet, a fragment and the
     sprite (lab/013). Rows come from the registry's plan, so the list cannot disagree with
     what boot actually does. */
  function renderPlan(assets) {
    const el = ensure();
    if (!el) return;
    el.rows.replaceChildren();
    rows.clear();
    plan = {byId: new Map(), byUrl: new Map(), fetched: 0, fetchedDone: 0, modules: 0, built: 0};
    /* `adopt` builds a mode this copy is not in yet, so it names its own plan; boot
       names none and gets the document's. */
    for (const asset of assets || (registry.planned ? registry.planned() : [])) {
      /* Infrastructure is already running: it is not something to wait for. */
      if (asset.role === "infra") continue;
      plan.byId.set(asset.id, asset);
      if (asset.url) plan.byUrl.set(asset.url, asset);
      const module = asset.kind === "js";
      if (module) plan.modules++;
      const carried = asset.mode !== "online";
      if (!carried) plan.fetched++;

      const row = document.createElement("li");
      row.className = "boot-row";
      row.dataset.id = asset.id;
      /* An inline stylesheet or fragment is *done* the moment it is parsed; an inline
         module is not, and the construct events move it from `carried` to `ok`. */
      row.dataset.state = carried ? "carried" : "pending";
      row.innerHTML = '<span class="boot-dot" aria-hidden="true"></span><span class="boot-name"></span><span class="boot-detail"></span>';
      row.querySelector(".boot-name").textContent = label(asset.id);
      row.querySelector(".boot-detail").textContent = carried
        ? `in this file${sizeOf(asset) ? ` · ${sizeOf(asset)}` : ""}`
        : "waiting for the CDN";
      el.rows.append(row);
      rows.set(asset.id, row);
    }
    paintBar();
    watchFetches();
  }

  /* The fetch owns 0..0.6 of the bar and construction owns 0.6..1. Without that split the
     construct handler's `done/total` would overwrite the fetch progress downwards the moment
     the first module builds. */
  function paintBar() {
    const fetchShare = plan.fetched ? 0.6 * (plan.fetchedDone / plan.fetched) : 0;
    const buildShare = plan.modules ? 0.4 * (plan.built / plan.modules) : 0;
    setBar(Math.min(1, fetchShare + buildShare));
  }

  /**
   * Paint the fetch phase from the browser's own timeline.
   *
   * No registry event is involved, and none is missing: `performance.getEntriesByType` is
   * append-only on completion and carries duration and (with jsDelivr's
   * `timing-allow-origin: *`) sizes. An event would be a second truth for the same fact
   * (lab/013 measured both).
   */
  function watchFetches() {
    cancelAnimationFrame(timelineFrame);
    if (!plan.fetched) return;
    let seen = 0;
    const step = () => {
      const entries = performance.getEntriesByType("resource");
      for (; seen < entries.length; seen++) {
        const entry = entries[seen];
        const asset = plan.byUrl.get(entry.name);
        if (!asset) continue;
        const row = rows.get(asset.id);
        if (!row || row.dataset.state !== "pending") continue;
        row.dataset.state = "fetched";
        const ms = entry.duration ? ` · ${Math.round(entry.duration)} ms` : "";
        row.querySelector(".boot-detail").textContent = `verified · ${sizeOf(asset)}${ms}`;
        plan.fetchedDone++;
      }
      paintBar();
      if (plan.fetchedDone < plan.fetched && registry.state === "booting") {
        timelineFrame = requestAnimationFrame(step);
      }
    };
    timelineFrame = requestAnimationFrame(step);
  }

  function reset() {
    const el = ensure();
    failures.length = 0;
    degraded.length = 0;
    offered = null;
    offersAllowed = true;
    cancelAnimationFrame(timelineFrame);
    rows.clear();
    if (!el) return;
    el.error.hidden = true;
    el.retry.hidden = true;
    el.toggle.hidden = true;
    el.update.hidden = true;
    el.updateGo.hidden = true;
    el.updateGo.disabled = false;
    el.continue.hidden = true;
    el.diag.hidden = true;
    el.diag.textContent = "";
    el.dialog.dataset.phase = "booting";
    el.title.textContent = "Starting the editor";
    el.sub.textContent = "";
    setBar(0);
  }

  /* One implementation, in the registry, because the About panel shows the same report and
     a second copy is how two diagnostics came to disagree in the first place. */
  const diagnosticsText = () => registry.diagnostics({order: lastStart.order});

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

  /* The registry names the action; this is the sentence a reader sees. A failure card that
     only says what broke leaves the reader with a document they cannot repair, which is the
     difference between a degraded file and a dead one. */
  function remedyNote(remedy) {
    if (!remedy) return "";
    switch (remedy.action) {
      case "update-runtime":
        return `Next: update this file's runtime${remedy.need ? ` to one that provides ${remedy.need}` : ""}, save, and reopen.`;
      case "refresh-catalog":
        return `Next: open the Plugins panel and refresh the catalog${remedy.why ? ` — ${remedy.why}` : ""}.`;
      case "open-editor-copy":
        return "Next: open an editor copy of this document.";
      case "reopen":
        return "Next: save and reopen this file.";
      case "none":
        return remedy.why ? `Nothing this file can do — ${remedy.why}.` : "";
      default:
        /* `retry` is the button already on the card, so it needs no sentence. */
        return "";
    }
  }

  /*
   * Ready, but not whole: list every soft failure with the same remedy vocabulary the
   * failure card uses, and let the reader continue. This is the non-blocking lane — the
   * content is already on screen and saving still works, so the card is a note, not a wall.
   */
  function renderDegraded(el) {
    if (!el || !degraded.length) return;
    el.dialog.dataset.phase = "ready";
    el.title.textContent = "Ready — with limitations";
    el.sub.textContent = `${degraded.length} feature${degraded.length === 1 ? "" : "s"} could not load · everything else is available`;
    el.error.hidden = false;
    el.errorTitle.textContent = "What did not load";
    el.errorBody.textContent = degraded
      .map((issue) => `${label(issue.id)}: ${issue.message}${issue.remedy ? ` — ${remedyNote(issue.remedy) || "retry"}` : ""}`)
      .join("  •  ");
    el.diag.textContent = diagnosticsText();
    el.retry.hidden = false;
    el.toggle.hidden = false;
    el.copy.hidden = false;
    el.continue.hidden = false;
    clearTimeout(showTimer);
    open();
    el.continue.focus();
  }

  function renderFailure(failure) {
    const el = ensure();
    if (!el) return;
    failures.push(failure);
    const copy = copyFor(failure);
    const remedy = remedyNote(failure.remedy);
    el.dialog.dataset.phase = "failed";
    el.title.textContent = copy.title;
    el.sub.textContent = "Aborted — nothing has been changed on disk";
    /* Mark the row that failed: the registry emits "active" and then aborts, so
       without this the last row would sit on "starting…" forever. */
    const failedRow = rows.get(failure.id) || el.rows.querySelector(`.boot-row[data-id="${failure.id}"]`);
    if (failedRow) {
      failedRow.dataset.state = "failed";
      failedRow.querySelector(".boot-detail").textContent = "failed";
    }
    el.error.hidden = false;
    el.errorTitle.textContent = label(failure.id);
    el.errorBody.textContent = [copy.body, remedy].filter(Boolean).join(" ");
    el.diag.textContent = diagnosticsText();
    el.retry.hidden = false;
    el.toggle.hidden = false;
    el.copy.hidden = false;
    /* Errors are never delayed: the faster they appear, the less it feels hung. */
    clearTimeout(showTimer);
    open();
    el.retry.focus();
    offerUpdate(failure);
  }

  /* ---------------------------------------------------------------- recovery */

  const pinnedTag = () => registry.tagOf();

  /**
   * Offer a newer release when the failure looks like a stale pin.
   *
   * Only `integrity` and `http` qualify: those are the two ways a tag can stop serving what
   * a document pinned. A construct error or a missing module is not a pin problem, and
   * offering a different release would be a guess dressed as a fix.
   *
   * This lives in the failure card and not in Document settings on purpose: a failed boot
   * injects no toolbar, so the sheet is unreachable exactly when it is needed (measured in
   * lab/009).
   */
  async function offerUpdate(failure) {
    const el = ensure();
    if (!el || !["integrity", "http", "api"].includes(failure.kind)) return;

    /* An `api` refusal asks a different question: not "what is the newest release?" but
       "which release is the first that provides this API?". Answering with `latest` would
       be wrong for a plugin written against an API that a newer release no longer
       advertises, and useless for one that a release older than latest already satisfies. */
    if (failure.kind === "api") {
      const index = await registry.catalog();
      if (!offersAllowed || registry.state !== "failed" || !el.error || el.error.hidden) return;
      const current = registry.tagOf();
      const target = (index?.releases || []).find((release) => (release.hostApi || 1) >= (failure.need || 1));
      if (!target) {
        el.update.hidden = false;
        el.updateText.textContent = `Needs host API ${failure.need}; no published runtime provides it yet.`;
        el.updateGo.hidden = true;
        return;
      }
      offered = { from: current, to: target.tag, need: failure.need, reopen: true };
      el.updateText.textContent = `${target.tag} provides host API ${failure.need}; this document pins ${current}. `
        + "Updating rewrites its pin, and the new runtime is loaded on reopen — nothing on disk changes until you save.";
      el.updateGo.textContent = `Update to ${target.tag}`;
      el.update.hidden = false;
      el.updateGo.hidden = false;
      return;
    }

    const {current, latest, newer, date: when} = await registry.compareUpdate();
    /* The card may have moved on while the catalog was in flight. */
    if (!offersAllowed || registry.state !== "failed" || !el.error || el.error.hidden) return;
    if (!current || !newer) return;
    offered = {from: current, to: latest};
    el.updateText.textContent = `${latest}${when ? ` (${when})` : ""} exists; this document pins ${current}. `
      + "Updating rewrites its pin and fetches that release — nothing on disk changes until you save.";
    el.updateGo.textContent = `Update to ${latest}`;
    el.update.hidden = false;
    el.updateGo.hidden = false;
  }

  function updateFailed(el, message) {
    offersAllowed = false;
    if (!el) return;
    el.update.hidden = false;
    el.updateText.textContent = message;
    el.updateGo.hidden = true;
    el.updateGo.disabled = false;
  }

  async function applyUpdate(el) {
    const offer = offered;
    if (!offer) return;
    el.updateGo.disabled = true;
    el.updateGo.textContent = `Fetching ${offer.to}…`;
    let applied = null;
    try {
      const entry = await registry.release(offer.to);
      applied = registry.repin(entry);
    } catch (error) {
      updateFailed(ensure(), `${offer.to} could not be read (${error && error.message ? error.message : String(error)}). Nothing was changed.`);
      return;
    }
    updating = {tag: offer.to, moved: applied.moved.length, from: offer.from, reopen: offer.reopen || null};
    /* A runtime that provides a newer host API cannot be adopted by this session: the loader
       is inline and already running. Re-pinning is the whole repair; a retry against the old
       loader would fail again and the restore-on-failure below would undo a correct update. */
    if (offer.reopen) {
      renderRepaired(ensure());
      return;
    }
    reset();
    open();
    try {
      await registry.retry();
    } catch {
      /* retry() records its own failure and re-renders the card. */
    }
    if (registry.state !== "ready") {
      /* Failure is total: put the document's own pin back, and say so. The card keeps the
         failure it just rendered, so the reader still has the real error in front of them. */
      const tag = updating?.tag;
      updating = null;
      applied.restore();
      updateFailed(ensure(), `${tag} did not load either. This document's own pin was restored; nothing was changed on disk.`);
    }
  }

  function renderRepaired(el) {
    const done = updating;
    updating = null;
    if (!el || !done) return;
    const canSave = !!document.querySelector("[data-save]");
    el.dialog.dataset.phase = "ready";
    el.title.textContent = `Updated to ${done.tag}`;
    el.sub.textContent = done.reopen
      ? `${done.moved} fetched asset${done.moved === 1 ? "" : "s"} re-pinned; host API ${done.reopen} is loaded on reopen`
      : `${done.moved} fetched asset${done.moved === 1 ? "" : "s"} re-pinned from ${done.from}`;
    el.error.hidden = true;
    el.errorBody.textContent = "";
    el.retry.hidden = true;
    el.toggle.hidden = true;
    el.copy.hidden = true;
    el.update.hidden = true;
    el.updateGo.hidden = true;
    el.continue.hidden = false;
    /* The repair is in memory. A viewer has no save button, and saying "save the file" to
       a document that cannot write itself would be a lie (lab/009, finding 3). */
    el.update.hidden = false;
    el.updateText.textContent = done.reopen
      ? canSave
        ? "Save the file, then reopen it to load the new runtime. The plugin stays unavailable until then."
        : "This document is read-only, so the runtime update lasts for this session only; reopen a saved copy to load it."
      : canSave
        ? "Save the file to keep this update. Until you do, the repaired pin lives in this tab only."
        : "This document is read-only, so the update lasts for this session only.";
    el.updateGo.hidden = true;
    clearTimeout(showTimer);
    open();
    el.continue.focus();
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

    el.updateGo.addEventListener("click", () => {
      applyUpdate(el);
    });

    el.continue.addEventListener("click", () => {
      reset();
      close();
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
    renderPlan(detail.plan);
    const el = ensure();
    if (el) {
      const version = /@([^/]+)\//.exec(registry.manifest().cdnBase || "")?.[1];
      const files = plan.fetched;
      el.sub.textContent = files
        ? `${plan.modules} modules · ${files} files fetched from the CDN${version ? ` · ${version}` : ""}`
        : `${plan.modules} modules · everything embedded in this file`;
    }
    scheduleOpen();
  });

  registry.on("construct", (detail) => {
    const el = ensure();
    if (!el) return;
    /* A plugin builds long after the dialog closed, with its own small asset list.
       The boot progress is about this document's modules, so it stays out of it. */
    if (detail.lazy) return;
    const row = rows.get(detail.id);
    if (row) {
      if (detail.state === "skipped") {
        row.dataset.state = "skipped";
        row.querySelector(".boot-detail").textContent = "unavailable — skipped";
      } else {
        row.dataset.state = detail.state === "ok" ? "ok" : "active";
        row.querySelector(".boot-detail").textContent = detail.state === "ok" ? "ready" : "building…";
      }
    }
    if (detail.state === "ok") plan.built++;
    paintBar();
  });

  /* A plugin's own failure is the plugin's business: it is shown on its row and in a figure,
     not in the boot summary. Only a soft *document* asset belongs in the degraded list. */
  registry.on("error", (detail) => {
    const issue = detail && detail.error;
    if (!issue || issue.plugin) return;
    if (registry.state !== "booting" && registry.state !== "ready") return;
    if (!degraded.includes(issue)) degraded.push(issue);
  });

  registry.on("ready", (detail) => {
    const el = ensure();
    setBar(1);
    if (!el) return;
    if (updating) {
      renderRepaired(el);
      return;
    }
    el.dialog.dataset.phase = "ready";
    el.sub.textContent = `Ready · ${detail.count} modules`;
    if (degraded.length) {
      renderDegraded(el);
      return;
    }
    close();
  });

  registry.on("failed", (detail) => renderFailure(detail.error));
})();
