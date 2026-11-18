# Changelog

## Unreleased

### Added

- **A document can name the library it lives in, and Save obeys.** `#doc-settings.cloud` is
`{id, api?}`; when it is present, the save sink PUTs the serialized document to that object
instead of downloading a file, and the JSON door treats a followed redirect as what it is —
an Access login page arriving with status 200 — rather than as a successful save. Absent or
malformed, the field means "a file", which is what every document written before it existed
is, so nothing migrates and the button keeps its old meaning on disk. The endpoint is stored
relative on purpose: a document copied to another host must not drag the old origin with it.

- **The library chooses the save policy.** A hosted document keeps its assets `online`
(`slim`), because one runtime serving many documents is the only reason to host the runtime at
all: a save that inlined everything turned a 77 kB document into 400 kB, which is five times
the storage, five times the transfer, and no shared cache. A file still gets whatever policy
its author chose — the sink decides, not the document.

- **Publish a read-only link**, from File → *Publish a read-only link…* — `serialize()` pointed
at `mode: "view"`, POSTed, and shown as a copyable dialog. Not a flag on the private file and
not a mode flip on the stored bytes: a save in edit mode marks the viewer's assets `absent`
(`policy.js`), so a flipped copy boots into the failure card. The copy leaves `cloud` behind,
so a reader who saves it as an editor writes a file rather than overwriting the original. The
menu item is hidden when the document names no library (`html[data-cloud="off"]`).

## v0.6.2 — 2026-11-17

### Added

- **An export contribution may return bytes.** `export[id]()` could only return `text`, and
the host built `new Blob([text])` — which no binary format can survive. A `.docx` is a zip,
a `.pptx` a package, a `.pdf` a stream: as a string each would be a lie about what the plugin
produced, and as base64 the host's problem rather than the format's. A contribution now
returns `{name, mime, text}` *or* `{name, mime, bytes}`, and a contribution that returns
neither is refused with a sentence rather than an empty download. `bytes` widens nothing: it
is the same host-owned download, the same session's worth of no new global, and a file the
plugin never names twice. Measured by `test/browser/contributions.spec.js` — seven exact
bytes out, byte for byte.

- **A figure carries the width its author set, and says when it could not be captured.**
The static export replaced every figure with an `<img>` sized by the frame's CSS, so the
authored `data-w` (0.2–1) was silently dropped — the precise thing that a Word file, a Typst
file or a printed page needs in order to honour it. The image now carries `width="80%"`,
which is the one spelling pandoc, a printer and a browser all read. And `buildStatic()` used
to *clear* `data-missing` whether or not it had a capture, so a red "figure could not be
captured" card became indistinguishable from a figure; the marker now travels, and
`validateStatic()` reports it. The HTML export keeps working (a placeholder is still
better than no file), but a caller whose contract is `fail` can now refuse — which is what
the export pipeline being built needs.

- **`buildStatic(captures, {media})` and `figureFiles(captures)`** — the seam between "one
self-contained file" and "a document an engine converts". `media: "data-uri"` is the
default and today's behaviour; `media: "files"` references `fig-01.png` and returns the
bytes to put beside it, under one naming rule that both use. A data URL is right for a
single file and wrong elsewhere: LaTeX drops the image, Typst inlines every byte as a
decimal number, Markdown inlines the base64 into the prose. `capture({format})` and
`captureAndBuild({format, media})` pass it through, because the target decides the format —
WebP for the HTML export, never for Word 2013. No UI changes; nothing in the editor calls
the new modes yet.

- **`npm run export` — a document in, a document out.** `tools/export.mjs` runs the file's
own export module to capture its figures, stages the result as HTML plus `fig-01.png`, hands
it to pandoc with one Lua filter (`tools/sd-export.lua`), and then *audits the result*: the
materialized DOM is counted, pandoc's AST is counted, and any difference is a failed export
rather than a warning. Three stages because each answers a different question, and because a
second idea of "a figure" would disagree with the HTML export about figure 4. No dependency
is added to this repository — the browser is the one the tests already install, and pandoc is
a tool on `PATH` (`--pandoc=…` for another). What the lab measured, rather than assumed:
`<article>` is skipped by the reader (children hoisted), `<p><ul>` parses correctly, `<u>` is
a real `Underline` node, a caret paragraph is `Para [LineBreak]`, and a `data:` URI figure is
an **empty** LaTeX figure — so the materializer writes `fig-01.png` and the engine is handed
the bytes. `-M sd-target=<writer>` exists because a JSON conversion would otherwise take the
html branch of every format-dependent decision the filter makes.

- **An export of the same document twice is the same bytes.** A docx carries the clock
twice — every zip entry's DOS timestamp, and `docProps/core.xml`'s `dcterms:created`/`modified`
— and pandoc writes both from the wall clock, so two runs differed (measured: 11 733 vs
11 734 bytes, 4 968 differing bytes, all of them time). `tools/reproducible.mjs` rewrites the
archive instead of asking the writer: entries are copied *compressed* (a 12 MB figure is never
inflated), timestamps pinned to the zip epoch, `core.xml` stamped, extra fields dropped
because 0x5455 carries a Unix mtime. `SOURCE_DATE_EPOCH` is the standard answer and pandoc
honours it — verified in the wasm build, `1970-01-01T00:00:00Z` — but `pandoc-wasm`
instantiates WASI with `env = []`, so the browser could not set it until we wrote our own
glue. Both paths now exist and the CLI's does not depend on the engine's cooperation.

