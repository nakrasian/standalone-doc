# Changelog

## Unreleased — fragmentation (flag off)

The pagination cycle: a paragraph can cross a page boundary without becoming two
paragraphs. The work is on `feat/pagination-split` and the flag is off in the
shipped document until a mode decides to turn it on.

### Added

- **A page break inside a paragraph is a sibling `<span data-frag>` in the same
  `<p>`**, not a second `<p>`. `Range.extractContents()` moves the tail so
  nested inline markup (a link, an `<em>`) survives; the span is
  `display: block` and is pushed to the next page's content top with
  `margin-block-start`. N cuts are *sibling* spans, never nested, so page
  pushes do not compound. The text stream, the paragraph count and the undo
  snapshot are unchanged.
- **The planner measures the semantic document.** A fragmented block is taller
  than the text it holds, so a pass merges before it plans and reports its own
  post-conditions (`checkPass`): text conserved, one fragment per planned cut at
  the planned offset, every tail within 1.5 px of the named page content top,
  `from/to` meeting across N+1 items, no orphan page-start margin, and every
  whole block on the page the plan named — or the numbers that disagreed.
- **A block table, not a set of tags** (`DEFAULT_STRATEGIES`): `p` is lines,
  `h1–h6` are whole, `pre`/`table`/`figure`/lists are atomic, `blockquote` is
  lines only with inline children, and an inline replaced element makes a `p`
  atomic. `pagination.defineBlock(tag, spec)` is the plugin seam.
- **Export parity.** `buildStatic()` unwraps the fragments and leaves one empty
  `.page-break-inline` span; `sd-export.lua` turns it into the target's native
  break (`w:br`, `#pagebreak()`, `\newpage`), so a `.docx` keeps one paragraph
  *and* the break. Page starts become an empty `.page-break` Div.
- **Live print matches the screen measure.** `[data-frag]` and
  `[data-page-start]` become block breaks, gaps reset, sheets hide, and `#stage`
  drops its 8.5 in screen width so the printable box is the same 6.7 in measure;
  `afterprint` re-plans at the restored viewport.

### Fixed

- **Deleting in a fragmented paragraph refills the page in the same pre-paint
  pass.** A block that got shorter is merged, re-planned and re-split inside the
  MutationObserver callback, so the next lines move up from the tail instead of
  waiting for an idle reconcile (which the next keystroke cancelled). A
  deletion that frees a page drops it in that same pass.
- **Every deletion gesture that touches a seam removes exactly its range.**
  Measured in all three engines: Backspace one character *before* the seam
  deleted two, Delete at or just before it deleted two in Chromium and WebKit,
  and a selection whose range reached the seam lost an extra character. The
  editor owns collapsed and selected Backspace/Delete when the range comes
  within one character of a fragment start.
- **Copy and cut across a seam carry no page furniture.** The browser serialised
  the fragment as a line break in `text/plain` and as a `data-frag` element with
  the page push in `text/html`; pasting it back inserted a paragraph break and a
  216 px gap. The payload is rebuilt from the text coordinate with the fragments
  unwrapped, and cut removes exactly the selection.
- **Page gaps are no longer rounded to whole pixels.** Half a pixel per page
  accumulated through the flow (3 px by page 36 in a 1,000-block document); the
  fractional plan value is used, and a reused cut is no longer re-measured with
  a full line walk on every pass.
- **A late scroll correction belongs to the pass that scheduled it.** A stale
  rAF correction from an earlier pass could restore an anchor captured before
  the reader moved, resetting `scrollTop`; a new pass cancels pending
  corrections, and only a pass that re-set the selection schedules one.

### Tests and size

132 unit tests and 633 browser tests (210 per engine, plus the three Chromium-only
clipboard cases) pass; the copy/paste and
visual specs are Chromium-only (clipboard permissions, Linux baselines). The
visual baseline is generated on the CI runner and cached there, not committed:
a page screenshot is platform-specific. On a 1,000-block document a delete at
the seam costs ~12 ms in Chromium (~3 ms on a three-block document); the browser
suite asserts a generous budget so a pass that re-walks the document per
keystroke fails.

## v0.9.1 — 2026-11-18

The page gap stops being a node in the document, and the exports learn the same
vocabulary. This is the Gate 0 sweep plus the margin model; no comment or
fragment work is in it (that stays on `feat/pagination-split`, flag off).

### Added

- **The page gap is a margin on the first block of a page** (`data-page-start`),
  not a `.page-spacer` node. Every engine reported the spacer inside a
  cross-block selection as a **948 px** rect — a highlight painted across a page
  of white space — and removing it under a live caret moved the block a page and
  scrolled the viewport (**+882 / +490 / +1097 px** in Chromium / WebKit /
  Firefox). A margin is invisible to the plan (`measureH()` excludes margins)
  and to a selection. The plan's arithmetic is unchanged; only the realisation
  moved. `applyGaps()` writes a value only when it differs by more than 0.5 px,
  so a no-op pass rewrites nothing.
- **`src/layout.js` — one coordinate space.** A client rect becomes stage-local
  layout px in one place (minus the stage origin, divided by zoom); pagination,
  the page edges and the folio use it. Three origin bugs of the same shape were
  found in the lab; a property test now asserts that scrolling and zooming do
  not change a layout coordinate.
- **`pageTops` / `pageBottoms`** on every plan: the content edges a comment
  overlay — or a later fragment pass — must agree with.
- **Page breaks in pandoc exports after the margin change.** `buildStatic()`
  inserts an empty `.page-break` Div before each page start and removes the
  attribute; `sd-export.lua` converts it to the target's native break
  (`<w:br w:type="page"/>`, `#pagebreak()`, `\newpage`). The HTML reader drops
  attributes on a `<p>` and strips the `data-` prefix elsewhere, so an attribute
  could not be the only route.

