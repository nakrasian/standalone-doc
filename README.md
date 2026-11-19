# standalone-doc

A self-saving, single-file HTML document editor. You open one `.html` file, write in it,
insert interactive figures, and save it back to disk — no server, no install, no build
step required of the person reading it.

This repository hosts the editor source, the build tool that splits it into publishable
assets, and the runtime that lets a saved document carry its own dependencies either
**inline** (works offline, from `file://`) or **by reference** (small, CDN-hosted, pinned
and hash-verified). A document may also name a **library** it belongs to: then Save writes
back to that library instead of downloading, and a read-only copy of it can be published as
a link.

## Compatibility promise

> A document saved by version *N* opens and edits correctly in version *N+1*.
> Saved documents pin the exact runtime code they were saved with, by URL tag plus a
> SHA-384 `integrity` hash. Running code never changes under a saved document unless its
> owner explicitly chooses to update it.

The manifest carries `"schema": 1`. The format is still preliminary: fields are added as
phases land, and there is no migration contract yet. Once the editor is stable, `schema`
is what will identify a document that needs upgrading, and a bump will mean exactly that.

`cdnBase` is pinned to a tag (`v0.1.0`), never a branch. Branch URLs move, so a document
that pinned one would run different code after any commit — and jsDelivr caches branch
refs, so it would do so unpredictably. `npm run cdn:verify` fetches every published
asset at the pin and compares it with the recorded hash; `.github/workflows/cdn.yml` runs
it nightly.

A document's base and its bytes are therefore a *pair*: the hashes are the tree's, the URL
is the tag's, and the two only agree at the tag. `npm run build` alone produces documents
that are true only once that tag exists. To run the tree you are editing **before** it is
tagged, build against your own server instead — same hashes, different address:

```sh
npm run dev &                                                   # serves the tree, .test-tmp included
node build.mjs build --base=http://127.0.0.1:8080/.test-tmp/build/cdn
open .test-tmp/build/slim.html                                  # from disk, no tag involved
```

A `--base` build writes a *publication*, not just documents: the cdn bytes, `registry.json`,
and the plugin manifests, all re-pointed at the base, into `--out` (default
`.test-tmp/build`). That is what makes **Plugins → Available** work before the release — the
sheet derives the catalog url from `cdnBase`, so put the base's directory where the out
directory is being served (the command above does: `.test-tmp/build/cdn` → serves
`.test-tmp/build/`). Point `--base` elsewhere and the sheet reads *that* address's catalog,
which is usually the last release.

`--base` refuses to write into `dist/`, and `check` fails if `manifest.json`'s `cdnBase` is
not a tag: a local or branch base must never be committed, because every fetch from it
would promise bytes no server keeps.

### Finding a newer release

A saved document runs the release it was saved with and never changes under its reader. To
*find* a newer release it needs one address that is allowed to move, because the tag it is
pinned to can only describe itself. `npm run catalog` writes exactly that pair:

```
dist/runtime.json          the index — latest, and one entry per release (advisory)
dist/runtime/v0.3.1.json   that release's assets: id, kind, bytes, sha384, url, requiredBy
```

Both are generated from the **tags themselves** (`git show <tag>:manifest.json`), never from
the working tree, so an entry cannot advertise bytes its tag never shipped. The one entry
that comes from the tree is the release being prepared (`package.json`'s version has no tag
yet); once the tag exists both routes produce the same bytes. A shallow clone has no tags,
so `catalog` leaves the files alone and `check` says it could not verify them.

The catalog is advisory in the same sense as `dist/registry.json`: it costs convenience if it
lies or disappears, never correctness — whatever it names is still verified against the
hashes the document carries after re-pinning.

It is read from the base's moving sibling (`…@main/dist/runtime.json`) unless the document
names its own `catalog`. jsDelivr caches branch refs, so a fresh release can lag behind the
catalog until that path is purged — measured, and worth knowing before suspecting the code:

```sh
node build.mjs purge --main       # the two mutable catalog files
node build.mjs purge v0.9.0       # a release: its paths plus those two
```

Purging is a **cache** operation and nothing else: the endpoint answers `finished` even for a
path that does not exist, so it never tells you whether a release is correct. `verify-cdn` does
that. What a purge is for is the failure this repository has actually hit — a failed GitHub
fetch cached by the CDN, which serves one file as 404 while its neighbours are fine.

### The viewer's chrome

A `view`-mode document builds `doc-bar`: a 34 px bar with a folio, the title, *Save a copy*
and a settings popover (mode, pages, pinned runtime, zoom). It is the reason a repaired viewer
can keep its repair — the repair card promises "save the file" only when a `[data-save]` exists.
Its save is a download, because a read-only document cannot write the file it came from. A
reader can hide the bar while reading: it collapses to a restore button, and the choice is the
session's — a saved copy carries the bar back.

`settings.toolbar` decides whether that chrome shows (`"toolbar": true` in `#doc-settings`);
`buildViewer()` authors it, and a viewer saved before v0.5.0 never did, so it stays bar-less.
`#app-toolbar` — the editor's ribbon — is a different element and never exists in a viewer.

