export function createToolbar(deps = {}) {
  const {zoom, editor, figures, status, policy} = deps;
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

    /* Not #figure-tools: its markup is an asset now (the `figure-tools` fragment), so
       whether it travels with the file is the save policy's decision, not a cleanup
       rule. It is `hidden`, so an inline copy costs bytes and nothing else. */
    clone.querySelectorAll("#sheets > *, .page-spacer, [data-emoji-menu], [data-plugin-ui]").forEach((el) => el.remove());
    clone.querySelectorAll("[data-menu-panel]").forEach((m) => m.setAttribute("hidden", ""));
    clone.querySelectorAll(".menu").forEach((m) => {
      m.classList.remove("menu-flip");
      m.removeAttribute("style");
    });
    clone.querySelectorAll("[data-submenu-trigger]").forEach((b) => {
      b.setAttribute("aria-expanded", "false");
    });
    clone.querySelector("#app-toolbar")?.classList.remove("is-resizing");
    clone.querySelector("#stage")?.removeAttribute("style");
    /* Reset the whole element, not just its text: Status.refresh() also adds a
       title attribute, so a second save would otherwise differ from the first. */
    clone.querySelectorAll("[data-stats]").forEach((el) => {
      el.textContent = "—";
      el.removeAttribute("title");
    });
    clone.querySelectorAll("[data-dirty]").forEach((el) => {el.hidden = true;});
    clone.querySelector("#progress-dialog")?.removeAttribute("open");
    clone.querySelector("#doc-settings-dialog")?.removeAttribute("open");

    // Runtime frames out, and the store pruned to the figures still present.
    figures.prepareClone(clone);

    const size = document.querySelector("[data-fontsize]")?.value || "11pt";
    const theme = clone.querySelector("#user-theme");
    if (theme) theme.textContent = `:root{--doc-size:${size}}`;

    const title = (document.querySelector("[data-title]")?.value || "document").trim();
    clone.querySelector("title").textContent = title;

    /* Assets last: the policy decides what travels, and it rewrites both JSON
       blocks in the clone. A failure here is a failed save, not a partial file. */
    const planned = policy.planned({policy: options.policy, overrides: options.overrides});
    const {problems} = await policy.apply(clone, planned);
    if (problems.length) throw new Error(`save policy: ${problems.join("; ")}`);

    return {title, html: "<!doctype html>\n" + clone.outerHTML, planned};
  }

  /* Validate the parsed output, never the raw string: the runtime source is
     itself in the file, so a text search for `blob:` or `iframe` matches the
     checker code. A failed check aborts the download. */
  function validate(html) {
    const problems = [];
    if (!html.startsWith("<!doctype html>")) problems.push("missing doctype");
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (doc.querySelector(".page-spacer")) problems.push("a page spacer leaked into the file");
    if (doc.querySelector("#sheets > *")) problems.push("the sheet layer is not empty");
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

  function openDocSettings({section} = {}) {
    const dialog = settingsDialog();
    if (!dialog) return;
    const settings = globalThis.StandaloneDoc.settings();
    settingsDraft = {
      mode: settings.mode,
      editable: settings.editable,
      toolbar: settings.toolbar,
      thresholdMb: toMb(settings.saveThresholdBytes),
      timeoutMs: settings.timeoutMs,
      never: Number(settings.thresholdDeclined) > 0,
      planned: policy.planned({}),
    };
    paintDocSettings();
    if (!dialog.open) dialog.showModal();
    if (section) {
      dialog.querySelector(`[data-ds-section="${section}"]`)?.scrollIntoView({block: "nearest"});
    }
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

    dialog.querySelector("[data-ds='mode']").value = draft.mode;
    dialog.querySelector("[data-ds='editable']").checked = draft.editable && draft.mode === "edit";
    dialog.querySelector("[data-ds='editable']").disabled = draft.mode !== "edit";
    dialog.querySelector("[data-ds='toolbar']").checked = draft.toolbar && draft.mode !== "view";
    dialog.querySelector("[data-ds='toolbar']").disabled = draft.mode === "view";
    dialog.querySelector("[data-ds='threshold']").value = String(draft.thresholdMb);
    dialog.querySelector("[data-ds='timeout']").value = String(draft.timeoutMs);
    dialog.querySelector("[data-ds='never']").checked = draft.never;
    dialog.querySelector("[data-ds-never-hint]").textContent = draft.never
      ? "quiet until the file doubles"
      : "the prompt returns when the file doubles";
    dialog.querySelector("[data-ds-pin]").textContent = `@${pin}`;
    dialog.querySelector("[data-ds-base]").textContent = base.replace(/^https?:\/\//, "");

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
  }

  /** The settings block the draft would produce. Pure: comparing it is how we know
   *  whether the author actually changed anything. */
  function settingsPatch() {
    const draft = settingsDraft;
    const current = readSettingsBlock();
    /* Storage keys come from the policy, so "the default plan" writes nothing. */
    const next = policy.settingsFragment(draft.planned, current);
    next.mode = draft.mode;
    /* A setting can restrict a mode, never contradict it — the loader clamps too. */
    next.editable = draft.mode === "edit" ? draft.editable : false;
    next.toolbar = draft.mode === "view" ? false : draft.toolbar;
    next.saveThresholdBytes = Math.max(0, toBytes(draft.thresholdMb || 0));
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
    closeDocSettings();
    if (sameBlock(current, next)) return;
    writeSettingsBlock(next);
    status.markDirty();
  }

  /** `settings()` is the registry's normalised view; used only for the decline size. */
  const settings = () => (globalThis.StandaloneDoc && globalThis.StandaloneDoc.settings ? globalThis.StandaloneDoc.settings() : null);

  function wireDocSettings() {
    const dialog = settingsDialog();
    if (!dialog || dialog.dataset.wired) return;
    dialog.dataset.wired = "1";

    dialog.querySelector("[data-ds='mode']").addEventListener("change", (event) => {
      settingsDraft.mode = event.target.value;
      paintDocSettings();
    });
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
    dialog.querySelector("[data-ds-cancel]").addEventListener("click", closeDocSettings);
    dialog.querySelector("[data-ds-done]").addEventListener("click", commitDocSettings);
    /* Escape, or a backdrop-free close, discards the draft. */
    dialog.addEventListener("close", () => { settingsDraft = null; });
  }

  /* ------------------------------------------------------------ save policy UI */

  /* Rows are capabilities, not assets: content, the base view, each used plugin, the
     editor. That is the decision an author can actually make ("this copy is for
     reading"), and the useful saving is usually a plugin rather than the runtime. */
  const saveKilobytes = (bytes) =>
    bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

  function rowsFor(planned) {
    const base = [];
    const editor = [];
    const plugins = [];
    for (const decision of planned.decisions) {
      if (decision.role === "infra") continue;
      if (decision.category === "plugin") {
        plugins.push({
          key: decision.id,
          label: `Plugin · ${decision.id}`,
          ids: [decision.id],
          bytes: decision.bytes,
          choices: ["inline", "online", "absent"],
          choice: decision.to,
        });
      } else if ((decision.requiredBy || ["*"]).includes("*")) base.push(decision);
      else editor.push(decision);
    }
    const shared = (decisions) => {
      const first = decisions[0].to;
      return decisions.every((decision) => decision.to === first) ? first : "mixed";
    };
    const rows = [];
    if (base.length) {
      rows.push({key: "view", label: "Base view", ids: base.map((d) => d.id), bytes: base.reduce((n, d) => n + d.bytes, 0), choices: ["inline", "online"], choice: shared(base)});
    }
    rows.push(...plugins);
    if (editor.length) {
      rows.push({key: "editor", label: "Editor", ids: editor.map((d) => d.id), bytes: editor.reduce((n, d) => n + d.bytes, 0), choices: ["inline", "online", "absent"], choice: shared(editor)});
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

    /* Price a row choice from the file as it stands: removing a block saves what that
       block actually weighs, and re-adding one costs what the CDN copy weighs. Using
       the manifest's src/ byte counts here would overstate the saving by the size of
       the compiled envelope. */
    const totalFor = (decisions) => {
      let total = bytes;
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
          declined: !rows.some((row) => row.choices && row.choice !== "inline") && paint() > threshold,
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

  async function save(options = {}) {
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

    serialized = await attempt(options);
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
    if (statsHit) {closeAllMenus(); openDocSettings({section: "size"}); return;}

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
  syncChromeButtons(document.body.dataset.ui || "ribbon");
  return {save, serialize, validate, settings: openDocSettings};
}
