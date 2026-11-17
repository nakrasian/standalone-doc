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
7. dependency order comes from `manifest.json`'s `order`, not from source order;
8. factories take **one object**: `createX(deps = {})`, destructured inside the body.
   The signature *is* the dependency declaration: the build derives the graph from it
   and `boot()` injects exactly that list;
9. never write `"use strict"` in a factory. It is illegal beside a non-simple
   parameter list (`deps = {}` counts), and the envelope already applies it to the
   whole block. ES modules are strict regardless;
10. never reach another module through a global (`window.Figures`, `globalThis.Export`).
   Take it as a dependency or via `deps.late("id")`. Since Phase 3 nothing is
   published, and `lib/deps.mjs`'s `LEGACY_GLOBALS` map turns any such reference into a
   build failure instead of an edge that only works by luck of load order.

### The envelope

Converted assets are compiled into a classic script, because `export` is a syntax error
there and because a classic script keeps its parse-time position:

```html
/*@compiled-from src/signals.js — envelope is build-owned; edit the body or src/*/
(function () {
"use strict";
function createSignals(deps = {}) { … }      ← `export ` stripped
StandaloneDoc.register("signals", createSignals);
})();
```

The envelope lines are **build-owned**: change them by editing `src/` and running
`npm run combine`, or `split` will refuse with a message telling you so. The body is
yours, from either side. The IIFE keeps a duplicated block from clashing with the first
copy's declarations; `register()` is idempotent by id, so the first copy wins.

The registration carries **no metadata**. Order, dependencies, late edges and mode live
in the in-document `#asset-manifest`, derived from the signature at build time — one
source of truth instead of two that can disagree.

Assets with no `MODULES` entry pass through verbatim, so the transform can ship before
any asset changes shape.

**Changing a factory's signature changes the in-document manifest**, so run
`npm run combine` after touching it — `check` fails if the document's copy is stale.

**Document order is irrelevant.** `boot()` runs after parsing, so a module's markup may
sit anywhere; construction follows `manifest.json`'s `order`, which is why `progress`
(a dependency of `export`) is ordered before it even though its `<dialog>` sits late in
the body. Use `deps.late("id")` for a back-edge (editor → figures, toolbar → export) and
only call it from a function that runs after boot. When a cycle is only about a value
rather than behaviour, invert it instead: `status` takes its size estimate from a
callback that `figures` registers, so no edge exists.

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

Exploratory work lives in `lab/` at the repository root, which is **gitignored** and must never be committed.
The convention, if you keep one locally:

```
lab/NNN-slug/
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