### Comments and review copies

Comments are content: `#comment-store` and the `data-bid` block ids travel in every file and
every export, and the mode decides only who may write them. A comment anchors one range over
the document's text stream, so it survives edits; a phrase that cannot be found falls back to
the paragraph, and a paragraph that is gone leaves the comment *unattached* rather than
dropped.

There are three writers, one per capability:

- **the editor** (`edit`, `comments: "write"`) — select text, then *Insert › Comment on
  selection…*; the Comments panel in Document settings lists the threads. The comment is
  signed with the file's `author`, asked once and saved in the document;
- **a review copy** (`comment`, `comments: "write"`, `edit: "off"`) — the text is locked and
  the one bar carries *Add comment*, the thread list and *Save a copy*. A reviewer's name is
  asked once and kept in the browser, keyed by the document — never written into the file's
  `author`;
- **a viewer copy** (`view`, `comments: "read"`) — markers and a read-only thread, no
  annotation affordance at all. A viewer exported with `comments: "off"` carries neither the
  store's module nor the bundle.

A copy never writes back to the file it came from (invariant 21): *Save a copy* downloads a
new file with the same `#comment-store`, and the overlay, composer and popovers are session
chrome that `session.strip()` removes from it.

**Making a copy.** *File › Save as… › HTML › Save a copy for someone…* offers the three kinds.
The one field that matters is **may take an editable copy**:

- with it, the copy declares `capabilities.edit: "copy"` and keeps the editor's *address*
  (`url` + `integrity`, a few kilobytes of JSON, no code). The reader's bar offers **Edit a
  copy…**; the modules are fetched, verified and built on request, the copy's mode becomes
  `edit`, and `capabilities.edit` flips to `"off"` so a copy of that copy cannot recurse.
  Choosing `inline` storage for this warns with the download size rather than refusing it;
- without it the copy is **sealed**: the editor's blocks are gone *and* their addresses are
  deleted, so nothing — including its author — can turn it into an editor.

**Reading comments.** A document with comments shows them in a **rail beside the page** (the
editor, a review copy and a viewer all use it): cards in document order, unresolved first,
resolved kept below. Hovering a highlight previews its card; clicking pins it until the reader
clicks away or presses Escape, and the highlight flashes once so the eye can find it. A
resolved comment paints **no highlight** — the record stays in the rail to reopen or delete.
Below 1180px there is no honest room for a 324px column beside an 8.5in sheet, so the same
card becomes a popover next to the marker. **⌘⌥M** (Ctrl+Alt+M) starts a comment from the
selection, in every mode; the editor also has *Insert › Comment on selection…*.

**Comments on their own.** *File › Save as… › HTML › Comments only…* writes the store in a
minimal document (a few KB), and *File › Import comments…* accepts either that file or a full
copy, parsed with `DOMParser` rather than searched. The import applies what is unambiguous
(new comments, appended replies) and lists every disagreement — `resolved` differing between
the two files — with *Keep mine*, *Take imported* or *Keep both*. Nothing is resolved for you,
a comment is never dropped, and a comment whose paragraph is gone is listed as *unattached*.

### A document in a library

`#doc-settings.cloud` is `{id, api}`. With it, Save PUTs the serialized document to that
object instead of downloading, and the sink — not the file — chooses the `slim` policy, so
one runtime serves every document in the library. Without the field the document is a file,
exactly as before: that is the field's whole compatibility story, and why nothing migrates.

The endpoint is stored **relative** (`/api/docs`) and is only addressable from an http(s)
origin. A copy re-opened from disk still records where it came from, but behaves as the file
it is — otherwise ⌘S would PUT to `file:///api/docs/<id>`, fail, and leave a downloaded copy
that cannot be saved at all. A signed-out save is a *failed* save, and the sink knows it by
the response's content type rather than its status, because Access answers an expired session
with a login page and a 200.

A viewer is an **export**, not a mode: **File → Save as… → HTML → Viewer (read-only)…**
builds a copy in view mode with the two choices that belong to a copy — whether it shows
chrome, and whether it carries its assets (`inline`, opens from disk) or fetches them (`slim`,
one shared runtime) — and then downloads it or sends it to the library as a link. It is never
a mode flip on the file you are editing: a view-mode save marks the editing assets `absent`,
and nothing in the editor can put them back. Document settings consequently offers no mode at
all. The copy carries no `cloud`, because a copy is not a source.

### Repairing a document whose pin no longer resolves

A tag can stop serving what a document pinned: a rebuild without a release, a force-moved
tag, a tampered CDN. The document's own failure is already on screen — the content is parsed
and rendered — so the failure card is where the way out lives (Document settings is
unreachable there: a failed boot injects no toolbar).

It offers the catalog's newest release when the failure is `integrity` or `http`, and applies
it like this: fetch that release's manifest, rewrite `url`/`integrity`/`bytes` **for the
assets this document fetches**, leave `mode`, inline blocks and plugin pins alone, then
retry. Nothing is written to disk until you save, and the card says so; a document that
cannot save (a viewer) is told the repair lasts for this session. If the new release does not
load either, the document's own pin is restored and the card says so — a failed update
changes nothing.

