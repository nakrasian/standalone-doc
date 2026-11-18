export function createToolbar(deps = {}) {
  const {zoom, editor, figures, status, policy, session} = deps;
  /* export (100) is built after toolbar (90) and is only reached from a click. */
  const exporter = deps.late("export");

  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

  /** Toggle buttons describe the *other* state, so a saved minimal file reads right. */
  function syncChromeButtons(name) {
    document.querySelectorAll("[data-chrome-toggle]").forEach((btn) => {
      const compact = name === "minimal";
      btn.setAttribute("aria-label", compact ? "Full toolbar" : "Compact chrome");
      btn.setAttribute("title", compact ? "Full toolbar" : "Compact chrome");
      btn.setAttribute("aria-pressed", String(compact));
    });
  }

  /* Which chrome you are looking at is a preference, not a change to the document:
     it is written to settings so the next save carries it, and deliberately does not
     mark the file dirty — the dot means "content or settings changed". */
  function rememberUi(name) {
    const block = document.getElementById("doc-settings");
    if (!block) return;
    try {
      const settings = JSON.parse(block.textContent || "{}");
      if (settings.ui === name) return;
      settings.ui = name;
      block.textContent = JSON.stringify(settings);
    } catch { /* a corrupt settings block is boot's problem, not the toggle's */ }
  }

  function switchUI(name) {
    if (name !== "ribbon" && name !== "minimal") return;

    document.body.dataset.ui = name;
    const chromeEl = document.getElementById("app-toolbar");
    chromeEl.classList.add("is-resizing");
    closeAllMenus();

    setTimeout(() => chromeEl.classList.remove("is-resizing"), 260);

    syncChromeButtons(name);
    rememberUi(name);
  }

  function toggleChrome() {
    switchUI(document.body.dataset.ui === "minimal" ? "ribbon" : "minimal");
  }

  let submenuCloseTimer = null;

  function cancelSubmenuClose() {
    clearTimeout(submenuCloseTimer);
    submenuCloseTimer = null;
  }

  function closeSubmenu(sub) {
    cancelSubmenuClose();
    const trigger = sub.querySelector("[data-submenu-trigger]");
    const menu = sub.querySelector("[data-menu-panel]");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    if (menu) menu.setAttribute("hidden", "");
  }

  function scheduleSubmenuClose(sub) {
    cancelSubmenuClose();
    submenuCloseTimer = setTimeout(() => closeSubmenu(sub), 140);
  }

  function closeAllSubmenus() {
    document.querySelectorAll("[data-submenu]").forEach(closeSubmenu);
  }

  function closeSiblingSubmenus(sub) {
    const parent = sub.parentElement;
    if (!parent) return;
    for (const child of parent.children) {
      if (child !== sub && child.matches && child.matches("[data-submenu]")) {
        closeSubmenu(child);
      }
    }
  }

  function positionSubmenu(trigger, menu) {
    menu.removeAttribute("hidden");
    const parentMenu = trigger.closest(".menu");
    const rightAligned = !!trigger.closest('.menu-wrap[data-menu-align="right"]');
    const rect = trigger.getBoundingClientRect();
    const anchor = rightAligned && parentMenu ? parentMenu.getBoundingClientRect() : rect;
    const width = menu.offsetWidth || 220;
    const height = menu.offsetHeight || 120;

    /* Right-aligned (minimal) menus cascade to the left of the whole
       dropdown, not over its rows. Ribbon menus cascade to the right and
       flip left only when there is no room. */
    let left;
    if (rightAligned) {
      /* Touch/overlap the parent menu: a visible gap makes the submenu
         close while the pointer crosses it. */
      left = Math.max(8, anchor.left - width + 4);
    } else {
      left = rect.right + 2 + width <= window.innerWidth - 8
        ? rect.right + 2
        : Math.max(8, rect.left - width - 2);
    }

    const topBase = rightAligned ? anchor.top : rect.top - 5;
    const top = Math.min(Math.max(8, topBase), window.innerHeight - height - 8);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function openSubmenu(sub) {
    const trigger = sub.querySelector("[data-submenu-trigger]");
    const menu = sub.querySelector("[data-menu-panel]");
    if (!trigger || !menu) return;
    closeSiblingSubmenus(sub);
    trigger.setAttribute("aria-expanded", "true");
    positionSubmenu(trigger, menu);
  }

  function toggleSubmenu(trigger) {
    const sub = trigger.closest("[data-submenu]");
    if (!sub) return;
    const open = trigger.getAttribute("aria-expanded") === "true";
    if (open) closeSubmenu(sub);
    else openSubmenu(sub);
  }

  function closeAllMenus() {
    document.querySelectorAll("[data-menu-panel]").forEach((menu) => {
      menu.setAttribute("hidden", "");
    });
    closeAllSubmenus();
  }

  function initTitle() {
    const inputs = [...document.querySelectorAll("[data-title]")];
    const apply = (value) => {
      inputs.forEach((el) => {if (el.value !== value) el.value = value;});
      document.title = value.trim() || "Standalone HTML Doc";
    };
    inputs.forEach((el) => el.addEventListener("input", () => {
      apply(el.value);
      status.markDirty();
    }));
    const first = inputs.find((el) => el.value) || inputs[0];
    if (first) apply(first.value);
  }

  function setFavicon(emoji) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">`
      + `<text y=".9em" font-size="90">${emoji}</text></svg>`;
    document.getElementById("favicon").href = "data:image/svg+xml," + encodeURIComponent(svg);
    document.querySelectorAll("[data-favicon]").forEach((el) => {el.textContent = emoji;});
    status.markDirty();
  }

  function pickFavicon(trigger) {
    const parent = trigger.parentElement;
    const existing = parent.querySelector("[data-emoji-menu]");
    if (existing) {existing.remove(); return;}

    const menu = document.createElement("div");
    menu.className = "menu";
    menu.dataset.emojiMenu = "";
    menu.style.cssText = "min-width:0;display:flex;gap:2px;padding:6px;"
      + `left:${trigger.offsetLeft}px;top:${trigger.offsetTop + trigger.offsetHeight + 4}px;`;

    for (const emoji of ["🧬", "📄", "📝", "📚", "🧠", "🔬", "🌱", "💡", "🪶", "⚗️"]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = emoji;
      b.style.cssText = "width:auto;flex:0 0 auto;font-size:16px;padding:0 4px;";
      b.addEventListener("click", () => {setFavicon(emoji); menu.remove();});
      menu.append(b);
    }
    parent.append(menu);
  }

  /**
   * Build the saved file. Async because a policy may have to fetch an asset that
   * this document loaded from the CDN (re-inlining verifies the bytes first); every
   * other policy decision is bookkeeping, so `inline` stays a pure clone.
   */
  async function serialize(options = {}) {
    const clone = document.documentElement.cloneNode(true);

    /* What this session rendered, in one place (`session.js`) — the viewer's bar strips
       the same list, and it drifted between the two the last time it was copied. Note
       what is *not* stripped: `#figure-tools` is an asset (`figure-tools` fragment), so
       whether it travels is the save policy's decision, not a cleanup rule. It is
       `hidden`, so an inline copy costs bytes and nothing else. */
    session.strip(clone);

    // Runtime frames out, and the store pruned to the figures still present.
    figures.prepareClone(clone);

    const size = document.querySelector("[data-fontsize]")?.value || "11pt";
    const theme = clone.querySelector("#user-theme");
    if (theme) theme.textContent = `:root{--doc-size:${size}}`;

    const title = (document.querySelector("[data-title]")?.value || "document").trim();
    clone.querySelector("title").textContent = title;

    /* Assets last: the policy decides what travels, and it rewrites both JSON
       blocks in the clone. A failure here is a failed save, not a partial file.
       `mode` is what makes a copy in another mode possible: a publish is a save in view
       mode, and the plan drops the editing assets rather than offloading them, so the
       copy cannot edit even if someone hands it an editor. */
    const planned = policy.planned({
      policy: options.policy,
      overrides: options.overrides,
      mode: options.mode,
      absentOutside: options.absentOutside === true,
    });
    const {problems} = await policy.apply(clone, planned);
    if (problems.length) throw new Error(`save policy: ${problems.join("; ")}`);

    /* Chrome is not the policy's business — it is what the copy *shows*, not what it
       carries — so an export sets it here, on the block the policy just wrote. */
    if (options.toolbar !== undefined) {
      const block = clone.querySelector("#doc-settings");
      if (block) {
        try {
          const stored = JSON.parse(block.textContent || "{}");
          stored.toolbar = Boolean(options.toolbar);
          block.textContent = JSON.stringify(stored);
        } catch { /* a corrupt block is boot's problem, not the export's */ }
      }
    }

    return {title, html: "<!doctype html>\n" + clone.outerHTML, planned};
  }

  /* Validate the parsed output, never the raw string: the runtime source is
     itself in the file, so a text search for `blob:` or `iframe` matches the
     checker code. A failed check aborts the download. */
  function validate(html) {
    const problems = [];
    if (!html.startsWith("<!doctype html>")) problems.push("missing doctype");
    const doc = new DOMParser().parseFromString(html, "text/html");
    problems.push(...session.problems(doc));
    /* A plugin's panel is this session's UI. If one is in the file, the cleanup above
       missed a path — fail the save rather than ship it. */
    if (doc.querySelector("[data-plugin-ui]")) problems.push("a plugin's UI leaked into the document");
    /* What a reader needs to boot, not what happens to be in the markup: a slim
       document legitimately has no toolbar module, and still works. */
    if (!doc.getElementById("asset-manifest")) problems.push("the asset manifest is missing");
    if (!doc.getElementById("doc-settings")) problems.push("the settings block is missing");
    if (!doc.querySelector('script[id="registry"]')) problems.push("the loader is missing");
    if (doc.querySelector("#content iframe, #content script")) {
      problems.push("a runtime iframe or script leaked into the document body");
    }
    if ([...doc.querySelectorAll("[src^='blob:']")].length) {
      problems.push("a blob: URL leaked into the file");
    }

    let store = null;
    const storeEl = doc.querySelector("#figure-store");
    try {store = JSON.parse(storeEl?.textContent || "{}");}
    catch {problems.push("#figure-store is not valid JSON");}
    if (store) {
      const figures = store.figures || {};
      const used = new Set();
      for (const figure of doc.querySelectorAll("figure[data-figure-id]")) {
        const id = figure.dataset.figureId;
        const entry = figures[id];
        if (!entry) {
          problems.push(`figure ${id} has no store entry`);
          continue;
        }
        used.add(id);
        if (entry.sourceId) used.add(entry.sourceId);
        const source = entry.src ? entry : figures[entry.sourceId];
        if (!source || !source.src) problems.push(`figure ${id} has no source`);
      }
      for (const id of Object.keys(figures)) {
        if (!used.has(id)) problems.push(`unused figure source ${id}`);
      }
    }
    return problems;
  }

  /* ------------------------------------------------------- document settings sheet */
  /*
   * Two scopes share one sheet, and the copy says so: `mode` / `editable` / `toolbar`
   * are read by the loader, so they apply on **next open**; the threshold and the
   * per-capability storage are read by `serialize()`, so they apply **when you save**.
   * Nothing here re-runs the loader: a `file://` document cannot reopen itself, and
   * pretending otherwise would be the one lie this sheet must not tell.
   */

  const settingsEl = () => document.getElementById("doc-settings");
  const settingsDialog = () => document.getElementById("doc-settings-dialog");
  const MB = 1024 * 1024;

  function readSettingsBlock() {
    const el = settingsEl();
    try {
      return el ? JSON.parse(el.textContent || "{}") : {};
    } catch {
      return {};
    }
  }

  function writeSettingsBlock(next) {
    const el = settingsEl();
    if (!el) return false;
    el.textContent = JSON.stringify(next);
    return true;
  }

  const toMb = (bytes) => Math.round((Number(bytes) / MB) * 10) / 10;
  const toBytes = (mb) => Math.round(Number(mb) * MB);

  let settingsDraft = null;

  /* Which panel is showing. One dialog, five questions; the tab is a view of the draft, not
     a second draft. */
  const TABS = ["document", "storage", "runtime", "plugins", "about"];
  let activeTab = "document";

  function selectTab(name) {
    const dialog = settingsDialog();
    if (!dialog || !TABS.includes(name)) return;
    activeTab = name;
    for (const tab of dialog.querySelectorAll("[data-dd-tab]")) {
      tab.setAttribute("aria-selected", String(tab.dataset.ddTab === name));
    }
    for (const panel of dialog.querySelectorAll("[data-dd-panel]")) {
      panel.hidden = panel.dataset.ddPanel !== name;
    }
    /* The Plugins panel is a host element: `plugins.js` owns everything inside it, and it is
       mounted on first activation because that mount is the one that reads a catalog (a
       network call, an author may never want it). */
    if (name === "plugins") mountPluginsPanel();
    if (name === "about") paintAbout();
  }

  function mountPluginsPanel() {
    const host = settingsDialog()?.querySelector("[data-dd-plugins]");
    if (!host) return;
    /* `optional`, not a dep: plugins is built after the toolbar (order 95 > 90), and the
       getter is read when the tab opens, not when this module is constructed. */
    const plugins = deps.optional("plugins")();
    if (!plugins || typeof plugins.renderPanel !== "function") {
      if (!host.childElementCount) host.textContent = "No plugin module in this document.";
      return;
    }
    const loading = plugins.renderPanel(host);
    /* The tab is where "two plugins have newer versions" is *noticed*; the row is where it is
       acted on. Counting needs the catalog, so it lands when the panel has read it. */
    if (loading && typeof loading.then === "function") {
      loading.then((count) => {
        const tab = settingsDialog()?.querySelector('[data-dd-tab="plugins"]');
        if (tab) tab.textContent = count ? `Plugins · ${count}` : "Plugins";
      }).catch(() => {});
    }
  }

  function openDocSettings({tab} = {}) {
    const dialog = settingsDialog();
    if (!dialog) return;
    const settings = globalThis.StandaloneDoc.settings();
    settingsDraft = {
      mode: settings.mode,
      editable: settings.editable,
      toolbar: settings.toolbar,
      author: settings.author || "",
      thresholdMb: toMb(settings.saveThresholdBytes),
      timeoutMs: settings.timeoutMs,
      never: Number(settings.thresholdDeclined) > 0,
      planned: policy.planned({}),
      /* A release this sheet has fetched but not applied: the pin is a document fact,
         so it lands with Done and dies with Cancel, like every other field here. */
      repin: null,
    };
    paintDocSettings();
    if (!dialog.open) dialog.showModal();
    selectTab(tab || activeTab || "document");
  }

  function closeDocSettings() {
    settingsDraft = null;
    const dialog = settingsDialog();
    if (dialog?.open) dialog.close();
  }

  /** Re-price the draft from its rows, and re-derive which preset (if any) it is. */
  function repriceDraft(planned) {
    settingsDraft.planned = planned;
    paintDocSettings();
  }

  function paintDocSettings() {
    const dialog = settingsDialog();
    if (!dialog || !settingsDraft) return;
    const draft = settingsDraft;
    const manifest = globalThis.StandaloneDoc.manifest();
    const base = String(manifest.cdnBase || "");
    const pin = /@([^/]+)/.exec(base)?.[1] ?? "unpinned";

    /* `mode` is deliberately absent from this sheet: it is not a setting of a file you are
       editing, it is what an export produces (see `viewer()`). `editable` is the setting
       that can restrict this file, and it is always available because this file is always
       an editor. */
    dialog.querySelector("[data-ds='editable']").checked = draft.editable;
    /* "Show chrome" now: the editor's ribbon, or a viewer's bar. Neither mode overrides
       the other, so the control is always honest and always editable. */
    dialog.querySelector("[data-ds='toolbar']").checked = draft.toolbar;
    dialog.querySelector("[data-ds='threshold']").value = String(draft.thresholdMb);
    dialog.querySelector("[data-ds='timeout']").value = String(draft.timeoutMs);
    dialog.querySelector("[data-ds='never']").checked = draft.never;
    dialog.querySelector("[data-ds='author']").value = draft.author;
    dialog.querySelector("[data-ds-never-hint]").textContent = draft.never
      ? "quiet until the file doubles"
      : "the prompt returns when the file doubles";
    /* A pending re-pin is shown where the pin lives, because that is what changes. */
    dialog.querySelector("[data-ds-pin]").textContent = draft.repin ? `@${draft.repin.tag} (pending)` : `@${pin}`;
    dialog.querySelector("[data-ds-base]").textContent = base.replace(/^https?:\/\//, "");
    const check = dialog.querySelector("[data-ds-update]");
    check.textContent = draft.repin ? `Update to ${draft.repin.tag}` : "Check for updates…";
    /* A document with no `catalog` and a dev base has nowhere to look: the button says
       so instead of offering a press that can only fail. */
    check.disabled = !registry()?.catalogUrl?.() && !draft.repin;

    dialog.querySelector("[data-ds-sub]").textContent = draft.mode === "edit"
      ? "Stored in this file. Behaviour applies on next open; assets apply when you save."
      : `Stored in this file. This copy opens in ${draft.mode} mode.`;

    const preset = policy.presetFor(draft.planned);
    dialog.querySelectorAll("[data-preset]").forEach((chip) => {
      const name = chip.dataset.preset;
      chip.setAttribute("aria-pressed", String(name === (preset ?? "custom")));
    });

    const body = dialog.querySelector("[data-ds-rows]");
    body.replaceChildren();
    for (const row of rowsFor(draft.planned)) {
      const tr = document.createElement("tr");
      tr.dataset.row = row.key;
      const name = document.createElement("td");
      name.textContent = row.label;
      if (row.why) {
        const hint = document.createElement("span");
        hint.className = "ds-hint";
        hint.textContent = ` ${row.why}`;
        name.append(hint);
      }
      const size = document.createElement("td");
      size.className = "num";
      size.textContent = saveKilobytes(row.bytes);
      const stored = document.createElement("td");
      if (row.choices) {
        const select = document.createElement("select");
        for (const choice of row.choices) {
          const option = document.createElement("option");
          option.value = choice;
          option.textContent = choice === "online" ? "CDN" : choice;
          select.append(option);
        }
        if (row.choice === "mixed") {
          const option = document.createElement("option");
          option.value = "mixed";
          option.textContent = "mixed";
          select.append(option);
        }
        select.value = row.choice;
        select.addEventListener("change", () => {
          /* Re-derive the row list from the live plan, apply this one change to it, and
             price the result: the plan is the truth, rows are a view of it. */
          const next = rowsFor(draft.planned);
          const target = next.find((candidate) => candidate.key === row.key);
          if (target) target.choice = select.value;
          repriceDraft(policy.planned({policy: "inline", overrides: overridesFrom(next)}));
        });
        stored.append(select);
      } else {
        stored.textContent = "inline";
      }
      tr.append(name, size, stored);
      body.append(tr);
    }

    const inline = draft.planned.decisions.reduce((sum, decision) => sum + (decision.to === "inline" ? decision.bytes : 0), 0);
    const offloads = draft.planned.decisions.some((decision) => decision.to === "online");
    dialog.querySelector("[data-ds-total]").textContent =
      `Stored inline: ${saveKilobytes(inline)} · reader ${offloads ? "fetches what is offloaded, after verifying it" : "opens offline"}`;

    const pending = dialog.querySelector("[data-ds-pending]");
    pending.hidden = sameBlock(readSettingsBlock(), settingsPatch());
    pending.textContent = "Unsaved";

    const state = dialog.querySelector("[data-dd-state]");
    if (state) {
      state.textContent = `${draft.mode} mode${draft.repin ? ` · pin ${draft.repin.tag} pending` : ""}`;
      state.dataset.mode = draft.mode;
    }
  }

  /* About: the numbers an author asks for when the file is too big, and the report they are
     asked to paste when it will not open. Both are read, never invented. */
  function paintAbout() {
    const dialog = settingsDialog();
    if (!dialog) return;
    const manifest = globalThis.StandaloneDoc.manifest();
    const assets = manifest.assets || [];
    const infra = assets.filter((asset) => asset.role === "infra").reduce((sum, asset) => sum + (asset.bytes || 0), 0);
    const bodies = assets.reduce((sum, asset) => sum + (asset.bytes || 0), 0);
    const file = document.documentElement.outerHTML.length;
    const facts = [
      ["File", saveKilobytes(file)],
      ["Asset bodies", `${saveKilobytes(bodies)} · ${saveKilobytes(infra)} of it infrastructure`],
      ["Loaded now", `${Object.keys(globalThis.StandaloneDoc.modules || {}).length} modules`],
      ["Pinned tag", /@([^/]+)\//.exec(manifest.cdnBase || "")?.[1] ?? "unpinned"],
      ["Host API", String(globalThis.StandaloneDoc.hostApi)],
    ];
    const body = dialog.querySelector("[data-dd-facts]");
    if (body) {
      body.replaceChildren();
      for (const [key, value] of facts) {
        const tr = document.createElement("tr");
        const name = document.createElement("td");
        name.textContent = key;
        const cell = document.createElement("td");
        cell.className = "num";
        cell.textContent = value;
        tr.append(name, cell);
        body.append(tr);
      }
    }
    const diag = dialog.querySelector("[data-dd-diag]");
    if (diag) diag.textContent = globalThis.StandaloneDoc.diagnostics();
  }

  /** The settings block the draft would produce. Pure: comparing it is how we know
   *  whether the author actually changed anything. */
  function settingsPatch() {
    const draft = settingsDraft;
    const current = readSettingsBlock();
    /* Storage keys come from the policy, so "the default plan" writes nothing. */
    const next = policy.settingsFragment(draft.planned, current);
    /* Preserved, never chosen: a document's mode comes from its own block (a build
       flavour or an export), and this sheet may not rewrite it. */
    next.mode = draft.mode;
    /* A setting can restrict a mode, never contradict it — the loader clamps too.
       `toolbar` is chrome, not the editor's ribbon, so it survives a mode change. */
    next.editable = draft.mode === "edit" ? draft.editable : false;
    next.toolbar = draft.toolbar;
    next.saveThresholdBytes = Math.max(0, toBytes(draft.thresholdMb || 0));
    /* An author name is written only when there is one: a document with no comments has
       nobody to attribute, and an empty string in every file is a change for nothing. */
    if (draft.author && draft.author.trim()) next.author = draft.author.trim();
    else delete next.author;
    next.timeoutMs = Math.max(0, Math.round(Number(draft.timeoutMs) || 0));

    if (draft.never) {
      /* The stored number is the size at which the author declined; the prompt re-arms
         at twice that. `outerHTML` is the honest estimate available without saving. */
      next.thresholdDeclined = Number(settings()?.thresholdDeclined) || document.documentElement.outerHTML.length;
    } else {
      delete next.thresholdDeclined;
    }

    return next;
  }

  const sameBlock = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /** Apply the draft. Opening the sheet and pressing Done is not a change. */
  function commitDocSettings() {
    if (!settingsDraft) return;
    const current = readSettingsBlock();
    const next = settingsPatch();
    const repin = settingsDraft.repin;
    closeDocSettings();
    if (sameBlock(current, next) && !repin) return;
    if (!sameBlock(current, next)) writeSettingsBlock(next);
    if (repin) {
      /* Only `mode: online` module assets move; a plugin's bytes are its author's and
         an inline asset's hash describes bytes the file already has. */
      registry().repin(repin);
    }
    status.markDirty();
  }

  const registry = () => globalThis.StandaloneDoc;

  /**
   * "Check for updates…" — the deliberate path to a newer release, as opposed to the
   * failure card (which exists because the pin no longer resolves).
   *
   * Three rules, all of them about not lying to the author:
   *   - Nothing is written until Done. The fetched release is a draft field.
   *   - Failure is total. A catalog that cannot be read, or a release manifest that
   *     does not parse, leaves the pin exactly where it was.
   *   - The running code does not change. This window started on `@pin` and keeps it;
   *     the *file* moves, so what you save from now on runs the new release.
   */
  async function checkForUpdates() {
    const dialog = settingsDialog();
    if (!dialog || !settingsDraft) return;
    const button = dialog.querySelector("[data-ds-update]");
    const note = dialog.querySelector("[data-ds-update-note]");
    const say = (text, tone) => {
      note.hidden = !text;
      note.textContent = text || "";
      if (tone) note.dataset.tone = tone;
      else note.removeAttribute("data-tone");
    };

    if (settingsDraft.repin) {
      /* Second press is a withdrawal, not a second fetch. */
      settingsDraft.repin = null;
      say("");
      paintDocSettings();
      return;
    }
    const api = registry();
    if (!api?.catalogUrl?.()) {
      say("This copy names no release catalog — a dev build has no moving sibling to read.", "warn");
      return;
    }

    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Checking…";
    say("Reading the release index…");
    try {
      /* One question, one implementation: the failure card asks the same thing and applies it
         at once, because a failed boot has no toolbar to press Done on. */
      const {current, latest, newer, entry, readable} = await api.compareUpdate({fetchEntry: true});
      if (!readable) {
        say("Could not read the release index (offline, or the catalog is missing). Nothing changed.", "warn");
        return;
      }
      if (!current) {
        say("This document has no tag to compare against. Nothing changed.", "warn");
        return;
      }
      if (!latest || latest === current) {
        say(`Already on the newest release (${current}).`, "ok");
        return;
      }
      if (!newer) {
        say(`The index offers ${latest}; this copy is on ${current}, which is newer. Nothing changed.`, "ok");
        return;
      }
      settingsDraft.repin = entry;
      paintDocSettings();
      say(`${latest} is available. Press Done to point this file at it: the running window keeps ${current}, and every copy you save from now on runs ${latest}.`, "ok");
    } catch (error) {
      /* `release()` raises a `failure` with a readable reason; either way the pin stands. */
      say(`${error?.message || "That release could not be read"}. Nothing changed.`, "warn");
    } finally {
      button.disabled = false;
      button.textContent = settingsDraft.repin ? `Update to ${settingsDraft.repin.tag}` : label;
    }
  }

  /** `settings()` is the registry's normalised view; used only for the decline size. */
  const settings = () => (globalThis.StandaloneDoc && globalThis.StandaloneDoc.settings ? globalThis.StandaloneDoc.settings() : null);

  function wireDocSettings() {
    const dialog = settingsDialog();
    if (!dialog || dialog.dataset.wired) return;
    dialog.dataset.wired = "1";

    /* No `[data-ds='mode']` listener: the sheet has no mode control. A file's mode comes
       from its own block, and producing a viewer is an export (`viewer()`). */
    dialog.querySelector("[data-ds='editable']").addEventListener("change", (event) => {
      settingsDraft.editable = event.target.checked;
    });
    dialog.querySelector("[data-ds='toolbar']").addEventListener("change", (event) => {
      settingsDraft.toolbar = event.target.checked;
    });
    dialog.querySelector("[data-ds='threshold']").addEventListener("change", (event) => {
      settingsDraft.thresholdMb = Number(event.target.value) || 0;
    });
    dialog.querySelector("[data-ds='timeout']").addEventListener("change", (event) => {
      settingsDraft.timeoutMs = Math.round(Number(event.target.value) || 0);
    });
    dialog.querySelector("[data-ds='author']").addEventListener("change", (event) => {
      settingsDraft.author = event.target.value;
      paintDocSettings();
    });
    for (const tab of dialog.querySelectorAll("[data-dd-tab]")) {
      tab.addEventListener("click", () => selectTab(tab.dataset.ddTab));
    }
    dialog.querySelector("[data-dd-copy]").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const text = globalThis.StandaloneDoc.diagnostics();
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
      } catch {
        /* No clipboard permission: show it, so it can be selected by hand. */
        const diag = settingsDialog()?.querySelector("[data-dd-diag]");
        if (diag) diag.hidden = false;
        button.textContent = "Select above";
      }
      setTimeout(() => { button.textContent = "Copy"; }, 1400);
    });
    dialog.querySelector("[data-ds='never']").addEventListener("change", (event) => {
      settingsDraft.never = event.target.checked;
      paintDocSettings();
    });
    dialog.querySelector("[data-ds='arm']").addEventListener("click", () => {
      settingsDraft.never = false;
      paintDocSettings();
    });
    dialog.querySelectorAll("[data-preset]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const name = chip.dataset.preset;
        if (!policy.PRESETS.includes(name)) return;
        repriceDraft(policy.planned({policy: name}));
      });
    });
    dialog.querySelector("[data-ds-update]").addEventListener("click", () => { checkForUpdates(); });
    dialog.querySelector("[data-ds-cancel]").addEventListener("click", closeDocSettings);
    dialog.querySelector("[data-ds-done]").addEventListener("click", commitDocSettings);
    /* Escape, or a backdrop-free close, discards the draft. */
    dialog.addEventListener("close", () => { settingsDraft = null; });
  }

  /* ------------------------------------------------------------ save policy UI */

  /* Rows are capabilities, not assets: content, the base view, each used plugin, the
     editor. That is the decision an author can actually make ("this copy is for
     reading"), and the useful saving is usually a plugin rather than the runtime. */
  /** The plugin's own name, if the file declares one; the asset id is the fallback. */
  function pluginLabel(plugin, assetId) {
    const name = (globalThis.StandaloneDoc.manifest().plugins || {})[plugin]?.label;
    return name ? `Plugin · ${name}` : `Plugin · ${assetId}`;
  }

  /** Figures that would break if this plugin did not travel (`policy` owns the count). */
  const usedPluginCount = (plugin) => Number(policy.usage()?.[plugin]) || 0;

  const saveKilobytes = (bytes) =>
    bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

  /**
   * Rows are capabilities, not assets: one per `requiredBy` group. Three modes now ship
   * chrome of their own — a `["*"]` base, `["edit"]` editing, `["view"]` the viewer bar —
   * so an edit document is offered the choice of carrying a reader's bar it will not
   * build. Plugins are their own rows: their presence is an author's switch.
   */
  function rowsFor(planned) {
    const LABEL = {view: "Base view", editor: "Editor", viewer: "Viewer"};
    /* `["view"]` and `["*"]` must not share a key: one is the base row, the other is the
       bar that only a viewer builds. */
    const keyOf = (requiredBy) => requiredBy.includes("*")
      ? "view"
      : requiredBy.includes("edit") ? "editor" : requiredBy.includes("view") ? "viewer" : requiredBy.join("+");
    const groups = new Map();
    const plugins = [];
    for (const decision of planned.decisions) {
      if (decision.role === "infra") continue;
      if (decision.category === "plugin") {
        /* A plugin a figure needs cannot be `absent` — `policy.target()` clamps it, and
           the row does not offer what the door would refuse. */
        const used = usedPluginCount(decision.plugin);
        plugins.push({
          key: decision.id,
          label: pluginLabel(decision.plugin, decision.id),
          ids: [decision.id],
          bytes: decision.bytes,
          why: used ? `${used} figure${used === 1 ? "" : "s"} need it` : "",
          choices: used ? ["inline", "online"] : ["inline", "online", "absent"],
          choice: decision.to,
        });
        continue;
      }
      const key = keyOf(decision.requiredBy || ["*"]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(decision);
    }
    const shared = (decisions) => {
      const first = decisions[0].to;
      return decisions.every((decision) => decision.to === first) ? first : "mixed";
    };
    const rows = [];
    for (const [key, decisions] of groups) {
      if (key === "viewer") continue;
      rows.push({
        key,
        label: LABEL[key] || key,
        ids: decisions.map((d) => d.id),
        bytes: decisions.reduce((n, d) => n + d.bytes, 0),
        choices: key === "view" ? ["inline", "online"] : ["inline", "online", "absent"],
        choice: shared(decisions),
      });
    }
    rows.push(...plugins);
    for (const [key, decisions] of groups) {
      if (key !== "viewer") continue;
      rows.push({
        key,
        label: LABEL[key] || key,
        ids: decisions.map((d) => d.id),
        bytes: decisions.reduce((n, d) => n + d.bytes, 0),
        choices: ["inline", "online", "absent"],
        choice: shared(decisions),
      });
    }
    return rows;
  }

  function overridesFrom(rows) {
    const overrides = {};
    for (const row of rows) {
      if (row.choice === "mixed" || !row.choices) continue;
      for (const id of row.ids) overrides[id] = row.choice;
    }
    return overrides;
  }

  /**
   * Ask what should travel. Resolves `{overrides, declined}`, or null when the author
   * cancels — a cancelled save writes nothing.
   */
  function askSavePolicy({planned, bytes, blocks, threshold}) {
    const dialog = document.getElementById("save-policy-dialog");
    if (!dialog) return Promise.resolve(null);

    const rows = rowsFor(planned);
    /* `bytes` is what this document's own plan would write. The dialog prices every
       choice from "everything present in the file", so add back what that plan already
       dropped — a mode-driven `absent`, such as the viewer bar in an editing document. */
    const baseline = planned.decisions.reduce(
      (total, decision) => (decision.to !== "inline" && blocks[decision.id] != null ? total + blocks[decision.id] : total),
      bytes,
    );

    /* Price a row choice from the file as it stands: removing a block saves what that
       block actually weighs, and re-adding one costs what the CDN copy weighs. Using
       the manifest's src/ byte counts here would overstate the saving by the size of
       the compiled envelope. */
    const totalFor = (decisions) => {
      let total = baseline;
      for (const decision of decisions) {
        const present = blocks[decision.id] != null;
        if (present && decision.to !== "inline") total -= blocks[decision.id];
        if (!present && decision.to === "inline") total += (decision.bytes || 0) + 80;
      }
      return Math.max(0, total);
    };

    return new Promise((resolve) => {
      const finish = (value) => {
        dialog.removeEventListener("close", onClose);
        if (dialog.open) dialog.close();
        resolve(value);
      };
      const onClose = () => resolve(null);
      dialog.addEventListener("close", onClose, {once: true});

      const paint = () => {
        const next = policy.planned({policy: "inline", overrides: overridesFrom(rows)});
        const total = totalFor(next.decisions);
        const offloads = rows.some((row) => row.choices && row.choice === "online");
        const drops = rows.some((row) => row.choices && row.choice === "absent");
        dialog.querySelector("[data-save-title]").textContent = `This document is ${saveKilobytes(total)}`;
        /* Say what this particular mix means: "absent" and "CDN" are not the same
           promise to the reader, so they must not share a sentence. */
        dialog.querySelector("[data-save-note]").textContent = offloads
          ? "Anything marked CDN is fetched and hash-checked when the file is opened, so editing it needs a connection. Everything else opens offline."
          : drops
            ? "Opens offline, with nothing to fetch. What you set to absent is not in this copy at all — the original still has it."
            : "Opens offline, with nothing to fetch.";
        dialog.querySelector("[data-save-confirm]").textContent = `Save · ${saveKilobytes(total)}`;
        return total;
      };

      const body = dialog.querySelector("[data-save-rows]");
      body.replaceChildren();
      for (const row of rows) {
        const wrap = document.createElement("div");
        wrap.className = "sp-row";
        wrap.dataset.row = row.key;
        const text = document.createElement("div");
        text.className = "sp-text";
        const label = document.createElement("span");
        label.className = "sp-label";
        label.textContent = row.label;
        const size = document.createElement("span");
        size.className = "sp-size";
        size.textContent = saveKilobytes(row.bytes);
        text.append(label, size);
        if (row.why) {
          const why = document.createElement("div");
          why.className = "sp-why";
          why.textContent = row.why;
          text.append(why);
        }
        if (row.choices) {
          const select = document.createElement("select");
          for (const choice of row.choices) {
            const option = document.createElement("option");
            option.value = choice;
            option.textContent = choice === "online" ? "CDN" : choice;
            select.append(option);
          }
          if (row.choice === "mixed") {
            const option = document.createElement("option");
            option.value = "mixed";
            option.textContent = "mixed";
            select.append(option);
          }
          select.value = row.choice;
          select.addEventListener("change", () => {
            row.choice = select.value;
            paint();
          });
          wrap.append(text, select);
        } else {
          const fixed = document.createElement("span");
          fixed.className = "sp-fixed";
          fixed.textContent = "inline";
          wrap.append(text, fixed);
        }
        body.append(wrap);
      }

      dialog.querySelector("[data-save-cancel]").onclick = () => finish(null);
      dialog.querySelector("[data-save-confirm]").onclick = () =>
        finish({
          overrides: overridesFrom(rows),
          declined: !rows.some((row) => row.choices && row.choice === "online") && paint() > threshold,
        });

      paint();
      dialog.showModal();
      dialog.querySelector("select")?.focus();
    });
  }

  /** Remember "keep inline" so the prompt does not return until the file doubles. */
  function rememberDecline(bytes) {
    const block = document.getElementById("doc-settings");
    if (!block) return;
    try {
      const settings = JSON.parse(block.textContent || "{}");
      settings.thresholdDeclined = bytes;
      block.textContent = JSON.stringify(settings);
    } catch { /* a corrupt settings block is boot's problem, not the save path's */ }
  }

  /* ------------------------------------------------------------ the two sinks
   *
   * One save path, two destinations: the file it came from (a download — a browser
   * cannot write a file back) and the library that serves it. Which one is a property of
   * the document (`#doc-settings.cloud`), not of the button, so the same ⌘S is correct
   * wherever the file is opened — and a copy that lost the field keeps downloading.
   *
   * The library also *chooses the policy*. A hosted document keeps its assets `online`,
   * because that is what lets one runtime serve every document in the library, and what
   * stops a save from turning 77 kB into 400 kB of inlined copies.
   */
  const library = () => {
    const registry = globalThis.StandaloneDoc;
    const settings = registry && registry.settings ? registry.settings() : {};
    return settings.cloud || null;
  };

  /**
   * The JSON door, with the trap named.
   *
   * An expired session does not answer 401: Access redirects to a login page, `fetch`
   * follows it, and the response is HTML with status 200. The content type is the only
   * thing that tells the two apart, so it is what this checks — a save that treats a
   * login page as success is the one bug this path exists to prevent.
   */
  async function call(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {"content-type": "text/html; charset=utf-8", ...(options.headers || {})},
    });
    const type = response.headers.get("content-type") || "";
    if (!type.includes("application/json")) {
      /* A page where data was expected: an expired session (Access redirects and `fetch`
         follows), a mistyped endpoint, or something in front of the host. All three mean
         the same thing to the person saving, so the message names the one they can act
         on — and the status, because a 200 here is the whole trap. */
      throw new Error(
        response.redirected || type.includes("text/html")
          ? "signed out — reopen this document to sign in (the library answered with a page, not data)"
          : `unexpected response (${response.status})`,
      );
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }

  /**
   * A copy is not a source.
   *
   * The published file must not carry the write target, or a reader who saves it as an
   * editor would PUT over the document it was copied from — and a link that can be
   * turned back into the original is not a read-only link.
   */
  function detach(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const block = doc.getElementById("doc-settings");
    if (block) {
      try {
        const settings = JSON.parse(block.textContent || "{}");
        delete settings.cloud;
        block.textContent = JSON.stringify(settings);
      } catch { /* a corrupt block is boot's problem, not the publish path's */ }
    }
    return "<!doctype html>\n" + doc.documentElement.outerHTML;
  }

  /* The link is what a publish produces, so it gets a dialog rather than a status line:
     it has to be readable, selectable, and still there while it is pasted. */
  function showPublished(url) {
    const dialog = document.getElementById("publish-dialog");
    if (!dialog) {
      console.info("Published:", url);
      return;
    }
    const field = dialog.querySelector("[data-publish-url]");
    field.value = new URL(url, location.href).href;
    dialog.showModal();
    field.select();
  }

  function wirePublish() {
    const dialog = document.getElementById("publish-dialog");
    if (!dialog) return;
    dialog.querySelector("[data-publish-copy]")?.addEventListener("click", async () => {
      const field = dialog.querySelector("[data-publish-url]");
      try {
        await navigator.clipboard.writeText(field.value);
      } catch {
        /* Copy needs a secure context; a `file://` copy of this dialog still gets the
           selected text, which is one keystroke away. */
        field.select();
      }
    });
  }

  /* ------------------------------------------------------------ the viewer
   *
   * A viewer is an *export*, not a mode of the file you are editing. That is a safety
   * property, not a preference: `policy.js` marks the editing assets `absent` in a
   * view-mode save, so a file rewritten that way can never be edited again — only
   * replaced by an older copy. So the viewer is built as a copy, and the two choices
   * that used to be settings *of the file* travel with the copy instead: whether it shows
   * chrome, and whether it carries its assets (mailable, opens from disk) or fetches them
   * (small, one shared runtime).
   */

  const VIEWER_POLICIES = policy.PRESETS;

  /** Ask for the copy's two options. `null` when the author closes the dialog. */
  function askViewer() {
    const dialog = document.getElementById("viewer-dialog");
    if (!dialog) return Promise.resolve(null);
    /* Publishing needs somewhere to publish; downloading never does. */
    const publish = dialog.querySelector("[data-viewer-publish]");
    if (publish) publish.hidden = !library();
    dialog.querySelector("[data-viewer-toolbar]").checked = true;
    dialog.querySelector("[data-viewer-policy]").value = "slim";
    return new Promise((resolve) => {
      dialog.addEventListener(
        "close",
        () => {
          const destination = dialog.returnValue;
          if (destination !== "download" && destination !== "library") return resolve(null);
          resolve({
            destination,
            toolbar: dialog.querySelector("[data-viewer-toolbar]").checked,
            policy: dialog.querySelector("[data-viewer-policy]").value,
          });
        },
        { once: true },
      );
      dialog.showModal();
    });
  }

  /**
   * Build a read-only copy and send it somewhere: a download, or the library this document
   * belongs to. Never this file — a failed export leaves the document exactly as it was,
   * down to the dirty dot, which is the whole reason it is not a setting.
   */
  async function viewer({toolbar = true, policy: preset = "slim", destination = "download"} = {}) {
    let copy;
    try {
      copy = await serialize({
        mode: "view",
        toolbar: Boolean(toolbar),
        policy: VIEWER_POLICIES.includes(preset) ? preset : "slim",
        /* A copy is a flavour, not a save: what this mode cannot use is *gone* from the
           declaration, so nobody can flip the copy back into an editor by editing a field. */
        absentOutside: true,
      });
    } catch (error) {
      console.error("Viewer aborted:", error && error.message ? error.message : error);
      return;
    }

    const problems = validate(copy.html);
    if (problems.length) {
      console.error("Viewer aborted:", problems);
      return;
    }

    /* A copy is not a source: it must not carry the write target. */
    const html = detach(copy.html);
    const target = library();

    if (destination === "library" && target) {
      try {
        const {url} = await call(`${target.api}/${target.id}/share`, {method: "POST", body: html});
        showPublished(url);
      } catch (error) {
        console.error("Publish failed:", error && error.message ? error.message : error);
      }
      return;
    }

    const name = `${copy.title.replace(/[\\/:*?"<>|]+/g, "-")} (read-only).html`;
    const url = URL.createObjectURL(new Blob([html], {type: "text/html"}));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function save(options = {}) {
    /* `to: "file"` is the deliberate way out of the library — a copy you keep. */
    const target = options.to === "file" ? null : library();
    let serialized;
    const attempt = async (opts) => {
      try {
        return await serialize(opts);
      } catch (error) {
        console.error("Save aborted:", error && error.message ? error.message : error);
        status.markDirty();
        return null;
      }
    };

    /* The sink picks the policy: a hosted document keeps its assets where every other
       document in the library can share them. A file keeps whatever the author chose,
       which is why the default is only applied when there is somewhere to send bytes. */
    serialized = await attempt(target ? {policy: "slim", ...options} : options);
    if (!serialized) return;

    /* Over the document's own threshold: ask once, with real numbers. The dialog is
       a decision, never an automatic offload. */
    const registry = globalThis.StandaloneDoc;
    const settings = registry && registry.settings ? registry.settings() : {};
    const threshold = Number(settings.saveThresholdBytes) || 0;
    const bytes = serialized.html.length;
    const declined = Number(settings.thresholdDeclined) || 0;
    if (!options.policy && !options.overrides && threshold > 0 && bytes > threshold && !(declined && bytes < declined * 2)) {
      const blocks = {};
      for (const decision of serialized.planned.decisions) {
        const block = policy.blockOf(document, decision.id);
        if (block) blocks[decision.id] = block.outerHTML.length + 80; /* markers + newlines */
      }
      const choice = await askSavePolicy({planned: serialized.planned, bytes, blocks, threshold});
      if (!choice) return;
      if (choice.declined) rememberDecline(bytes);
      serialized = await attempt({overrides: choice.overrides});
      if (!serialized) return;
    }

    const {title, html} = serialized;
    const problems = validate(html);
    if (problems.length) {
      console.error("Save aborted:", problems);
      status.markDirty();
      return;
    }

    if (target) {
      try {
        await call(`${target.api}/${target.id}`, {method: "PUT", headers: {"x-doc-title": title}, body: html});
        status.save(html.length);
      } catch (error) {
        /* A failed copy must not look saved: the dot stays on and the reason is one
           console line — the same shape as a failed serialise, on purpose. */
        console.error("Save to library failed:", error && error.message ? error.message : error);
        status.markDirty();
      }
      return;
    }

    const url = URL.createObjectURL(new Blob([html], {type: "text/html"}));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[\\/:*?"<>|]+/g, "-")}.html`;
    a.click();
    status.save(html.length);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const KEYMAP = [
    {keys: "Mod+S", label: "Save", group: "File", run: save, anywhere: true},
    {keys: "Mod+B", label: "Bold", group: "Format", cmd: "bold"},
    {keys: "Mod+I", label: "Italic", group: "Format", cmd: "italic"},
    {keys: "Mod+U", label: "Underline", group: "Format", cmd: "underline"},
    {keys: "Mod+Shift+X", label: "Strikethrough", group: "Format", cmd: "strikeThrough"},
    {keys: "Mod+.", label: "Superscript", group: "Format", cmd: "superscript"},
    {keys: "Mod+,", label: "Subscript", group: "Format", cmd: "subscript"},
    {keys: "Mod+\\", label: "Clear formatting", group: "Format", cmd: "removeFormat"},
    {keys: "Mod+Alt+0", label: "Paragraph", group: "Blocks", block: "p"},
    {keys: "Mod+Alt+1", label: "Heading 1", group: "Blocks", block: "h1"},
    {keys: "Mod+Alt+2", label: "Heading 2", group: "Blocks", block: "h2"},
    {keys: "Mod+Alt+3", label: "Heading 3", group: "Blocks", block: "h3"},
    {keys: "Mod+Shift+Q", label: "Quote", group: "Blocks", block: "blockquote"},
    {keys: "Mod+Shift+C", label: "Code block", group: "Blocks", block: "pre"},
    {keys: "Mod+Shift+8", label: "Bulleted list", group: "Blocks", cmd: "insertUnorderedList"},
    {keys: "Mod+Shift+7", label: "Numbered list", group: "Blocks", cmd: "insertOrderedList"},
    {keys: "Mod+K", label: "Insert link", group: "Insert", run: () => editor.openLink()},
    {keys: "Mod+Shift+K", label: "Remove link", group: "Insert", cmd: "unlink"},
    {keys: "Mod+Z", label: "Undo", group: "History", cmd: "undo"},
    {keys: "Mod+Shift+Z", label: "Redo", group: "History", cmd: "redo"},
    {keys: "Mod+Shift+M", label: "Toggle compact chrome", group: "View", run: toggleChrome, anywhere: true},
    /* native: listed in the shortcut dialog but handled by zoomChord(), which
       matches on e.code so Mod+= and Mod+Shift++ both work. */
    {keys: "Mod+=", label: "Zoom in", group: "View", native: true, zoom: "in"},
    {keys: "Mod+-", label: "Zoom out", group: "View", native: true, zoom: "out"},
    {keys: "Mod+0", label: "Actual size (100%)", group: "View", native: true, zoom: "reset"},
    {keys: "Mod+9", label: "Fit page width", group: "View", native: true, zoom: "fit"},
    {keys: "Mod+,", label: "Document settings", group: "File", run: () => openDocSettings(), anywhere: true},
    {keys: "Mod+/", label: "Keyboard shortcuts", group: "Help", run: showShortcuts, anywhere: true},
  ];

  const byChord = new Map(
    KEYMAP.filter((entry) => !entry.native).map((entry) => [entry.keys, entry])
  );

  function pretty(keys) {
    if (isMac) {
      return keys.replaceAll("Mod", "⌘").replaceAll("Alt", "⌥").replaceAll("Shift", "⇧");
    }
    return keys.replaceAll("Mod", "Ctrl");
  }

  function showShortcuts() {
    const groups = new Map();
    for (const entry of KEYMAP) {
      if (!groups.has(entry.group)) groups.set(entry.group, []);
      groups.get(entry.group).push(entry);
    }

    const list = document.getElementById("keylist");
    list.replaceChildren(...[...groups].flatMap(([group, entries]) => {
      const heading = document.createElement("h3");
      heading.textContent = group;
      const rows = entries.map((entry) => {
        const row = document.createElement("div");
        const name = document.createElement("span");
        name.textContent = entry.label;
        const kbd = document.createElement("kbd");
        kbd.textContent = pretty(entry.keys);
        row.append(name, kbd);
        return row;
      });
      return [heading, ...rows];
    }));
    document.getElementById("shortcuts-dialog").showModal();
  }

  function paintKeyHints() {
    const hints = new Map();
    for (const entry of KEYMAP) {
      if (entry.cmd) hints.set(`cmd:${entry.cmd}`, entry.keys);
      if (entry.block) hints.set(`block:${entry.block}`, entry.keys);
      if (entry.zoom) hints.set(`zoom:${entry.zoom}`, entry.keys);
    }
    hints.set("action:save", "Mod+S");
    hints.set("action:link", "Mod+K");
    hints.set("action:shortcuts", "Mod+/");
    hints.set("action:settings", "Mod+,");

    /* Markup can declare its own hint slot (`<kbd data-hint="action:settings">`), which
       keeps the menu's shape in the fragment instead of growing this function. */
    document.querySelectorAll(".menu kbd[data-hint]").forEach((slot) => {
      const keys = hints.get(slot.dataset.hint);
      if (keys) slot.textContent = pretty(keys);
    });

    document.querySelectorAll(".menu button").forEach((btn) => {
      if (btn.querySelector("kbd")) return;
      let keys = null;
      if (btn.dataset.cmd) keys = hints.get(`cmd:${btn.dataset.cmd}`);
      else if (btn.dataset.blockSet) keys = hints.get(`block:${btn.dataset.blockSet}`);
      else if (btn.dataset.zoom) keys = hints.get(`zoom:${btn.dataset.zoom}`);
      else if (btn.hasAttribute("data-save")) keys = hints.get("action:save");
      else if (btn.dataset.export === "html-interactive") keys = hints.get("action:save");
      else if (btn.hasAttribute("data-link")) keys = hints.get("action:link");
      else if (btn.hasAttribute("data-shortcuts")) keys = hints.get("action:shortcuts");
      if (!keys) return;
      const kbd = document.createElement("kbd");
      kbd.textContent = pretty(keys);
      btn.append(kbd);
    });
  }

  function inEditor() {
    const sel = window.getSelection();
    return document.activeElement === content
      || (!!sel && sel.rangeCount > 0 && content.contains(sel.anchorNode));
  }

  function keyName(e) {
    if (e.code && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
    if (e.code && /^Digit\d$/.test(e.code)) return e.code.slice(5);
    if (e.key.length === 1) return e.key.toUpperCase();
    return e.key;
  }

  function chordOf(e) {
    const parts = [];
    if (isMac ? e.metaKey : e.ctrlKey) parts.push("Mod");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    parts.push(keyName(e));
    return parts.join("+");
  }

  /* Zoom chords match on e.code, so Mod+=, Mod+Shift+= (where e.key is "+")
     and the numpad keys all land in the same place. Alt is excluded so
     Mod+Alt+0 (Paragraph) keeps working. */
  function zoomChord(e) {
    if (!(isMac ? e.metaKey : e.ctrlKey)) return null;
    if (e.altKey) return null;
    switch (e.code) {
      case "Equal":
      case "NumpadAdd": return "in";
      case "Minus":
      case "NumpadSubtract": return "out";
      case "Digit0":
      case "Numpad0": return "reset";
      case "Digit9":
      case "Numpad9": return "fit";
      default: return null;
    }
  }

  /* Typed percentage: commit on Enter / blur, revert on Escape, step on
     ArrowUp/ArrowDown. The anchor is the viewport centre (anchorY null).
     The field is rewritten to the normalised value, so typing "0" shows
     "10" after the clamp. */
  function commitZoomInput(input) {
    const ok = zoom.setPercent(input.value, null);
    input.value = String(Math.round(zoom.value * 100));
    zoom.syncUI();
    return ok;
  }

  // Keep the caret in the editor when a toolbar control is pressed.
  document.addEventListener("mousedown", (e) => {
    if (e.target.closest("#app-toolbar button")) e.preventDefault();
  });

  // Select the whole zoom value on focus, so click + type replaces it.
  document.addEventListener("focusin", (e) => {
    const input = e.target.closest && e.target.closest("[data-zoom-input]");
    if (input) input.select();
  });

  // blur does not bubble: commit in the capture phase.
  document.addEventListener("blur", (e) => {
    const input = e.target.closest && e.target.closest("[data-zoom-input]");
    if (input) commitZoomInput(input);
  }, true);

  document.addEventListener("click", (e) => {
    const toggleBtn = e.target.closest("[data-chrome-toggle]");
    if (toggleBtn) {toggleChrome(); return;}

    const menuBtn = e.target.closest("[data-menu]");
    if (menuBtn) {
      const menu = menuBtn.nextElementSibling;
      if (menu && menu.classList.contains("menu")) {
        const isHidden = menu.hasAttribute("hidden");
        if (isHidden) {
          closeAllMenus();
          zoom.syncUI();
          menu.removeAttribute("hidden");
          requestAnimationFrame(() => {
            menu.classList.remove("menu-flip");
            menu.style.maxHeight = "";
            const btn = menuBtn.getBoundingClientRect();
            const gap = 6;
            const margin = 8;
            const below = window.innerHeight - btn.bottom - gap - margin;
            const above = btn.top - gap - margin;
            const flip = menu.scrollHeight > below && above > below;
            menu.classList.toggle("menu-flip", flip);
            menu.style.maxHeight = `${Math.max(120, flip ? above : below)}px`;
          });
        } else {
          menu.setAttribute("hidden", "");
          menu.classList.remove("menu-flip");
        }
        return;
      }
    }

    const settingsItem = e.target.closest("[data-settings-open]");
    if (settingsItem) {closeAllMenus(); openDocSettings(); return;}

    /* The size readout is the second door: it is the number that makes an author ask
       "why is this file big?", so it opens the sheet where that is answered. */
    const statsHit = e.target.closest("[data-stats]");
    if (statsHit) {closeAllMenus(); openDocSettings({tab: "storage"}); return;}

    /* A plugin's home is a panel of the document dialog, so its menu items and the Plugins
       command open the same dialog at the same tab. */
    const pluginsItem = e.target.closest("[data-plugins-open]");
    if (pluginsItem) {closeAllMenus(); openDocSettings({tab: "plugins"}); return;}

    const submenuBtn = e.target.closest("[data-submenu-trigger]");
    if (submenuBtn) {toggleSubmenu(submenuBtn); return;}

    const faviconBtn = e.target.closest("[data-favicon]");
    if (faviconBtn) {pickFavicon(faviconBtn); return;}

    const cmdBtn = e.target.closest("[data-cmd]");
    const blockBtn = e.target.closest("[data-block-set]");
    const linkBtn = e.target.closest("[data-link]");
    const fontBtn = e.target.closest("[data-font]");
    const figureBtn = e.target.closest("[data-figure-pick]");
    const exportBtn = e.target.closest("[data-export]");
    const saveBtn = e.target.closest("[data-save]");
    const viewerBtn = e.target.closest("[data-viewer]");
    const shortcutBtn = e.target.closest("[data-shortcuts]");
    const zoomBtn = e.target.closest("[data-zoom]");

    /* A field inside a menu must not close it on click: the caret has to
       land in the input. Every other click inside a menu closes it. */
    const keepMenu = !!e.target.closest(".menu-field");
    if (e.target.closest(".menu") && !keepMenu) closeAllMenus();

    if (cmdBtn) {editor.exec(cmdBtn.dataset.cmd); return;}
    if (blockBtn) {editor.setBlock(blockBtn.dataset.blockSet); return;}
    if (linkBtn) {editor.openLink(); return;}
    if (fontBtn) {editor.setFontSize(fontBtn.dataset.font); return;}
    if (figureBtn) {figures.pick(figureBtn.dataset.figurePick); return;}
    if (zoomBtn) {zoom.command(zoomBtn.dataset.zoom, e.clientY); return;}
    if (exportBtn) {exporter().begin(exportBtn.dataset.export); return;}
    if (viewerBtn) {askViewer().then((choice) => choice && viewer(choice)); return;}
    if (saveBtn) {save(); return;}
    if (shortcutBtn) {showShortcuts(); return;}

    if (!e.target.closest("[data-emoji-menu]")) {
      if (!keepMenu) closeAllMenus();
      document.querySelectorAll("[data-emoji-menu]").forEach((m) => m.remove());
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target.matches("[data-block]")) editor.setBlock(e.target.value);
    if (e.target.matches("[data-fontsize]")) editor.setFontSize(e.target.value);
  });

  document.addEventListener("keydown", (e) => {
    /* Zoom fields own Enter / Escape / ArrowUp / ArrowDown. */
    const field = e.target.closest && e.target.closest("[data-zoom-input]");
    if (field) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (commitZoomInput(field) && field.closest(".menu")) closeAllMenus();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        field.value = String(Math.round(zoom.value * 100));
        field.blur();
        closeAllMenus();
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        zoom.command(e.key === "ArrowUp" ? "in" : "out");
        field.value = String(Math.round(zoom.value * 100));
        return;
      }
    }

    if (e.key === "Escape") {
      closeAllMenus();
    }
    if (e.key === "ArrowRight") {
      const trigger = e.target.closest && e.target.closest("[data-submenu-trigger]");
      if (trigger) {
        e.preventDefault();
        openSubmenu(trigger.closest("[data-submenu]"));
        const first = trigger.closest("[data-submenu]").querySelector("[data-menu-panel] button");
        if (first) first.focus();
        return;
      }
    }

    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod) return;

    /* Zoom before the chord table: it must work with focus in the editor or
       in one of the fields. */
    const zoomCmd = zoomChord(e);
    if (zoomCmd) {
      e.preventDefault();
      zoom.command(zoomCmd, e.clientY || null);
      return;
    }

    const entry = byChord.get(chordOf(e));
    if (!entry) return;
    /* `anywhere` shortcuts fire outside the editor; the rest are scoped to it. */
    if (!entry.anywhere && !inEditor()) return;

    e.preventDefault();
    if (entry.run) {entry.run(); return;}
    if (entry.cmd) {editor.exec(entry.cmd); return;}
    if (entry.block) {editor.setBlock(entry.block);}
  });

  /* Cascading menus open on hover for mouse users; click/toggle covers
     touch and keyboard. */
  document.querySelectorAll("[data-submenu]").forEach((sub) => {
    const trigger = sub.querySelector("[data-submenu-trigger]");
    if (!trigger) return;
    trigger.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse") {
        cancelSubmenuClose();
        openSubmenu(sub);
      }
    });
    sub.addEventListener("pointerenter", cancelSubmenuClose);
    sub.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse" && !sub.contains(e.relatedTarget)) {
        scheduleSubmenuClose(sub);
      }
    });
  });

  initTitle();
  paintKeyHints();
  editor.syncToolbar();
  zoom.syncUI();

  wireDocSettings();
  wirePublish();
  syncChromeButtons(document.body.dataset.ui || "ribbon");
  return {save, serialize, validate, viewer, settings: openDocSettings};
}
