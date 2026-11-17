# Contributing

## The two-way rule

`index.html` and `src/` are both editable, and both are checked in. **A single change
touches one side of a given asset, never both.**

| You want to… | Do this |
|---|---|
| edit `figures` | edit `src/figures.js`, then `npm run combine` |
| edit everything at once | edit `index.html`, then `npm run split` |
| add a new asset | add markers in `index.html`, then `npm run split` |

`npm run check` fails when the two sides disagree, and tells you which asset diverged.
If both sides were edited in the same commit, `check` cannot tell which is intended —
that is the failure mode the rule exists to prevent.

### Marker discipline

- Markers are flush-left comments. `<!-- @asset id="…" kind="css|js" order="N" -->`
  opens, `<!-- /@asset -->` closes.
- The element inside must start on the line after the open marker and end on its own
  line before the close marker.
- `combine` splices **only the element body**. Attributes, indentation and surrounding
  whitespace are preserved byte-for-byte, which is what makes `verify` meaningful.
- Element ids must be unique. A `<style>`/`<script>` with an id that is neither marked nor
  in the runtime allowlist (`user-theme`, `print-page`, `figure-store`) fails `check`.

## Module shape (Phase 2 onward)

Source modules are dependency-injected with **zero `import` statements**:

```js
export function createFigures({ store, progress, loader }) {
  "use strict";
  // helpers stay private to this function
  return { mount, prepareClone, savedStoreBytes };
}
```

Rules the build enforces:

1. exactly one `export function create<Name>(` per file, and its name must match the
   entry in `lib/compile.mjs`'s `MODULES` table;
2. **every top-level declaration is exported.** Private helpers live inside the factory.
   This is what makes the swap to the shipped form reversible;
3. the token `import` appears nowhere (comments included) — dependencies arrive as
   arguments;
4. no `export` at the start of a line inside a template literal (the strip is line-based
   and would corrupt the string);
5. no literal `</script>` — it cannot be embedded in an inline script;
6. no DOM access at module evaluation time — everything happens inside the factory or
   inside `boot()`;
7. dependency order comes from `manifest.json`'s `order`, not from source order.

### The envelope

Converted assets are compiled into a classic script, because `export` is a syntax error
there and because a classic script keeps its parse-time position:

```html
/*@compiled-from src/signals.js — envelope is build-owned; edit the body or src/*/
var Signals = globalThis.Signals || (function () {
function createSignals(deps = {}) { … }      ← `export ` stripped
return createSignals();
})();
```

The two envelope lines are **build-owned**: change them by editing `src/` and running
`npm run combine`, or `split` will refuse with a message telling you so. The body is
yours, from either side. `globalThis.X ||` makes a duplicated block reuse the first
instance instead of attaching a second set of observers.

Assets with no `MODULES` entry pass through verbatim, so the transform can ship before
any asset changes shape.

Why: a module with no imports is valid both as a CDN ES module and as an inline classic
script. One source shape, two loaders, no bundler.

## Tests

| Tier | Where | Runs |
|---|---|---|
| 1 | `test/unit` (`node:test`) | every commit |
| 2 | `test/browser` (Playwright, chromium/webkit/firefox) | every push |
| 3 | size budgets (`size-baseline.json`) | every push, warning first |
| 4 | nightly CDN health + integrity | schedule |

Before opening a PR: `npm run check && npm test`. Before changing anything behavioural:
`npm run test:browser`.

## Lab (private)

Exploratory work lives in `archive/lab/`, which is **gitignored** and must never be committed.
The convention, if you keep one locally:

```
archive/lab/NNN-slug/
  notes.md        front-matter: id, question, status (open|answered|promoted|abandoned),
                  answer, date, promoted_to, depends_on
  probe.html      standalone. Once the code exists in src/, import it — never copy it.
  probe.spec.mjs  optional Playwright assertions
```

A probe graduates in four steps: **open → answered → promoted → (shelved)**. Promotion
means the behaviour lands in `src/` *as a test*, not as pasted probe code. Probes are
never deleted; they are marked `promoted` and kept as archaeology.

## Commits

Small, single-purpose. Conventional-ish prefixes (`feat:`, `fix:`, `chore:`, `docs:`,
`test:`, `refactor:`). Every commit must leave `npm run check` green.

### Optional pre-commit hook

```sh
git config core.hooksPath .githooks
```

Runs `node build.mjs check` before each commit.
