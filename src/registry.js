/* The container: the only global. Every asset registers a factory and boot()
   builds them in manifest order, so document order stops mattering. */
globalThis.StandaloneDoc = globalThis.StandaloneDoc || (function () {
  "use strict";

  const factories = Object.create(null);
  const meta = Object.create(null);
  const modules = Object.create(null);
  const errors = [];
  const listeners = Object.create(null);
  let state = "declared";

  function register(id, factory, options) {
    /* Idempotent by id: a hand-concatenated document may contain the same block
       twice. The first registration wins, so the module is built only once. */
    if (factories[id]) return;
    factories[id] = factory;
    meta[id] = options || {};
  }

  /* Observers get told what boot is doing; they never influence it. */
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

  /* A back-edge: resolved when called, never during construction. */
  function late(id) {
    return function () {
      const module = modules[id];
      if (!module) throw new Error(`"${id}" is not built yet (late edge used during construction, or the asset is disabled)`);
      return module;
    };
  }

  function abort(phase, id, error) {
    state = "failed";
    const record = {
      phase,
      id,
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? String(error.stack) : null,
    };
    errors.push(record);
    emit("failed", {error: record, errors: errors.slice()});
    throw error;
  }

  function order() {
    return Object.keys(factories).sort((a, b) => (meta[a].order || 0) - (meta[b].order || 0));
  }

  function boot() {
    if (state !== "declared") return modules;
    state = "booting";
    errors.length = 0;

    const plan = order();
    emit("start", {order: plan, total: plan.length});

    for (const [index, id] of plan.entries()) {
      emit("construct", {id, state: "active", index, total: plan.length});

      const deps = {env: globalThis, late};
      for (const name of meta[id].deps || []) {
        if (!(name in modules)) {
          abort("construct", id, new Error(`${id} requires "${name}", which is not built`));
        }
        deps[name] = modules[name];
      }

      try {
        modules[id] = factories[id](deps);
      } catch (error) {
        abort("construct", id, error);
      }

      /* Transitional: publish the legacy global until every consumer takes the
         dependency properly (Phase 3, commit 5). */
      if (meta[id].global) globalThis[meta[id].global] = modules[id];
      emit("construct", {id, state: "ok", index, total: plan.length});
    }

    state = "ready";
    emit("ready", {count: plan.length});
    return modules;
  }

  /* Tear the graph down and build it again. Registered factories survive, so a
     failure that was environmental can be retried without reloading the file. */
  function retry() {
    if (state === "booting") return modules;
    for (const id of Object.keys(modules)) delete modules[id];
    for (const [id, options] of Object.entries(meta)) {
      if (options.global) delete globalThis[options.global];
    }
    errors.length = 0;
    state = "declared";
    return boot();
  }

  return {
    register,
    on,
    late,
    boot,
    retry,
    order,
    modules,
    factories,
    meta,
    errors,
    get state() {
      return state;
    },
  };
})();
