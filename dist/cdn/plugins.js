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

  /* Contribution kinds that render into chrome. A plugin offering one of these has to be
     built at boot, or its menu would stay empty until something else loaded it. There is
     no "toolbar" kind: the formatting row is a fixed set of document commands, and a kind
     that forced a boot build to render nothing was a trap (HANDOFF 6d).
     `inline` sits in the Insert menu beside `insert` and differs in exactly one way: `insert`
     adds a *block* (a figure, through the store), `inline` inserts at the caret inside a
     paragraph and owns no store. A citation is the case that made the difference visible —
     it belongs where the author is typing, not in a modal. */
  const UI_KINDS = ["insert", "inline", "export", "panel", "command"];

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
      /* Insertions, both kinds, in the Insert menu: one adds a block, the other lands in the
         text at the caret. Two attributes on purpose — the click handler must be able to tell
         them apart without asking the manifest. */
      { selector: "[data-plugin-inserts]", kind: "insert", attribute: "pluginInsert" },
      { selector: "[data-plugin-inserts]", kind: "inline", attribute: "pluginInline" },
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
        /* What the content may ask the host for at run time (__figureBytes). Declared by the
           contribution, stored on the figure. */
        assets: content.assets || declared.assets || null,
      });
    } catch (error) {
      refuse(id, `insert "${itemId}" failed: ${(error && error.message) || error}`);
    }
  }

  /**
   * Run an `inline` contribution: the plugin inserts at the caret, through the editor.
   *
   * The host calls and the plugin acts, which is the same division as `insert()` but for the
   * other end of the document. What the host does *not* do is insert: an inline insertion is
   * caret arithmetic (`editor.insertInline`), and a host that guessed where the caret was
   * would be a second opinion about the selection.
   */
  async function runInline(id, itemId) {
    const instance = registry.instance(id);
    const handler = instance && instance.inline && instance.inline[itemId];
    const entry = pluginEntries()[id];
    if (!entry || !handler) return refuse(id, `does not implement inline "${itemId}"`);
    try {
      /* The menu is closed before the handler runs, so a picker it opens is not competing
         with an open panel for the pointer and the focus. */
      document.querySelectorAll("[data-menu-panel]:not([hidden])").forEach((menu) => {menu.hidden = true;});
      await handler({contribution: contribution(entry, "inline", itemId) || {}, pin: pinFor(id, entry)});
    } catch (error) {
      refuse(id, `inline "${itemId}" failed: ${(error && error.message) || error}`);
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
      /* Text for a text format; bytes for what a writer actually emits. A .docx is a zip;
         as a string it would be a lie, and as base64 the host's problem rather than the
         format's. */
      if (!file || (file.text == null && file.bytes == null)) {
        return refuse(id, `export "${itemId}" returned neither text nor bytes`);
      }
      download(file);
    } catch (error) {
      /* The useful half of a failed fetch is *which* fetch: a registry failure carries its
         url, and a plugin's own error does not — so the address is appended when there is
         one and the sentence stays a sentence when there isn't. "HTTP 403" alone names
         neither the file nor the host, which is a click with no next step in it. */
      const where = error && error.url ? ` — ${error.url}` : "";
      refuse(id, `export "${itemId}" failed: ${(error && error.message) || error}${where}`);
    }
  }

  function download({name = "export.txt", mime, text, bytes, extras = []}) {
    /* A binary result has no honest default type, so the plugin must say. */
    const type = mime || (bytes == null ? "text/plain" : "application/octet-stream");
    save(new Blob([bytes == null ? text : bytes], { type }), name);
    /* A text target names its figures, so they travel beside it — one file per figure, spaced
       so a browser that asks "allow multiple downloads?" is asked once, not five times. */
    extras.forEach((extra, index) => setTimeout(() => {
      const extraType = extra.mime || type;
      save(new Blob([extra.bytes == null ? extra.text : extra.bytes], {type: extraType}), extra.name);
    }, 250 * (index + 1)));
  }

  function save(blob, name) {
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
    /* A console line is not an answer to a click. The host owns this dialog — the plugin
       never draws chrome — and it is session state (`data-plugin-ui`), so a save drops it. */
    announce(message);
    return false;
  }

  function announce(message) {
    let dialog = document.getElementById("plugin-refusal");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "plugin-refusal";
      dialog.setAttribute("data-plugin-ui", "");
      dialog.innerHTML = `<form method="dialog">
        <h2>That export is not possible yet</h2>
        <p data-refusal-message></p>
        <div class="dialog-actions">
          <button class="primary" value="close" autofocus>Close</button>
        </div>
      </form>`;
      document.body.append(dialog);
    }
    dialog.querySelector("[data-refusal-message]").textContent = message;
    if (!dialog.open) dialog.showModal();
  }


  /* ------------------------------------------------------------------- the panel */
  /*
   * The author-facing half: what is in this file, what could be, and how to add one from
   * a url. Storage (inline vs fetched) is *not* here — that decision lives in the Storage
   * panel, and a second control for it would be the third copy of the same rows.
   *
   * A *panel*, not a dialog: `toolbar.js` owns the document dialog and its tabs, and hands
   * this module an empty element on first activation (order 95 > 90, so it is asked for
   * through the optional edge, read at that moment and never at construction — the audit
   * parses source text, and a call written in a comment is an edge to itself). Built in JS
   * on purpose — it is session state, tagged `data-plugin-ui`, and the save path drops it
   * like any other runtime node.
   */

  let panel = null;
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

  /* The plugin index, which is not the runtime catalog: a plugin version must be
     discoverable after its own release, without waiting for a runtime tag. `manifest.json`
     authors the address and the build carries it into the document; a document written
     before the field existed keeps the old tag-sibling path. */
  const catalogUrl = () => {
    const doc = registry.manifest();
    if (doc.pluginIndex) return doc.pluginIndex;
    return String(doc.cdnBase || "").replace(/\/$/, "").replace(/\/cdn$/, "") + "/registry.json";
  };

  /* A document may carry its own catalog in a `#plugin-catalog` block. That is what makes
     the sheet useful from disk: a `file://` page cannot fetch a relative url (lab/007), and
     the published tag is not where a lab document looks. Absent, it is fetched from the
     runtime's cdnBase — advisory either way. */
  function catalogBlock() {
    const el = document.getElementById("plugin-catalog");
    if (!el) return null;
    try {
      const parsed = JSON.parse(el.textContent);
      /* Parseable is not the same as useful: `{}` in the block would win over the network and
         show an empty list, which reads exactly like "nothing is published". Fall through
         unless there is at least one table to show. */
      if (!parsed || (parsed.schema !== 1 && !parsed.assets && !parsed.bundles)) return null;
      if (!parsed.assets && !parsed.bundles) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** The tag this document pins, or null for a base that is not a tag (a dev build). */
  const pinnedTag = () => /@([^/]+)\//.exec(registry.manifest().cdnBase || "")?.[1] ?? null;

  /**
   * A snapshot is stale when it points at an index other than the one this file reads.
   *
   * It used to be `tag !== pinnedTag`, because a bundle's manifest was relative to the
   * runtime tag. Now the index names absolute manifest urls, so the runtime tag is no longer
   * what makes the snapshot true — the *index* is. A document written before `pluginIndex`
   * keeps the older rule, so the notice still appears where it used to.
   */
  const catalogStale = () => {
    if (catalog?.index) return catalog.index !== catalogUrl();
    return Boolean(catalog?.tag && pinnedTag() && catalog.tag !== pinnedTag());
  };

  /**
   * Re-read the catalog from the tag this document pins and rewrite the snapshot.
   *
   * A snapshot is true for one index revision. The index it names is the authority, so a
   * refresh re-reads that address and records the new revision; a document that pinned a
   * runtime tag no longer has to reopen before it can see a plugin published afterwards.
   */
  async function refreshCatalog() {
    const url = catalogUrl();
    const tag = pinnedTag();
    say(`Reading ${url}…`);
    let next = null;
    try {
      const fetched = await registry.prefetch(url);
      next = JSON.parse(fetched.text);
    } catch (error) {
      return say(`${url} could not be read (${(error && error.message) || error}). Nothing was changed.`);
    }
    if (!next || typeof next !== "object" || !(next.assets || next.bundles)) {
      return say(`${url} is not a plugin catalog. Nothing was changed.`);
    }
    const el = document.getElementById("plugin-catalog");
    if (!el) return say("This file has no #plugin-catalog block to refresh — add one by building with `pluginCatalog`.");
    el.textContent = JSON.stringify({
      schema: 1,
      generated: next.generated,
      revision: next.revision || null,
      index: url,
      /* `tag` stays for documents and surfaces written before the index existed: it is
         still true (the runtime this snapshot was built into), it is just no longer the
         thing that decides whether the snapshot is current. */
      tag,
      assets: next.assets || {},
      bundles: next.bundles || {},
    });
    catalog = JSON.parse(el.textContent);
    catalogFrom = "this file";
    catalogError = null;
    status.markDirty();
    renderSheet();
    say(`Catalog refreshed from ${url} (${next.revision ? `${next.revision.slice(0, 16)}…` : tag || "untagged"}). Save to keep it.`);
  }

  const say = (text) => {
    foot = text;
    if (panel) panel.querySelector("[data-ps-foot]").textContent = text;
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

  /* Bytes under a kilobyte are common in a catalog (a 477-byte module) and "0 KB" is a lie
     the eye reads as empty. One formatter, because a bundle's total and an asset's size are
     the same claim at two scales. */
  const sizeLabel = (bytes) => {
    if (!bytes) return "";
    if (bytes < 2048) return `${bytes} bytes`;
    /* A bundle is measured in MB (an 87 MB engine reads as "85154 KB" otherwise), and a
       formatter that stops at KB is a formatter that lies about the unit. */
    return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

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

    /* An upgrade belongs to the plugin, so it lives on the plugin's row: the catalog data is
       per-entry, the trust decision is per-plugin, and a runtime bump must not change a
       plugin behind the author's back. */
    const found = updateState(id);
    let update = null;
    if (found && found.state === "blocked") {
      /* The plugin is newer than this file's runtime. The action belongs to the runtime, and
         naming the release is the difference between a dead button and a route. */
      update = element("button", "ps-btn", found.minRuntime ? `Update runtime to ${found.minRuntime}` : "Needs a newer runtime");
      update.disabled = !found.minRuntime;
      update.title = found.minRuntime
        ? `Needs host API ${found.need}; ${found.minRuntime} is the first release that provides it.`
        : `No published runtime provides host API ${found.need} yet.`;
      if (found.minRuntime) update.addEventListener("click", () => requestRuntimeUpdate(id, found));
    } else if (found && found.state !== "same") {
      update = element("button", "ps-btn ps-primary");
      update.dataset.update = id;
      update.textContent = found.state === "tampered" ? "Bytes differ" : `Update to ${found.candidate.version}`;
      update.addEventListener("click", () => upgrade(id));
      if (found.state === "tampered") {
        update.classList.remove("ps-primary");
        update.title = "The catalog serves different bytes under the version this file pins.";
      }
    }

    main.append(name, version, island, used, element("span", "ps-grow"), ...(update ? [update] : []), toggle, remove);
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
      element("span", "ps-used", sizeLabel(latest.bytes)),
      element("span", "ps-grow"),
    );
    const blocked = runtimeNeeded({ entry: latest, asset });
    const install = element("button", "ps-btn ps-primary", "Install");
    install.dataset.install = id;
    if (blocked) {
      install.disabled = true;
      install.textContent = blocked.minRuntime ? `Update runtime to ${blocked.minRuntime}` : "Needs newer runtime";
      install.title = `Needs host API ${blocked.need}; this file provides ${registry.hostApi}.`;
    } else {
      install.addEventListener("click", () => installFrom(id, asset, latest));
    }
    main.append(install);
    row.append(main);
    if (asset.description) row.append(element("p", "ps-hint", asset.description));
    if (blocked) row.append(element("p", "ps-hint", runtimeSentence(blocked)));
    return row;
  }

  /*
   * A bundle is not an asset: the catalog names a manifest, and the manifest names its own
   * assets. So the row can only say what the projection carries — size, asset count, island —
   * and the manifest's own sha384 is why that projection is worth reading at all.
   */
  function bundleRow(id, asset) {
    const row = element("div", "ps-row");
    row.dataset.id = id;
    row.dataset.state = "available";
    const main = element("div", "ps-main");
    const island = element("span", "ps-badge", asset.island || "sealed");
    island.dataset.island = asset.island || "sealed";
    const count = Number(asset.assets) || 0;
    const size = asset.assetBytes ? ` · ${sizeLabel(asset.assetBytes)}` : "";
    main.append(
      element("span", "ps-name", asset.label || id),
      element("span", "ps-version", asset.version ? `v${asset.version}` : ""),
      island,
      element("span", "ps-used", `${count} asset${count === 1 ? "" : "s"}${size}`),
      element("span", "ps-grow"),
    );
    const blocked = runtimeNeeded({ entry: asset, asset });
    const install = element("button", "ps-btn ps-primary", "Install");
    install.dataset.install = id;
    install.dataset.installBundle = id;
    if (blocked) {
      install.disabled = true;
      install.textContent = blocked.minRuntime ? `Update runtime to ${blocked.minRuntime}` : "Needs newer runtime";
      install.title = `Needs host API ${blocked.need}; this file provides ${registry.hostApi}.`;
    } else {
      install.addEventListener("click", () => installBundle(id, asset));
    }
    main.append(install);
    row.append(main);
    if (asset.about) row.append(element("p", "ps-hint", asset.about));
    if (blocked) row.append(element("p", "ps-hint", runtimeSentence(blocked)));
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
    if (!panel) return;
    const sheet = panel;
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
    /* Bundles are listed beside single modules and install the same way; the difference is
       that one row writes N assets. A bundle whose id is already installed is not offered,
       which is the whole update story today: remove, then add. */
    const bundles = Object.entries(catalog?.bundles || {}).filter(([id, asset]) => !plugins[id]
      && (matches(id) || matches(asset.label || "") || matches(asset.about || "")));
    const availableList = sheet.querySelector('[data-ps-list="available"]');
    availableList.replaceChildren();
    if (!available.length && !bundles.length) {
      const why = catalogError
        ? `No catalog reachable (${catalogError}). Add a plugin by url below.`
        : catalog
          ? `Catalog: ${catalogFrom}. Nothing in it matches.`
          : "No catalog yet for this runtime — add a plugin by url below.";
      availableList.append(element("p", "ps-empty", why));
    } else {
      for (const [id, asset] of bundles) availableList.append(bundleRow(id, asset));
      for (const [id, asset] of available) availableList.append(availableRow(id, asset));
    }

    const from = sheet.querySelector("[data-ps-from]");
    const mark = catalog?.index
      ? catalog.revision ? ` @${String(catalog.revision).slice(0, 12)}…` : ""
      : catalog?.tag ? ` @${catalog.tag}` : "";
    if (from) from.textContent = catalog ? `· ${catalogFrom}${mark}` : catalogFrom ? `· ${catalogFrom}` : "";

    /* A stale snapshot is not an error, it is a fact with an action: the bundles it names are
       pinned to another tag, so they would fail their manifest hash check. Refreshing is one
       request, and only offered when there is a block to write. */
    const stale = sheet.querySelector("[data-ps-stale]");
    if (stale) {
      const isStale = catalogStale();
      stale.hidden = !isStale;
      if (isStale) {
        stale.textContent = catalog.index
          ? `This snapshot reads ${catalog.index}${catalog.revision ? ` (${String(catalog.revision).slice(0, 16)}…)` : ""}; this file now reads ${catalogUrl()}. `
          : `This catalog snapshot was taken at ${catalog.tag}; this file pins ${pinnedTag()}. `;
        if (document.getElementById("plugin-catalog")) {
          const refresh = element("button", "ps-btn", "Refresh catalog");
          refresh.addEventListener("click", () => refreshCatalog());
          stale.append(refresh);
        } else {
          stale.append(document.createTextNode("Only a document that carries its catalog can refresh it."));
        }
      }
    }

    const advanced = sheet.querySelector('[data-ps-form]');
    advanced.replaceChildren(formRow());

    const total = Object.keys(plugins).length;
    const used = Object.values(plugins).filter((entry) => usedBy(Object.keys(plugins).find((id) => plugins[id] === entry)) > 0).length;
    sheet.querySelector("[data-ps-sub]").textContent =
      `${total} installed · ${used} used · everything here is written into this file when you save`;
    sheet.querySelector("[data-ps-foot]").textContent = foot
      || "Installing pins url + sha384. Storage (inline or fetched) is set in Document settings.";
  }

  function buildPanel(container) {
    container.replaceChildren();
    const dialog = element("div", "ps-root");
    dialog.setAttribute("data-plugin-ui", "");
    dialog.innerHTML = `
      <div class="ps-head">
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
          <p class="ps-hint ps-stale" data-ps-stale hidden></p>
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
      </div>`;

    dialog.querySelector("[data-ps-search]").addEventListener("input", () => renderSheet());
    for (const chip of dialog.querySelectorAll("[data-ps-jump]")) {
      chip.addEventListener("click", () => {
        for (const other of dialog.querySelectorAll("[data-ps-jump]")) other.setAttribute("aria-pressed", String(other === chip));
        dialog.querySelector(`[data-ps-section="${chip.dataset.psJump}"]`).scrollIntoView({ block: "start", behavior: "smooth" });
      });
    }
    container.append(dialog);
    return dialog;
  }

  /**
   * Fill the document dialog's Plugins panel. Called on first activation (and on every
   * later activation), because reading the catalog is a network call an author may never
   * want — the panel is mounted by the tab, not by boot.
   */
  function renderPanel(container) {
    if (!container) return null;
    if (!panel || panel.parentElement !== container) panel = buildPanel(container);
    foot = "";
    renderSheet();
    return loadCatalog()
      .then(() => { renderSheet(); return updateCount(); })
      .catch(() => { renderSheet(); return 0; });
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

  /* A plugin's *content* may run unsandboxed (island: "trusted"), which is a real
     capability: lab/005 measured that such content can read `parent.document`. The author
     confirms it when they add the plugin or turn it back on — and nothing separate is
     stored, because the plugin entry in the file *is* the record of that decision. */
  function confirmTrusted({ label, verb, detail }) {
    return new Promise((resolve) => {
      const dialog = element("dialog", "plugin-trust");
      dialog.setAttribute("data-plugin-ui", "");
      dialog.innerHTML = `
        <div class="pt-head">
          <h2 data-pt-title></h2>
          <p>Declared by the plugin, at the version you are pinning.</p>
        </div>
        <div class="pt-body">
          <p class="pt-what" data-pt-what></p>
          <p class="pt-hint" data-pt-hint></p>
        </div>
        <div class="pt-foot">
          <span class="pt-hint" data-pt-prepared></span>
          <button data-pt-cancel>Cancel</button>
          <button class="pt-go" data-pt-ok></button>
        </div>`;
      dialog.querySelector("[data-pt-title]").textContent = `${label} needs unsandboxed content`;
      dialog.querySelector("[data-pt-what]").textContent = detail
        || "This plugin's content runs with allow-same-origin: it can read and modify this document, "
        + "including what gets saved. A sandboxed island cannot.";
      dialog.querySelector("[data-pt-hint]").textContent =
        "Being in this file is the record of your consent — reopening will not ask again. "
        + "A new version that widens its access to this level asks again.";
      dialog.querySelector("[data-pt-prepared]").textContent = `${verb} “${label}”`;
      dialog.querySelector("[data-pt-ok]").textContent = `${verb} with unsandboxed content`;

      const finish = (ok) => {
        dialog.close();
        dialog.remove();
        resolve(ok);
      };
      dialog.querySelector("[data-pt-cancel]").addEventListener("click", () => finish(false));
      dialog.querySelector("[data-pt-ok]").addEventListener("click", () => finish(true));
      dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); });
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  /** Does taking this action expose unsandboxed content anywhere in the bundle? */
  function wantsTrust(island, contributes) {
    if (island === "trusted") return true;
    return Object.values(contributes || {}).some(
      (items) => Array.isArray(items) && items.some((item) => item && item.island === "trusted"),
    );
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
    if (enabled && wantsTrust(entry.island, entry.contributes)) {
      const ok = await confirmTrusted({ label: entry.label || id, verb: "Turn on" });
      if (!ok) {
        say(`${entry.label || id} stays off.`);
        renderSheet();
        return;
      }
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

  /**
   * What a catalog row needs from the host, when this file cannot provide it.
   *
   * `minRuntime` is computed by the index from the releases' own `hostApi`, so the answer is
   * a specific tag rather than "some newer version". A plugin and a runtime are versioned
   * independently; this is the one place the two numbers meet.
   */
  function runtimeNeeded(candidate) {
    const wanted = Number(candidate?.entry?.api ?? candidate?.asset?.api ?? 1) || 1;
    if (wanted <= registry.hostApi) return null;
    return { need: wanted, minRuntime: candidate.entry?.minRuntime || candidate.asset?.minRuntime || null };
  }

  function runtimeSentence(found) {
    if (!found.minRuntime) {
      return `Needs host API ${found.need}; this file provides ${registry.hostApi}, and no published runtime provides ${found.need} yet.`;
    }
    return `Needs host API ${found.need}; this file provides ${registry.hostApi}. Update this file's runtime to ${found.minRuntime} or later, save, and reopen.`;
  }

  /** Open the place where the runtime moves; a viewer has no such place, so it says so. */
  function requestRuntimeUpdate(id, found) {
    const label = (manifestJSON()?.plugins?.[id] || {}).label || id;
    const settings = registry.can?.("settings") ? registry.use("settings") : null;
    if (settings && typeof settings.open === "function") {
      settings.open({ tab: "runtime" });
      say(`${label} ${runtimeSentence(found)}`);
      return;
    }
    say(`${label} ${runtimeSentence(found)} Document settings → Runtime is the place, in a copy that can edit.`);
  }

  /** The catalog's proposal for one id, in the shape either installer takes. */
  function catalogCandidate(id) {
    const bundle = catalog?.bundles?.[id];
    if (bundle) {
      /* Newer indexes carry every published version; an older one is a single row. The
         newest is first, and it is the only one an install or an update considers. */
      const versions = Array.isArray(bundle.versions) && bundle.versions.length ? bundle.versions : [bundle];
      const latest = versions[0];
      return {kind: "bundle", version: latest.version || null, sha384: latest.sha384 || null, entry: latest, asset: bundle, versions};
    }
    const asset = catalog?.assets?.[id];
    const latest = (asset?.versions || [])[0];
    if (latest) return {kind: "asset", version: latest.version || null, sha384: latest.sha384 || null, entry: latest, asset};
    return null;
  }

  /**
   * What the catalog says about a plugin this file already pins.
   *
   * `tampered` is deliberately not `newer`: the same version carrying different bytes is a
   * different plugin wearing the same name, and offering it as an "update" would launder the
   * substitution. Only a single-module pin can be compared without fetching, because its
   * `integrity` is in this file; a bundle's identity is its manifest hash, which the catalog
   * names and the document does not repeat.
   */
  function updateState(id) {
    const record = (manifestJSON()?.plugins || {})[id];
    if (!record) return null;
    const candidate = catalogCandidate(id);
    if (!candidate || !candidate.version) return null;
    /* A plugin this runtime cannot host has one remedy, and no version comparison changes
       it: the file's runtime moves, or the plugin stays unbuilt. */
    const blocked = runtimeNeeded(candidate);
    if (blocked) return {candidate, state: "blocked", ...blocked};
    const pinned = record.version || null;
    if (!pinned) return {candidate, state: "newer"};
    if (candidate.version === pinned) {
      const assetId = record.entry || id;
      const asset = (manifestJSON().assets || []).find((entry) => entry.id === assetId);
      if (candidate.kind === "asset" && asset && candidate.sha384 && asset.integrity && asset.integrity !== candidate.sha384) {
        return {candidate, state: "tampered"};
      }
      return {candidate, state: "same"};
    }
    return {candidate, state: registry.isNewer(candidate.version, pinned) ? "newer" : "same"};
  }

  /** How many installed plugins have a newer version in the catalog (the tab badge). */
  const updateCount = () => Object.keys(manifestJSON()?.plugins || {})
    .filter((id) => updateState(id)?.state === "newer").length;

  /**
   * Move one plugin to the catalog's version.
   *
   * The pin is the install, so this is an install that is allowed to overwrite: the entry is
   * rewritten, the assets it no longer names are dropped, and `enabled` survives (an author
   * who switched a plugin off did not ask for it back on by accepting an update).
   */
  async function upgrade(id) {
    const found = updateState(id);
    if (!found) return say(`The catalog has no version of ${id}.`);
    if (found.state === "blocked") return requestRuntimeUpdate(id, found);
    if (found.state === "tampered") {
      return say(`${id} ${found.candidate.version} is pinned to different bytes than the catalog serves — `
        + "that is not an update, and nothing was changed.");
    }
    if (found.state !== "newer") return say(`${id} is already on ${found.candidate.version}.`);
    const keep = (manifestJSON()?.plugins || {})[id] || {};
    if (found.candidate.kind === "bundle") {
      await installBundle(id, found.candidate.entry, {replace: true, keep});
    } else {
      await installFrom(id, found.candidate.asset || {label: keep.label}, found.candidate.entry, {replace: true, keep});
    }
  }

  async function install(id, { label, url, integrity, bytes, factory = null, island = "sealed", version = null, contributes = null, api = 1 }, { replace = false, keep = null } = {}) {
    const next = manifestJSON();
    if (!next) return say("this document has no asset manifest");
    if (next.plugins?.[id] && !replace) return say(`${label || id} is already in this file.`);
    const wanted = Number(api) || 1;
    if (wanted > registry.hostApi) {
      return say(`${label || id} needs host API ${wanted}; this document provides ${registry.hostApi}. Nothing was added.`);
    }
    if (wantsTrust(island, contributes)) {
      const ok = await confirmTrusted({ label: label || id, verb: "Add" });
      if (!ok) return say(`${label || id} was not added.`);
    }
    /* Measured in lab/007: a relative url works in Firefox and fails in Chromium and
       WebKit, so it is refused rather than pinned. */
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url || "")) {
      return say("A plugin url must be absolute (https://…) — a relative one does not work from disk.");
    }
    next.plugins = next.plugins || {};
    next.plugins[id] = {
      label: label || id,
      version,
      /* What the plugin was written against. Absent means 1, and the registry refuses a
         newer one before activate() — so it has to travel with the pin, not just sit in the
         catalog. */
      api: wanted,
      island,
      enabled: keep ? keep.enabled !== false : true,
      entry: id,
      assets: [id],
      /* A catalog entry carries what the plugin offers, because an installed plugin that
         once contributed a menu must keep contributing it. A pasted url offers nothing:
         no declarations were published with it. */
      contributes: contributes && typeof contributes === "object" ? contributes : {},
    };
    next.assets = (next.assets || []).filter((asset) => asset.id !== id);
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

  function installFrom(id, asset, latest, options = {}) {
    if (!latest.url || !latest.sha384) return say(`${asset.label || id} has no pinned version in the catalog.`);
    const blocked = runtimeNeeded({ entry: latest, asset });
    if (blocked) return say(`${asset.label || id} ${runtimeSentence(blocked)} Nothing was added.`);
    install(id, {
      label: asset.label || id,
      url: latest.url,
      integrity: latest.sha384,
      bytes: latest.bytes,
      factory: latest.factory || null,
      island: asset.island || latest.island || "sealed",
      version: latest.version,
      api: latest.api ?? asset.api ?? 1,
      /* Contributions may be per version (a plugin can start contributing something new),
         so the version wins over the asset. */
      contributes: latest.contributes || asset.contributes || null,
    }, options);
  }

  /* The catalog's directory. A relative manifest is only published by the legacy
     `registry.json` index (the new index names absolute urls), so this is `<cdnBase>/../`
     for it; taking the directory rather than stripping a known filename keeps both shapes
     correct and cannot silently resolve a manifest one directory too deep. */
  const catalogBase = () => catalogUrl().replace(/[^/]*$/, "");

  /**
   * Everything about a manifest that would make this install fail, checked in the order a
   * network can lie. The host trusts its own build gate, not a stranger's JSON.
   */
  function bundleFaults(bundle, id) {
    if (!bundle || typeof bundle !== "object") return "it is not an object";
    if (bundle.schema !== 1) return `its schema is ${bundle.schema}, expected 1`;
    if (bundle.id !== id) return `it is "${bundle.id}", not "${id}"`;
    if (!Array.isArray(bundle.assets) || !bundle.assets.length) return "it declares no assets";
    /* Absolute, not https-only: `install()` allows either for a locally served plugin, and a
       document that can pin a pasted http url can pin one a manifest names. The build gate is
       where a *published* manifest is held to https. */
    const bad = bundle.assets.find((asset) => !asset || !asset.id
      || !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(String(asset.url || ""))
      || !/^sha384-[A-Za-z0-9+/]{64}$/.test(String(asset.integrity || "")));
    if (bad) return `asset "${(bad && bad.id) || "?"}" has no absolute url + sha384`;
    if (bundle.entry && !bundle.assets.some((asset) => asset.id === bundle.entry)) {
      return `its entry "${bundle.entry}" is not one of its assets`;
    }
    return null;
  }

  /**
   * Install a bundle: one catalog row, N pinned assets.
   *
   * Two claims hold before anything is written — the manifest is the one the catalog hashed,
   * and the pins inside it are well-formed. The assets themselves are *not* fetched: 55 MB of
   * engines is a first-export cost, and the loader verifies each one when it is used.
   */
  async function installBundle(id, asset, { replace = false, keep = null } = {}) {
    const next = manifestJSON();
    if (!next) return say("this document has no asset manifest");
    if (next.plugins?.[id] && !replace) return say(`${asset.label || id} is already in this file.`);
    if (!asset.manifest) return say(`${asset.label || id} has no manifest to read.`);

    let url;
    try {
      /* Absolute when the plugin rides its own tag (the index names the manifest there);
         relative only for a plugin still published at the runtime tag. `new URL` ignores
         the base for an absolute manifest, so both shapes work without a branch. */
      url = new URL(asset.manifest, asset.base || catalogBase()).toString();
    } catch {
      return say(`${asset.manifest} is not a url this document can resolve.`);
    }
    let fetched;
    try {
      fetched = await registry.prefetch(url);
    } catch (error) {
      const reason = (error && error.message) || error;
      /* The common way to land here is a document whose runtime is older than the plugin: the
         catalog it reads is its own tag's, so a 404 on the manifest means "update first". */
      const hint = /\b404\b/.test(String(reason)) && pinnedTag()
        ? ` This document pins ${pinnedTag()}, and a plugin published after that tag is not in it.`
        : "";
      return say(`${url} could not be read (${reason}) — nothing was added.${hint}`);
    }
    /* The catalog's hash is the only thing standing between a tampered manifest and a
       document that pins whatever it says. */
    if (asset.sha384 && fetched.integrity !== asset.sha384) {
      return say(`${url} is not the manifest the catalog pins — nothing was added.`);
    }
    let bundle;
    try {
      bundle = JSON.parse(fetched.text);
    } catch {
      return say(`${url} is not JSON — nothing was added.`);
    }
    const fault = bundleFaults(bundle, id);
    if (fault) return say(`${url} is not installable: ${fault}. Nothing was added.`);
    const api = Number(bundle.api ?? asset.api ?? 1) || 1;
    if (api > registry.hostApi) {
      /* A refusal that does not say what to do reads like a broken plugin. The remedy is one
         panel away, and it is the *document's* runtime that moves, not this session's. The
         index names the first release that provides the API, which is the part a reader
         cannot work out alone. */
      return say(`${bundle.label || id} ${runtimeSentence({ need: api, minRuntime: asset.minRuntime || null })} Nothing was added.`);
    }
    const island = bundle.island || asset.island || "sealed";
    if (wantsTrust(island, bundle.contributes)) {
      const ok = await confirmTrusted({ label: bundle.label || asset.label || id, verb: "Add" });
      if (!ok) return say(`${bundle.label || id} was not added.`);
    }
    const assets = bundle.assets;
    const clash = assets.find((incoming) => (next.assets || []).some(
      (existing) => existing.id === incoming.id && existing.url !== incoming.url));
    if (clash) return say(`"${clash.id}" is already pinned to a different url in this file — nothing was added.`);

    next.plugins = next.plugins || {};
    next.plugins[id] = {
      label: bundle.label || asset.label || id,
      version: bundle.version || asset.version || null,
      api,
      island,
      enabled: keep ? keep.enabled !== false : true,
      entry: bundle.entry || id,
      assets: assets.map((incoming) => incoming.id),
      contributes: bundle.contributes && typeof bundle.contributes === "object" ? bundle.contributes : {},
    };
    const incoming = new Set(assets.map((candidate) => candidate.id));
    next.assets = (next.assets || []).filter((existing) => !incoming.has(existing.id));
    for (const candidate of assets) {
      const { id: assetId, ...rest } = candidate;
      next.assets.push({ id: assetId, mode: "online", requiredBy: ["*"], category: "plugin", plugin: id, ...rest });
    }
    writeManifest(next);
    try {
      await registry.require(id);
    } catch {
      /* shown on the row */
    }
    say(`${bundle.label || id} ${replace ? "updated" : "pinned"} — ${assets.length} asset${assets.length === 1 ? "" : "s"}. Save to write it into the file.`);
    renderSheet();
  }

  /* ------------------------------------------------------------------- wiring */

  document.addEventListener("click", (event) => {
    const inlineButton = event.target.closest("[data-plugin-inline]");
    if (inlineButton) {
      const [id, itemId] = inlineButton.dataset.pluginInline.split(":");
      runInline(id, itemId);
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

  return { activateUi, wire, unwire, openPanel, renderPanel, updateCount, install };
}
