/**
 * lib/deps.mjs — derive each module's dependency contract from its source.
 *
 * The contract is the factory's signature, so there is exactly one place a
 * dependency can be declared and no table to drift:
 *
 *   export function createEditor(deps = {}) {
 *     const {signals, status, pagination} = deps;   → deps
 *     const figures = deps.late("figures");         → late
 *     const {document} = deps.env;                  → environment
 *     return {init, exec, /* … *\/};                 → provides
 *
 * Extraction is deliberately strict: one destructuring statement, first in the
 * body, plain identifiers, no renaming. Anything else is an error, because a
 * parser that quietly guesses is worse than one that refuses.
 */

const FACTORY = /^export function (create[A-Za-z0-9_$]*)\s*\(([^)]*)\)\s*\{\s*$/m;

const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * Legacy global → asset id. Publishing these stopped in Phase 3, commit 5; the
 * map survives as a tripwire: any `window.Figures` that reappears is reported by
 * extractContract() and FAILS the build audit, instead of quietly becoming an
 * undeclared edge that only works because of load order.
 */
export const LEGACY_GLOBALS = Object.freeze({
  Signals: "signals",
  Zoom: "zoom",
  Pagination: "pagination",
  Status: "status",
  ProgressDialog: "progress",
  Figures: "figures",
  Editor: "editor",
  Toolbar: "toolbar",
  Export: "export",
});

/** Split an object literal's top level into entries (handles nesting/strings). */
function topLevelEntries(objectText) {
  const entries = [];
  let depth = 0;
  let start = 0;
  let quote = null;
  for (let i = 0; i < objectText.length; i++) {
    const ch = objectText[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if ("{[(".includes(ch)) depth++;
    else if ("}])".includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      entries.push(objectText.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(objectText.slice(start));
  return entries.map((entry) => entry.replace(/^\s+|\s+$/g, "")).filter(Boolean);
}

/** Slice out the object literal that starts at `openIndex` (a `{`). */
function objectAt(source, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return null;
}

function providedNames(source, factory) {
  /* Two shapes are in use: `return {…}` and `const api = {…}; …; return api;`. */
  /* Anchored to the factory's top level (two spaces), so a nested
     `return {…}` inside a helper is never mistaken for the public API. */
  const apiDecl = /^  const api = \{/m.exec(source);
  const literal = /^  return \{/m.exec(source);
  const openIndex = apiDecl
    ? apiDecl.index + apiDecl[0].length - 1
    : literal
      ? literal.index + literal[0].length - 1
      : -1;
  if (openIndex < 0) return null;

  const body = objectAt(source, openIndex);
  if (body == null) return null;

  const names = [];
  for (const entry of topLevelEntries(body)) {
    if (entry.startsWith("...")) return null; // a spread means we cannot be sure
    const getter = /^get\s+([A-Za-z_$][\w$]*)/.exec(entry);
    if (getter) {
      names.push(getter[1]);
      continue;
    }
    const plain = /^([A-Za-z_$][\w$]*)\s*(?:[:,]|$)/.exec(entry);
    if (plain) {
      names.push(plain[1]);
      continue;
    }
    return null;
  }
  return names;
}

/**
 * @param {string} source   the asset's ES module text
 * @param {object} options  { globals: { "Signals": "signals", … } }
 */
export function extractContract(source, { globals = {} } = {}) {
  const decl = FACTORY.exec(source);
  if (!decl) throw new Error("no `export function create<Name>(…)` declaration");
  const [, factory, params] = decl;

  const bodyStart = decl.index + decl[0].length;
  const body = source.slice(bodyStart);
  const lines = body.split("\n");

  /* The first non-blank, non-comment line must be the destructuring (or, for a
     dependency-free factory, must not be one). */
  let firstLine = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
    firstLine = trimmed;
    break;
  }

  const destructures = [...body.matchAll(/^  const \{[^}]*\} = deps;$/gm)].length;
  if (destructures > 1) throw new Error(`${factory}: more than one \`const {…} = deps;\` statement`);

  const hasParams = /\bdeps\b/.test(params);
  const destructure = firstLine ? /^const \{([^}]*)\} = deps;$/.exec(firstLine) : null;

  if (hasParams && !destructure) {
    throw new Error(
      `${factory} takes a deps parameter but the first statement is not ` +
        `\`const {…} = deps;\` — the contract must be extractable`,
    );
  }
  if (!hasParams && destructure) {
    throw new Error(`${factory} destructures deps but does not accept a deps parameter`);
  }

  const deps = [];
  let usesEnv = false;
  if (destructure) {
    for (const raw of destructure[1].split(",")) {
      const part = raw.trim();
      if (!part) continue;
      const name = /^([A-Za-z_$][\w$]*)\s*(?:=|$)/.exec(part)?.[1];
      if (!name) throw new Error(`${factory}: cannot parse dependency "${part}"`);
      if (name === "env") usesEnv = true;
      else if (name === "late") throw new Error(`${factory}: do not destructure \`late\`; call deps.late("id")`);
      else deps.push(name);
    }
  }

  const late = [...source.matchAll(/deps\.late\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);

  /* Module references reached through a global are implicit edges: they work by
     accident of load order. Reported so they can be converted to deps/late. */
  const implicitGlobals = [];
  for (const m of source.matchAll(/\b(?:globalThis|window)\.([A-Za-z_$][\w$]*)/g)) {
    const id = globals[m[1]];
    if (id && !deps.includes(id) && !late.includes(id)) implicitGlobals.push(id);
  }

  return {
    factory,
    deps,
    late: [...new Set(late)],
    usesEnv,
    provides: providedNames(source, factory),
    implicitGlobals: [...new Set(implicitGlobals)],
  };
}

/**
 * Graph audit. Returns {problems, warnings}. `index` maps id → {order, …}.
 */
export function auditContract(id, contract, index) {
  const problems = [];
  const warnings = [];
  const self = index.get(id);
  if (!self) return { problems: [`${id}: not in the manifest`], warnings };

  for (const name of contract.deps) {
    const dep = index.get(name);
    if (!dep) {
      problems.push(`${id}: depends on "${name}", which is not an asset`);
      continue;
    }
    if (name === id) problems.push(`${id}: cannot depend on itself`);
    if (dep.order >= self.order) {
      problems.push(
        `${id} (${self.order}) requires ${name} (${dep.order}) — a construction dependency must come earlier; use deps.late("${name}") if it is a back-edge`,
      );
    }
  }

  for (const name of contract.late) {
    const dep = index.get(name);
    if (!dep) {
      problems.push(`${id}: late("${name}") names no asset`);
      continue;
    }
    if (name === id) {
      problems.push(`${id}: cannot late-bind itself`);
      continue;
    }
    if (dep.order < self.order) {
      warnings.push(`${id}: late("${name}") points backwards (${dep.order} < ${self.order}); it could be a plain dependency`);
    }
  }

  for (const name of contract.implicitGlobals) {
    problems.push(`${id}: reaches ${name} through a global; take it as a dependency (or deps.late) instead`);
  }

  if (contract.provides === null) warnings.push(`${id}: could not derive the returned API surface`);

  return { problems, warnings };
}
