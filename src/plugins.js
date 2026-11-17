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
  const {signals, figures, status, env} = deps;
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


  /* ------------------------------------------------------------------- the sheet */
  /*
   * The author-facing half: what is in this file, what could be, and how to add one from
   * a url. Storage (inline vs fetched) is *not* here — that decision lives in Document
   * settings, and a second control for it would be the third copy of the same rows.
   *
   * Built in JS on purpose: the sheet is session state, tagged `data-plugin-ui`, and the
   * save path drops it like any other runtime node.
   */

  let sheet = null;
  let catalog = null;
  let catalogError = null;
  let foot = "";
  let pendingPin = null;

  const manifestJSON = () => {
    const el = document.getElementById("asset-manifest");
    try {
      return el ? JSON.parse(el.textContent) : null;
    } catch {
      return null;
    }
  };

  /* Writing the manifest is the only mutation in this module, and it is deliberate:
     installing a plugin is editing the file's own description of itself. */
  function writeManifest(next) {
    const el = document.getElementById("asset-manifest");
    if (!el) return false;
    el.textContent = JSON.stringify(next);
    registry.reloadManifest();
    status.markDirty();
    return true;
  }

  const catalogUrl = () =>
    String(registry.manifest().cdnBase || "").replace(/\/$/, "").replace(/\/cdn$/, "") + "/registry.json";

  /* A document may carry its own catalog in a `#plugin-catalog` block. That is what makes
     the sheet useful from disk: a `file://` page cannot fetch a relative url (lab/007), and
     the published tag is not where a lab document looks. Absent, it is fetched from the
     runtime's cdnBase — advisory either way. */
  function catalogBlock() {
    const el = document.getElementById("plugin-catalog");
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch {
      return null;
    }
  }

  const say = (text) => {
    foot = text;
    if (sheet) sheet.querySelector("[data-ps-foot]").textContent = text;
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function usedBy(id) {
    return figures.pluginUsage()[id] || 0;
  }

  function assetRows(entry, manifest) {
    const table = element("table", "ps-assets");
    const head = element("thead");
    const headRow = element("tr");
    for (const label of ["Asset", "Size", "Stored"]) headRow.append(element("th", null, label));
    head.append(headRow);
    const body = element("tbody");
    for (const assetId of entry.assets || []) {
      const asset = (manifest.assets || []).find((candidate) => candidate.id === assetId) || {};
      const row = element("tr");
      row.append(
        element("td", "ps-asset-id", assetId),
        element("td", "ps-num", `${Math.round((asset.bytes || 0) / 1024)} KB`),
        element("td", null, asset.mode || "—"),
      );
      body.append(row);
    }
    table.append(head, body);
    return table;
  }

  function installedRow(id, entry, manifest) {
    const count = usedBy(id);
    const built = Boolean(registry.instance(id));
    const row = element("div", "ps-row");
    row.dataset.id = id;
    row.dataset.state = entry.enabled === false ? "off" : built ? "on" : "idle";

    const main = element("div", "ps-main");
    const name = element("span", "ps-name", entry.label || id);
    const version = element("span", "ps-version", entry.version ? `v${entry.version}` : "");
    const island = element("span", "ps-badge", entry.island || "sealed");
    island.dataset.island = entry.island || "sealed";
    const used = element("span", "ps-used", count ? `used by ${count} figure${count === 1 ? "" : "s"}` : "used by none");

    const toggle = element("label", "ps-switch");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = entry.enabled !== false;
    box.dataset.toggle = id;
    box.addEventListener("click", (event) => {
      /* The intent comes from the manifest, not from the checkbox: a click may have
         flipped the input before this handler ran, and a refusal must not leave a
         switch that says the opposite of the file. */
      event.preventDefault();
      const current = (manifestJSON()?.plugins?.[id] || {}).enabled !== false;
      setEnabled(id, !current);
    });
    toggle.append(box, element("span", null, box.checked ? "on" : "off"));

    const remove = element("button", "ps-btn", "Remove");
    remove.dataset.remove = id;
    remove.addEventListener("click", () => uninstall(id));

    main.append(name, version, island, used, element("span", "ps-grow"), toggle, remove);
    row.append(main);

    const error = (registry.errors || []).find((item) => item.id === id);
    if (error) row.append(element("p", "ps-why", `${error.kind} — ${error.message}`));
    else if (count) row.append(element("p", "ps-hint", "A plugin a figure needs cannot be removed or switched off."));

    const details = element("details", "ps-details");
    details.append(element("summary", null, `${(entry.assets || []).length} asset${(entry.assets || []).length === 1 ? "" : "s"} · storage is set in Document settings`));
    details.append(assetRows(entry, manifest));
    row.append(details);
    return row;
  }

  function availableRow(id, asset) {
    const latest = (asset.versions || [])[0] || {};
    const row = element("div", "ps-row");
    row.dataset.id = id;
    row.dataset.state = "available";
    const main = element("div", "ps-main");
    const island = element("span", "ps-badge", asset.island || latest.island || "sealed");
    island.dataset.island = asset.island || latest.island || "sealed";
    main.append(
      element("span", "ps-name", asset.label || id),
      element("span", "ps-version", latest.version ? `v${latest.version}` : ""),
      island,
      /* Bytes under a kilobyte are common in a catalog (a 477-byte module) and "0 KB" is
         a lie the eye reads as empty. */
      element("span", "ps-used", latest.bytes ? (latest.bytes < 2048 ? `${latest.bytes} bytes` : `${Math.round(latest.bytes / 1024)} KB`) : ""),
      element("span", "ps-grow"),
    );
    const install = element("button", "ps-btn ps-primary", "Install");
    install.dataset.install = id;
    install.addEventListener("click", () => installFrom(id, asset, latest));
    main.append(install);
    row.append(main);
    if (asset.description) row.append(element("p", "ps-hint", asset.description));
    return row;
  }

  function formRow() {
    const wrap = element("div", "ps-form");
    const field = (labelText, placeholder, mono) => {
      const row = element("div", "ps-field");
      const label = element("label", null, labelText);
      const input = document.createElement("input");
      input.placeholder = placeholder;
      if (mono) input.classList.add("ps-mono");
      row.append(label, input);
      wrap.append(row);
      return input;
    };
    const url = field("URL", "https://esm.sh/mermaid@11.4.1?bundle", true);
    const label = field("Name", "Mermaid");
    const result = element("p", "ps-result");
    const actions = element("div", "ps-field");
    actions.append(element("label"));
    const verify = element("button", "ps-btn", "Fetch and verify");
    const add = element("button", "ps-btn ps-primary", "Add");
    add.disabled = true;
    actions.append(verify, add);
    wrap.append(actions, result);

    verify.addEventListener("click", async () => {
      const target = url.value.trim();
      result.dataset.tone = "busy";
      result.textContent = "fetching…";
      add.disabled = true;
      pendingPin = null;
      /* Checked here as well as in install(): a relative url resolves against this
         document over http and fails from disk, so it must not get as far as a hash. */
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target)) {
        result.dataset.tone = "bad";
        result.textContent = "A plugin url must be absolute (https://…) — a relative one does not work from disk.";
        return;
      }
      try {
        const fetched = await registry.prefetch(target);
        pendingPin = { url: target, integrity: fetched.integrity, bytes: fetched.size, label: label.value.trim() };
        result.dataset.tone = "ok";
        const size = fetched.size < 2048 ? `${fetched.size} bytes` : `${Math.round(fetched.size / 1024)} KB`;
        result.textContent = `verified ${size} · ${fetched.integrity.slice(0, 22)}… — press Add to pin it`;
        add.disabled = false;
      } catch (error) {
        result.dataset.tone = "bad";
        result.textContent = `${error.kind || "error"} — ${error.message || error}`;
      }
    });

    add.addEventListener("click", async () => {
      if (!pendingPin) return;
      const id = (pendingPin.label || pendingPin.url).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "plugin";
      await install(id, { ...pendingPin, label: pendingPin.label || id, island: "sealed" });
      url.value = "";
      label.value = "";
      result.textContent = "";
      add.disabled = true;
      pendingPin = null;
    });
    return wrap;
  }

  function renderSheet() {
    if (!sheet) return;
    const manifest = manifestJSON() || { assets: [], plugins: {} };
    const plugins = manifest.plugins || {};
    const search = (sheet.querySelector("[data-ps-search]").value || "").trim().toLowerCase();
    const matches = (text) => !search || String(text).toLowerCase().includes(search);

    const installed = Object.entries(plugins).filter(([id, entry]) => matches(id) || matches(entry.label || ""));
    const installedList = sheet.querySelector('[data-ps-list="installed"]');
    installedList.replaceChildren();
    if (!installed.length) {
      installedList.append(element("p", "ps-empty", Object.keys(plugins).length
        ? "No plugin in this file matches that search."
        : "No plugins in this file. Install one from the catalog, or paste a url below."));
    } else {
      for (const [id, entry] of installed) installedList.append(installedRow(id, entry, manifest));
    }

    const available = Object.entries(catalog?.assets || {}).filter(([id, asset]) => !plugins[id] && (matches(id) || matches(asset.label || "")));
    const availableList = sheet.querySelector('[data-ps-list="available"]');
    availableList.replaceChildren();
    if (!available.length) {
      const why = catalogError
        ? `No catalog reachable (${catalogError}). Add a plugin by url below.`
        : catalog
          ? `Catalog: ${catalogFrom}. Nothing in it matches.`
          : "No catalog yet for this runtime — add a plugin by url below.";
      availableList.append(element("p", "ps-empty", why));
    } else {
      for (const [id, asset] of available) availableList.append(availableRow(id, asset));
    }

    const from = sheet.querySelector("[data-ps-from]");
    if (from) from.textContent = catalog ? `· ${catalogFrom}` : catalogFrom ? `· ${catalogFrom}` : "";

    const advanced = sheet.querySelector('[data-ps-form]');
    advanced.replaceChildren(formRow());

    const total = Object.keys(plugins).length;
    const used = Object.values(plugins).filter((entry) => usedBy(Object.keys(plugins).find((id) => plugins[id] === entry)) > 0).length;
    sheet.querySelector("[data-ps-sub]").textContent =
      `${total} installed · ${used} used · everything here is written into this file when you save`;
    sheet.querySelector("[data-ps-foot]").textContent = foot
      || "Installing pins url + sha384. Storage (inline or fetched) is set in Document settings.";
  }

  function buildSheet() {
    const dialog = element("dialog", "plugin-sheet");
    dialog.setAttribute("data-plugin-ui", "");
    dialog.innerHTML = `
      <div class="ps-head">
        <h2>Plugins</h2>
        <p class="ps-sub" data-ps-sub></p>
        <input class="ps-search" type="search" data-ps-search placeholder="Search plugins…" aria-label="Search plugins">
        <div class="ps-nav">
          <button class="ps-chip" data-ps-jump="installed" aria-pressed="true">In this file</button>
          <button class="ps-chip" data-ps-jump="available" aria-pressed="false">Available</button>
          <button class="ps-chip" data-ps-jump="advanced" aria-pressed="false">Add from URL</button>
        </div>
      </div>
      <div class="ps-body">
        <section class="ps-sect" data-ps-section="installed">
          <h3>In this file</h3>
          <p>A plugin's menus and panels are only there while it is loaded.</p>
          <div data-ps-list="installed"></div>
        </section>
        <section class="ps-sect" data-ps-section="available">
          <h3>Available <span class="ps-from" data-ps-from></span></h3>
          <p>From this runtime's catalog. Installing pins <code>url + sha384</code> into this file.</p>
          <div data-ps-list="available"></div>
        </section>
        <section class="ps-sect" data-ps-section="advanced">
          <h3>Add from URL</h3>
          <p>A hash is required: it is the only authority for what runs. The url must be absolute — a
            relative one works in one engine and fails in two.</p>
          <div data-ps-form></div>
        </section>
      </div>
      <div class="ps-foot">
        <span class="ps-hint" data-ps-foot></span>
        <button class="ps-btn ps-primary" data-ps-done>Done</button>
      </div>`;

    dialog.querySelector("[data-ps-search]").addEventListener("input", () => renderSheet());
    dialog.querySelector("[data-ps-done]").addEventListener("click", () => dialog.close());
    for (const chip of dialog.querySelectorAll("[data-ps-jump]")) {
      chip.addEventListener("click", () => {
        for (const other of dialog.querySelectorAll("[data-ps-jump]")) other.setAttribute("aria-pressed", String(other === chip));
        dialog.querySelector(`[data-ps-section="${chip.dataset.psJump}"]`).scrollIntoView({ block: "start", behavior: "smooth" });
      });
    }
    document.body.append(dialog);
    return dialog;
  }

  function openSheet() {
    if (!sheet) sheet = buildSheet();
    foot = "";
    renderSheet();
    if (!sheet.open) sheet.showModal();
    loadCatalog().then(() => renderSheet()).catch(() => renderSheet());
  }

  let catalogFrom = null;

  async function loadCatalog() {
    if (catalog || catalogError) return;
    const inline = catalogBlock();
    if (inline) {
      catalog = inline;
      catalogFrom = "this file";
      return;
    }
    try {
      const response = await fetch(catalogUrl(), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      catalog = await response.json();
      catalogFrom = catalogUrl();
    } catch (error) {
      /* Advisory only: the document embeds its own pins, so a missing catalog costs
         nothing but convenience — but say which url failed, or the next person has to
         guess whether the network, the tag, or the code is at fault. */
      catalogFrom = catalogUrl();
      catalogError = `${(error && error.message) || String(error)} at ${catalogUrl()}`;
    }
  }

  async function setEnabled(id, enabled) {
    const next = manifestJSON();
    const entry = next?.plugins?.[id];
    if (!entry) return;
    const count = usedBy(id);
    if (!enabled && count > 0) {
      say(`Refused — ${count} figure${count === 1 ? "" : "s"} still need ${entry.label || id}. Keep it, or turn those figures into static content first.`);
      return;
    }
    entry.enabled = Boolean(enabled);
    writeManifest(next);
    if (!enabled) await registry.deactivate(id);
    else {
      try {
        await registry.require(id);
      } catch {
        /* the row shows the reason; a failed plugin is not a failed sheet */
      }
    }
    say(enabled ? `${entry.label || id} loaded.` : `${entry.label || id} unloaded.`);
    renderSheet();
  }

  async function uninstall(id) {
    const next = manifestJSON();
    const entry = next?.plugins?.[id];
    if (!entry) return;
    const count = usedBy(id);
    if (count > 0) {
      say(`Refused — ${count} figure${count === 1 ? "" : "s"} still need ${entry.label || id}. Its pin must stay in this file.`);
      return;
    }
    await registry.deactivate(id);
    delete next.plugins[id];
    next.assets = (next.assets || []).filter((asset) => asset.plugin !== id);
    writeManifest(next);
    say(`${entry.label || id} removed from this file. Save to write that.`);
    renderSheet();
  }

  async function install(id, { label, url, integrity, bytes, factory = null, island = "sealed", version = null, contributes = null }) {
    const next = manifestJSON();
    if (!next) return say("this document has no asset manifest");
    if (next.plugins?.[id]) return say(`${label || id} is already in this file.`);
    /* Measured in lab/007: a relative url works in Firefox and fails in Chromium and
       WebKit, so it is refused rather than pinned. */
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url || "")) {
      return say("A plugin url must be absolute (https://…) — a relative one does not work from disk.");
    }
    next.plugins = next.plugins || {};
    next.plugins[id] = {
      label: label || id,
      version,
      island,
      enabled: true,
      entry: id,
      assets: [id],
      /* A catalog entry carries what the plugin offers, because an installed plugin that
         once contributed a menu must keep contributing it. A pasted url offers nothing:
         no declarations were published with it. */
      contributes: contributes && typeof contributes === "object" ? contributes : {},
    };
    next.assets = next.assets || [];
    next.assets.push({
      id,
      kind: "js",
      role: "module",
      order: 300 + next.assets.length,
      mode: "online",
      category: "plugin",
      plugin: id,
      requiredBy: ["*"],
      bytes: bytes || 0,
      url,
      integrity,
      ...(factory ? { factory } : {}),
    });
    writeManifest(next);
    try {
      await registry.require(id);
    } catch {
      /* shown on the row */
    }
    say(`${label || id} pinned. Save to write it into the file.`);
    renderSheet();
  }

  function installFrom(id, asset, latest) {
    if (!latest.url || !latest.sha384) return say(`${asset.label || id} has no pinned version in the catalog.`);
    install(id, {
      label: asset.label || id,
      url: latest.url,
      integrity: latest.sha384,
      bytes: latest.bytes,
      factory: latest.factory || null,
      island: asset.island || latest.island || "sealed",
      version: latest.version,
      /* Contributions may be per version (a plugin can start contributing something new),
         so the version wins over the asset. */
      contributes: latest.contributes || asset.contributes || null,
    });
  }

  /* ------------------------------------------------------------------- wiring */

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-plugins-open]")) {
      openSheet();
      return;
    }
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

  return { activateUi, wire, unwire, openPanel, openSheet, install };
}