### Fixed

- **The static document carries no page furniture.** `buildStatic()` removed
  chrome by id only, so a `.docx` exported from the editor carried `#sheets`'
  folios (pandoc turns them into paragraphs) and any
  `[data-runtime="ephemeral"]` node inside `#content`. The second sweep is
  `session.strip()`'s selector set — one list, three callers (save, print,
  export). The committed test `a .docx carries the document, not the session`
  asserts all four sentinels end to end; a second test asserts the number of
  Word page breaks equals the page-start blocks on screen.
- **The save path strips page geometry too.** `session.strip()` and the undo
  snapshot clear `data-page-start` and its margin; a saved document carries the
  authored blocks, and pagination recomputes the gaps on load.
- **The viewer save test parses the file instead of text-searching it.** The
  saved copy carries every inline asset's source, so a selector or a comment
  mentioning `.page-spacer` is not a page spacer — the assertions now use
  `DOMParser`.

### Tests and size

113 unit tests and 468 browser tests pass (156 per engine). Against `v0.9.0`,
`index.html` grew 13.2 KB (2.8 %), all of it the margin model and
`src/layout.js`. `dist/slim.html` gains one fetched asset (`layout.js`).

## v0.9.0 — 2026-11-18

One dialog, one honest manifest per flavour, one update path — and a boot dialog that shows the
half of boot that was silent (Phase 7's B, C and D, measured in `lab/013`–`lab/015`).

### Added

- **The release purge is one command** (`node build.mjs purge [tag]`, `--main`, `--dry-run`).
  `release` used to print a 32-path `for f in …; do curl …; done` whose list was typed out beside
  the manifest it came from; the paths are now one function (`publishedPaths()`, used by both
  commands), the purge runs four at a time, reports each path (`ok` / `throttled` / why) and
  exits non-zero if any did not settle. `--main` purges only the two mutable catalog files, which
  is usually all a release needs — an exact tag's bytes cannot go stale, and the reason to purge a
  tag is a *failed* fetch the CDN cached. Two things the endpoint teaches, recorded in the help
  and the README: it answers `{"status":"finished"}` for a path or ref that does not exist (a purge
  validates nothing — `verify-cdn` does), and it reports `throttled` per path because jsDelivr
  caches a repository's version list for up to ten minutes after a tag appears.

- **The boot dialog shows the fetch, not just the build.** `boot()` reported construction and
  said nothing during the fetch, which on a slow link is 99 % of the wait: `lab/013` measured
  4,331 ms of silence out of 4,358, with the bar flat at 0 % for all of it, while construction
  cost 27 ms. The rows now come from `registry.planned()` — every asset the document boots, not
  just the modules — and are painted from the browser's own resource timeline
  (`performance.getEntriesByType("resource")`, which jsDelivr lets us read: `timing-allow-origin:
  *`). No registry event was added: an event would be a second truth for the same fact. The bar
  models phases (fetch 0–0.6, construct 0.6–1) so the construct handler cannot walk it
  backwards. `#boot-dialog` now states invariant 16 once instead of four times.
- **One document dialog with five panels.** Document settings and the Plugins sheet were two
  windows over one file's decisions. They are now one dialog — Document, Storage, Runtime,
  Plugins, About — with one draft and one Done. The Plugins panel is a host element filled by
  `plugins.js` on first activation (order 95 > 90, reached through the optional edge), so the
  catalog is still read only when an author asks for it. The tab stops offering what the door
  would refuse, and the About panel reads its numbers and the diagnostics report from the
  registry (`registry.diagnostics()`, which the failure card's *Copy* now uses too — one
  implementation).
- **An update path, in one place.** `registry.compareUpdate()` answers "what would an update
  move?" for both callers: the failure card (applies at once — a failed boot has no toolbar)
  and the Runtime panel (drafts, because a pin is a document fact). The two had duplicated the
  plumbing *and* disagreed about what "could not read the index" means; `readable` is now a
  separate answer from `newer`. Only `mode: online` assets move, as before.
- **Plugin updates live on the plugin's row** (see `docs/PLUGINS.md` §7). The catalog's version
  is compared per plugin, the row offers *Update to x.y.z*, `enabled` survives, a same-level
  island does not re-ask, and a same-version-different-`sha384` is reported as *Bytes differ* —
  a substitution, never an upgrade. The tab label carries the count, so the Runtime panel
  *notices* and the row *acts*.
- **An optional in-file plugin catalog** (`manifest.json` → `"pluginCatalog": true`). The block
  is generated from `plugins.json`, carries the `tag` it was taken at, and `check` refuses one
  that is missing when asked for, present when not, or taken at a different tag than the
  document pins. A bundle's `manifest` stays relative, so a snapshot rides the tag the document
  pins. The Plugins panel names a stale snapshot and offers **Refresh** (one request, a
  document change). Off for this repository, on for a distribution that ships plugins.
- **`registry.planned()`** — the assets this document will boot, in manifest order — so the
  loader and the boot UI cannot disagree about the plan. `start` now reports assets and fetched
  counts beside the module list.

### Fixed

- **Every flavour's manifest describes its own body.** `buildViewer` inherited `mode: "inline"`
  for the assets it stripped, so `dist/viewer.html` declared 26 inline assets and carried 14
  blocks: **238.6 KB of claims about bytes the file does not have**, and zero `absent`
  declarations anywhere in the repository. Stripped assets are now written `absent` (what
  invariant 19 says the word is for, and what the export path already did), and `check` fails
  when an `inline` asset has no block or an `absent` one still has its block. Every
  size-by-mode reading — including the ones in `lab/014` — was measuring that lie.
- **The Plugins panel is styled by its own rules.** The `ps-*` rules were scoped to
  `[data-plugin-panel]` — which is the attribute a *plugin's panel button* carries, not the
  panel host — so the panel rendered unstyled and menu buttons inherited its grid. They are
  scoped to `[data-dd-plugins]`, and a browser test asserts two computed values that can only
  come from the panel's own rules (`lab/014`'s lesson in miniature: a scope is a claim).