- **`tools/reference.docx` and `tools/sd-template.typ` — the look, as two artefacts.**
`npm run reference` derives the Word reference from the engine that will use it: ask pandoc
for a document that exercises every style (title, h1–h3, body, quote, code, table, captioned
figure), then replace the style definitions that carry the look and pin the page geometry in
the section properties. A reference docx is the *only* way to style Word, and ours had none:
the exported docx now carries `<w:pgSz w:w="12240" w:h="15840"/>` and Georgia 11 pt, Title
26 pt, captions centred at 9.5 pt. The Typst template is written the long way (no `conf`
module) so a pandoc upgrade cannot quietly change it, and it states the same page. Both are
used by default when present; the export prints which.

- **PDF, measured: `pandoc (html → typst)` then `typst (typst → pdf)`, never "pandoc writes a
  PDF".** The `.typ` target has no extra cost; the PDF is a second engine. With
  `@myriaddreamin/typst-ts-node-compiler`, a two-page Letter document with our template
  compiles in **8 ms** to 53.5 KB. That build has **no image decoder** — `read("fig-01.png")`
  returns the bytes and `image(bytes)` fails — so a document with figures needs the wasm build
  (or native typst). Recorded in `lab/011-pandoc-export/notes.md` §14 with the probe that
  proves it, rather than shipped as a maybe.

- **`host.use("materialize")` — the one way a plugin may capture a document.** `export.js` is
where figures are captured and chrome is dropped, but it offered no capability, so a plugin
could not reach the materialized HTML at all. It now provides `{build}`: one function, which
runs the host's own progress dialog and the same abort, and returns `{html, files, problems}`
instead of throwing — whether a placeholder is fatal is the caller's contract
(`onMissing: fail`), not the materializer's. A plugin may *be* an exporter; it may not become
the export menu.

- **A plugin's `bin` is no longer fetched because a plugin was loaded.** `buildPlugin()`
fetched every online asset of a bundle in parallel and constructed each one, so a bundle
carrying a 12 MB typst compiler downloaded it to export Markdown. `bin` assets are skipped in
both phases: `bytesOf()` is their only fetch, `host.bytes()` their only reader — which is what
`bin` was for (invariant 13), and what an export target needs.

- **An exporter that runs in the tab: `plugins/pandoc-export/`.** Word, Typst and Markdown,
converted by the same pandoc.wasm the CLI now uses, with nothing leaving the machine. It pins
five assets (`pandoc` 58.6 MB `bin`, the bundled WASI shim, `tools/sd-export.lua` as a `bin`
because a `js` asset would be *evaluated*, and optionally `tools/reference.docx` +
`tools/sd-template.typ` so a browser export looks like a CLI one), reads them through
`host.bytes`/`host.text`, and builds the HTML with `host.use("materialize")` — the editor's own
capture path, so a `.docx` cannot disagree with the `.html` export about figure 4. The 58.6 MB
is fetched on the **first export**: `bin` assets are never prefetched, which is the rule that
made a lazily-loaded compiler possible at all. Three browser tests: a .docx with the figure
embedded (zip magic, `word/media/`, > 8 KB), a .typ when the document has no figures, and a
refusal with a reason when it does — a `.typ` that references `fig-01.png` is two files, and a
contribution returns one.

