/* The container: the only global. Assets register their factory (inline) or are
   resolved from the CDN, and boot() builds them in manifest order — never
   document order. */
globalThis.StandaloneDoc = globalThis.StandaloneDoc || (function () {
  "use strict";

  const factories = Object.create(null);
  const modules = Object.create(null);
  const errors = [];
  const listeners = Object.create(null);
  const injected = [];
  const sources = Object.create(null);
  let state = "declared";
  let parsed = null;

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

  function failure(kind, id, message, extra) {
    return Object.assign({ kind, id, message }, extra || {});
  }

  function fail(record) {
    setState("failed");
    errors.push(record);
    emit("failed", { error: record, errors: errors.slice() });
    return false;
  }

  /* Only constructed modules: infrastructure is already running. */
  function order() {
    return manifest()
      .assets.filter((asset) => asset.kind === "js" && asset.role !== "infra")
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
    const timeoutMs = manifest().timeoutMs || 8000;

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
    const blob = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
    let namespace;
    try {
      namespace = await import(blob);
    } catch (error) {
      throw failure("import", asset.id, error && error.message ? error.message : "module failed to evaluate", { url: asset.url });
    }
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

  async function boot() {
    if (state !== "declared") return modules;
    setState("booting");
    errors.length = 0;

    const assets = manifest().assets.slice().sort((a, b) => a.order - b.order);
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
      if (asset.role === "infra" && asset.kind === "js") continue; /* already running */

      /* Stylesheets are not modules: inline ones are already in the document,
         online ones are injected here, in manifest order, so cascade order is
         the same in both flavours. */
      if (asset.kind === "css") {
        const result = loaded.get(asset.id);
        if (result?.css != null) {
          const style = document.createElement("style");
          style.textContent = result.css;
          style.dataset.asset = asset.id;
          document.head.append(style);
          injected.push(style);
        }
        continue;
      }

      const position = index++;
      emit("construct", { id: asset.id, state: "active", index: position, total: jsAssets.length });

      const deps = { env: globalThis, late };
      for (const name of asset.deps || []) {
        if (!(name in modules)) {
          return fail(failure("construct", asset.id, `requires "${name}", which is not built`));
        }
        deps[name] = modules[name];
      }

      const factory = factories[asset.id] || loaded.get(asset.id)?.factory;
      if (!factory) {
        return fail(
          failure(
            "missing",
            asset.id,
            asset.mode === "inline" ? "not loaded (its block is missing from this document)" : "not loaded from the CDN",
          ),
        );
      }

      try {
        modules[asset.id] = factory(deps);
      } catch (error) {
        return fail(
          failure("construct", asset.id, error && error.message ? error.message : String(error), {
            stack: error && error.stack ? String(error.stack) : null,
          }),
        );
      }

      /* No global is published: the manifest's dependency list is the only way
         one module reaches another, and boot injects it. */
      emit("construct", { id: asset.id, state: "ok", index: position, total: jsAssets.length });
    }

    setState("ready");
    emit("ready", { count: Object.keys(modules).length });
    return modules;
  }

  /* Tear the graph down and build it again. Registered factories survive, so a
     failure that was environmental can be retried without reloading the file. */
  async function retry() {
    if (state === "booting") return modules;
    for (const id of Object.keys(modules)) delete modules[id];
    for (const node of injected.splice(0)) node.remove();
    for (const id of Object.keys(sources)) delete sources[id];
    errors.length = 0;
    setState("declared");
    return boot();
  }

  return {
    register,
    on,
    late,
    source,
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