- **A bundle is measured in MB.** `sizeLabel()` stopped at KB, so the 87 MB pandoc bundle read
  `85154 KB` in *Available*. It switches unit at 1 MB.
- **`catalogBlock()` no longer treats `{}` as a catalog.** A parseable block with no tables won
  over the network and showed an empty *Available* list, which reads like "nothing is
  published". It now falls through, and a snapshot from another tag says so.

### Size

Against `v0.8.2`: `index.html` grew 24.4 KB (5.5 %), `dist/editor.html` 25.4 KB (5.8 % — the
same code, plus the inline assets), `slim.html` 6.4 KB (8.1 %), `viewer.html` 6.7 KB (3.5 %).
Honest accounting: ~10 KB is the new UI (five-panel shell, about, author, plugin updates,
catalog refresh), ~6 KB is the per-asset boot rows (`slim`'s growth is almost entirely
`registry` + `boot-ui`, which are inline in every flavour), and the rest is documentation
comments in the CSS and the modules. The *dedupe* this cycle was smaller than planned: the
plumbing behind an update is ~30 lines, and the 3.4 + 6.8 KB that `lab/014` priced were UI and
recovery logic that cannot be shared, not plumbing. `check` warns about the drift (a warning by
decision); `size-baseline.json` is re-seeded at this tree.

## v0.8.2 — 2026-11-18

### Fixed

- **The Word reference document is fetchable again.** `reference.docx` was published at a
jsDelivr url that answers `403`: jsDelivr refuses a list of extensions, and `.docx` is on it.
Nothing was broken loudly — the asset is a `bin`, so it is never built with the plugin, and the
plugin wraps it in `optionalBytes()` — which is exactly why it went unnoticed from v0.7.0 to
v0.8.1: every Word export quietly fell back to pandoc's default reference document instead of
the one this repository ships. The same bytes are now published as `reference.bin`; the plugin
still writes them into the wasm FS as `reference.docx`, so the output is unchanged and correct.
`verify-cdn` found this on v0.8.1 (the bundle pass added in v0.8.1 checks plugin assets, which
`manifest.json` never listed), and `bundleProblems()` now refuses a jsDelivr pin at a blocked
extension — or at no extension at all — so the next one fails at build time, before a tag.

## v0.8.1 — 2026-11-18

### Added

