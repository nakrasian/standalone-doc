/**
 * Autosave, and the two bars that are decisions rather than reports.
 *
 * The library is a sink, and a sink that only writes when somebody presses a key is a
 * document that loses the last paragraph of every session. This module is the only thing
 * that writes without being asked, so everything about it is a rule about *when not to*:
 *
 *   - **cloud only** — no `cloud` record means no sink, whatever the field says;
 *   - **never** while a manual save is in flight, while `navigator.onLine` is false, after a
 *     failed boot, or while the conflict bar is up. A 409 must stop the timer: a retry loop
 *     against a conflict is a way to lose the other tab's work one keystroke at a time;
 *   - **silent when nothing changed** — `primed` is the last bytes the library confirmed,
 *     so an idle tick that fires after another tab saved is not a save at all.
 *
 * Two surfaces, and the difference is the whole of `docs/AUTOSAVE.md` §1b:
 *
 *   - a **successful autosave says nothing out loud**. The ribbon carries `Saved 12:04`
 *     instead, because a toast every thirty seconds trains people to ignore toasts;
 *   - **any failure speaks once**, then a bar says `Could not save · retrying in 30 s` and
 *     backs off. A toast per attempt is how a working document gets closed by accident;
 *   - a **conflict is a bar**, not a toast: it is a decision, and it stays up until it is made.
 *
 * Snapshots (`docs/AUTOSAVE.md` §3): a manual save always checkpoints, an autosave never
 * (`?checkpoint=0`), leaving does, and every fifteen minutes of continuous autosaving does.
 * The library keeps ten, so the ten kept versions should be milestones — not keystrokes.
 */