- **PDF with figures, in the tab — and two PDFs that say which they are.** The exporter now
typesets through `typst.ts`: `pandoc → .typ → typst.wasm → PDF`, figures included. Measured in
Chromium: **1.5 s** for a one-page document with a figure, from a 27 MB compiler plus a 211 KB
bundle, both pinned as `bin` assets and fetched on the first PDF. `typst.ts` is pinned as its
all-in-one bundle because a plugin loaded from a `blob:` URL cannot resolve the package's
internal imports, and the fonts are the document's own `typst-font-*` assets when it has them
(jsDelivr's default text set otherwise — the compiler ships none). The napi build in the lab
could not decode images; the wasm build can, which is the reason this is the one that shipped.

The two options are now named for what they do: **Print (standard)** and **Print (captured
figures)** in the browser's dialog, instant and using the reader's fonts, versus **PDF
(typeset)** from the plugin, which brings its own page, its own type and its own figures. Same
`PDF` menu, three entries, no ambiguity about which one you are getting.

- **`pandoc-wasm` is a devDependency, so `npm run export` needs no install.** `tools/engine.mjs`
is one recipe with two engines: `native` (pandoc on PATH — faster, and the only one that can
hand a PDF to an external typesetter) and `wasm` (the same binary the plugin runs, which is
what makes "the CLI and the browser agree" a testable claim rather than a hope). The default
is native when a binary exists, wasm otherwise. `--to=pdf` writes the `.typ` **always** and
compiles it with `typst` when one is installed; without one it says which command to run and
exits 1, because pandoc is not a PDF writer and the browser's print path already exists.

- **`npm run shim`** regenerates `plugins/pandoc-export/wasi-shim.js` from the devDependency
(the shim is ESM-only because that is how it is published; a plugin loaded from a `blob:` URL
cannot import, so it is bundled into one module by `tools/shim.mjs`, and the artifact is
committed because a plugin must be a self-contained file at a pinned URL).

- **The exporter is published, and a document can install it from a manifest.** `npm run build`
now writes the plugin into `dist/` — five files beside the runtime (`dist/cdn/plugins/pandoc-export/`)
and `dist/plugins/pandoc-export.json`, which records id, kind, order, size and sha384 for all
eight assets. Three of those are npm pins (58 MB + 27 MB + 211 KB) rather than copies: they
belong where jsDelivr serves them immutably, and the manifest's hash is the promise while the
url is only the address — the same arrangement `plugins.json` uses for nanoid. `check` fails
when either the files or the manifest are stale.

Installing is copy-and-paste: `assets` into `#asset-manifest`, the entry into `plugins`.
`test/browser/plugin-manifest.spec.js` does exactly that against the published file and exports
a `.docx`, and separately asserts every declared `bytes`/`integrity` against the bytes at that
url — so the manifest is verified, not trusted. Writing it caught one thing the earlier
hand-built fixtures had carried by accident: the plugin's entry module needs `"factory"`, or
the loader treats the module *namespace* as the plugin and there are no contributions at all.

- **A text target carries its figures, and a refusal is something you can see.** `.md` and
`.typ` used to be offered only for figure-free documents — a plugin returned one file and the
host had no archive step — so the entries were there and did nothing visible. A contribution
may now return `extras`, which the host downloads after the document (spaced, so a browser
asks once); and `refuse()` opens a host-owned dialog instead of writing a console line, which
is what "I clicked and nothing happened" was. The dialog is `data-plugin-ui`, so a save drops
it like any other session state.

- **`npm run demo` — a document with the exporter installed, to click through.** Writes
`.test-tmp/plugin-demo.html`, pinning the seven assets the plugin needs (url + sha384 each,
including the 27 MB typesetter), with a figure whose source is in `#figure-store`. `npm run dev`
and open the URL; `Save as… ▸ Word (.docx)…` and `PDF (typeset)…` are the shipped code paths.

### Fixed

- **The browser's .docx contained the Typst template.** `plugins/pandoc-export` attached the
look per *document* rather than per *writer*, so `--template sd-template.typ` reached pandoc
for docx too — and the docx writer writes whatever template it is given into
`word/document.xml`. The file was a valid zip with a media part and a `document.xml`, so the
test passed; Word offered its text-recovery converter. The template now goes only to typst and
the reference docx only to Word, and the test reads `word/document.xml` and asserts it is
OOXML (`<w:document`, `<w:pgSz`, no `typst`) — a container is not a document.

- **A static export carried the viewer bar.** `buildStatic()` removed the editor's chrome by id
and the viewer bar was never on the list, so exporting `index.html` (which holds *every*
mode's chrome) printed a reader's bar into the document — 1 034 words of it according to the
audit, which is how it was found. `#viewer-bar` is chrome like `#app-toolbar` and now goes.

- **A CSS comment that named `<script>` swallowed the document.** `viewer-bar-styles.css`
documented the v0.6.2 bug with the literal tag inside a `/* … */` comment; a browser is
untroubled, and pandoc — which is not a browser — treats everything after an unclosed
`<script` as script text, so the export became two paragraphs of CSS. Reworded, and
`tools/export.mjs` now refuses a materialized document whose `<script`/`</script>` counts
disagree, with a sentence that names this exact cause. The audit caught it first (headings
1 → 0, words 7 → 1 034), which is the argument for the audit.

- **A block painted its own source when its id was shared.** An asset block is found by its
  id (`script[id="<assetId>"]`), and `viewer-bar-markup` gives its root the same id as the
  `viewer-bar` script. `#viewer-bar { display: flex }` matched the `<script>` as well as the
  bar, outranked the UA sheet's `script { display: none }`, and painted the module below the
  toolbar — provenance header first, so it read as a stray `/*@compiled-from …*/` note — in
  `index.html`, in every viewer file, and in every copy either one saved. The viewer bar's
  sheet is now qualified `header#viewer-bar`, and `page-styles.css` states the general rule
  (`script, style { display: none !important }`) so no stylesheet can make text of a block.

### Size

index 411.2 → 417.5 KB · editor 399.6 → 405.1 KB · viewer 181.4 → 183.4 KB · slim 77.1 →
77.6 KB (the viewer's bar sheet is `mode: online`, so a viewer pays for the qualifiers; an
editor pays only for the one general rule). The export seam is 3.0 KB of `export` + `plugins`,
carried by an editor and by no flavour that cannot export: `slim.html` inlines the manifest but
fetches `export`, and a viewer never had it. The 0.5 KB every flavour pays is the loader —
two `kind !== "bin"` guards, which are inline by definition because the thing that verifies
hashes cannot be a thing that might fail to arrive.

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
