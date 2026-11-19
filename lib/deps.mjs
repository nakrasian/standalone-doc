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
 * Remove comments, keeping the code around them, so scanning for a legacy global
 * name cannot match prose. A small state machine is enough: quotes and template
 * literals are tracked so a `//` inside a string survives.
 */
export function stripComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
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
  let usesSettings = false;
  if (destructure) {
    for (const raw of destructure[1].split(",")) {
      const part = raw.trim();
      if (!part) continue;
      const name = /^([A-Za-z_$][\w$]*)\s*(?:=|$)/.exec(part)?.[1];
      if (!name) throw new Error(`${factory}: cannot parse dependency "${part}"`);
      if (name === "env") usesEnv = true;
      else if (name === "settings") usesSettings = true;
      else if (name === "late") throw new Error(`${factory}: do not destructure \`late\`; call deps.late("id")`);
      else deps.push(name);
    }
  }

  const late = [...source.matchAll(/deps\.late\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  const optional = [...source.matchAll(/deps\.optional\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);

  /* A reference to another module through anything but `deps` is an implicit
     edge: it works by accident of load order. Both spellings are caught —
     `window.Figures`, and the bare `Pagination.schedule()` that only resolved
     while the legacy global existed. Comments are stripped first: prose about a
     module is not a dependency. */
  const code = stripComments(source);
  const implicitGlobals = [];
  const declared = (id) => deps.includes(id) || late.includes(id) || optional.includes(id);
  for (const m of code.matchAll(/\b(?:globalThis|window)\.([A-Za-z_$][\w$]*)/g)) {
    const id = globals[m[1]];
    if (id && !declared(id)) implicitGlobals.push(id);
  }
  for (const m of code.matchAll(/(?<![\w$.])([A-Z][A-Za-z0-9_$]*)\s*[.(]/g)) {
    const id = globals[m[1]];
    if (id && !declared(id)) implicitGlobals.push(id);
  }

  return {
    factory,
    deps,
    late: [...new Set(late)],
    optional: [...new Set(optional)],
    usesEnv,
    usesSettings,
    /* The factory *body*, not the file: another top-level function's `return {…}`
       (chooseCut's cut description was one) would otherwise be read as the API. */
    provides: providedNames(body, factory),
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

  /* Does `dep` exist in every mode its dependent exists in? An always-present
     module cannot depend on an edit-only one: a view-mode document would boot the
     dependent and find the dependency missing. */
  /* A capability-gated asset is never "always present": whether it is built depends on
     the document's `capabilities`, which a dependency graph cannot see. So it cannot be
     a plain dependency of anything (invariant 28). */
  const covers = (dep, dependent) => {
    if (dep.capability) return false;
    const depModes = new Set(dep.requiredBy || ["*"]);
    if (depModes.has("*")) return true;
    return (dependent.requiredBy || ["*"]).every((mode) => depModes.has(mode));
  };

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
    if (!covers(dep, self)) {
      problems.push(
        `${id} is needed by ${(self.requiredBy || ["*"]).join(", ")} but ${name} is only needed by ` +
          `${(dep.requiredBy || ["*"]).join(", ")} — take it via deps.optional("${name}") so the other modes still boot`,
      );
    }
  }

  for (const name of contract.optional ?? []) {
    const dep = index.get(name);
    if (!dep) {
      problems.push(`${id}: optional("${name}") names no asset`);
      continue;
    }
    if (name === id) problems.push(`${id}: cannot be optional on itself`);
    if (covers(dep, self) && dep.order < self.order) {
      warnings.push(`${id}: optional("${name}") is always present and built first; take it as a plain dependency`);
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
    if (dep.order < self.order && covers(dep, self)) {
      warnings.push(`${id}: late("${name}") points backwards (${dep.order} < ${self.order}); it could be a plain dependency`);
    }
  }

  for (const name of contract.implicitGlobals) {
    problems.push(`${id}: reaches ${name} through a global; take it as a dependency (or deps.late) instead`);
  }

  if (contract.provides === null) warnings.push(`${id}: could not derive the returned API surface`);

  return { problems, warnings };
}
