# pandoc-export — a plugin

Exports the document as **Word (.docx)**, as **PDF** (typeset by Typst, figures included), and
as **Typst (.typ)** or **Markdown (.md)**. Everything runs in the tab: no server, no upload.

    Save as… ▸ Word (.docx)…        a real .docx, figures embedded
    Save as… ▸ PDF (typeset)…       pandoc → .typ → typst.wasm → PDF, fonts embedded
    Save as… ▸ Typst (.typ)…        the source, plus its figure files
    Save as… ▸ Markdown (.md)…      the source, plus its figure files

A text format names its figures (`image("fig-01.png")`, `![](fig-01.png)`), so the host
downloads the document first and then each figure — one click, a small burst of files. Chrome
asks once whether to allow multiple downloads the first time.

## Two PDFs, and why both exist

    PDF ▸ Print (standard)…          the browser's dialog: instant, your fonts, its headers
    PDF ▸ Print (captured figures)…  same, after capturing figures so islands appear
    PDF ▸ PDF (typeset)…             this plugin: Typst's engine, template page, real type

Print is instant and uses whatever the reader's browser has; it is the one to use when the
point is paper *now*. Typeset is a download: `tools/sd-template.typ` decides the page, the
fonts are embedded, figures are captured at 2×, and the same `.typ` can be kept or handed to a
native `typst`. They are different artefacts, so they are named differently — "print" versus
"typeset" — and neither is pretending to be the other.

## What a document pins

Four assets, all verified by the host before any of this runs (`host.bytes`/`host.text` are
the only source of bytes, and the host is the only thing that hashes):

| id | kind | size | what |
|---|---|---|---|
| `pandoc` | `bin` | 58.6 MB | `pandoc.wasm` 3.10 — the same binary the CLI uses |
| `wasi-shim` | `js` | 41.8 KB | `@bjorn3/browser_wasi_shim`, bundled by `npm run shim` |
| `sd-export-lua` | `bin` | ~8 KB | `tools/sd-export.lua` — **`bin`, not `js`**: a `js` asset is *evaluated*, and Lua is not JavaScript. There is no text kind yet (see `docs/PLUGINS.md`). |
| `sd-template-typ` | `bin` | ~3 KB | optional: `tools/sd-template.typ`, so `.typ` looks like the CLI's |
| `sd-reference` | `bin` | 12 KB | optional: `tools/reference.docx`, so `.docx` looks like the CLI's |
| `typst-bundle` | `bin` | 211 KB | optional, for PDF: `typst.ts`'s all-in-one bundle (one file, no imports) |
| `typst-compiler` | `bin` | 27 MB | optional, for PDF: `typst.wasm` |
| `typst-font-*` | `bin` | ~0.5 MB each | optional, for PDF: each one pinned means one fewer request to jsDelivr |

A manifest entry looks like this (the `url`/`integrity` are what the document carries):

```json
{ "id": "pandoc", "kind": "bin", "role": "module", "order": 300, "mode": "online",
  "category": "plugin", "plugin": "pandoc", "requiredBy": ["*"],
  "bytes": 58643584, "url": "https://…/pandoc.wasm", "integrity": "sha384-…" }
```

…and the plugin itself:

```json
"plugins": { "pandoc": {
  "label": "Pandoc export", "version": "0.1.0", "island": "sealed", "enabled": true,
  "entry": "pandoc-export",
  "assets": ["pandoc", "wasi-shim", "sd-export-lua", "sd-template-typ", "sd-reference", "pandoc-export"],
  "contributes": { "export": [
    { "id": "docx", "label": "Word (.docx)…" },
    { "id": "typ", "label": "Typst (.typ)…" },
    { "id": "md", "label": "Markdown (.md)…" } ] } } }
```

## What it costs, and when

The 58.6 MB is fetched **on the first export**, not when the plugin loads: `bin` assets are
never prefetched (a plugin's cost is decided by the click, not by its contents). The
conversion after that is ~1 s; the compile happens once per page load.

## Text targets carry their figures

`pandoc` writes `image("fig-01.png")`, which is two files; the contribution returns the text
plus `extras`, and the host downloads each extra after it. Word embeds its figures, so it is
one file and unaffected.

**What is not offered** is a *refusal without a reason*: if a figure could not be captured
(`materialize()` reports it), the export is refused and the host shows a dialog saying which
figure — the same `--on-missing=fail` the CLI defaults to.

## Fonts

The wasm compiler ships **no fonts**. With `typst-font-*` assets pinned the plugin hands them
to `loadFonts()` and the PDF needs nothing from the network; without them it asks jsDelivr for
typst's default text set (~4.4 MB, from `typst-assets@v0.13.1`). A document that must typeset
offline should pin its fonts — the same rule as every other byte.

## Determinism

The glue passes `SOURCE_DATE_EPOCH=0` into the wasm environment, so a document exported twice
in the browser is byte-identical — something the npm loader cannot do, because it instantiates
WASI with `env = []`.

## Rebuilding the bundled shim

    npm run shim          # writes plugins/pandoc-export/wasi-shim.js from the devDependency

The artifact is committed: a plugin must be a self-contained file at a pinned URL.
