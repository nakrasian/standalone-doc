/* The container: the only global. Assets register their factory (inline) or are
   resolved from the CDN, and boot() builds them in manifest order — never
   document order. */
globalThis.StandaloneDoc = globalThis.StandaloneDoc || (function () {
  "use strict";

  const factories = Object.create(null);
  const modules = Object.create(null);
  /* In-flight lazy builds, so two figures asking for one plugin share a fetch. */
  const pending = new Map();
  /* The contract a plugin is written against. Bumped only when it breaks; a plugin
     declares the version it needs and the registry refuses a mismatch.
     2 (v0.11.0): `editor.insertInline()`, `pagination.defineBlock()`, `data-atomic`, and the
     rule that a plugin's `data-plugin-style` CSS travels in the file. A plugin that inserts
     inline content cannot work on a host without them, and must be refused before activate.
     3: an `insert` contribution may state its own geometry (`width`/`height`), declare the
     island profile `compute` (a pinned engine that compiles expressions), and declare
     `exports` — the formats its island can hand back to an export itself. A host without
     them would insert the figure at the wrong aspect, widen its island to `sandboxed`, and
     silently rasterize what the plugin can draw as vector. */
  const HOST_API = 3;
  /* Capabilities other modules offer to plugins. A module puts itself in this table
     when it is built, so a plugin can only use what this document really has: a
     viewer has no editor, and a file with the toolbar absent has no menus. */
  const providers = Object.create(null);
  /* Built plugins: their bundle, their scope, and their own deactivate(). */
  const live = Object.create(null);
  /* Bumped on unload, so a build that was in flight cannot resurrect what the
     author just switched off. */
  const generations = Object.create(null);
  const errors = [];
  const listeners = Object.create(null);
  const injected = [];
  const sources = Object.create(null);
  /* Decoded bytes per asset id: an inline bin block is decoded once, a fetched one is
     kept from the verification pass. */
  const binaries = Object.create(null);
  let state = "declared";
  let parsed = null;
  let settingsParsed = null;
  let settingsText = null;

  /* The shell gates the app on this attribute, so it must be set wherever state
     changes — never by the UI, which only observes. */
  function setState(next) {
    state = next;
    if (typeof document !== "undefined") document.documentElement.dataset.bootState = next;
  }

  /* The manifest is authoritative for order/deps/mode; a registration only
     supplies the factory, which is what makes the inline and CDN flavours the
     same code path. */
  function register(id, factory) {
    /* Idempotent by id: a hand-concatenated document may contain the same block
       twice. The first registration wins, so the module is built only once. */
    if (factories[id]) return;
    factories[id] = factory;
  }

  /* A plugin is a bundle of assets, not a file. `category` is what the save policy
     reads; `plugin` is the group an asset belongs to. Either one is enough to keep an
     asset out of boot, so a document written before both existed still behaves. */
  function isPlugin(asset) {
    return Boolean(asset && (asset.category === "plugin" || asset.plugin));
  }

  /** The `plugins` index: identity, label, its default island profile, assets. */
  function plugins() {
    return manifest().plugins || {};
  }

  function assetById(id) {
    return (manifest().assets || []).find((asset) => asset.id === id) || null;
  }

  /* The assets a plugin pins, in build order. A single-file plugin may name none:
     then its id is the asset id. */
  function pluginAssets(entry, id) {
    const ids = Array.isArray(entry?.assets) && entry.assets.length ? entry.assets : [id];
    return ids
      .map((assetId) => assetById(assetId))
      /* An `absent` declaration is "this left the file", so there is nothing to build
         and nothing to fetch: a plugin whose assets all left is unavailable, not
         damaged (invariant 28). */
      .filter((asset) => asset && asset.mode !== "absent")
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  /* The document's manifest is edited in place when a plugin is installed, so the parse
     cache has to be dropped deliberately. */
  function reloadManifest() {
    parsed = null;
    return manifest();
  }

  function manifest() {
    if (parsed) return parsed;
    const el = document.getElementById("asset-manifest");
    try {
      parsed = el ? JSON.parse(el.textContent) : { assets: [] };
    } catch (error) {
      parsed = { assets: [], parseError: String(error && error.message) };
    }
    return parsed;
  }

  /* Where a document saves when it is not a file on disk.
   *
   * Two facts, both checked here rather than at the save: which object, and which
   * endpoint. A block that cannot name both is treated exactly like no block at all —
   * a document that cannot say where it belongs is a file, and its Save button
   * downloads. That is this field's whole compatibility story: every document written
   * before it existed keeps behaving as one.
   */
  function cloudOf(value) {
    const id = value && typeof value.id === "string" ? value.id : "";
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) return null;
    /* Relative on purpose. The endpoint is a convention of the host the document is
       opened against; an absolute one would pin a document to an origin it may later be
       copied away from, which is the opposite of what the field is for. */
    const api = typeof value.api === "string" && /^\/[A-Za-z0-9._~/-]*$/.test(value.api) ? value.api : "/api/docs";
    /* The endpoint is relative, so it is only addressable from an http(s) origin. A copy
       re-opened from disk is a file whatever its block says — and that is not pedantry:
       without it, ⌘S on a downloaded document tries to PUT to `file:///api/docs/<id>`,
       fails, and leaves the document unsaveable, while the viewer dialog offers a
       "Copy to library" button that cannot work. */
    if (typeof location === "undefined" || !/^https?:$/.test(location.protocol)) return null;
    return {id, api: api.replace(/\/+$/, "")};
  }

  /* What the document permits to be done to it without asking again.
   *
   * `updates.inline` is consent to replace the *loader's bytes* in place — the one
   * operation that changes code this file runs, with no url to verify at boot. That is
   * why the answer lives in the document and nowhere else. Absent means `ask`, which is
   * what every file written before the field says and what the library assumes; an
   * unrecognised value is `ask` for the same reason a mistyped pin is not an upgrade.
   *
   * Read here; written by no path in this runtime. A save that could grant consent would
   * be a document consenting on its own behalf. The settings sheet writes it because a
   * person pressed Done, and that is the whole distinction.
   */
  function updatesOf(value) {
    const inline = value && typeof value === "object" ? value.inline : null;
    return {inline: inline === "allow" || inline === "never" ? inline : "ask"};
  }

  /* How this document behaves. Derived from #doc-settings; `manifest().mode` is
     read as a fallback for documents saved before the block existed (one release
     of compatibility, not a permanent second source of truth). */
  function settings() {
    const el = document.getElementById("doc-settings");
    const text = el ? el.textContent : "";
    /* Keyed on the block's text: the save path writes `thresholdDeclined` into it, and
       a cached parse would make the sticky choice invisible until the next open. */
    if (settingsParsed && text === settingsText) return settingsParsed;
    settingsText = text;
    let authored = null;
    try {
      authored = el ? JSON.parse(el.textContent) : null;
    } catch (error) {
      authored = { parseError: String(error && error.message) };
    }
    const mode = authored?.mode ?? manifest().mode ?? "edit";
    settingsParsed = {
      mode,
      ui: authored?.ui === "minimal" ? "minimal" : "ribbon",
      editable: mode === "edit" && (authored?.editable ?? true),
      /* "Show chrome", not "show the editor toolbar": a view-mode document can carry a
         bar of its own (doc-bar), and a file saved before that existed never authored
         this, so it keeps its chrome-less look. */
      toolbar: authored?.toolbar ?? mode !== "view",
      saveThresholdBytes: authored?.saveThresholdBytes ?? 2 * 1024 * 1024,
      /* Behaviour, so it lives in the settings block; the manifest's copy is the
         fallback for a document saved before the move. */
      timeoutMs: Number(authored?.timeoutMs ?? manifest().timeoutMs) || 8000,
      /* The save choice travels unnormalised: a preset name, or the explicit
         per-asset map that replaces it once anything is overridden. */
      policy: authored?.policy ?? null,
      assets: authored?.assets ?? null,
      thresholdDeclined: Number(authored?.thresholdDeclined) || 0,
      /* The author's name is document data: it is what a reviewer's reply is
         attributed against, and the editor's Document panel reads it back. Kept as a
         string (never `undefined`) so a template binding cannot print "undefined". */
      author: typeof authored?.author === "string" ? authored.author : "",
      /* `{comments: "off" | "read" | "write", edit: "copy" | "off"}`. Undeclared is
         `{}`, never a default: an empty object keeps `settingsFragment()` from writing
         a capability the document never had, and `allows()` from turning bytes on. */
      capabilities: authored?.capabilities && typeof authored.capabilities === "object" ? authored.capabilities : {},
      /* The library this document belongs to, or null for a file. Read live by the
         toolbar's save, so the settings sheet can write it and the next ⌘S obeys. */
      cloud: cloudOf(authored && authored.cloud),
      /* `{inline: "ask" | "allow" | "never"}` — normalised on read, so every consumer
         has one shape to switch on and an absent field is not a third case. */
      updates: updatesOf(authored && authored.updates),
    };
    return settingsParsed;
  }

  /* ------------------------------------------------------------ release catalog */

  /**
   * Where a document hears about a newer release. `cdnBase` is a tag, and a tag can only
   * describe itself, so the news lives at its moving sibling (`@main`); `catalog` in the
   * manifest overrides that. Reading it changes nothing — what it names is verified against
   * the hashes this document writes into itself, so a lying catalog costs an update, never
   * correctness.
   */
  function catalogUrl() {
    const doc = manifest();
    if (doc.catalog) return doc.catalog;
    const base = String(doc.cdnBase || "").replace(/\/$/, "");
    if (!/@[^/]+\/dist\/cdn$/.test(base)) return null; /* a dev base has no moving sibling */
    return base.replace(/@[^/]+/, "@main").replace(/\/cdn$/, "/runtime.json");
  }

  async function fetchJSON(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** The release index, or null. Never a document failure: nothing is recorded. */
  /** The tag this document pins, or null for a base that is not a tag (a dev build). */
  const tagOf = (base = manifest().cdnBase) => /@([^/]+)\//.exec(String(base || ""))?.[1] ?? null;

  /** `X.Y.Z`, with or without a leading `v`; anything unparseable sorts below a release. */
  function isNewer(a, b) {
    const parts = (tag) => String(tag || "").replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
    const left = parts(a);
    const right = parts(b);
    for (let i = 0; i < 3; i += 1) {
      if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) > (right[i] || 0);
    }
    return false;
  }

  /**
   * What an update would move, in one place.
   *
   * Two callers asked this question and answered it differently — the failure card (which
   * applies at once, because a boot that failed has no toolbar) and Document settings (which
   * drafts, because a pin is a document fact and nothing is decided before Done). They also
   * duplicated the plumbing: read the index, compare tags, fetch `runtime/<tag>.json`. The
   * policy is per-caller; the plumbing is not.
   */
  async function compareUpdate({ fetchEntry = false } = {}) {
    const current = tagOf();
    const index = await catalog();
    const latest = index?.latest ?? null;
    const newer = Boolean(current && latest && isNewer(latest, current));
    const entry = newer && fetchEntry ? await release(latest) : null;
    const date = (index?.releases || []).find((item) => item.tag === latest)?.date || null;
    /* `readable` is not `newer`: a catalog that could not be read and a release that is not
       newer are different news, and only one of them is worth alarming an author about. */
    return {current, latest, newer, entry, date, readable: index !== null};
  }

  async function catalog() {
    const url = catalogUrl();
    if (!url) return null;
    try {
      const data = await fetchJSON(url, 6000);
      return data && Array.isArray(data.releases) ? { ...data, url } : null;
    } catch {
      return null;
    }
  }

  /** One release's asset table, read from beside the index and shape-checked. */
  async function release(tag) {
    const dir = catalogUrl()?.replace(/[^/]*$/, "");
    if (!dir) throw failure("update", tag, "this document names no catalog to read");
    try {
      const data = await fetchJSON(`${dir}runtime/${tag}.json`, 8000);
      const usable = data && data.tag === tag && typeof data.base === "string"
        && Array.isArray(data.assets)
        && data.assets.every((a) => a && a.id && a.sha384 && a.url);
      if (!usable) throw new Error("not a release");
      return data;
    } catch (error) {
      throw failure("update", tag, `its release manifest could not be read (${error.message})`);
    }
  }

  /**
   * Move this document's pin onto a release; returns how to undo it. Only assets the
   * document *fetches* move: an inline asset's hash describes bytes the file already has,
   * and a pinned plugin's bytes are its author's. `mode` is the save policy's business, so
   * a re-pin never re-inlines or drops anything as a side effect.
   *
   * `left` is the other half of the answer, and it is not a failure list: three of its
   * reasons are facts about the file (infra is always inline; a plugin's bytes are its
   * author's; an inline hash describes bytes that are here), and one is news (this release
   * publishes nothing for an asset the document names). A caller that only reported
   * `moved` would let a person believe the loader came with the pin.
   */
  function repin(entry) {
    const el = document.getElementById("asset-manifest");
    if (!el) throw failure("update", entry.tag, "this document has no asset manifest to rewrite");
    const before = el.textContent;
    const doc = JSON.parse(before);
    const remote = new Map((entry.assets || []).map((asset) => [asset.id, asset]));
    const moved = [];
    const left = [];
    for (const mine of doc.assets) {
      /* The same four rules the library plans a batch with, in the file's own order. */
      if (mine.role === "infra") { left.push({id: mine.id, why: "infra"}); continue; }
      if (mine.plugin || mine.category === "plugin") { left.push({id: mine.id, why: "plugin"}); continue; }
      if (mine.mode !== "online") { left.push({id: mine.id, why: "inline"}); continue; }
      const source = remote.get(mine.id);
      if (!source) { left.push({id: mine.id, why: "unpublished"}); continue; }
      mine.url = source.url;
      mine.integrity = source.sha384;
      if (typeof source.bytes === "number") mine.bytes = source.bytes;
      moved.push(mine.id);
    }
    doc.cdnBase = entry.base;
    el.textContent = JSON.stringify(doc);
    reloadManifest();
    return {
      moved,
      left,
      tag: entry.tag,
      /* What the file permits, so a caller can say "the loader stays" and mean it. */
      updates: settings().updates,
      restore() {
        el.textContent = before;
        reloadManifest();
      },
    };
  }

  function on(event, fn) {
    (listeners[event] || (listeners[event] = [])).push(fn);
    return function off() {
      listeners[event] = (listeners[event] || []).filter((other) => other !== fn);
    };
  }

  function emit(event, detail) {
    for (const fn of (listeners[event] || []).slice()) {
      try {
        fn(detail);
      } catch (error) {
        /* A broken observer must not derail boot. */
        console.error(`boot observer for "${event}" failed:`, error);
      }
    }
  }

  function late(id) {
    return function () {
      const module = modules[id];
      if (!module) throw new Error(`"${id}" is not built yet (late edge used during construction, or the asset is disabled)`);
      return module;
    };
  }

  /* Unlike late(), this never throws: the asset may be absent for good — it is
     mode-gated (an editor module in a view-mode document) or disabled. The getter
     is read at call time, so a module built later is still visible. */
  function optional(id) {
    return function () {
      return modules[id];
    };
  }

  /**
   * What a reader can do about an issue.
   *
   * One record, one answer, rendered by every surface — the boot card, the Plugins sheet,
   * a figure's notice, the diagnostics text. `target` is filled in by whoever knows it (a
   * release index can name the runtime that would satisfy an `api` refusal; the loader
   * cannot), and `need` is what that target must provide. A `none` remedy is not a dead
   * end: it carries the reason, because "this file cannot fix it" is information.
   */
  function remedyFor(issue) {
    switch (issue.kind) {
      case "api":
        return { action: "update-runtime", need: issue.need ? `host API ${issue.need}` : "a newer runtime" };
      case "integrity":
        return issue.plugin
          ? { action: "refresh-catalog", why: "the catalog proposes the version; this file pins the bytes" }
          : { action: "update-runtime" };
      case "http":
        return issue.plugin
          ? { action: "refresh-catalog", why: "this copy's runtime may be older than the plugin" }
          : { action: "update-runtime" };
      case "offline":
      case "unreachable":
      case "timeout":
        return { action: "retry" };
      case "import":
      case "construct":
        return { action: "retry" };
      case "missing":
        return issue.plugin
          ? { action: "refresh-catalog", why: "this file carries no pinned copy" }
          : { action: "retry" };
      case "disabled":
        return { action: "none", why: "it is switched off in this file — turn it on in the Plugins panel" };
      case "unresolved":
        return { action: "refresh-catalog", why: "this file carries no pinned copy" };
      case "unavailable":
        return { action: "none", why: issue.message || "this document does not provide it" };
      case "forbidden":
        return { action: "none", why: "a plugin cannot read another plugin's bytes" };
      default:
        return { action: "none" };
    }
  }

  /* A one-line answer for the diagnostics text and any surface that shows issues as a list. */
  function remedyLine(remedy) {
    if (!remedy) return null;
    switch (remedy.action) {
      case "retry": return "retry — nothing in the file has changed";
      case "update-runtime": return `update this file's runtime${remedy.need ? ` to one that provides ${remedy.need}` : ""}, save, and reopen`;
      case "update-plugin": return `update ${remedy.target || "the plugin"} in the Plugins panel`;
      case "refresh-catalog": return `refresh the plugin catalog${remedy.why ? ` (${remedy.why})` : ""}`;
      case "reopen": return "save and reopen this file";
      case "open-editor-copy": return "open an editor copy of this document";
      case "none": return remedy.why ? `nothing this file can do — ${remedy.why}` : "nothing this file can do";
      default: return remedy.action;
    }
  }

  function failure(kind, id, message, extra) {
    const issue = Object.assign({ kind, id, message }, extra || {});
    if (!issue.remedy) issue.remedy = remedyFor(issue);
    return issue;
  }

  function fail(record) {
    setState("failed");
    errors.push(record);
    emit("failed", { error: record, errors: errors.slice() });
    return false;
  }

  /* The lazy counterpart of fail(): recorded and emitted, but the document stays
     readable. A missing plugin is a missing capability, not a missing file — the
     reader's content is already on screen and must stay there. */
  function record(record) {
    errors.push(record);
    emit("error", { error: record, errors: errors.slice() });
    return record;
  }

  /* ------------------------------------------------------------- host contract */

  /**
   * Offer a capability to plugins. Called by the module that can actually do the
   * work (figures, editor, toolbar), never by a plugin; the returned function
   * withdraws it, which retry() and unload rely on.
   */
  function provide(name, impl) {
    providers[name] = impl;
    return function withdraw() {
      if (providers[name] === impl) delete providers[name];
    };
  }

  function capability(name) {
    if (!providers[name]) {
      throw failure("unavailable", name, "is not provided by this document (no module offers it)");
    }
    return providers[name];
  }

  /* Everything the host hands a plugin is tracked here. A plugin's own deactivate()
     is advisory — nothing can prove it released anything — but this list is not: the
     host withdraws its own menus, styles, panels and listeners on unload regardless. */
  function makeScope() {
    const disposals = [];
    return {
      add(dispose) {
        if (typeof dispose === "function") disposals.push(dispose);
        return dispose;
      },
      dispose() {
        for (const dispose of disposals.splice(0).reverse()) {
          try {
            dispose();
          } catch (error) {
            console.warn("plugin cleanup failed:", error);
          }
        }
      },
    };
  }

  function bump(id) {
    generations[id] = (generations[id] || 0) + 1;
  }

  /** What "unbuilt" means: the modules, and any stylesheet the bundle injected. */
  function unbuild(assets) {
    const ids = new Set(assets.map((asset) => asset.id));
    for (const id of ids) delete modules[id];
    for (const node of [...injected]) {
      if (ids.has(node.dataset && node.dataset.asset)) {
        node.remove();
        injected.splice(injected.indexOf(node), 1);
      }
    }
  }

  /**
   * Text of one of a plugin's own assets.
   *
   * Bytes that arrived by reference are the verified ones. Bytes the file carries are
   * read back out of their block, so "content inline, runtime online" needs no second
   * copy — the content is what the document already has.
   */
  async function assetText(assetId) {
    const asset = assetById(assetId);
    if (!asset) throw failure("missing", assetId, "is not in the manifest");
    if (asset.mode !== "inline") return source(assetId);
    if (asset.kind === "css") {
      const el = document.querySelector(`style[id="${assetId}"]`);
      return el ? el.textContent : "";
    }
    if (asset.kind === "html") {
      const el = inlineElement(assetId);
      return el ? el.innerHTML : "";
    }
    const el = document.querySelector(`script[id="${assetId}"]`);
    /* A block carries the build's provenance comment and its register() line. Neither is
       part of what the plugin *is*, and the by-reference path returns the published body
       without them, so strip them here and the two paths agree. */
    return el ? stripEnvelope(el.textContent) : "";
  }

  function stripEnvelope(text) {
    return String(text || "")
      .replace(/^\s*\/\*@compiled-from[^\n]*\n/, "")
      .replace(/\n?\s*StandaloneDoc\.register\([^\n]*\);\s*$/, "")
      .replace(/^\s*\n/, "")
      .replace(/\s+$/, "");
  }

  /* The element of a block carried by the file, found through its marker: a
     fragment's element does not carry the asset id itself. */
  function inlineElement(assetId) {
    if (typeof document === "undefined") return null;
    const walker = document.createTreeWalker(document.body, 128 /* SHOW_COMMENT */);
    const wanted = new RegExp(`id="${assetId}"`);
    let node;
    while ((node = walker.nextNode())) {
      if (!/^\s*@asset\b/.test(node.nodeValue || "") || !wanted.test(node.nodeValue || "")) continue;
      let sibling = node.nextSibling;
      while (sibling && sibling.nodeType !== 1 /* ELEMENT_NODE */) sibling = sibling.nextSibling;
      return sibling;
    }
    return null;
  }

  /* The host object a plugin's activate() receives. Deliberately small: everything
     here is either data the document already owns or a capability that was actually
     built, so a plugin cannot reach past this document's own configuration. */
  function makeHost(id, entry, assets, scope) {
    const own = new Set(assets.map((asset) => asset.id));
    return {
      api: HOST_API,
      plugin: {
        id,
        label: entry.label || id,
        version: entry.version || null,
        /* The island a contribution's *content* mounts into. Not the plugin's own
           reach: plugin code always runs in this document, like the editor does. */
        island: entry.island || "sealed",
      },
      /** Text of one of its *own* assets; another plugin's bytes are not readable. */
      async text(assetId) {
        if (!own.has(assetId)) throw failure("forbidden", assetId, `is not part of plugin "${id}"`);
        const asset = assetById(assetId);
        if (asset && asset.kind === "bin") {
          throw failure("missing", assetId, "is binary — use host.bytes() for it");
        }
        return assetText(assetId);
      },
      /** Bytes of one of its own assets (wasm, or any other binary it pinned). */
      async bytes(assetId) {
        if (!own.has(assetId)) throw failure("forbidden", assetId, `is not part of plugin "${id}"`);
        return bytesOf(assetId);
      },
      /** A capability this document built (figures, editor, toolbar), or a refusal. */
      use: (name) => capability(name),
      /** Whether it is there at all — the question a plugin should ask first, because
          `use()` on an absent capability fails the plugin, not the feature. */
      can: (name) => Boolean(providers[name]),
      /** Host-owned cleanup: withdraws things even if the plugin never does. */
      track: (dispose) => scope.add(dispose),
      on: (event, fn) => scope.add(on(event, fn)),
      /* A copy: a plugin reading settings is fine, editing the live snapshot is not. */
      settings: () => ({ ...settings() }),
      manifest: () => manifest(),
    };
  }

  /* A document declares the mode it was saved for (edit | view | comment), and an
     asset declares the modes that need it. "*" means all of them, so a view-mode
     document never even fetches the editor. */
  function inMode(asset, mode) {
    const requiredBy = asset.requiredBy || ["*"];
    return requiredBy.includes("*") || requiredBy.includes(mode);
  }

  /* The runtime twin of `policy.allows()` and of the build's filter: a capability the
     document does not declare is `absent`, so `boot()` skips it rather than failing on
     a block it was never supposed to fetch (invariant 28). */
  function allows(asset, capabilities) {
    if (!asset.capability) return true;
    const value = (capabilities || {})[asset.capability];
    return Boolean(value) && value !== "off";
  }

  /* Infra is the root of trust; everything else may be authored soft. */
  function isCritical(asset) {
    return asset.role === "infra" || asset.critical !== false;
  }

  /* Only constructed modules: infrastructure is already running, and a plugin is
     built by require(), not by boot. */
  function planned() {
    const {mode, capabilities} = settings();
    return manifest()
      .assets.filter((asset) => inMode(asset, mode) && allows(asset, capabilities) && !isPlugin(asset))
      .sort((a, b) => a.order - b.order);
  }

  function order() {
    return planned()
      .filter((asset) => asset.kind === "js" && asset.role !== "infra")
      .map((asset) => asset.id);
  }

  /**
   * A paste-ready report of this document's runtime state.
   *
   * Data, not prose: the boot dialog and the About panel both show it, and neither owns it.
   * `order` is what a boot attempt asked for — the modules, not every asset — because that
   * is what a reader can compare against the rows they saw.
   */
  function diagnostics({ order: modulesOrder = null } = {}) {
    const lines = [
      "standalone-doc boot",
      `state:    ${state}`,
      `document: ${location.href}`,
      `modules:  ${(modulesOrder || Object.keys(modules)).join(", ") || "—"}`,
      "",
    ];
    for (const error of errors) {
      lines.push(`[${error.kind || error.phase}] ${error.id}: ${error.message}`);
      if (error.url) lines.push(`url: ${error.url}`);
      if (error.expected) lines.push(`expected ${error.expected}`, `actual   ${error.actual}`);
      if (error.stack) lines.push(error.stack);
      if (error.remedy) lines.push(`next:     ${remedyLine(error.remedy)}`);
      lines.push("");
    }
    lines.push(`user agent: ${navigator.userAgent}`);
    return lines.join("\n");
  }

  async function sha384(buffer) {
    const digest = await crypto.subtle.digest("SHA-384", buffer);
    let binary = "";
    for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
    return "sha384-" + btoa(binary);
  }

  /* Bytes from the CDN, verified, not yet evaluated. Split out from fetchAsset so
     the save path can embed exactly what it verified (Phase 4): "verified before
     it runs" and "verified before it is written into a file" are the same rule. */
  async function fetchVerified(asset) {
    if (asset.mode !== "online") {
      throw failure("missing", asset.id, `not loaded, and its mode is "${asset.mode}"`);
    }
    if (!asset.url) throw failure("missing", asset.id, "has no url in the manifest");
    const timeoutMs = settings().timeoutMs || 8000;

    /* Our own timer, not AbortSignal.timeout: engines disagree about the error
       name they produce, and we need to know *we* aborted, not the network. */
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(asset.url, { signal: controller.signal, cache: "force-cache" });
    } catch (error) {
      const timedOut = controller.signal.aborted;
      /* navigator.onLine only *labels* the failure; it never decides anything. */
      const kind = timedOut ? "timeout" : navigator.onLine === false ? "offline" : "unreachable";
      const message = timedOut ? `no response within ${timeoutMs} ms` : (error && error.message) || "fetch failed";
      throw failure(kind, asset.id, message, { url: asset.url, plugin: isPlugin(asset) });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw failure("http", asset.id, `HTTP ${response.status}`, { url: asset.url, status: response.status, plugin: isPlugin(asset) });
    }

    const bytes = await response.arrayBuffer();
    const actual = await sha384(bytes);
    if (asset.integrity && actual !== asset.integrity) {
      throw failure("integrity", asset.id, "hash does not match the manifest", {
        url: asset.url,
        expected: asset.integrity,
        actual,
        plugin: isPlugin(asset),
      });
    }

    /* Both: a module is evaluated from text, a binary asset is handed over as bytes, and
       the hash is over the bytes either way. */
    return { text: new TextDecoder().decode(bytes), bytes };
  }

  /* Evaluate verified bytes. Side effects stay here, never in the fetch, so the
     load phase can run in parallel without reordering anything. */
  async function evaluate(asset, fetched) {
    const text = typeof fetched === "string" ? fetched : fetched.text;
    if (asset.kind === "css") return { css: text };
    if (asset.kind === "html") return { html: text };
    /* A binary asset is bytes handed to whoever asked. It is never evaluated here: the
       runtime that instantiates it belongs to the plugin, not to the loader. */
    if (asset.kind === "bin") return { binary: fetched.bytes || new ArrayBuffer(0) };
    const blob = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
    let namespace;
    try {
      namespace = await import(blob);
    } catch (error) {
      throw failure("import", asset.id, error && error.message ? error.message : "module failed to evaluate", { url: asset.url, plugin: isPlugin(asset) });
    }
    /* An asset with no `factory` is a plain ES module — the namespace *is* the
       module. That is how a third-party library (an npm package pinned as a plugin)
       differs from one of ours, without a wrapper. */
    if (!asset.factory) return { namespace };
    const factory = namespace[asset.factory];
    if (typeof factory !== "function") {
      throw failure("import", asset.id, `module does not export ${asset.factory}`, { url: asset.url });
    }
    return { factory };
  }

  async function fetchAsset(asset) {
    if (factories[asset.id]) return { factory: factories[asset.id] };
    if (asset.mode !== "online") {
      throw failure("missing", asset.id, `not loaded, and its mode is "${asset.mode}"`, { plugin: isPlugin(asset) });
    }
    const fetched = await fetchVerified(asset);
    return evaluate(asset, fetched);
  }

  /**
   * Decoded bytes for one asset: the binary sibling of `source(id)`.
   *
   * Inline bytes are base64 in the document (the only text-safe way to carry them);
   * by-reference bytes come from the same verified fetch that a module would. Cached,
   * because a wasm module of any size must not be transferred twice.
   */
  async function bytesOf(id) {
    if (binaries[id] instanceof ArrayBuffer) return binaries[id];
    const asset = assetById(id);
    if (!asset) throw failure("missing", id, "is not in the manifest");
    let bytes;
    if (asset.mode === "inline") {
      const el = document.querySelector(`script[id="${id}"]`);
      if (!el) throw failure("missing", id, "is inline but its block is not in this document");
      const base64 = (el.textContent || "").replace(/\s+/g, "");
      const binary = atob(base64);
      const view = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
      bytes = view.buffer;
    } else {
      const fetched = await fetchVerified(asset);
      bytes = fetched.bytes;
    }
    binaries[id] = bytes;
    return bytes;
  }

  /**
   * Fetch a url and hash it, with nothing to verify against.
   *
   * This is *pinning*, not loading: the author decided the url is the right one, and the
   * hash makes it immutable from then on. `fetchVerified` is the other direction — it
   * refuses bytes that do not match a pin the document already has.
   */
  async function prefetch(url) {
    if (!url) throw failure("missing", url || "(none)", "no url to fetch");
    const timeoutMs = settings().timeoutMs || 8000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, { signal: controller.signal, mode: "cors", cache: "no-store" });
    } catch (error) {
      const timedOut = controller.signal.aborted;
      const kind = timedOut ? "timeout" : navigator.onLine === false ? "offline" : "unreachable";
      throw failure(kind, url, timedOut ? `no response within ${timeoutMs} ms` : (error && error.message) || "fetch failed");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw failure("http", url, `HTTP ${response.status}`, { url, status: response.status });
    const bytes = await response.arrayBuffer();
    return { bytes, text: new TextDecoder().decode(bytes), integrity: await sha384(bytes), size: bytes.byteLength };
  }

  /* Verified CDN text for an asset, which is what a saved document embeds when a
     policy decides to inline an asset that was loaded by reference. Cached: the
     bytes at a pinned url + hash cannot change. An inline asset does not need
     this — its text is already the block in the document. */
  async function source(id) {
    if (sources[id] != null) return sources[id];
    const asset = manifest().assets.find((candidate) => candidate.id === id);
    if (!asset) throw failure("missing", id, "is not in the manifest");
    if (asset.mode === "inline") {
      throw failure("missing", id, "is inline, so its text is the block in this document, not a CDN file");
    }
    const fetched = await fetchVerified(asset);
    sources[id] = fetched.text;
    binaries[id] = fetched.bytes;
    return fetched.text;
  }

  /**
   * Put a fetched fragment where its manifest entry says. Chrome goes in front of
   * `#viewport` because the body is a flex column and its position is the layout;
   * a plugin fragment can name its own host with `append:<selector>`.
   */
  function insertFragment(asset, markup) {
    const instruction = asset.insert || "before:#viewport";
    const split = instruction.indexOf(":");
    const place = split < 0 ? "before" : instruction.slice(0, split);
    const selector = split < 0 ? instruction : instruction.slice(split + 1);
    const anchor = document.querySelector(selector);

    /* A fragment is published as its *body*, so the element has to be rebuilt from
       the open tag the manifest carries. That is what keeps a fetched fragment
       identical to the inline one. */
    const open = asset.open || "<div>";
    const tag = (/^<([a-zA-Z][\w-]*)/.exec(open) || [null, "div"])[1];
    const template = document.createElement("template");
    template.innerHTML = `${open}${markup}</${tag}>`;
    const nodes = template.content;
    /* Tag the roots: a fetched fragment is session state, and the save path has to be
       able to tell it from a block that belongs to the file. */
    for (const node of nodes.children) node.setAttribute("data-asset", asset.id);
    if (place === "append" && anchor) anchor.append(nodes);
    else if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(nodes, anchor);
    else document.body.append(nodes);
  }

  /* A stylesheet that arrived by reference. Injected in manifest order so the
     cascade is the same in both flavours. */
  function injectStyle(asset, css) {
    const style = document.createElement("style");
    style.textContent = css;
    style.dataset.asset = asset.id;
    document.head.append(style);
    injected.push(style);
  }

  /**
   * Build exactly one asset.
   *
   * Throws a failure record rather than failing the document: boot() decides that a
   * throw means this file cannot start, while require() decides that only the plugin
   * cannot. The steps are the same either way — a lazy plugin and a boot-time asset
   * must not be able to drift apart.
   */
  async function constructOne(asset, { loaded, index = 0, total = 1, lazy = false } = {}) {
    if (asset.mode === "absent") {
      throw failure("unavailable", asset.id, "is not carried by this document");
    }
    /* Fragments and stylesheets are not modules: an inline one is already in the
       document (that is the point of shipping markup), a fetched one is inserted
       here, before anything that reads it. */
    if (asset.kind === "html") {
      const fetched = loaded?.get(asset.id);
      if (fetched?.html != null) insertFragment(asset, fetched.html);
      return "skipped";
    }
    if (asset.kind === "css") {
      const result = loaded?.get(asset.id);
      if (result?.css != null) injectStyle(asset, result.css);
      return "skipped";
    }
    if (asset.kind === "bin") {
      /* Nothing to construct: decode (inline) or keep (fetched), then hand it over. */
      await bytesOf(asset.id);
      return "skipped";
    }
    if (asset.role === "infra" && asset.kind === "js") return "skipped"; /* already running */

    emit("construct", { id: asset.id, state: "active", index, total, lazy });

    const deps = { env: globalThis, settings: settings(), late, optional };
    for (const name of asset.deps || []) {
      if (!(name in modules)) {
        throw failure("construct", asset.id, `requires "${name}", which is not built`, { plugin: isPlugin(asset) });
      }
      deps[name] = modules[name];
    }

    const result = loaded?.get(asset.id);
    const factory = factories[asset.id] || result?.factory;
    if (!factory && !result?.namespace) {
      throw failure(
        "missing",
        asset.id,
        asset.mode === "inline"
          ? "not loaded (its block is missing from this document)"
          : "not loaded from the CDN",
        { plugin: isPlugin(asset) },
      );
    }

    try {
      const built = factory ? factory(deps) : result.namespace;
      /* A factory may be async — a plugin that has to await its own template or wasm
         is. Boot's factories are sync, so this only costs a typeof per asset. */
      modules[asset.id] = built && typeof built.then === "function" ? await built : built;
    } catch (error) {
      throw failure("construct", asset.id, error && error.message ? error.message : String(error), {
        stack: error && error.stack ? String(error.stack) : null,
        plugin: isPlugin(asset),
      });
    }

    /* No global is published: the manifest's dependency list is the only way one
       module reaches another, and boot injects it. */
    emit("construct", { id: asset.id, state: "ok", index, total, lazy });
    return "built";
  }

  async function boot() {
    if (state !== "declared") return modules;
    setState("booting");
    errors.length = 0;
    pending.clear();

    /* Plugins are never built here. A document must open when a plugin is missing,
       damaged or switched off, and keeping them out of this list is what keeps boot's
       fail-closed contract about *this document's own* assets. */
    const assets = planned();
    const jsAssets = assets.filter((asset) => asset.kind === "js" && asset.role !== "infra");
    const online = assets.filter((asset) => asset.mode === "online");
    emit("start", {
      order: jsAssets.map((asset) => asset.id),
      assets: assets.map((asset) => asset.id),
      total: jsAssets.length,
      fetched: online.length,
    });

    /* 1. Load in parallel: I/O is order-free. */
    const loaded = new Map();
    const skipped = new Set(); /* assets whose failure the document can survive */
    const outcomes = await Promise.allSettled(
      online.map(async (asset) => {
        loaded.set(asset.id, await fetchAsset(asset));
      }),
    );
    for (const [i, outcome] of outcomes.entries()) {
      if (outcome.status !== "rejected") continue;
      const asset = online[i];
      /* `critical: false` is authored in the manifest, never inferred: a builder can say a
         module is a feature, but only the document can say its absence is survivable. */
      if (isCritical(asset)) return fail(outcome.reason);
      record(outcome.reason);
      skipped.add(asset.id);
      emit("construct", { id: asset.id, state: "skipped", index: 0, total: jsAssets.length, error: outcome.reason });
    }

    /* 2. Construct in order: side effects are order-bound. */
    let index = 0;
    for (const asset of assets) {
      const isModule = asset.kind === "js" && asset.role !== "infra";
      if (skipped.has(asset.id)) {
        if (isModule) index++;
        continue;
      }
      /* A fragment is DOM this module reads. Constructing against a missing one is how a
         soft failure becomes a thrown exception somewhere else; skip the consumer and name
         the fragment instead. */
      const missing = (asset.fragments || []).find((id) => skipped.has(id));
      if (missing) {
        const issue = failure("unavailable", asset.id, `needs "${missing}", which did not load`, {
          plugin: isPlugin(asset),
        });
        if (isCritical(asset)) return fail(issue);
        record(issue);
        skipped.add(asset.id);
        emit("construct", { id: asset.id, state: "skipped", index: isModule ? index : 0, total: jsAssets.length, error: issue });
        if (isModule) index++;
        continue;
      }
      try {
        await constructOne(asset, { loaded, index: isModule ? index : 0, total: jsAssets.length });
      } catch (error) {
        if (isCritical(asset)) return fail(error);
        record(error);
        skipped.add(asset.id);
        emit("construct", { id: asset.id, state: "skipped", index: isModule ? index : 0, total: jsAssets.length, error });
      }
      if (isModule) index++;
    }

    setState("ready");
    emit("ready", { count: Object.keys(modules).length, skipped: [...skipped], errors: errors.slice() });
    return modules;
  }

  /**
   * Load and build one plugin, on demand.
   *
   * The document carries the pin (`url` + `integrity` in its own manifest), so this
   * is a verified fetch and a construct — never a lookup by name and never a
   * resolution against a catalog. Concurrent callers share one build; a build plugin
   * returns immediately.
   *
   * A failure is recorded, emitted as "error" and re-thrown to the caller, but the
   * document stays as it was. `unresolved` means this file has no pinned copy;
   * `disabled` means its author switched it off here.
   */
  function requirePlugin(id) {
    if (modules[id]) return Promise.resolve(modules[id]);
    if (pending.has(id)) return pending.get(id);
    const generation = generations[id] || 0;
    const promise = buildPlugin(id, generation)
      .catch((error) => {
        /* One place emits the failure, whatever the reason: the figure that asked
           shows it, and the sheet shows it on the row. */
        emit("plugin", { id, state: "failed", error });
        throw error;
      })
      .finally(() => pending.delete(id));
    /* The caller renders the failure (a figure shows it); this only stops an
       unhandled rejection when the first caller is not listening. */
    promise.catch(() => {});
    pending.set(id, promise);
    return promise;
  }

  async function buildPlugin(id, generation) {
    const entry = plugins()[id];
    if (!entry) throw record(failure("unresolved", id, "this document needs it but has no pinned copy of it", { plugin: true }));
    if (entry.enabled === false) throw record(failure("disabled", id, "is turned off in this document", { plugin: true }));

    const assets = pluginAssets(entry, id);
    if (!assets.length) throw record(failure("missing", id, "has no assets in this document's manifest", { plugin: true }));

    /* Same two phases as boot, for one bundle. Inline assets are already in the
       document and need no fetch. A `bin` is the exception, and it is the whole point of
       the kind: a wasm runtime is fetched by `bytesOf()` when the plugin asks for it, not
       because the plugin was loaded. Without this, exporting Markdown would download a
       typst compiler the target never uses. */
    const online = assets.filter((asset) => asset.mode === "online"
      && asset.kind !== "bin" && !factories[asset.id]);
    const loaded = new Map();
    const outcomes = await Promise.allSettled(
      online.map(async (asset) => {
        loaded.set(asset.id, await fetchAsset(asset));
      }),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") throw record(outcome.reason);
    }

    /* Unloaded while the bytes were in flight: do not construct and do not activate.
       The same check runs again after activate(), for an unload that lands during it. */
    if ((generations[id] || 0) !== generation) {
      throw record(failure("stale", id, "was unloaded while it was loading", { plugin: true }));
    }

    for (const [position, asset] of assets.entries()) {
      /* A binary is never constructed here either: `bytesOf()` is its only fetch, and
         `host.bytes()` its only reader (invariant 13). */
      if (asset.kind === "bin") continue;
      try {
        await constructOne(asset, { loaded, index: position, total: assets.length, lazy: true });
      } catch (error) {
        throw record(error);
      }
    }

    /* The entry asset is what the plugin *is*; everything else it pinned is there to
       support it. Fall back to the last built asset rather than guessing by name. */
    const main = modules[entry.entry] || modules[assets[assets.length - 1].id] || null;

    const api = Number(entry.api ?? HOST_API) || HOST_API;
    if (api > HOST_API) {
      unbuild(assets);
      throw record(failure("api", id,
        `needs a newer editor: host API ${api}, this one provides ${HOST_API}`
        + ` — update this document's runtime (Document settings → Runtime), then reopen`,
        { plugin: true, need: api }));
    }

    /* Two-phase, like boot: bytes, then side effects. activate() is where a plugin
       wires its contributions, and it is allowed to be async. */
    const scope = makeScope();
    let deactivate = null;
    let activation = null;
    if (main && typeof main.activate === "function") {
      try {
        activation = await main.activate(makeHost(id, entry, assets, scope));
        if (activation && typeof activation.deactivate === "function") deactivate = () => activation.deactivate();
      } catch (error) {
        scope.dispose();
        unbuild(assets);
        throw record(
          failure("construct", id, `activate() failed: ${error && error.message ? error.message : String(error)}`, {
            stack: error && error.stack ? String(error.stack) : null,
          }),
        );
      }
    }

    /* Unloaded while it was loading: nothing may survive this build. */
    if ((generations[id] || 0) !== generation) {
      scope.dispose();
      unbuild(assets);
      throw record(failure("stale", id, "was unloaded while it was loading", { plugin: true }));
    }

    /* `activation` is kept because the implementations live on it: `insert`, `export`
       and the rest. The registry does not interpret them; the host modules do. */
    live[id] = { id, entry, assets, api, scope, deactivate, activation };
    emit("plugin", { id, label: entry.label || id, state: "ready" });
    return main;
  }

  /**
   * Unload a plugin.
   *
   * Best effort by design: `deactivate()` is a promise the plugin makes and nothing
   * can verify it, so the host withdraws what it handed out (the scope) and removes
   * the built modules either way. Figures already mounted keep running until the
   * file is reopened — that is the honest limit of an unload in a live document.
   */
  async function deactivatePlugin(id) {
    const rec = live[id];
    bump(id); /* first, so a build in flight cannot undo this */
    delete live[id];
    if (!rec) return false;
    try {
      if (rec.deactivate) await rec.deactivate();
    } catch (error) {
      record(
        failure("construct", id, `deactivate() failed: ${error && error.message ? error.message : String(error)}`),
      );
    }
    rec.scope.dispose();
    unbuild(rec.assets);
    emit("plugin", { id, label: rec.entry.label || id, state: "deactivated" });
    return true;
  }

  /**
   * Build another mode into this copy, on request.
   *
   * Not a save: the received file is never written, and the result is a *new* file with
   * no library (`cloud` is the export's business). The copy carries the other mode's
   * *declarations* — `mode: "online"` with `url` + `integrity`, a few kilobytes of JSON
   * and no code — and this is where the code is fetched, verified and built (invariant
   * 34's other half: a sealed copy, whose addresses were deleted, fails here).
   *
   * The upgrade is a document change: `mode` and `capabilities.edit = "off"` land in
   * `#doc-settings`, so the file is dirty before the first keystroke, and a copy of the
   * copy is not an editor (no recursion).
   */
  async function adopt(mode) {
    if (!["edit", "view", "comment"].includes(mode)) {
      throw failure("unavailable", mode, "is not a mode this document can adopt");
    }
    if (state !== "ready") throw failure("construct", mode, "can only adopt from a ready document");
    /* What actually needs work: a module that is not built, or a fetched stylesheet or
       fragment. An inline stylesheet/fragment is already applied — it was parsed with the
       document — so it is not a job for this loop and must not be mistaken for one. */
    const required = manifest().assets
      .filter((asset) => asset.role !== "infra" && !isPlugin(asset) && asset.kind !== "bin")
      .filter((asset) => inMode(asset, mode) && allows(asset, settings().capabilities));
    const wanted = required
      .filter((asset) => (asset.kind === "js" ? !(asset.id in modules) : asset.mode === "online"))
      .sort((a, b) => a.order - b.order);

    /* An `inline` declaration with no block is the one thing this cannot fix: the bytes
       are neither here nor addressable. Say that, rather than booting half an editor. */
    const stranded = wanted.find((asset) => asset.mode !== "online");
    if (stranded) {
      throw failure(
        "missing",
        stranded.id,
        `${stranded.id}: is declared "${stranded.mode}" but this copy does not carry it — only a copy with an editable address can adopt "${mode}"`,
      );
    }

    setState("booting");
    emit("start", {
      order: wanted.filter((asset) => asset.kind === "js").map((asset) => asset.id),
      assets: wanted.map((asset) => asset.id),
      total: wanted.filter((asset) => asset.kind === "js").length,
      fetched: wanted.length,
      /* The rows are the *adopted* plan, not the current mode's: the dialog would
         otherwise list what this copy already runs. */
      plan: wanted,
    });

    const loaded = new Map();
    try {
      await Promise.all(wanted.map(async (asset) => {
        loaded.set(asset.id, await fetchAsset(asset));
      }));
    } catch (error) {
      setState("ready");
      emit("ready", {count: Object.keys(modules).length});
      throw error;
    }

    let index = 0;
    try {
      for (const asset of wanted) {
        const isModule = asset.kind === "js" && asset.role !== "infra";
        await constructOne(asset, {loaded, index: isModule ? index : 0, total: wanted.length});
        if (isModule) index += 1;
      }
    } catch (error) {
      /* Fail closed for the mode, open for the document: what was built is withdrawn,
         and the copy the reader already had stays readable. */
      unbuild(wanted);
      setState("ready");
      emit("ready", {count: Object.keys(modules).length});
      throw error;
    }

    const block = document.getElementById("doc-settings");
    if (block) {
      try {
        const stored = JSON.parse(block.textContent || "{}");
        stored.mode = mode;
        stored.editable = mode === "edit";
        stored.capabilities = {...(stored.capabilities || {}), edit: "off"};
        block.textContent = JSON.stringify(stored);
      } catch {
        /* A corrupt block: the caller's mode change already happened in memory, and
           the next save is the place to fix the file. */
      }
    }
    modules["apply-settings"]?.apply?.();
    modules.pagination?.schedule?.();
    modules.status?.markDirty?.();
    setState("ready");
    emit("ready", {count: Object.keys(modules).length});
    return {mode, adopted: wanted.map((asset) => asset.id)};
  }

  /* Tear the graph down and build it again. Registered factories survive, so a
     failure that was environmental can be retried without reloading the file. */
  async function retry() {
    if (state === "booting") return modules;
    for (const id of Object.keys(live)) await deactivatePlugin(id);
    for (const id of Object.keys(modules)) delete modules[id];
    for (const node of injected.splice(0)) node.remove();
    for (const id of Object.keys(sources)) delete sources[id];
    for (const id of Object.keys(binaries)) delete binaries[id];
    for (const name of Object.keys(providers)) delete providers[name];
    pending.clear();
    errors.length = 0;
    setState("declared");
    return boot();
  }

  return {
    register,
    on,
    /* A module raises an event a plugin can hear with `host.on()`. Only the host's own
       modules call this (the editor's `restore`, today); it is not a general-purpose bus and
       a plugin cannot emit. */
    emit,
    late,
    settings,
    optional,
    source,
    bytes: bytesOf,
    prefetch,
    reloadManifest,
    require: requirePlugin,
    deactivate: deactivatePlugin,
    /** What a plugin's activate() returned, or null when it is not built. */
    instance: (id) => live[id]?.activation || null,
    provide,
    /** A capability this document built, or a `kind: "unavailable"` refusal. Host modules
     *  use the same accessor a plugin's `host.use()` does, so absence is one rule. */
    use: capability,
    /** Whether this document built a named capability. */
    can: (name) => Boolean(providers[name]),
    hostApi: HOST_API,
    plugins,
    boot,
    adopt,
    retry,
    order,
    planned,
    diagnostics,
    manifest,
    catalogUrl,
    catalog,
    compareUpdate,
    tagOf,
    isNewer,
    release,
    repin,
    modules,
    factories,
    errors,
    get state() {
      return state;
    },
  };
})();
