/**
 * Save policies: decide, per asset, what travels inside the saved file.
 *
 *   inline  everything the document's mode needs is in the file      (default)
 *   smart   the body inline, the authoring capability online         (read offline, edit online)
 *   slim    everything except the loader online                      (smallest file)
 *
 * Mode eligibility applies to every policy rather than being one of them: an asset
 * whose `requiredBy` lacks the document's mode is *absent*, because the document
 * does not have that capability. That is why a viewer has no editor in it, rather
 * than an editor fetched from somewhere.
 *
 * The dependency contract already encodes the capability split (`"*"` = a reader
 * needs it, `"edit"` = authoring), which is why `smart` needs no new metadata.
 */
export function createPolicy(deps = {}) {
  const {figures, settings, env} = deps;

  const PRESETS = ["inline", "smart", "slim"];
  const CHOICES = ["inline", "online", "absent"];

  const requiredEverywhere = (asset) => (asset.requiredBy || ["*"]).includes("*");
  const isInfra = (asset) => asset.role === "infra";

  function inMode(asset, mode) {
    const requiredBy = asset.requiredBy || ["*"];
    return requiredBy.includes("*") || requiredBy.includes(mode);
  }

  /* What should happen to one asset. Order is the point: the loader can never be
     offloaded, a capability this document lacks is absent, an unused plugin is
     absent, then the author's override, then the preset. */
  function target(asset, {mode, policy, overrides, usage}) {
    if (isInfra(asset)) return "inline";
    if (!inMode(asset, mode)) return "absent";
    if (asset.category === "plugin" && !((usage || {})[asset.id] > 0)) return "absent";
    const override = (overrides || {})[asset.id];
    if (CHOICES.includes(override)) return override;
    if (policy === "slim") return "online";
    if (policy === "smart") return requiredEverywhere(asset) ? "inline" : "online";
    return "inline";
  }

  /**
   * Pure: manifest in, per-asset target and size estimate out. `usage` counts the
   * figures that need each plugin; `baseBytes` is the document minus its asset
   * bodies, so the estimate is comparable to the file about to be written.
   */
  function plan(manifest, {policy = "inline", mode = "edit", overrides = {}, usage = {}, baseBytes = 0} = {}) {
    const decisions = [...((manifest && manifest.assets) || [])]
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((asset) => ({
        id: asset.id,
        order: asset.order,
        role: asset.role || "module",
        category: asset.category,
        requiredBy: asset.requiredBy || ["*"],
        from: asset.mode || "inline",
        to: target(asset, {mode, policy, overrides, usage}),
        bytes: asset.bytes || 0,
      }));
    const inlineBytes = decisions
      .filter((decision) => decision.to === "inline")
      .reduce((sum, decision) => sum + decision.bytes, 0);
    return {policy, mode, usage, decisions, inlineBytes, estimate: baseBytes + inlineBytes};
  }

  /** The asset states a plan produces, ignoring the loader (never a choice). */
  const stateOf = (planned) =>
    planned.decisions
      .filter((decision) => !isInfra(decision))
      .map((decision) => `${decision.id}=${decision.to}`)
      .join(",");

  /** Which preset produces exactly this plan, or null when the author deviated. */
  function presetFor(planned) {
    const wanted = stateOf(planned);
    for (const policy of PRESETS) {
      const candidate = plan(
        {assets: planned.decisions.map((decision) => ({...decision, mode: "inline"}))},
        {policy, mode: planned.mode, usage: planned.usage || {}},
      );
      if (stateOf(candidate) === wanted) return policy;
    }
    return null;
  }

  /**
   * The `#doc-settings` fragment that describes this plan.
   *
   * Storage rule: a preset is a shorthand for a complete map, and the shorthand is
   * valid only until the author touches one asset. The moment anything is
   * overridden, the file stores the explicit map and no `policy` key — an
   * overridden document must not claim a preset it no longer follows.
   */
  function persist(planned) {
    const preset = presetFor(planned);
    if (preset) return {policy: preset};
    const assets = {};
    for (const decision of planned.decisions) {
      if (isInfra(decision)) continue;
      assets[decision.id] = decision.to;
    }
    return {assets};
  }

  /* ---------------------------------------------------------------- DOM work */

  const docOf = (root) => root.ownerDocument || root;
  const byId = (root, id) => root.querySelector(`[id="${id}"]`);
  const isComment = (node, pattern) =>
    Boolean(node) && node.nodeType === 8 && pattern.test(node.nodeValue || ""); /* 8 = COMMENT_NODE */
  const startMarker = (node) => isComment(node, /^\s*@asset\b/);
  const endMarker = (node) => isComment(node, /^\s*\/@asset\s*$/);
  const blank = (node) => node && node.nodeType === 3 && !(node.nodeValue || "").trim(); /* 3 = TEXT_NODE */

  /** Remove an asset's element together with its markers and the lines around them. */
  function removeBlock(el) {
    let first = el;
    let node = el.previousSibling;
    while (node && !startMarker(node)) {
      if (!blank(node)) return false;
      first = node;
      node = node.previousSibling;
    }
    if (!startMarker(node)) return false;
    first = node;

    let last = el;
    node = el.nextSibling;
    while (node && !endMarker(node)) {
      if (!blank(node)) return false;
      last = node;
      node = node.nextSibling;
    }
    if (!endMarker(node)) return false;
    last = node;
    if (blank(last.nextSibling)) last = last.nextSibling;

    let cursor = first;
    while (cursor) {
      const next = cursor === last ? null : cursor.nextSibling;
      cursor.parentNode.removeChild(cursor);
      cursor = next;
    }
    return true;
  }

  /** The first @asset marker whose order is greater than `order`, for a tidy insert. */
  function markerAfter(root, order) {
    const doc = docOf(root);
    const walker = doc.createTreeWalker(root, 128 /* SHOW_COMMENT */);
    let node;
    while ((node = walker.nextNode())) {
      if (!startMarker(node)) continue;
      const found = /order="(\d+)"/.exec(node.nodeValue || "");
      if (found && Number(found[1]) > order) return node;
    }
    return null;
  }

  /**
   * Insert an asset block built from verified CDN bytes.
   *
   * The body is the source text plus the single registration line — the same shape a
   * build-produced block has, minus the build-provenance comment line, which exists
   * for `verify` on the repository's own file and means nothing in a saved document.
   */
  function insertBlock(root, {id, order, kind, factory, text}) {
    const doc = docOf(root);
    const isCss = kind === "css";
    const body = isCss
      ? text.replace(/\n$/, "")
      : `${text.replace(/\n$/, "")}\nStandaloneDoc.register(${JSON.stringify(id)}, ${factory});`;
    /* Two spaces for the element, two more for its body — the same shape the build
       produces, so a re-inlined block is indistinguishable from an original one. */
    const indented = body
      .split("\n")
      .map((line) => (line ? `    ${line}` : ""))
      .join("\n");

    const fragment = doc.createDocumentFragment();
    fragment.append(
      doc.createTextNode("\n"),
      doc.createComment(` @asset id="${id}" kind="${isCss ? "css" : "js"}" order="${order}" `),
      doc.createTextNode("\n  "),
    );
    const el = doc.createElement(isCss ? "style" : "script");
    if (!isCss) el.type = "module";
    el.id = id;
    el.textContent = isCss ? `\n${indented}\n  ` : `\n${indented}\n  `;
    fragment.append(el, doc.createTextNode("\n"), doc.createComment(" /@asset "), doc.createTextNode("\n"));

    const ref = markerAfter(root, order);
    if (ref && ref.parentNode) ref.parentNode.insertBefore(fragment, ref);
    else (root.querySelector("body") || root).append(fragment);
  }

  function readJSON(root, id) {
    const el = byId(root, id);
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch {
      return null;
    }
  }

  function writeJSON(root, id, value) {
    const el = byId(root, id);
    if (!el) return false;
    const next = JSON.stringify(value);
    if (el.textContent === next) return false;
    el.textContent = next;
    return true;
  }

  /**
   * Apply a plan to a clone of the document.
   *
   * Only re-inlining needs the network: every other move is bookkeeping over the
   * `url` + `integrity` the document already carries, which is what makes
   * "offload" work offline.
   */
  async function apply(root, planned) {
    const manifest = readJSON(root, "asset-manifest");
    if (!manifest) return {problems: ["the clone has no asset manifest"], changed: []};

    const registry = env.StandaloneDoc;
    const byIdEntry = new Map((manifest.assets || []).map((entry) => [entry.id, entry]));
    const problems = [];
    const changed = [];
    let manifestChanged = false;

    for (const decision of planned.decisions) {
      const entry = byIdEntry.get(decision.id);

      /* A stylesheet that arrived from the CDN was injected at boot. That is session
         state: the saved file must not carry both a fetched copy and the markup that
         says to fetch it. */
      for (const injected of root.querySelectorAll(`style[data-asset="${decision.id}"]`)) injected.remove();

      const el = byId(root, decision.id);
      const present = Boolean(el);

      if (decision.to === "inline") {
        if (!present) {
          /* Stylesheets have no factory; modules need one to register. Both need a
             pinned url, because that is the only place their bytes come from. */
          const needsFactory = entry && entry.kind === "js";
          if (!entry || !entry.url || (needsFactory && !entry.factory)) {
            problems.push(`${decision.id}: this document has no pinned url for it, so it cannot be inlined`);
            continue;
          }
          try {
            const text = await registry.source(decision.id);
            insertBlock(root, {
              id: decision.id,
              order: entry.order,
              kind: entry.kind,
              factory: entry.factory,
              text,
            });
            changed.push(decision.id);
          } catch (error) {
            problems.push(`${decision.id}: ${error && error.message ? error.message : String(error)}`);
            continue;
          }
        }
        if (entry && entry.mode !== "inline") {
          entry.mode = "inline";
          manifestChanged = true;
        }
        continue;
      }

      /* online or absent: the block leaves the document. */
      if (present && !removeBlock(el)) {
        problems.push(`${decision.id}: could not remove its block (markers are not where they should be)`);
        continue;
      }
      if (present) changed.push(decision.id);
      if (entry && entry.mode !== decision.to) {
        entry.mode = decision.to;
        manifestChanged = true;
      }
    }

    if (manifestChanged) writeJSON(root, "asset-manifest", manifest);

    /* Record the choice in the file, so reopening and saving again is stable. */
    const stored = readJSON(root, "doc-settings") || {};
    const fragment = persist(planned);
    const next = {...stored, ...fragment, mode: planned.mode};
    if (next.policy === null || next.policy === undefined) delete next.policy;
    if (!fragment.assets) delete next.assets;
    writeJSON(root, "doc-settings", next);

    return {problems, changed};
  }

  /** The document's stored choice: an explicit map wins over a preset. */
  function resolve(block) {
    const source = block || {};
    if (source.assets && typeof source.assets === "object") return {policy: null, overrides: source.assets};
    const policy = PRESETS.includes(source.policy) ? source.policy : "inline";
    return {policy, overrides: {}};
  }

  /** How many figures need each plugin. Inert until plugins exist (Phase 5). */
  function usage() {
    try {
      return (figures && figures.pluginUsage && figures.pluginUsage()) || {};
    } catch {
      return {};
    }
  }

  /**
   * The plan the live document would use at save, honouring its stored choice unless
   * the caller names a policy (that is what the save dialog does).
   */
  function planned({policy, overrides, mode, baseBytes = 0} = {}) {
    const registry = env.StandaloneDoc;
    const manifest = registry && registry.manifest ? registry.manifest() : {assets: []};
    const stored = resolve(settings);
    const chosen = policy ? {policy, overrides: overrides || {}} : stored;
    return plan(manifest, {
      policy: chosen.policy || "inline",
      mode: mode || settings.mode,
      overrides: chosen.overrides,
      usage: usage(),
      baseBytes,
    });
  }

  return {plan, apply, persist, presetFor, resolve, planned, target, usage, PRESETS};
}