### Moving a document to a newer release, on purpose

The same move as the repair below, made from a document that works: **Document settings →
Runtime → Check for updates…**. It reads the release index, finds the newest release, and
offers it as a draft. Nothing is written until you press **Done**; fetching a release that
does not parse changes nothing. The pin moves for the *file*, not the window: this session
keeps the runtime it booted with, and the note says which is which. Only assets the document
fetches are re-pinned — an inline asset's hash describes bytes the file already has, and a
plugin's bytes stay its author's.

## Quick start

No dependencies to install. Node 20+.

```sh
npm run verify      # round-trip check: index.html <-> src/
npm run check       # CI gate: verify + manifest schema + guarded-file scan
npm run build       # dist/editor.html + dist/size-report.json
npm run dev         # http://127.0.0.1:8080 — always use this for anything that fetches
npm run cdn:verify  # fetch every published asset and check its hash (needs network)
npm test            # unit tests (node:test)
npm run report      # size table, per asset
npm run export -- doc.html --to=docx,typ,md    # tools/export.mjs — pandoc.wasm by default,
                                               # --engine=native for a pandoc on PATH
npm run reference                             # derive tools/reference.docx from the engine
```

## Repository layout

```
index.html          canonical editor. Hand-editable. Assets marked with @asset comments.
manifest.json       asset registry: id, kind, order, file, bytes, sha384, mode, requiredBy
build.mjs           split | combine | verify | check | build | report | catalog | dev  (zero deps)
tools/              export.mjs + sd-export.lua + the census: the document → engine path
plugins/            pandoc-export/: Word, PDF (typeset by Typst) and text, in the tab
src/                one file per asset, generated from index.html by `split`
dist/               build output (committed: the CDN serves these at a tag)
dist/runtime.json   releases a document may re-pin to; one manifest per tag in dist/runtime/
test/unit/          node:test suites
test/browser/       playwright suites (chromium, webkit, firefox)
docs/PLUGINS.md     the plugin contract: host API, contributions, islands, pinning
docs/MANIFEST.md    the three JSON blocks in a document: every field, authored vs derived
plugins.json        curated plugin catalog, published as dist/registry.json
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
offers to offload core assets to the CDN, showing the exact saving. A document that names a
library is the exception: the *sink* chooses, and a hosted document keeps its assets by
reference so one runtime serves every document there.

## Isolation and the one global

Source modules are dependency-injected and contain **no `import` statements**:

```js
export function createFigures({ store, progress, loader }) { /* … */ }
```

That shape is valid as a CDN module (the loader `import()`s it and passes dependencies)
*and* as an inline `<script type="module">` block: the build adds one comment line above
the body and one `StandaloneDoc.register(...)` line below it, so the block is the source
verbatim. Each block has its own scope, and `export` is legal — no bundler, no module
graph, nothing to resolve. `file://` therefore never needs to fetch a module. The only
shared global is `globalThis.StandaloneDoc`.

## Plugins

A document can pin a plugin — a bundle of assets with a `plugins[]` record — and load it on
demand, verified before it runs, with an in-place failure card when it is missing rather than
a broken file. Contributions (insert, export, panel, command) are declared in the manifest and
rendered by the host, so a plugin extends the surface without occupying it.

**Document settings is one dialog with five panels** — Document, Storage, Runtime, Plugins,
About. The pin, the storage decision and the plugin pins belong to the same file, so they are
one dialog with one Done: nothing but the plugin pins is written before it, and a plugin update
sits on that plugin's row, never in a runtime sweep.

**Plugins → Available** lists two shapes. A *module* is one self-contained ES file proposed by
`plugins.json`. A *bundle* is one plugin with many assets (the pandoc exporter: eight of them,
including two engines on npm), and there the catalog carries a pointer rather than a copy of
the pins: it names the published manifest and that manifest's own `sha384`, the sheet fetches
it, checks the bytes, then pins every asset it declares. One click, N assets, no JSON copied
by hand — and a manifest the catalog did not hash is refused before anything is written.

Read `docs/PLUGINS.md` before writing one. The three island profiles it describes are
enforced, not advisory: `sealed` has no network, `sandboxed` is today's figure sandbox, and
`trusted` lets a plugin's *content* reach the document — which asks the author once.

## Status

`v0.9.0` adds one document dialog, `absent` written by every flavour, a per-asset boot
progress line, plugin updates on the row, and an optional in-file plugin catalog. `v0.8.0`
brought: module conversion, the dependency contract and its audit, the
registry and `boot()` with diagnostics, the CDN loader, save-time materialization with
policies, the plugin manager, the update flow, a viewer flavour, export, and a library a
document can name — with the viewer as an export rather than a mode. Next is the host itself
(R2 behind Cloudflare Access): this repository knows how to talk to a library, not how to be
one. The file format is not frozen — see `CHANGELOG.md`.

## License

MIT.
