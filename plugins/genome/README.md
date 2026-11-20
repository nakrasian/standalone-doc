# genome — a GenomeSpy map as a figure

Paste a `.spec.json` and you get a gene-arrow map in the page: hover a gene for its product and
coordinates, clamp the window to the locus or free it to the contig, and print it as the
engine's own vector.

```
Insert ▸ Genome map…     pick a GenomeSpy spec (.spec.json)
```

There is nothing to configure and nothing to upload. The figure holds the data; the engine is
one pinned copy in the document, shared by every map in it.

## Three assets, and why the split matters

| asset | kind | what it is | where it runs |
|---|---|---|---|
| `genome.js` | `js` | the plugin: file picker, spec check, figure markup | document level, once |
| `genome-view.js` | `bin` (`~5 KB`) | theme, embed, clamp, `imageExport.svg()` | inside each island, imported from a blob |
| `genomespy` | `bin` (`1.4 MB`) | GenomeSpy, self-contained with its fonts and wasm atlas | inside each island, imported from a blob |

`bin` means **never evaluated in the document**. The island asks for both by name through
`__figureBytes()`, the host answers with bytes it verified against the pin, and the island
imports them from `blob:` URLs. That is why a document with four loci grows by ~100 KB of
figures instead of the 5.9 MB the same four figures cost as self-contained exports — and why
fixing the view or upgrading the engine is a pin, not a re-insert.

The engine pin is `genome-spy-python`'s bundled build, because the npm package is not the same
artifact: `genome-spy@0.13.0/dist/index.js` is UMD and expects its font atlas at a runtime
`baseUrl`, which a network-sealed island cannot fetch. The bundled one carries its assets
inline, which is what makes it work offline.

```
https://cdn.jsdelivr.net/gh/genome-spy/genome-spy-python@0.10.0/src/genome_spy/static/genome-spy.js
sha384-nQjDyto+9BjFVITcwo+M9R0iq4zB/01ImkdKLj3oAO5AtvCbVWlasDkTzCxwkCeI   (1,424,224 bytes)
```

## The figure's contract

Written into the figure at insert time, not into the plugin, so a later version cannot widen it:

| field | value | why |
|---|---|---|
| `island` | `compute` | `sealed` plus `'unsafe-eval'`. GenomeSpy compiles filters with `new Function`; the island still has no network, no storage and no parent, and the code it compiles is code the file pinned. |
| `assets` | `["genome-view", "genomespy"]` | the only two ids the island may ask the host for |
| `exports` | `["svg"]` | the island exposes `window.__figureExport`, and the export asks it before it rasterizes — so a static page and a printed PDF get vector text instead of a 2× canvas |
| `width`/`height` | `1 × 0.32` | a locus map is wide and short; the html default (1:0.72) would be mostly empty |

The export hook is the engine's own:

```js
const result = await api.imageExport.svg({background: "white"});
return {format: "svg", text: await result.blob.text()};
```

`genome-view.js` owns that. If it throws, the host logs it and rasterizes instead, so the worst
case is quality, never a missing figure.

## The window

`clamp to locus` is a rewrite of `scales.x.zoom.extent`, not a subscription on a scale:

- **clamped** — `extent: [lo, hi]`, the authored window. You can zoom in and pan inside it, and
  you cannot leave it.
- **free** — `extent: [0, contig]`, from `genomes[assembly].contigs[0].size`, or the spec's own
  `zoom.extent` when it declares one.

The toggle is only offered when the spec declares somewhere to zoom out *to*. Toggling
re-embeds at the authored domain, so a reader who pans away and clamps again lands back on the
locus rather than wherever they drifted.

## Where the spec comes from

`locus.py` slices a GenBank file into `*.locus.json`, `spec.py` turns that into a GenomeSpy spec,
and this plugin draws whatever spec it is handed. Layout stays in Python: the plugin never
re-derives labels, categories or leader offsets, so a tuned `labels.json` and the figure cannot
disagree.

Any spec in GenomeSpy's grammar with a genomic x scale works — not only the locus shape. The
plugin checks two things (an x scale, a two-position domain) and lets the engine report the rest
in its own vocabulary.

**Label width is the spec's decision.** `spec.py` measures label rows for the figure width it
was told to target (~1000 px). A document's text column is narrower, so a spec generated for a
1000 px figure will crowd its labels in a 640 px column. Generate for the width you will print
at, or use the lambda-phage example's `measureText` + `pileup` grammar, which lays labels out at
the current width instead of baking rows.

## What does not work here, on purpose

- **Lazy data sources** (BigWig, indexed FASTA, bgzip+tabix BED/GFF3/VCF, BAM) need HTTP Range,
  an index file, and a network. A `compute` island has none of the three. Inline the rows (a
  locus is ~25 KB) or host the figure as `sandboxed` — and understand that you have then given
  the content the network.
- **NCBI as a data source.** NCBI publishes neither `.fai` nor `.tbi`, so it is not a lazy
  source at all; it belongs in the authoring step (`locus.py --gbff`), where the data is turned
  into rows that travel in the file.
- **Fonts in the exported SVG.** GenomeSpy names Lato in its SVG text; the pinned bundle carries
  a bitmap atlas for canvas rendering and falls back to an embedded default when the network
  font metadata is unavailable (it always is, in a sealed island). The vector is correct; a
  machine without Lato will substitute.
- **Editable labels.** Labels are data, and the data lives in the spec. Re-run `spec.py`, then
  insert again.

## Publishing

```
1. bump plugins/genome/plugin.json's version
2. node build.mjs build                  # dist/cdn/plugins/genome/, dist/plugins/genome.json
3. node build.mjs check                  # pins, hashes, index
4. git tag -a plugin-genome-v0.1.0 -m "…"
5. git push origin main && git push origin plugin-genome-v0.1.0
6. node build.mjs purge --main && node build.mjs verify-cdn
```

`npm run demo:genome` writes a document with the plugin installed and a real figure in it;
`npm run dev` serves it. The demo pins `genome.js` and `genome-view.js` at this working tree and
the engine at the published jsDelivr address, so it exercises the same bytes a reader gets.