export function createAutosave(deps = {}) {
  const {signals, env} = deps;
  const {document} = env;
  const registry = () => env.StandaloneDoc;
  const status = () => deps.optional("status")();
  /* The chrome, not a dependency: this module is built *before* the bar it asks for bytes,
     and a document re-pinned across releases may carry only one of the two. A getter that
     returns undefined is the honest shape for both facts. */
  const getToolbar = deps.optional("toolbar");
  const getDocBar = deps.optional("doc-bar");

  const DEFAULT_IDLE_MS = 2000;
  const DEFAULT_INTERVAL_MS = 60_000;
  /* Every fifteen minutes of continuous autosaving is the floor under a long session. */
  const CHECKPOINT_EVERY_MS = 15 * 60 * 1000;
  /* 30 s → 1 min → 2 min, capped. Long enough that a flaky network is not a metronome. */
  const RETRY_STEPS_MS = [30_000, 60_000, 120_000];
  /* A tab hidden for longer than this counts as leaving, and gets a checkpoint on return. */
  const HIDDEN_CHECKPOINT_MS = 5 * 60 * 1000;

  /** How this document wants to be saved. Read live: the sheet writes it. */
  function config() {
    const authored = registry()?.settings?.()?.autosave || {};
    const mode = ["off", "idle", "interval"].includes(authored.mode) ? authored.mode : "off";
    return {
      mode,
      idleMs: Number(authored.idleMs) > 0 ? Number(authored.idleMs) : DEFAULT_IDLE_MS,
      intervalMs: Number(authored.intervalMs) > 0 ? Number(authored.intervalMs) : DEFAULT_INTERVAL_MS,
    };
  }

  const cloud = () => registry()?.settings?.()?.cloud || null;
  const noticeEl = () => document.querySelector("[data-notice]");

  /**
   * The chrome that builds this document's bytes.
   *
   * Resolved per call, not once: `adopt()` can change the mode under a running document, and
   * the answer is different either side of that line. The editor applies a save policy; a
   * review copy strips the same session list and keeps the manifest it already has. One
   * sink, two builders — which is the whole reason this module does not own `serialize`.
   */
  function producer() {
    const mode = registry()?.settings?.()?.mode || "edit";
    const api = mode === "edit" ? getToolbar() : getDocBar();
    return api && typeof api.serialize === "function" ? api : null;
  }

  /** `{title, html}`, or null when nothing can build it (a viewer, a hand-stripped copy). */
  async function bytes(options = {}) {
    const api = producer();
    if (!api) return null;
    try {
      return await api.serialize(options);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  /* The last bytes the library confirmed. `null` until we have read the stored version and
     built once, which is what makes "nothing changed → no save" a comparison rather than a
     guess. */
  let primed = null;
  /* The document's `updatedAt`, from `GET /api/docs/<id>` or the `ETag` of the last write.
     Null means "unknown", and unknown means autosave stays off: an `If-Match` we cannot name
     is not a check. A manual save still works — the library treats an absent header as an
     older client, which is exactly the behaviour every document had before this release. */
  let version = null;
  let idleTimer = null;
  let intervalTimer = null;
  let retryTimer = null;
  let retryStep = 0;
  let inFlight = false;
  let manualInFlight = false;
  let conflict = null;
  let failure = null;
  let lastCheckpointAt = 0;
  let hiddenAt = 0;
  let leaving = null;
  let started = false;

  function clearTimers() {
    clearTimeout(idleTimer);
    clearTimeout(retryTimer);
    clearInterval(intervalTimer);
    idleTimer = null;
    retryTimer = null;
    intervalTimer = null;
  }

  /**
   * May autosave write right now?
   *
   * Every clause is a way this loses work if it is missing: no sink, a boot that did not
   * finish (the document is not the document yet), offline (the write will fail and the
   * retry bar would be a lie), a conflict (a decision is pending, and more writes cannot
   * make it), an unknown version (no `If-Match`, so no conflict detection).
   */
  function allowed() {
    if (!producer()) return false;
    if (config().mode === "off") return false;
    if (!cloud()) return false;
    if (registry()?.state !== "ready") return false;
    if (conflict) return false;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
    return true;
  }

  /* --------------------------------------------------------------- the sink */

  /** The JSON door, with the same trap named: a login page is not an answer. */
  async function readJSON(response) {
    const type = response.headers.get("content-type") || "";
    if (!type.includes("application/json")) {
      throw new Error(
        response.redirected || type.includes("text/html")
          ? "signed out — reopen this document to sign in (the library answered with a page, not data)"
          : `unexpected response (${response.status})`,
      );
    }
    return response.json().catch(() => ({}));
  }

  const stripQuotes = (tag) => String(tag || "").replace(/^W\//, "").replace(/^"|"$/g, "");

  /** The version this document last saw, so a save can quote it in `If-Match`. */
  async function readVersion() {
    const target = cloud();
    if (!target) return null;
    try {
      const response = await fetch(`${target.api}/${target.id}`, {
        credentials: "same-origin",
        headers: {accept: "application/json"},
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await readJSON(response);
      version = stripQuotes(response.headers.get("etag")) || body.updatedAt || null;
    } catch {
      /* Not a document failure: the document opens, saves manually, and simply does not
         autosave. Saying so at open would be noise about a feature nobody asked for. */
      version = null;
    }
    return version;
  }

  /**
   * Write the bytes. Returns the library's answer; throws with `.conflict` on a 409.
   *
   * `checkpoint` is the caller's: a person's ⌘S and the end of a session are milestones, a
   * keystroke is not. `ifMatch: false` is "keep mine" and only the conflict bar may use it —
   * the library accepts it and snapshots the other version first, so the decision is
   * recoverable from History rather than merely decisive.
   */
  async function put(html, {title, checkpoint = true, ifMatch = true, keepalive = false} = {}) {
    const target = cloud();
    if (!target) throw new Error("this document names no library");
    const url = `${target.api}/${target.id}${checkpoint ? "" : "?checkpoint=0"}`;
    const headers = {"content-type": "text/html; charset=utf-8", "x-doc-title": title || document.title};
    if (ifMatch && version) headers["if-match"] = version;
    const response = await fetch(url, {
      method: "PUT",
      credentials: "same-origin",
      headers,
      body: html,
      keepalive,
    });
    const body = await readJSON(response);
    if (response.status === 409 && body.code === "conflict") {
      const error = new Error(body.error || "this document changed elsewhere since you opened it");
      error.conflict = body.current || {};
      throw error;
    }
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    /* The write moved the version, so the next save quotes this one. Reading it from the
       header (rather than from the clock) is what keeps a save made from another tab from
       looking like a conflict. */
    version = stripQuotes(response.headers.get("etag")) || body.savedAt || version;
    primed = html;
    return body;
  }

  /* ------------------------------------------------------------ the surfaces */

  /** One bar, two kinds of decision: a conflict, or a failure that is retrying. */
  function paintNotice({tone, text, primary, secondary}) {
    const el = noticeEl();
    if (!el) return;
    el.dataset.tone = tone;
    el.querySelector("[data-notice-text]").textContent = text;
    for (const [tag, button] of [["[data-notice-primary]", primary], ["[data-notice-secondary]", secondary]]) {
      const node = el.querySelector(tag);
      if (!node) continue;
      node.hidden = !button;
      node.textContent = button ? button.label : "";
      node.onclick = button ? button.run : null;
    }
    el.hidden = false;
  }

  function hideNotice() {
    const el = noticeEl();
    if (!el) return;
    el.hidden = true;
    el.removeAttribute("data-tone");
    for (const tag of ["[data-notice-primary]", "[data-notice-secondary]"]) {
      const node = el.querySelector(tag);
      if (!node) continue;
      node.hidden = true;
      node.onclick = null;
    }
  }

  const clockOf = (iso) => {
    const when = iso ? new Date(iso) : new Date();
    if (Number.isNaN(when.getTime())) return "";
    try {
      return when.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
    } catch {
      return "";
    }
  };

  function showConflict(current) {
    conflict = {current: current || {}};
    clearTimers();
    const at = clockOf(conflict.current.savedAt || conflict.current.updatedAt);
    paintNotice({
      tone: "conflict",
      text: `This document was saved elsewhere${at ? ` — ${at}` : ""}. Your unsaved changes are still here.`,
      secondary: {label: "Reload theirs", run: reloadTheirs},
      primary: {label: "Keep mine", run: keepMine},
    });
  }

  /** The retry bar. The countdown is the point: silence with a spinner is not information. */
  function showRetry() {
    if (conflict) return;
    const seconds = Math.round(RETRY_STEPS_MS[Math.min(retryStep, RETRY_STEPS_MS.length - 1)] / 1000);
    paintNotice({
      tone: "warn",
      text: `Could not save · retrying in ${seconds} s`,
      primary: {label: "Retry now", run: retryNow},
    });
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    const wait = RETRY_STEPS_MS[Math.min(retryStep, RETRY_STEPS_MS.length - 1)];
    retryStep += 1;
    showRetry();
    retryTimer = setTimeout(() => tick({checkpoint: false}), wait);
  }

  function retryNow() {
    retryStep = 0;
    clearTimeout(retryTimer);
    tick({checkpoint: false});
  }

  /* --------------------------------------------------------------- the rules */

  function failed(error) {
    const first = failure === null;
    failure = (error && error.message) || String(error);
    /* Once. A failed autosave is the one case where silence costs work, and a toast per
       attempt is how a working document gets closed by accident. */
    if (first) registry()?.toast?.(`Could not save — ${failure}`, "error");
    scheduleRetry();
  }

  /**
   * One autosave attempt: build the bytes, compare them with what the library confirmed,
   * write only if they differ.
   */
  async function tick({checkpoint = false} = {}) {
    if (!allowed() || inFlight || manualInFlight) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    let built;
    try {
      built = await bytes({});
    } catch (error) {
      failed(error);
      return;
    }
    if (!built || built.html === primed) return;
    const due = checkpoint || Date.now() - lastCheckpointAt >= CHECKPOINT_EVERY_MS;
    await save(built.html, {title: built.title, checkpoint: due, manual: false});
  }

  /**
   * The one write path, manual or automatic. Returns what happened, so a caller with a
   * button can say something and a timer can say nothing.
   */
  async function save(html, {title, checkpoint = true, manual = false, ifMatch = true} = {}) {
    const target = cloud();
    if (!target) return {ok: false, skipped: "no-library"};
    if (inFlight) return {ok: false, skipped: "busy"};
    inFlight = true;
    if (manual) manualInFlight = true;
    clearTimers();
    try {
      const body = await put(html, {title, checkpoint, ifMatch});
      if (checkpoint) lastCheckpointAt = Date.now();
      retryStep = 0;
      failure = null;
      conflict = null;
      /* A save that works clears its own retry bar. A conflict is never cleared by a save:
         only the person decides that, and the bar is where they do it. */
      hideNotice();
      /* The quiet half: `Saved 12:04`, in place. A successful autosave says nothing else. */
      status()?.save?.(html.length);
      if (manual) registry()?.toast?.("Saved to the library");
      return {ok: true, body};
    } catch (error) {
      if (error.conflict) {
        /* Stop the timer, keep the bar. Nothing moves until the person presses one of them. */
        showConflict(error.conflict);
        return {ok: false, conflict: error.conflict};
      }
      if (manual) registry()?.toast?.(error.message, "error");
      else failed(error);
      return {ok: false, error};
    } finally {
      inFlight = false;
      manualInFlight = false;
      if (!conflict) schedule();
    }
  }

  /* -------------------------------------------------------- the two decisions */

  /**
   * "Reload theirs" — discard what is in memory and load the current version.
   *
   * The only destructive button, so it is the secondary one and it asks once. A native
   * `confirm()` is the right weight here: it is a modal question about lost work, it has no
   * styling to get wrong, and it cannot be dismissed by clicking the page behind it.
   */
  function reloadTheirs() {
    if (typeof env.confirm === "function" && !env.confirm("Discard your unsaved changes?")) return;
    env.location.reload();
  }

  /**
   * "Keep mine" — a `PUT` **without** `If-Match`.
   *
   * The library accepts that and snapshots the version it replaces, so their work becomes a
   * History entry rather than a casualty. The version is re-read first: it may have moved
   * again while the bar was up, and overwriting something three saves newer is not the
   * decision the person made.
   */
  async function keepMine() {
    const quoted = conflict?.current?.updatedAt || null;
    await readVersion();
    if (quoted && version && version !== quoted) {
      showConflict({updatedAt: version, savedAt: ""});
      return;
    }
    conflict = null;
    hideNotice();
    let built;
    try {
      built = await bytes({});
    } catch (error) {
      failed(error);
      return;
    }
    if (!built) return;
    await save(built.html, {title: built.title, checkpoint: true, manual: true, ifMatch: false});
  }

  /* ------------------------------------------------------------- the session */

  /**
   * Leaving the document. `keepalive` is best-effort by design: the budget is tens of
   * kilobytes and a document is hundreds, so this is the one save allowed to fail without
   * saying anything. Saving *correctness* never depends on it.
   */
  async function leave({keepalive = false} = {}) {
    if (!allowed() || inFlight || leaving) return;
    leaving = (async () => {
      try {
        const built = await bytes({});
        /* Nothing changed → no snapshot. Without this, a tab hidden for five minutes would
           fill History with identical versions. */
        if (!built || built.html === primed) return;
        await put(built.html, {title: built.title, checkpoint: true, keepalive});
        lastCheckpointAt = Date.now();
        status()?.save?.(built.html.length);
      } catch {
        /* Best-effort, and never a message: the tab is going away. */
      } finally {
        leaving = null;
      }
    })();
    return leaving;
  }

  /** Arm or disarm the clock. Idle mode is armed by an edit, not by this. */
  function schedule() {
    clearInterval(intervalTimer);
    intervalTimer = null;
    if (!allowed() || failure) return;
    if (config().mode !== "interval") return;
    intervalTimer = setInterval(() => tick({checkpoint: false}), config().intervalMs);
  }

  /**
   * Something may have changed: arm the clock this document asked for.
   *
   * This is also how a mode chosen *after* boot takes effect — the sheet writes the field,
   * the next edit reaches here, and the right timer starts. No forward call from the settings
   * sheet, and nothing to keep in sync.
   */
  function nudge() {
    if (!started || !allowed() || manualInFlight) return;
    const {mode, idleMs} = config();
    if (mode === "idle") {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => tick({checkpoint: false}), idleMs);
      return;
    }
    /* `interval` is armed by the clock, not by a keystroke — but a document someone just
       switched into interval mode has no clock running yet. */
    if (mode === "interval" && !intervalTimer) schedule();
  }

  signals.on("edit", nudge);
  /* Comments and figures change the document without an `input` event, and a reviewer
     writing a note is exactly the person `interval` mode exists for. Same debounce, same
     comparison — a mutation that changes nothing costs one serialize and no request. */
  signals.on("mutation", nudge);

  if (typeof env.addEventListener === "function") {
    env.addEventListener("pagehide", () => { leave({keepalive: true}); });
    env.addEventListener("online", () => {
      /* The wait was the whole point: nothing was attempted while offline, so nothing has
         to be undone — the pending change just goes now. */
      if (failure) retryNow();
      else schedule();
    });
    env.addEventListener("offline", () => { clearTimers(); });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      /* A tab that is being closed fires `pagehide`; one that is merely hidden does not, and
         we cannot know for how long. So the "hidden for more than five minutes" checkpoint
         happens on return — the session boundary is the fact, and it is still true then. */
      return;
    }
    if (!hiddenAt) return;
    const away = Date.now() - hiddenAt;
    hiddenAt = 0;
    if (away >= HIDDEN_CHECKPOINT_MS) tick({checkpoint: true});
  });

  /**
   * The chrome hands over the two things only it knows: how to build this document's bytes,
   * and whether the person has changed anything. Called once, at construction.
   */
  async function start() {
    started = true;
    if (!allowed()) return;
    /* One serialize at boot, and only for a document that will autosave: it is the price of
       "nothing changed → no save" being a fact rather than a guess. */
    if (version === null && cloud()) await readVersion();
    try {
      primed = (await bytes({}))?.html ?? null;
    } catch {
      primed = null;
    }
    lastCheckpointAt = Date.now();
    schedule();
  }

  /**
   * Re-read the settings. Called when the sheet has written them, so a mode chosen on a
   * running document starts (or stops) now rather than at the next keystroke.
   */
  function refresh() {
    started = true;
    if (!allowed()) {
      clearTimers();
      return;
    }
    if (primed === null) start();
    else schedule();
  }

  /** For the settings sheet and the tests: what this document would do, and why it does not. */
  function state() {
    return {
      mode: config().mode,
      cloud: Boolean(cloud()),
      version,
      conflict: conflict ? {...conflict} : null,
      failure,
      priming: primed !== null,
    };
  }

  /* The one writer, offered as a capability rather than as a module dependency: the editor's
     `⌘S` and a review copy's button both have to go through the same version and the same
     conflict bar, or two writers would each hold a different idea of what "changed
     elsewhere" means. `registry.can("sink")` is false in a document whose manifest predates
     this module, and those keep saving the way they always did. */
  registry()?.provide?.("sink", {save, leave, refresh, state});

  /* `adopt()` can make a document ready, or its chrome available, after this module is
     constructed — and for a document that was already ready, no `ready` event is coming. */
  if (registry()?.state === "ready") start();
  else registry()?.on?.("ready", () => { start(); });

  return {save, leave, refresh, state, tick};
}