- **The published plugin is discoverable.** `dist/registry.json` now carries a `bundles` section
beside `assets`: one entry per published plugin manifest, naming its path (relative to the
catalog's own directory, so an install rides the tag the *document* pins), its size, and its
own `sha384`. **Plugins → Available** lists it and installs it in one click — N asset entries
and one `plugins` entry — instead of asking an author to copy JSON out of a README. The
section is generated from the same `published()` bytes as the manifest, so the advertised hash
and the pins cannot drift apart; `check` fails when a manifest in `dist/plugins/` is not named
by the catalog, when the catalog names a bundle nothing publishes, or when a manifest's pins
no longer match the bytes beside them.

### Fixed

- **`plugins[id].api` survives an install.** The published manifest declared its host API and
both install paths dropped it, so the field existed only in the artifact. It is now written
with the pin, and a manifest that needs a newer host is refused before anything is added.

- **`verify-cdn` checks plugin bytes.** It fetched the runtime and the documents but not the
plugin assets (they are not in `manifest.json`'s table), so a release could verify green while
a first export 404'd. It now fetches each bundle manifest, checks it against the catalog's
hash, then checks every asset whose url this repository serves.

- **`release` purges `dist/registry.json`.** The catalog is fetched from the document's own tag
and from `@main`; both paths were outside the purge list, so a new release could keep offering
the previous catalog for hours.

## v0.8.0 — 2026-11-18

### Added

- **A document can name the library it lives in, and Save obeys.** `#doc-settings.cloud` is
`{id, api?}`; when it is present, the save sink PUTs the serialized document to that object
instead of downloading a file, and the JSON door treats a followed redirect as what it is —
an Access login page arriving with status 200 — rather than as a successful save. Absent or
malformed, the field means "a file", which is what every document written before it existed
is, so nothing migrates and the button keeps its old meaning on disk. The endpoint is stored
relative on purpose: a document copied to another host must not drag the old origin with it.

- **The library chooses the save policy.** A hosted document keeps its assets `online`
(`slim`), because one runtime serving many documents is the only reason to host the runtime
at all: a save that inlined everything turned a 77 kB document into 400 kB, which is five
times the storage, five times the transfer, and no shared cache. A file still gets whatever
policy its author chose — the sink decides, not the document.

- **A viewer is an export, not a mode.** File → *Save as… → HTML → Viewer (read-only)…* builds
a copy with `serialize()` pointed at `mode: "view"`, carrying the two choices that belong to a
copy rather than to a file: **show chrome** (the reader's bar) and **loading** (inline, smart or
slim). It is then downloaded, or sent to the library as a link — the same copy, two
destinations. Not a flag on the private file and not a mode flip on the stored bytes: a save in
edit mode marks the viewer's assets `absent` (`policy.js`), so a flipped copy boots into the
failure card. The copy leaves `cloud` behind, so a reader who saves it as an editor writes a
file rather than overwriting the original.

### Fixed

- **A save no longer erases the other mode's declaration.** The mode gate marked every asset the
current mode does not use as `absent`, so an edit-mode save destroyed the pin of the viewer's
assets — and an edited document could never be exported as a viewer afterwards, because there was
nothing left to fetch. `absent` is the author's word ("removed"); assets outside the mode leave
the file and keep their declaration, which is also how the build flavours already describe
themselves. An *export* asks for the other behaviour (`absentOutside`), because a copy that is
handed to a reader should not be flippable back into an editor by editing one field.

- **A copy re-opened from disk is a file.** `cloud.api` is relative, so it is only
addressable from an http(s) origin — but the field travels with the document, so a copy
downloaded from the library kept it, showed a *Copy to library* button that could only fail,
and routed ⌘S into a PUT to `file:///api/docs/<id>`. A downloaded copy could not be saved at
all, and said nothing while it did not. The sink is now derived from the document *and* the
origin: on `file://` the field still says where the document came from, and the document
behaves as the file it is.

- **"Save as… → HTML → Interactive" is a file, wherever the document lives.** It shared the
save sink, so on a hosted document it PUT to the library instead of downloading — and inherited
the library's `slim` policy, which produces a copy that needs the network to open. The export
now asks for the file destination explicitly, and keeps the author's policy.

- **A view-mode document paints only the chrome its mode builds.** `apply-settings` hid the
viewer's bar outside view mode; the reverse was missing, so a document carrying the editor's
ribbon inline and switched to view mode painted dead furniture next to its own bar.

### Changed

- **Document settings no longer offers a mode.** The control could only ever turn an editor into
a viewer, and a view-mode save drops the editing assets from the file — with no way back but an
older copy. `editable` and `toolbar` remain, because they restrict a file that is still an
editor. `mode` is still read from `#doc-settings` (every saved viewer depends on it) and still
written by the build flavours; it is simply not something this sheet can set.

## v0.7.0 — 2026-11-17

The release where a document can leave the editor: Word, a typeset PDF, Typst and Markdown,
converted by pandoc in the tab or from a command line, with the result *audited* rather than
hoped for — and with the exporter itself published as a plugin a document can install.

### Added

- **An exporter, as a plugin and as a command.** `Save as… ▸ Word (.docx)…` converts in the
  tab: the document's own `materialize()` captures its figures, one Lua filter
  (`tools/sd-export.lua`) teaches pandoc this editor's vocabulary, and a census compares the
  materialized DOM with pandoc's AST so a missing figure or a flattened list is a *failed
  export*, not a quiet one. `npm run export -- doc.html --to=docx,typ,md` is the same pipeline
  from a shell, with `--dry-run`, `--keep`, `--audit=warn`, `--on-missing=fail` (default) and
  `--engine=native|wasm`. `pandoc-wasm` is a devDependency, so the CLI needs no install; a
  pandoc 3 on `PATH` is faster and is the only engine that can hand a PDF to a typesetter.

- **A typeset PDF, and two PDFs named for what they do.** `pandoc → .typ → typst.wasm → PDF`,
  figures included: 1.5 s for a document with a figure, against a 27 MB compiler pinned as a
  `bin` asset and fetched on the first PDF. The browser's own dialog stays and is now
  `Print (standard)…` / `Print (captured figures)…` — instant, the reader's fonts, its headers
  — beside `PDF (typeset)…`, which brings the template's page, embedded fonts and captured
  figures. Same menu, three entries, no ambiguity about which one you are getting.

- **The exporter is published, and a document installs it from a manifest.** `npm run build`
  writes the plugin into `dist/cdn/plugins/pandoc-export/` and
  `dist/plugins/pandoc-export.json` — id, kind, order, size and sha384 for eight assets. Three
  are npm pins (58 MB of pandoc, 27 MB of typst, its 211 KB bundle): the hash is the promise
  and the url is only the address, the arrangement `plugins.json` already uses for nanoid.
  Installation is copy-and-paste, and it is tested that way: the spec installs from the
  published file, exports a `.docx`, and asserts every declared size and hash against the
  bytes at that url. `check` fails when the files or the manifest are stale.

- **An export of the same document twice is the same bytes.** A docx carries the clock twice —
  every zip entry's DOS timestamp and `docProps/core.xml` — and pandoc writes both from the
  wall clock: two runs differed in 4 968 of 11 733 bytes. `tools/reproducible.mjs` rewrites
  the archive instead of asking the writer; `SOURCE_DATE_EPOCH` is honoured too, which the
  browser now passes because the WASI glue is ours (`pandoc-wasm` instantiates it with
  `env = []`).

- **The look, as two artefacts.** `npm run reference` derives `tools/reference.docx` from the
  engine that will use it — a document that exercises every style, then the style bodies that
  carry the look are replaced and the page pinned in its section properties. Word styling has
  no other mechanism, and we had none: the exported docx carried no `pgSz` at all. It carries
  Letter, 0.9 in, Georgia 11 pt, Title 26 pt, captions centred 9.5 pt. `tools/sd-template.typ`
  states the same page, written without pandoc's new `conf` module so an upgrade cannot
  quietly change it.

- **`host.use("materialize")` — a plugin's one way in.** The editor owns figure capture and
  chrome removal, and a plugin could not reach the result. It can now ask for the captured
  document, with the host's progress dialog and abort, and gets `{html, files, problems}`
  rather than an exception — whether a placeholder is fatal is the caller's contract. A
  plugin may be an exporter; it may not become the export menu.

- **An export contribution may return `bytes`, and `extras`.** A `.docx` is a zip: as a string
  it would be a lie. A `.typ` or `.md` names its figures, so those travel beside it and the
  host downloads each one — which is what "one document" means for a text format.

- **`bin` is fetched only when `host.bytes()` asks.** `buildPlugin()` used to fetch and
  construct every online asset of a bundle, so a plugin carrying a compiler paid for it on
  load. That one rule is why a 58 MB engine could be a plugin at all.

- **`npm run demo`** writes a document with the exporter installed, so any of this can be
  clicked through by hand.

### Fixed

- **The browser's .docx contained the Typst template.** The plugin attached the look per
  *document* rather than per *writer*, so `--template sd-template.typ` reached pandoc for docx
  too — and the docx writer writes whatever template it is given into `word/document.xml`.
  Word offered its text-recovery converter. The file was a valid zip with a media part and a
  part called `document.xml`, so the old test passed; a container is not a document. The test
  now inflates `word/document.xml` and asserts `<w:document`, `<w:pgSz` and no `typst`.

- **A refusal was a console line.** A declined export (`figure has no captured source`) wrote
  to the console and nothing else — "I clicked and nothing happened". It is now a host-owned
  dialog, marked `data-plugin-ui` so a save drops it.

- **A static export carried the viewer bar.** `buildStatic()` removed the editor's chrome by
  id and `#viewer-bar` was never on the list, so exporting `index.html` — which holds every
  mode's chrome — printed a reader's bar into the document (1 034 words of it, per the audit).

- **A CSS comment that named `<script>` swallowed the document.** A note in
  `viewer-bar-styles.css` quoted the tag inside `/* … */`; a browser is untroubled and pandoc
  treats everything after an unclosed `<script` as script text, so the export became two
  paragraphs of CSS. Reworded, and `tools/export.mjs` refuses a materialized document whose
  `<script`/`</script>` counts disagree.

- **The dev server served `.wasm` as `application/octet-stream`**, so
  `WebAssembly.instantiateStreaming` refused a 200 response. It now sends
  `application/wasm` (and `.mjs`), which is the least a server that exists to be fetched from
  can do.

### Size

index 412.7 → 419.3 KB · editor 400.3 → 406.9 KB · viewer 182.8 → 183.4 KB ·
slim 77.1 → 77.6 KB. Nothing here is in a viewer: the exporter is `requiredBy: ["edit"]`,
and `slim.html` fetches it rather than inlining it. The loader's two `kind !== "bin"` guards
are the only cost every flavour pays, because the thing that verifies hashes cannot be a thing
that might fail to arrive.

## v0.6.2 — 2026-11-17

### Fixed

- **A block painted its own source when its id was shared.** An asset block is found by its
  id (`script[id="<assetId>"]`), and `viewer-bar-markup` gives its root the same id as the
  `viewer-bar` script. `#viewer-bar { display: flex }` matched the `<script>` as well as the
  bar, outranked the UA sheet's `script { display: none }`, and painted the module below the
  toolbar — provenance header first, so it read as a stray `/*@compiled-from …*/` note — in
  `index.html`, in every viewer file, and in every copy either one saved. The viewer bar's
  sheet is now qualified `header#viewer-bar`, and `page-styles.css` states the general rule
  (`script, style { display: none !important }`) so no stylesheet can make text of a block.

### Size

index 411.2 → 412.7 KB · editor 399.6 → 400.3 KB · viewer 181.4 → 182.8 KB · slim unchanged
(the viewer's bar sheet is `mode: online`, so a viewer pays for the qualifiers; an editor
pays only for the one general rule).

## v0.6.1 — 2026-11-17

### Fixed

- **`index.html` painted two bars.** The source document carries every mode's chrome — a
  flavour carries only its own — so opening it directly showed the viewer bar under the
  ribbon. `apply-settings` now hides chrome the document's mode does not own, which also
  covers a hand-edited copy that kept a block it will never run.
- **`[hidden]` lost to `#viewer-bar { display: flex }`** as well as to the button rule fixed in
  v0.6.0. One rule now covers the bar and its children: an element-selector `display` always
  outranks the UA sheet's `[hidden] { display: none }`.

### Size

editor 399.3 → 399.7 KB · viewer unchanged · no new assets.

## v0.6.0 — 2026-11-17

The release where a reader, not only a broken document, can move a file forward — and where
the two save paths stop being two.

### Added

- **"Check for updates…" in Document settings.** The failure card repairs a document that
  cannot boot; this does the same move on purpose. It reads the release index (the authored
  `catalog`, or the tag's moving sibling), finds `latest`, and offers it as a *draft*: nothing
  is written until **Done**, failure is total (no index, no offer, no change), and the note
  says which window keeps which runtime. Only `mode: online` module assets move — inline
  hashes still describe bytes the file has, and a plugin's bytes stay its author's. A dev
  base has no moving sibling, so the button says so instead of offering a press that can
  only fail.
- **A reader can hide the bar while reading.** Session-only: the bar collapses to a restore
  button (never a dead end), and a saved copy carries the bar back, because `session.strip()`
  removes the attribute from the clone. `#doc-settings`'s `toolbar` is the document's answer;
  this is the reader's, and it does not travel.
- **`docs/MANIFEST.md`** — the counterpart to `docs/PLUGINS.md`: every field of the three JSON
  blocks, who writes it, what is authored vs derived vs preserved, the compatibility shims,
  and the one caveat about tag trees.

### Changed

- **One save list, two savers.** `src/session.js` owns what a document must not carry out of
  the session that rendered it; `toolbar.serialize()` and the viewer bar both call it, and
  `validate()` checks the output against the same rules. It had already drifted: the viewer
  dropped the boot phase and open dialogs, the editor kept them, so the same document differed
  by which flavour saved it.
- **A plugin a figure needs cannot be saved as `absent`.** `policy.target()` clamps the
  override, and the sheet stops offering the choice; before, Document settings could produce
  a file the Plugins sheet refused to produce, with the same broken figure at the end.
- **A plugin's row in the sheet uses its label** (`Plugin · Whiteboard`) when the file declares
  one, instead of the asset id.
- **Figures are not tab stops.** `tabindex="-1"` on every figure: a `contenteditable="false"`
  subtree inside an editable region is focusable in Firefox, so Tab used to walk into each
  figure. The caption stays reachable.

### Removed

- **The `toolbar` contribution kind.** A plugin could declare one, which forced a boot build
  and rendered nothing. `UI_KINDS` and the catalog validator both refuse it now.
- **`dist/cdn/doc-settings.js`** — a stale copy of an asset that no longer exists.

### Fixed

- **`hidden` did nothing inside the viewer bar.** `#viewer-bar button { display: inline-flex }`
  beat the UA sheet's `[hidden] { display: none }`, so anything hidden in the bar still
  painted. One rule states the intent.
- **A view-mode copy of `index.html` could not boot offline.** The bar is `mode: online`, so a
  view copy fetched it from the pinned tag — correct for a released tree, a fixture bug for a
  tree that is ahead of its tag. The test builds a self-contained copy instead, which also
  removed a hidden dependency on jsDelivr.

### Size

editor 388.8 → 399.3 KB · slim 76.7 → 77.1 KB · viewer 174.2 → 180.8 KB. The session list
(3.2 KB, one copy instead of two) and the bar's reading control are the additions; the editor
still leaves out 11.2 KB of view-only chrome.

## v0.5.1 — 2026-11-17

A patch that trims what an editor carries and makes the release gate tell the truth. No
document behaviour changes; a viewer keeps its bar.

### Changed

- **The viewer bar is offloaded in an editing document, not carried.** Its three assets are
  `mode: online`, and `dist/editor.html` is now the canonical document *restricted to the mode
  it runs*: an asset only a viewer builds leaves the file, with `url` + `integrity` kept, so an
  editor pays nothing for chrome it never shows — **9.5 KB lighter**. `dist/editor.html` is
  therefore no longer byte-identical to `index.html`: `index.html` is the source of every
  asset and a flavour is a mode. A document switched to view mode fetches the bar from its pin.
- **`toolbar` is not clamped by mode.** The settings sheet used to force `toolbar: false` (and
  disable the control) in view mode, on the assumption that a viewer has no chrome. It has one
  now, so switching a document to view keeps the setting instead of silently stripping the bar
  from the copy you save. The row reads "Show chrome".

### Fixed

- **`verify-cdn` judged the working tree.** It compared HEAD's `manifest.json` against the
  tag's bytes, so the nightly job went red the moment `main` moved ahead of a release, for
  reasons that had nothing to do with the CDN. It now verifies what the *tag* published — the
  tag's own manifest, the tag's own documents.

### Added

- **`node build.mjs release <x.y.z>`** (and `--dry-run`): refuses a dirty tree, a taken tag, a
  version that is not newer, or a missing CHANGELOG section; bumps `cdnBase` and
  `package.json`; runs combine → build → catalog → `report --baseline` → check; then prints the
  tag, the push, the jsDelivr purges a brand-new tag needs, `verify-cdn --tag`, and the
  post-tag catalog commit.
- **`check` warns when `dist/cdn` differs from the tag it pins** — the state in which
  `dist/slim.html` cannot boot until you release, or `build --base` for a dev copy. A warning,
  not a failure: being ahead of the tag is what work in progress looks like.

### Size

editor 398.1 → 388.6 KB (−9.5 KB: chrome an editor never builds). slim and viewer unchanged;
a viewer still carries the bar inline, which is what keeps it offline.

## v0.5.0 — 2026-11-17

A read-only document now has chrome of its own: a folio that knows the page, a save, and
settings a reader can act on — and, because of it, a repaired viewer can keep its repair.

### Added

- **The viewer bar** — `viewer-bar-markup`, `viewer-bar-styles`, `viewer-bar`
  (`requiredBy: ["view"]`). The editor's minimal silhouette in 34 px: folio, centred title,
  *Save a copy*, and a settings popover with mode, pages, pinned runtime and zoom. It carries
  its own ~3 KB of CSS because `toolbar-styles.css` is edit-only and 30.5 KB, and a viewer must
  not pay that to show two buttons.
- **A real current page.** `pagination.pageAt()` answers which sheet covers the viewport's
  centre (not its top: a tall figure can fill the top while the reader is still above), and
  `pagination.syncFolio()` writes every `[data-folio]` on a rAF-throttled scroll tick. The
  editor's minimal bar shows a live `p. 3 / 12` for the first time — it had been static markup —
  and a viewer's bar reads the same element.
- **Save from a viewer**, which is the reason for the bar: 6a's repair card asks whether a
  `[data-save]` exists before promising "save the file to keep this update", so a viewer with a
  Save button is a viewer that can keep a repair. A viewer's save is a download — a read-only
  document cannot write the file it came from.

### Changed

- **The save policy has one row per capability** — Base view, Editor, Viewer — instead of folding
  everything non-base into "Editor". An editing document is therefore offered the Viewer row,
  absent by default: the bar is chrome it never builds, and the author can now see and price it.
- **`settings.toolbar` means "show chrome"**, not "show the editor toolbar":
  `authored.toolbar ?? (mode !== "view")`, and `buildViewer()` authors `true`. A viewer saved
  before this release never authored it, so it keeps its chrome-less look.
- **A figure is selectable only in edit mode.** `#figure-tools` is an edit-only fragment, so the
  outline a viewer used to draw promised actions that could not exist (lab/010, measured).

### Fixed

- **The save dialog's estimate subtracted a mode-driven `absent` twice.** Adding an asset a
  document does not build (the viewer bar in an editor) exposed it: the dialog now prices from
  "everything present in the file". *Keep inline* also means "nothing is fetched" rather than
  "every row is inline" — an absent row is a removal, not an offload.

### Size

editor 383.6 → 398.1 KB, viewer 161.4 → 174.2 KB, slim 75.4 → 76.7 KB. The bar is 7.9 KB of
markup, CSS and JS. An editing document carries it without building it, because `dist/editor.html`
is byte-identical to `index.html` and `index.html` is the canonical document — the author can drop
it with the Viewer row. A slim document pays 1.4 KB now, and fetches the bar (three files,
8.1 KB) only if it is saved as a viewer.

## v0.4.0 — 2026-11-17

A document whose pin no longer resolves can repair itself. The failure card offers the newest
release, re-pins what the document actually fetches, and retries — the reader's content never
leaves the screen.

### Added

- **Recovery in the failure card.** When boot fails with `integrity` or `http`, the card reads
  the runtime catalog and offers the release it names. Applying it fetches that release's
  manifest, rewrites `url`/`integrity`/`bytes` for the assets this document *fetches*, leaves
  `mode`, inline blocks and plugin pins untouched, and retries. A failed attempt restores the
  document's own pin. Nothing reaches disk until the reader saves, and a view-mode document —
  which cannot save — is told the repair lasts for this session.
- **`catalog` in `#asset-manifest`** (authored in `manifest.json`): where to hear about newer
  releases. Defaults to the base's moving sibling (`@main`), because a tag can only describe
  itself.
- **`build --base=<url> --out=<dir>`** builds the three flavours re-pointed at another base
  with `integrity`, `bytes` and every `mode` untouched — a hash never moves, only the address.
  It is what a development loop needs: `--base=http://127.0.0.1:8080/dist/cdn` plus
  `npm run dev` makes `slim.html` fetch the tree you are editing, before any tag exists.
  The flag refuses to write into `dist/`, because a committed document is a *release pair*:
  its base is a tag and its hashes are that tag's bytes. `check` now enforces the same rule
  from the other side — a `cdnBase` that is not `@vX.Y.Z` fails the gate.
- **A runtime catalog** (`dist/runtime.json` + `dist/runtime/<tag>.json`, `npm run catalog`),
  generated from the tags themselves: for every release, the `id`/`kind`/`bytes`/`sha384`/`url`
  of each reusable asset. This is what a document diffs against to find a newer runtime, so it
  needs no 381 KB `editor.html` fetch and no HTML parsing in the trust path. Reading it from
  tags rather than the working tree is what keeps an entry from advertising bytes its tag
  never shipped. `check` fails on a stale or hand-edited entry, and on a file that describes
  no tag.

## v0.3.1 — 2026-11-17

### Fixed

- **A figure no longer ends the document.** A figure is `contenteditable="false"`, so with
  nothing below it the browser had nowhere to put the caret and the reader could not type
  under the last figure. `editor.insertBlock()` now leaves a text block after every atomic
  block it inserts, reusing the paragraph already there when the figure lands mid-document.

### Changed

- **`cdnBase` moves to `v0.3.1`.** Every flavour now pins that tag, so `dist/slim.html` and
  `dist/viewer.html` fetch the bytes this release contains. Documents saved before this tag
  are unaffected: a file keeps the pin it was saved with, and `v0.3.0` keeps serving v0.3.0.

## v0.3.0 — 2026-11-17

Documents can carry plugins: code a document pins, loads on demand, verifies before it runs,
and extends the editor with — and a catalog so an author can find one.

### Added

- **Plugins.** A document pins a bundle of assets (`url` + `sha384` each) plus a `plugins[id]`
  record, and builds it through `require()` when something needs it. Boot never builds a
  plugin, so a missing, damaged or switched-off plugin cannot stop a document opening.
- **The host contract.** `activate(host)` receives `api`, `plugin`, `text()`/`bytes()` for its
  own assets, `use()` for capabilities this document actually built (`figures`, `editor`,
  `status`), `track()` for cleanup the host guarantees, `settings()` and `manifest()`.
- **Contributions.** `insert`, `export`, `panel` and `command` are declared in the manifest and
  rendered by the host, which also performs the effect: inserting goes through the store, the
  editor and the dirty flag; export builds the Blob. A plugin extends the surface; it never
  occupies the chrome or the content.
- **The plugins sheet** (gear) — enable/remove, "used by N figures", the pinned assets, a
  catalog, and *Add from URL*. Installing pins `url` + `sha384`; inlining stays the save
  policy's decision.
- **A catalog**: `plugins.json` is authored, `dist/registry.json` is published at the tag, and
  the sheet reads `<cdnBase>/../registry.json` — so any saved document can ask what this
  runtime proposes. A document may also carry the catalog in `#plugin-catalog` and work
  entirely offline.
- **`bin` assets**, so a plugin can carry WebAssembly: base64 inline, `.wasm` by reference,
  sizes and hashes over the decoded bytes.
- **`__figureBytes(name)`** inside an island: a sealed island asks for its figure's declared
  assets by name and receives the verified bytes over `postMessage` — the sandbox keeps its
  no-network property and can still run a runtime.
- **Island profiles are enforced**, not advisory: `sealed` (no network, no storage, no parent,
  CSP including `'wasm-unsafe-eval'`), `sandboxed` (may fetch, no parent), `trusted`
  (`allow-same-origin` — author-confirmed once, reader-badged *runs unsandboxed*).
- `docs/PLUGINS.md`: the contract, in full.

### Changed

- **`policy` no longer decides a plugin by figure count.** A plugin's presence is its
  `enabled` switch; an installed plugin that contributes menus and is used by no figure still
  travels.
- **Labels come from the manifest** (`boot-ui` no longer carries a label map), and `retry()`
  re-scans figures, since a mounted figure is stale after a graph rebuild.
- `node build.mjs dev` sends `Access-Control-Allow-Origin: *`, so a `file://` document can be
  tested against local bytes (measured: a relative url is not portable, an absolute one is).

### Format

`schema: 1`, still preliminary. Additive: a `bin` asset kind, a `plugins` block in
`#asset-manifest`, `label`/`category`/`plugin` on asset entries, `island`/`assets`/`plugin` on
figure store entries, and `#plugin-catalog`. `#doc-settings` is unchanged.

### Size

index.html 293 → 372 KB (+27 %), slim 44 → 65 KB (+48 %). The plugin contract is
infrastructure: every document carries the loader that can run one.

## v0.2.0 — 2026-11-17

The document gains a settings sheet, and its own behaviour becomes editable without
hand-editing JSON.

### Added

- **Document settings** (gear in the toolbar, `Mod+,`): mode, content lock, toolbar,
  the size threshold, the storage preset and per-capability rows (inline / CDN /
  absent), and the load timeout. Behaviour applies on next open; storage applies
  when you save. Clicking the size readout opens the same sheet at Size & loading.
- **Chrome preference** is part of the file: `settings.ui` remembers ribbon vs
  minimal, restored at boot before first paint.
- The gear menu replaces the standalone keyboard-shortcuts button; it carries
  *Document settings…* and *Keyboard shortcuts*, and no Save.

### Changed

- **`timeoutMs` moved from `#asset-manifest` to `#doc-settings`.** A timeout is
  behaviour, not an asset. Documents saved before this keep their timeout: the loader
  falls back to the manifest's copy, then to 8000 ms.
- **The keyboard-shortcuts button folded into the gear menu**, in both bars.
- **The dirty dot is honest**: toggling the chrome no longer marks the file dirty, and
  neither does opening the settings sheet and pressing Done without changes. A plain
  save no longer invents `policy: "inline"` — a document that never chose a policy
  stores nothing, because inline is the default.

### Format

`schema: 1`, still preliminary. Two additive fields (`settings.ui`, `settings.timeoutMs`)
and one subtraction: `policy` is only written when it differs from the default.

## v0.1.0 — 2026-11-17

The first published runtime. `manifest.json.cdnBase` points at
`…/standalone-doc@v0.1.0/dist/cdn`, so a document saved by this version pins an
immutable tag and verifies every asset by SHA-384 before running it.

### What works

- **One file, self-saving.** `dist/editor.html` contains the editor, the content and
  every asset inline. It opens from `file://`, edits, and saves back to one file.
- **Two other flavours**, built from the same source: `dist/slim.html` (infrastructure
  inline, everything else fetched from the tag) and `dist/viewer.html` (view mode, the
  editing capability absent rather than offloaded).
- **A loader with a contract.** `boot()` reads the document's `#asset-manifest`, loads
  in parallel, verifies each hash, then constructs in manifest order. Failures are
  reported per kind (`offline`, `unreachable`, `http`, `timeout`, `integrity`,
  `import`, `missing`, `construct`) and fail closed: no partial boot, no "open anyway".
- **Document settings.** `#doc-settings` carries `mode` (`edit` / `view`), whether the
  content is editable, whether chrome shows, and the size threshold. The loader applies
  it; a hand-edited document cannot claim to be editable when the file says otherwise.
- **Document dependencies declared, not discovered.** Each asset declares the modes
  that need it, an optional back-edge is explicit (`deps.optional`), and the build
  audits the graph: a construction dependency must exist in every mode its dependent
  exists in.
- **Save policies.** `inline` (default), `smart` (body inline, authoring online) and
  `slim` (everything but the loader online), applied per asset. A save over the
  document's own threshold asks once, per capability, with measured sizes; "keep
  inline" is remembered until the file doubles.
- **Chrome as fragments.** The sprite, toolbar, figure tools and edit-only dialogs are
  `kind="html"` assets: markup that can be inline, fetched and hash-verified, or absent.
- **One global.** `StandaloneDoc`. Everything else arrives through the manifest.

### Format

`schema: 1`. **Preliminary.** Fields are added as phases land and there is no migration
contract yet; a document saved by this version opens in later ones, but a later document
may use fields this version does not know. `schema` becomes meaningful when the editor
is stable enough to promise migrations.

### Verifying a release

```sh
node build.mjs check                       # the tree agrees with itself
node build.mjs verify-cdn --tag=v0.1.0     # every published byte matches its hash
```

The second command is also a nightly job (`.github/workflows/cdn.yml`).

### Not in this release

- The plugin manager, and plugin discovery via a registry. A figure cannot yet require
  a plugin; when it can, the plugin's URL and hash will be pinned in the document that
  uses it.
- The `update-runtime` flow: a document can be re-saved with a newer pin, but nothing
  offers it.
- A settings panel: `#doc-settings` is edited by hand today.
- Public authoring docs for plugins and the manifest (`docs/`).
