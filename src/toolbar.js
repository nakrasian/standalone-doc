export function createToolbar(deps = {}) {
  const {zoom, editor, figures, status} = deps;
  /* export (100) is built after toolbar (90) and is only reached from a click. */
  const exporter = deps.late("export");

  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

  function switchUI(name) {
    if (name !== "ribbon" && name !== "minimal") return;

    document.body.dataset.ui = name;
    const chromeEl = document.getElementById("app-toolbar");
    chromeEl.classList.add("is-resizing");
    closeAllMenus();

    setTimeout(() => chromeEl.classList.remove("is-resizing"), 260);

    document.querySelectorAll("[data-chrome-toggle]").forEach((btn) => {
      const compact = name === "minimal";
      btn.setAttribute("aria-label", compact ? "Full toolbar" : "Compact chrome");
      btn.setAttribute("title", compact ? "Full toolbar" : "Compact chrome");
      btn.setAttribute("aria-pressed", String(compact));
    });

    status.markDirty();
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

  function serialize() {
    const clone = document.documentElement.cloneNode(true);

    clone.querySelectorAll("#sheets > *, .page-spacer, [data-emoji-menu], #figure-tools").forEach((el) => el.remove());
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

    // Runtime frames out, and the store pruned to the figures still present.
    figures.prepareClone(clone);

    const size = document.querySelector("[data-fontsize]")?.value || "11pt";
    const theme = clone.querySelector("#user-theme");
    if (theme) theme.textContent = `:root{--doc-size:${size}}`;

    const title = (document.querySelector("[data-title]")?.value || "document").trim();
    clone.querySelector("title").textContent = title;

    return {title, html: "<!doctype html>\n" + clone.outerHTML};
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
    if (!doc.querySelector("#app-runtime, #toolbar")) problems.push("the runtime is missing");
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

  function save() {
    const {title, html} = serialize();
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
    {keys: "Mod+S", label: "Save", group: "File", run: save, global: true},
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
    {keys: "Mod+Shift+M", label: "Toggle compact chrome", group: "View", run: toggleChrome, global: true},
    /* native: listed in the shortcut dialog but handled by zoomChord(), which
       matches on e.code so Mod+= and Mod+Shift++ both work. */
    {keys: "Mod+=", label: "Zoom in", group: "View", native: true, zoom: "in"},
    {keys: "Mod+-", label: "Zoom out", group: "View", native: true, zoom: "out"},
    {keys: "Mod+0", label: "Actual size (100%)", group: "View", native: true, zoom: "reset"},
    {keys: "Mod+9", label: "Fit page width", group: "View", native: true, zoom: "fit"},
    {keys: "Mod+/", label: "Keyboard shortcuts", group: "Help", run: showShortcuts, global: true},
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
    if (!entry.global && !inEditor()) return;

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

  return {save, serialize, validate};
}
