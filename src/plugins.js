/**
 * Plugin contributions: the part of the host that gives a plugin a place in the UI.
 *
 * A plugin declares what it offers in the manifest (`plugins[id].contributes`) and
 * implements it in the object its `activate(host)` returns. This module joins the two:
 * it renders the declared entries into host elements that already exist in the chrome,
 * and calls the implementation when one is used.
 *
 * The rule that keeps the file honest: **a plugin extends the surface, it never
 * occupies it.** Entries are data rendered into a host element; a plugin never writes
 * markup into the toolbar, the menu panels or the content. Anything it inserts into the
 * document goes through `figures.insertHTML()`, which owns the store, the editor and the
 * dirty flag.
 *
 * Edit-only (`requiredBy: ["edit"]`). A viewer has no menus to extend, and a plugin that
 * a figure needs is loaded by that figure, not by this module.
 */
export function createPlugins(deps = {}) {
  const {signals, figures, env} = deps;
  const registry = env.StandaloneDoc;

  /* Contribution kinds that only exist as UI. A plugin offering one of these has to be
     built at boot, or its menu would stay empty until something else loaded it. */
  const UI_KINDS = ["insert", "export", "panel", "command", "toolbar"];

  const wiring = new Map(); /* plugin id -> disposals for the DOM we rendered */
  const dialogs = new Map(); /* "<plugin>:<panel>" -> the open dialog, if any */

  const pluginEntries = () => registry.manifest().plugins || {};

  /* The pin a figure stores, so the figure never looks a plugin up by name later. */
  function pinFor(id, entry) {
    const mainId = entry.entry || (entry.assets || [])[0];
    const asset = (registry.manifest().assets || []).find((candidate) => candidate.id === mainId) || {};
    return {
      id,
      label: entry.label || id,
      url: asset.url || null,
      integrity: asset.integrity || null,
    };
  }

  const contribution = (entry, kind, itemId) =>
    ((entry.contributes || {})[kind] || []).find((item) => item.id === itemId) || null;

  function menuButton(label, attribute, value) {
    const button = document.createElement("button");
    button.setAttribute("data-menu-item", "");
    button.dataset[attribute] = value;
    button.textContent = label;
    return button;
  }

  /* ---------------------------------------------------------------- rendering */

  /**
   * Render one plugin's declarations into every host that exists for them. Idempotent:
   * re-wiring unwires first, so a reload cannot double the entries.
   */
  function wire(id) {
    unwire(id);
    const entry = pluginEntries()[id];
    const instance = registry.instance(id);
    if (!entry || !instance) return;
    const contributes = entry.contributes || {};
    const disposals = [];

    const groups = [
      { selector: "[data-plugin-inserts]", kind: "insert", attribute: "pluginInsert" },
      { selector: "[data-plugin-exports]", kind: "export", attribute: "pluginExport" },
      /* Panels and commands live in the settings menu: they are "do something to the
         document" entries, not insertions. */
      { selector: "[data-plugin-actions]", kind: "panel", attribute: "pluginPanel" },
      { selector: "[data-plugin-actions]", kind: "command", attribute: "pluginCommand" },
    ];

    for (const { selector, kind, attribute } of groups) {
      const items = contributes[kind] || [];
      if (!items.length) continue;
      for (const host of document.querySelectorAll(selector)) {
        const separator = document.createElement("div");
        separator.className = "menu-sep";
        const group = document.createElement("div");
        group.className = "menu-label";
        group.textContent = entry.label || id;
        host.append(separator, group);
        for (const item of items) {
          host.append(menuButton(item.label || item.id, attribute, `${id}:${item.id}`));
        }
        host.hidden = false;
        disposals.push(() => {
          host.replaceChildren();
          host.hidden = true;
        });
      }
    }

    wiring.set(id, disposals);
  }

  function unwire(id) {
    for (const [key, dialog] of [...dialogs]) {
      if (!key.startsWith(`${id}:`)) continue;
      dialog.remove();
      dialogs.delete(key);
    }
    const disposals = wiring.get(id);
    if (!disposals) return;
    for (const dispose of disposals.splice(0).reverse()) {
      try {
        dispose();
      } catch (error) {
        console.warn("plugin contribution cleanup failed:", error);
      }
    }
    wiring.delete(id);
  }

  /* ------------------------------------------------------------------ actions */

  async function insert(id, itemId) {
    const instance = registry.instance(id);
    const handler = instance && instance.insert && instance.insert[itemId];
    const entry = pluginEntries()[id];
    if (!entry || !handler) return refuse(id, `does not implement insert "${itemId}"`);

    const declared = contribution(entry, "insert", itemId) || {};
    const island = declared.island || entry.island || "sealed";
    try {
      /* The handler returns content; the host inserts it. A plugin never touches the
         store, the editor or the dirty flag itself. */
      const content = await handler({ contribution: declared, pin: pinFor(id, entry) });
      if (!content || !content.html) return refuse(id, `insert "${itemId}" returned no html`);
      figures.insertHTML(content.html, {
        caption: content.caption || declared.label || entry.label || "",
        pin: pinFor(id, entry),
        island: content.island || island,
      });
    } catch (error) {
      refuse(id, `insert "${itemId}" failed: ${(error && error.message) || error}`);
    }
  }

  /**
   * Open a plugin's panel.
   *
   * The host owns the box — size, head, close button, modality — and hands the plugin an
   * empty body. The dialog is tagged `data-plugin-ui`, so `serialize()` drops it and a
   * save can never carry it. Re-opening re-runs the implementation: a panel that wants to
   * keep state keeps it in the plugin, not in stale DOM.
   */
  function openPanel(id, panelId) {
    const instance = registry.instance(id);
    const handler = instance && instance.panel && instance.panel[panelId];
    const entry = pluginEntries()[id];
    if (!entry || !handler) return refuse(id, `does not implement panel "${panelId}"`);
    const declared = contribution(entry, "panel", panelId) || {};
    const key = `${id}:${panelId}`;

    let dialog = dialogs.get(key);
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "plugin-panel";
      dialog.setAttribute("data-plugin-ui", "");
      const head = document.createElement("div");
      head.className = "pp-head";
      const title = document.createElement("h2");
      title.textContent = declared.label || entry.label || id;
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Close";
      close.addEventListener("click", () => dialog.close());
      head.append(title, close);
      const body = document.createElement("div");
      body.className = "pp-body";
      dialog.append(head, body);
      document.body.append(dialog);
      dialogs.set(key, dialog);
    }

    const body = dialog.querySelector(".pp-body");
    body.replaceChildren();
    try {
      const rendered = handler(body);
      if (rendered && typeof rendered.then === "function") {
        rendered.catch((error) => refuse(id, `panel "${panelId}" failed: ${(error && error.message) || error}`));
      }
    } catch (error) {
      refuse(id, `panel "${panelId}" failed: ${(error && error.message) || error}`);
    }
    if (!dialog.open) dialog.showModal();
  }

  async function runCommand(id, commandId) {
    const instance = registry.instance(id);
    const handler = instance && instance.command && instance.command[commandId];
    if (!handler) return refuse(id, `does not implement command "${commandId}"`);
    try {
      await handler();
    } catch (error) {
      refuse(id, `command "${commandId}" failed: ${(error && error.message) || error}`);
    }
  }

  async function runExport(id, itemId) {
    const instance = registry.instance(id);
    const handler = instance && instance.export && instance.export[itemId];
    if (!handler) return refuse(id, `does not implement export "${itemId}"`);
    try {
      const file = await handler();
      if (!file || file.text == null) return refuse(id, `export "${itemId}" returned no text`);
      download(file);
    } catch (error) {
      refuse(id, `export "${itemId}" failed: ${(error && error.message) || error}`);
    }
  }

  function download({ name = "export.txt", mime = "text/plain", text }) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* A refused contribution is a message, not an exception: nothing is half-applied. */
  function refuse(id, message) {
    const error = { kind: "construct", id, message };
    console.error(`plugin "${id}" ${message}`);
    signals.emit("plugin-refused", error);
    return false;
  }

  /* ------------------------------------------------------------------- wiring */

  document.addEventListener("click", (event) => {
    const insertButton = event.target.closest("[data-plugin-insert]");
    if (insertButton) {
      const [id, itemId] = insertButton.dataset.pluginInsert.split(":");
      insert(id, itemId);
      return;
    }
    const exportButton = event.target.closest("[data-plugin-export]");
    if (exportButton) {
      const [id, itemId] = exportButton.dataset.pluginExport.split(":");
      runExport(id, itemId);
      return;
    }
    const panelButton = event.target.closest("[data-plugin-panel]");
    if (panelButton) {
      const [id, itemId] = panelButton.dataset.pluginPanel.split(":");
      openPanel(id, itemId);
      return;
    }
    const commandButton = event.target.closest("[data-plugin-command]");
    if (commandButton) {
      const [id, itemId] = commandButton.dataset.pluginCommand.split(":");
      runCommand(id, itemId);
    }
  });

  registry.on("plugin", (detail) => {
    if (detail.state === "ready") wire(detail.id);
    else if (detail.state === "deactivated" || detail.state === "failed") unwire(detail.id);
  });

  /**
   * Build every enabled plugin that offers UI, and wire what is already built.
   *
   * A menu entry cannot be lazy: if the plugin is not built, the entry does not exist
   * and the author is left wondering which half is broken. A plugin that only
   * contributes a content runtime is *not* built here — a figure asks for it when it
   * mounts.
   */
  async function activateUi() {
    for (const [id, entry] of Object.entries(pluginEntries())) {
      if (entry.enabled === false) continue;
      const offers = UI_KINDS.some((kind) => (entry.contributes || {})[kind]);
      if (!offers) continue;
      try {
        await registry.require(id);
        wire(id);
      } catch {
        /* Recorded by the registry and shown on the plugin's row; a plugin that fails
           must not take the editor down with it. */
      }
    }
  }

  activateUi();

  return { activateUi, wire, unwire, openPanel };
}
