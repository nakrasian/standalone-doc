# standalone-doc

A self-saving, single-file HTML document editor. You open one `.html` file, write in it,
insert interactive figures, and save it back to disk — no server, no install, no build
step required of the person reading it.

This repository hosts the editor source, the build tool that splits it into publishable
assets, and the runtime that lets a saved document carry its own dependencies either
**inline** (works offline, from `file://`) or **by reference** (small, CDN-hosted, pinned
and hash-verified).

## Compatibility promise

> A document saved by version *N* opens and edits correctly in version *N+1*.
> Saved documents pin the exact runtime code they were saved with, by URL tag plus a
> SHA-384 `integrity` hash. Running code never changes under a saved document unless its
> owner explicitly chooses to update it.

The manifest carries `"schema": 1`. Any change to that schema is a breaking change and
requires a major version bump.

## Quick start

No dependencies to install. Node 20+.

```sh
npm run verify      # round-trip check: index.html <-> src/
npm run check       # CI gate: verify + manifest schema + guarded-file scan
npm run build       # dist/editor.html + dist/size-report.json
npm run dev         # http://127.0.0.1:8080 — always use this for anything that fetches
npm test            # unit tests (node:test)
npm run report      # size table, per asset
```

## Repository layout

```
index.html          canonical editor. Hand-editable. Assets marked with @asset comments.
manifest.json       asset registry: id, kind, order, file, bytes, sha384, mode, requiredBy
build.mjs           split | combine | verify | check | build | report | dev  (zero deps)
src/                one file per asset, generated from index.html by `split`
dist/               build output (committed: the CDN serves these at a tag)
test/unit/          node:test suites
```

`archive/` (private, gitignored) holds docs, samples, experiments and the probe lab.
Nothing in it is referenced by the build. See CONTRIBUTING.md and `archive/README.md`.

## The asset model

Every stylesheet and script in `index.html` sits inside a marker pair:

```html
<!-- @asset id="page-styles" kind="css" order="10" -->
  <style id="page-styles">
    ...
  </style>
<!-- /@asset -->
```

`npm run split` extracts each body to `src/<id>.css|js` and records its hash in
`manifest.json`. `npm run combine` writes `src/` back into `index.html`. Both directions
are supported; CI fails if the two ever disagree, so neither is "the real one".

Assets have a `mode`:

| mode | meaning |
|---|---|
| `inline` | body is embedded in the saved document. Works offline from `file://`. **Default.** |
| `online` | fetched from a pinned CDN URL and hash-verified at load. Small file, needs network. |
| `disabled` | not loaded (blocked while a figure needs it). |

`requiredBy` lists the document modes that need the asset (`"*"` = always, `"edit"`,
`"view"`, `"comment"`), which is how a read-only viewer avoids downloading the editor.

Saving computes the size first. Under 2 MB everything stays inline; above that the editor
offers to offload core assets to the CDN, showing the exact saving.

## Isolation and the one global

Source modules are dependency-injected and contain **no `import` statements**:

```js
export function createFigures({ store, progress, loader }) { /* … */ }
```

That shape is valid as a CDN module (the loader `import()`s it and passes dependencies)
*and* as an inline classic script (the build strips `export` and wraps the body in a
closure — no bundler, no module graph, nothing to resolve). `file://` therefore never
needs to fetch a module. The only shared global is `globalThis.StandaloneDoc`.

## Status

Phase 0–1 complete (repository, markers, split/combine/verify). Phases 2–7 — module
conversion, the bootstrap loader and error diagnostics, save-time materialization, the
plugin manager, CDN publishing and the update flow — are specified in
`docs/` (private) and land incrementally.

## License

MIT.
