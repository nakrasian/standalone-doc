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
     declares the version it needs and the registry refuses a mismatch. */
  const HOST_API = 1;
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
      .filter(Boolean)
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
      toolbar: mode !== "view" && (authored?.toolbar ?? true),
      saveThresholdBytes: authored?.saveThresholdBytes ?? 2 * 1024 * 1024,
      /* Behaviour, so it lives in the settings block; the manifest's copy is the
         fallback for a document saved before the move. */
      timeoutMs: Number(authored?.timeoutMs ?? manifest().timeoutMs) || 8000,
      /* The save choice travels unnormalised: a preset name, or the explicit
         per-asset map that replaces it once anything is overridden. */
      policy: authored?.policy ?? null,
      assets: authored?.assets ?? null,
      thresholdDeclined: Number(authored?.thresholdDeclined) || 0,
    };
    return settingsParsed;
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

  function failure(kind, id, message, extra) {
    return Object.assign({ kind, id, message }, extra || {});
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
    return el ? el.textContent : "";
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
        return assetText(assetId);
      },
      /** A capability this document built (figures, editor, toolbar), or a refusal. */
      use: (name) => capability(name),
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

  /* Only constructed modules: infrastructure is already running, and a plugin is
     built by require(), not by boot. */
  function order() {
    const mode = settings().mode;
    return manifest()
      .assets.filter((asset) => asset.kind === "js" && asset.role !== "infra" && inMode(asset, mode) && !isPlugin(asset))
      .sort((a, b) => a.order - b.order)
      .map((asset) => asset.id);
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
      throw failure(kind, asset.id, message, { url: asset.url });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw failure("http", asset.id, `HTTP ${response.status}`, { url: asset.url, status: response.status });
    }

    const bytes = await response.arrayBuffer();
    const actual = await sha384(bytes);
    if (asset.integrity && actual !== asset.integrity) {
      throw failure("integrity", asset.id, "hash does not match the manifest", {
        url: asset.url,
        expected: asset.integrity,
        actual,
      });
    }

    return { text: new TextDecoder().decode(bytes) };
  }

  /* Evaluate verified bytes. Side effects stay here, never in the fetch, so the
     load phase can run in parallel without reordering anything. */
  async function evaluate(asset, text) {
    if (asset.kind === "css") return { css: text };
    if (asset.kind === "html") return { html: text };
    const blob = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
    let namespace;
    try {
      namespace = await import(blob);
    } catch (error) {
      throw failure("import", asset.id, error && error.message ? error.message : "module failed to evaluate", { url: asset.url });
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
      throw failure("missing", asset.id, `not loaded, and its mode is "${asset.mode}"`);
    }
    const { text } = await fetchVerified(asset);
    return evaluate(asset, text);
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
    const { text } = await fetchVerified(asset);
    sources[id] = text;
    return text;
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
    if (asset.role === "infra" && asset.kind === "js") return "skipped"; /* already running */

    emit("construct", { id: asset.id, state: "active", index, total, lazy });

    const deps = { env: globalThis, settings: settings(), late, optional };
    for (const name of asset.deps || []) {
      if (!(name in modules)) {
        throw failure("construct", asset.id, `requires "${name}", which is not built`);
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

    const mode = settings().mode;
    /* Plugins are never built here. A document must open when a plugin is missing,
       damaged or switched off, and keeping them out of this list is what keeps boot's
       fail-closed contract about *this document's own* assets. */
    const assets = manifest()
      .assets.filter((asset) => inMode(asset, mode) && !isPlugin(asset))
      .sort((a, b) => a.order - b.order);
    const jsAssets = assets.filter((asset) => asset.kind === "js" && asset.role !== "infra");
    emit("start", { order: jsAssets.map((asset) => asset.id), total: jsAssets.length });

    /* 1. Load in parallel: I/O is order-free. */
    const online = assets.filter((asset) => asset.mode === "online");
    const loaded = new Map();
    const outcomes = await Promise.allSettled(
      online.map(async (asset) => {
        loaded.set(asset.id, await fetchAsset(asset));
      }),
    );
    for (const [i, outcome] of outcomes.entries()) {
      if (outcome.status === "rejected") return fail(outcome.reason);
    }

    /* 2. Construct in order: side effects are order-bound. */
    let index = 0;
    for (const asset of assets) {
      const isModule = asset.kind === "js" && asset.role !== "infra";
      try {
        await constructOne(asset, { loaded, index: isModule ? index : 0, total: jsAssets.length });
      } catch (error) {
        return fail(error);
      }
      if (isModule) index++;
    }

    setState("ready");
    emit("ready", { count: Object.keys(modules).length });
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
    if (!entry) throw record(failure("unresolved", id, "this document needs it but has no pinned copy of it"));
    if (entry.enabled === false) throw record(failure("disabled", id, "is turned off in this document"));

    const assets = pluginAssets(entry, id);
    if (!assets.length) throw record(failure("missing", id, "has no assets in this document's manifest"));

    /* Same two phases as boot, for one bundle. Inline assets are already in the
       document and need no fetch. */
    const online = assets.filter((asset) => asset.mode === "online" && !factories[asset.id]);
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
      throw record(failure("stale", id, "was unloaded while it was loading"));
    }

    for (const [position, asset] of assets.entries()) {
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
      throw record(failure("api", id, `needs host API ${api}; this document provides ${HOST_API}`));
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
      throw record(failure("stale", id, "was unloaded while it was loading"));
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

  /* Tear the graph down and build it again. Registered factories survive, so a
     failure that was environmental can be retried without reloading the file. */
  async function retry() {
    if (state === "booting") return modules;
    for (const id of Object.keys(live)) await deactivatePlugin(id);
    for (const id of Object.keys(modules)) delete modules[id];
    for (const node of injected.splice(0)) node.remove();
    for (const id of Object.keys(sources)) delete sources[id];
    for (const name of Object.keys(providers)) delete providers[name];
    pending.clear();
    errors.length = 0;
    setState("declared");
    return boot();
  }

  return {
    register,
    on,
    late,
    settings,
    optional,
    source,
    prefetch,
    reloadManifest,
    require: requirePlugin,
    deactivate: deactivatePlugin,
    /** What a plugin's activate() returned, or null when it is not built. */
    instance: (id) => live[id]?.activation || null,
    provide,
    hostApi: HOST_API,
    plugins,
    boot,
    retry,
    order,
    manifest,
    modules,
    factories,
    errors,
    get state() {
      return state;
    },
  };
})();
