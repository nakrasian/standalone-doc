/* The container: the only global. Every asset registers a factory and boot()
   builds them in manifest order, so document order stops mattering. */
globalThis.StandaloneDoc = globalThis.StandaloneDoc || (function () {
  "use strict";

  const factories = Object.create(null);
  const meta = Object.create(null);
  const modules = Object.create(null);
  const errors = [];
  let state = "declared";

  function register(id, factory, options) {
    /* Idempotent by id: a hand-concatenated document may contain the same block
       twice. The first registration wins, so the module is built only once. */
    if (factories[id]) return;
    factories[id] = factory;
    meta[id] = options || {};
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
    errors.push({
      phase,
      id,
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? String(error.stack) : null,
    });
    throw error;
  }

  function order() {
    return Object.keys(factories).sort((a, b) => (meta[a].order || 0) - (meta[b].order || 0));
  }

  function boot() {
    if (state !== "declared") return modules;
    state = "booting";
    for (const id of order()) {
      const deps = {env: globalThis, late};
      for (const name of meta[id].deps || []) {
        if (!(name in modules)) abort("construct", id, new Error(`${id} requires "${name}", which is not built`));
        deps[name] = modules[name];
      }
      try {
        modules[id] = factories[id](deps);
      } catch (error) {
        abort("construct", id, error);
      }
      /* Transitional: publish the legacy global until every consumer takes
         the dependency properly (Phase 3, commit 5). */
      if (meta[id].global) globalThis[meta[id].global] = modules[id];
    }
    state = "ready";
    return modules;
  }

  return {register, late, boot, order, modules, factories, errors, get state() {return state;}};
})();
