# pandoc-export — a plugin

Exports the document as **Word (.docx)**, and as **Typst (.typ)** or **Markdown (.md)** when
the document has no figures. The conversion runs in the tab: no server, no upload, no network
after the runtime is fetched once.

    Save as… ▸ Word (.docx)…        a real .docx, figures embedded
    Save as… ▸ Typst (.typ)…        one file, when there is nothing to reference
    Save as… ▸ Markdown (.md)…       ditto

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

## Why the text targets refuse figures

`pandoc` writes `image("fig-01.png")`, which is two files. A plugin contribution returns one
file, and the host's download has no archive step, so the honest answer is a refusal with a
reason: use `npm run export` (the CLI writes the figure beside the `.typ`) or the browser's
**PDF ▸ Captured figures**. Word embeds its figures, so it is unaffected.

## Determinism

The glue passes `SOURCE_DATE_EPOCH=0` into the wasm environment, so a document exported twice
in the browser is byte-identical — something the npm loader cannot do, because it instantiates
WASI with `env = []`.

## Rebuilding the bundled shim

    npm run shim          # writes plugins/pandoc-export/wasi-shim.js from the devDependency

The artifact is committed: a plugin must be a self-contained file at a pinned URL.
