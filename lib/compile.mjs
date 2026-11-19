/**
 * lib/compile.mjs — the asset envelope. Pure string functions, no I/O, so the
 * build and the tests exercise the same code.
 *
 * Source shape (src/*.js) is a real ES module:
 *
 *   export function createSignals(deps = {}) { … }
 *   export function helper(x) { … }
 *
 * Shipped shape (inside index.html) is the same text in a `<script type="module">`
 * block, plus one registration line:
 *
 *   /*@compiled-from src/signals.js — envelope is build-owned; edit the body*​/
 *   export function createSignals(deps = {}) { … }
 *   export function helper(x) { … }
 *   StandaloneDoc.register("signals", createSignals);
 *
 * Module blocks are why this file is small: `export` is legal, strictness is
 * implied, each block has its own scope (so no IIFE is needed to survive a
 * duplicated block) and top-level `await` is available to bootstrap. The body is
 * byte-identical to src/, which makes `verify` an equality check rather than a
 * reconstruction: the only build-owned parts are the comment above the body and
 * the single registration line below it.
 *
 * The registration carries no metadata. Order, dependencies, late edges and mode
 * live in the in-document #asset-manifest, derived from the signature at build
 * time — one source of truth instead of two that can disagree.
 *
 * Convention that keeps the transform invertible: **every top-level statement is
 * an exported declaration.** Enforced by assertConvertible(). It also guarantees
 * a module block's top level only *declares* things, which is what lets `check`
 * evaluate each source in isolation as a parse-and-side-effect gate.
 */

/**
 * Converted assets, keyed by asset id. An absent entry means "pass through
 * verbatim", which is what lets the transform ship before an asset changes shape.
 */
export const MODULES = {
  "apply-settings": {factory: "createApplySettings"},
  session: {factory: "createSession"},
  signals: {factory: "createSignals"},
  zoom: {factory: "createZoom"},
  selection: {factory: "createSelection"},
  layout: {factory: "createLayout"},
  pagination: {factory: "createPagination"},
  status: {factory: "createStatus"},
  progress: {factory: "createProgress"},
  figures: {factory: "createFigures"},
  policy: {factory: "createPolicy"},
  plugins: {factory: "createPlugins"},
  editor: {factory: "createEditor"},
  toolbar: {factory: "createToolbar"},
  export: {factory: "createExport"},
  "viewer-bar": {factory: "createViewerBar"},
};

/** The table entry, with the src path filled in. */
const entryFor = (id) => {
  const entry = MODULES[id];
  return entry ? { file: `src/${id}.js`, ...entry } : null;
};

const header = (entry) => `/*@compiled-from ${entry.file} — envelope is build-owned; edit the body or src/*/`;
const registerLine = (id, entry) => `StandaloneDoc.register(${JSON.stringify(id)}, ${entry.factory});`;

const DECLARATION = /^(?:async )?(?:function|const|let|class|var)\s+([A-Za-z_$][\w$]*)/;

export const isConverted = (id) => Object.hasOwn(MODULES, id);
export const moduleFor = (id) => entryFor(id);

/** Cheap, precise grammar gate. Throws with an actionable message. */
export function assertConvertible(id, source) {
  const entry = entryFor(id);
  if (!entry) return true;
  const fail = (why) => {
    throw new Error(`asset "${id}" (${entry.file}): ${why}`);
  };

  /* Reject module *syntax*, not the word: "figure import failed" in an error
     string is fine, `import`.x or `import(...)` is not. `file://` cannot resolve
     a bare specifier, so dependencies must arrive as arguments. */
  for (const [pattern, what] of [
    [/^\s*import\s/m, "an import declaration"],
    [/\bimport\s*\(/, "a dynamic import()"],
    [/\bimport\.meta\b/, "import.meta"],
  ]) {
    if (pattern.test(source)) fail(`uses ${what}; converted assets take dependencies as arguments`);
  }
  if (/<\/script/i.test(source)) fail("contains a literal </script>, which cannot be embedded in an inline script");
  if (/^export\s+default\b/m.test(source)) fail("uses `export default`; use named exports only");
  if (/^export\s*[{*]/m.test(source)) fail("uses an `export {…}` list; declare and export in one statement");

  const factories = [...source.matchAll(/^export function (create[A-Za-z0-9_$]*)\s*\(/gm)].map((m) => m[1]);
  if (factories.length !== 1) fail(`must export exactly one create<Name> function, found ${factories.length}`);
  if (factories[0] !== entry.factory) fail(`exports ${factories[0]} but the module table expects ${entry.factory}`);

  /* Every top-level statement is an exported declaration: private helpers live
     inside the factory. This is what keeps the block's top level free of side
     effects (see the header) and what makes uncompileBody trivial. */
  for (const line of source.split("\n")) {
    const decl = DECLARATION.exec(line);
    if (!decl || line.startsWith("export ")) continue;
    fail(`has a top-level declaration of "${decl[1]}" that is not exported (move private helpers inside ${entry.factory})`);
  }

  return true;
}

/** ESM source -> shipped body. */
export function compileBody(id, source) {
  const entry = entryFor(id);
  const text = source.replace(/\n$/, "");
  if (!entry) return { body: text };
  assertConvertible(id, text);
  const body = `${header(entry)}\n${text}\n${registerLine(id, entry)}`;
  if (/<\/script/i.test(body)) throw new Error(`asset "${id}": compiled body contains </script>`);
  return { body };
}

/** Shipped body -> ESM source. The exact inverse of compileBody. */
export function uncompileBody(id, body) {
  const entry = entryFor(id);
  if (!entry) return body;

  const open = `${header(entry)}\n`;
  const close = `\n${registerLine(id, entry)}`;
  if (!body.startsWith(open) || !body.endsWith(close)) {
    throw new Error(
      `asset "${id}": envelope anchors not found in index.html. ` +
        `Edit ${entry.file} and run "npm run combine" (the envelope is build-owned).`,
    );
  }
  return `${body.slice(open.length, body.length - close.length)}\n`;
}

/**
 * Parse a block without a browser. Converted assets are ES modules, so they are
 * imported from a `data:` URL: that both parses the module grammar and proves the
 * top level does nothing (a factory that touched the DOM at evaluation time would
 * throw here, which is rule 6 of CONTRIBUTING made executable).
 *
 * Pass-through assets are classic scripts (and bootstrap uses top-level await),
 * so they are parsed inside an async function instead.
 */
export async function parseProblem(id, text) {
  if (isConverted(id)) {
    const url = "data:text/javascript;charset=utf-8," + encodeURIComponent(text);
    try {
      await import(url);
      return null;
    } catch (err) {
      return err && err.message ? err.message : String(err);
    }
  }
  try {
    new Function(`return async function () {\n${text}\n}`);
    return null;
  } catch (err) {
    return err && err.message ? err.message : String(err);
  }
}
