/**
 * lib/compile.mjs — the asset envelope. Pure string functions, no I/O, so the
 * build and the tests exercise the same code.
 *
 * Source shape (src/*.js) is a real ES module:
 *
 *   export function createSignals(deps = {}) { … }
 *   export function helper(x) { … }
 *
 * Shipped shape (inside index.html) is a classic script, because `export` is a
 * syntax error there and because a classic script in place keeps today's
 * parse-time ordering. The envelope is build-owned; the body is yours:
 *
 *   /*@compiled-from src/signals.js — envelope is build-owned; edit the body*​/
 *   var Signals = globalThis.Signals || (function () {
 *   function createSignals(deps = {}) { … }
 *   function helper(x) { … }
 *   return createSignals();
 *   })();
 *
 * Why `globalThis.X ||`: a second copy of the same block (two documents
 * concatenated by hand) reuses the first instance instead of attaching a second
 * set of observers to the same element.
 *
 * Convention that makes the transform provably reversible: **every top-level
 * statement in a converted asset is an exported declaration.** Private helpers
 * live inside the factory. Enforced by assertConvertible(), and the export list
 * is recorded in manifest.json so `split` can invert without guessing (a
 * template literal may contain a line that merely looks like a declaration).
 */

/**
 * Converted assets, keyed by asset id. Empty until an asset is converted:
 * an absent entry means "pass through verbatim", which is what lets the
 * transform ship before any asset changes shape.
 */
export const MODULES = {
  // signals: {factory: "createSignals", global: "Signals"},
  // zoom:    {factory: "createZoom",    global: "Zoom"},
};

const head = (entry) =>
  `/*@compiled-from ${entry.file} — envelope is build-owned; edit the body or src/*/\n` +
  `var ${entry.global} = globalThis.${entry.global} || (function () {\n`;
const tail = (entry) => `\nreturn ${entry.factory}();\n})();`;

const DECLARATION = /^(?:async )?(?:function|const|let|class|var)\s+([A-Za-z_$][\w$]*)/;
const EXPORTED = /^export (?:async )?(?:function|const|let|class|var)\s+([A-Za-z_$][\w$]*)/;

export const isConverted = (id) => Object.hasOwn(MODULES, id);
export const moduleFor = (id) => MODULES[id];

/** Names of the exported declarations, in source order. */
export function moduleExportNames(source) {
  const names = [];
  for (const line of source.split("\n")) {
    const m = EXPORTED.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/** Every top-level declaration name, exported or not. */
function topLevelNames(body) {
  const names = [];
  for (const line of body.split("\n")) {
    const m = DECLARATION.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * True when `index` falls inside a backtick-delimited template literal, judged
 * by backtick parity (escaped backticks ignored). Good enough for our own code,
 * and it only ever produces a false *rejection*, never a false acceptance.
 */
function insideTemplate(source, index) {
  let ticks = 0;
  for (let i = 0; i < index; i++) {
    if (source[i] === "\\") {
      i++;
      continue;
    }
    if (source[i] === "`") ticks++;
  }
  return ticks % 2 === 1;
}

/** Cheap, precise grammar gate. Throws with an actionable message. */
export function assertConvertible(id, source) {
  const entry = MODULES[id];
  if (!entry) return moduleExportNames(source);
  const fail = (why) => {
    throw new Error(`asset "${id}" (${entry.file}): ${why}`);
  };

  if (/\bimport\b/.test(source)) fail("contains the token `import` (converted assets take dependencies as arguments)");
  if (/<\/script/i.test(source)) fail("contains a literal </script>, which cannot be embedded in an inline script");
  if (/^export\s+default\b/m.test(source)) fail("uses `export default`; use named exports only");
  if (/^export\s*[{*]/m.test(source)) fail("uses an `export {…}` list; declare and export in one statement");

  const factories = [...source.matchAll(/^export function (create[A-Za-z0-9_$]*)\s*\(/gm)].map((m) => m[1]);
  if (factories.length !== 1) fail(`must export exactly one create<Name> function, found ${factories.length}`);
  if (factories[0] !== entry.factory) fail(`exports ${factories[0]} but the module table expects ${entry.factory}`);

  /* Every top-level statement must be an exported declaration, so that the
     inlined body and the source differ only by the `export ` keyword. */
  for (const line of source.split("\n")) {
    const decl = DECLARATION.exec(line);
    if (!decl || line.startsWith("export ")) continue;
    fail(`has a top-level declaration of "${decl[1]}" that is not exported (move private helpers inside ${entry.factory})`);
  }

  /* The strip is line-based, so an `export ` at the start of a line inside a
     template literal would be silently removed from a string. Refuse. */
  let offset = 0;
  for (const [i, line] of source.split("\n").entries()) {
    if (line.startsWith("export ") && insideTemplate(source, offset)) {
      fail(`has a line starting with "export " inside a template literal (line ${i + 1}); the strip would corrupt it`);
    }
    offset += line.length + 1;
  }

  const exported = moduleExportNames(source);
  if (!exported.length) fail("has no exported declarations");
  return exported;
}

/**
 * ESM source -> shipped body. `exports` is returned so the caller can record it
 * in manifest.json, which is what makes uncompileBody unambiguous.
 */
export function compileBody(id, source) {
  const entry = MODULES[id];
  const text = source.replace(/\n$/, "");
  if (!entry) return { body: text, exports: [] };

  const exports = assertConvertible(id, text);
  const stripped = text
    .split("\n")
    .map((line) => (line.startsWith("export ") ? line.slice("export ".length) : line))
    .join("\n");
  const body = head(entry) + stripped + tail(entry);
  if (/<\/script/i.test(body)) throw new Error(`asset "${id}": compiled body contains </script>`);
  return { body, exports };
}

/** Shipped body -> ESM source. The exact inverse of compileBody. */
export function uncompileBody(id, body, exports) {
  const entry = MODULES[id];
  if (!entry) return body;

  const open = head(entry);
  const close = tail(entry);
  if (!body.startsWith(open) || !body.endsWith(close)) {
    throw new Error(
      `asset "${id}": envelope anchors not found in index.html. ` +
        `Edit ${entry.file} and run "npm run combine" (the envelope is build-owned).`,
    );
  }
  const inner = body.slice(open.length, body.length - close.length);
  if (!exports?.length) {
    throw new Error(`asset "${id}": manifest.json has no exports list; run "npm run combine" first`);
  }

  const declared = topLevelNames(inner);
  const stray = declared.filter((name) => !exports.includes(name));
  const missing = exports.filter((name) => !declared.includes(name));
  if (stray.length) {
    throw new Error(
      `asset "${id}": index.html declares ${stray.map((n) => `"${n}"`).join(", ")} inside the envelope but manifest.json ` +
        `does not list it. Add the declaration to ${entry.file} and run "npm run combine".`,
    );
  }
  if (missing.length) {
    throw new Error(`asset "${id}": manifest.json lists ${missing.join(", ")} but the envelope does not declare it`);
  }

  let text = inner;
  for (const name of exports) {
    const pattern = new RegExp(`^((?:async )?(?:function|const|let|class|var)\\s+${name}\\b)`, "m");
    if (!pattern.test(text)) throw new Error(`asset "${id}": cannot re-export "${name}"`);
    text = text.replace(pattern, "export $1");
  }
  return text + "\n";
}

/**
 * Parse-only check used by `check`. Compiles, does not execute; catches a
 * transform that produced a syntactically invalid body.
 */
export function syntaxError(body) {
  try {
    new Function(body);
    return null;
  } catch (err) {
    return err.message;
  }
}
