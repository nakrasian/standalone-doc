# Fragmentation workbench

A page that drives the **real** editor in an iframe through
`StandaloneDoc.modules`, so the pagination and fragment code can be exercised by
hand without a rebuild between experiments.

## Run it

```sh
npm run dev
```

Open <http://127.0.0.1:8080/demo/fragmentation.html>. It must be served over
`http://` — a `file://` page cannot reach into the frame. The frame loads
`dist/editor.html`, so after changing `src/`, run `npm run build` first.

## What the controls do

| control | what it calls |
|---|---|
| **Load demo document** | replaces `#content` with a lead, a long paragraph (about four pages), and three short blocks; resets history; turns fragmenting on |
| **Grow / Shrink paragraph** | appends or removes text in the long paragraph, then forces a pass |
| **Toggle fragmentation** | `pagination.setFragmenting()` — the session-only switch; the file never carries it |
| **Force a pass** | `pagination.refresh()` |
| **Type at the cut** | puts the caret eight characters before the first cut, types `x`, and forces a pass |
| **67% / 100% / 200%** | `zoom.set()`, then a pass |
| **Toggle geometry outlines** | outlines `[data-frag]` (blue, dashed) and `[data-page-start]` (amber) in the frame |
| **Reset mutation count** | zeroes the `MutationObserver` counter on `#content` |

## What to look for

- **The page gap is a margin, not a node.** No `.page-spacer` exists; the first
  block of each page carries `[data-page-start]` and a `margin-block-start`.
  The amber outline is that block.
- **One paragraph, several pages.** A cut produces a sibling
  `<span data-frag="<offset>">` inside the same `<p>`; the word count and the
  paragraph count do not change. The blue outlines are the fragments.
- **The tail starts at the page content top.** The plan readout shows each
  cut's `targetTop` and its measured `tailTop`; they differ by less than a pixel.
- **A no-op pass writes nothing.** Load the demo, press *Reset mutation count*,
  then *Force a pass*: the counter stays at `0` and `converged` becomes `true`.
  The cuts are reused, not merged and re-split.
- **Typing keeps the caret.** *Type at the cut* inserts a character before the
  first cut; the cut offset shifts by one, the fragments remain, and
  `selection kept` is `true`.
- **Turning it off reflows.** *Toggle fragmentation* merges every fragment; the
  page count rises (the long paragraph is whole again) and the caret's block
  stays where the reader left it.
- **The post-conditions are the test.** `post-conditions` is `pagination`'s own
  `checkPass`: text conserved, one fragment per cut at the planned offset, each
  tail on its page top, `from/to` meeting, no orphan margin. A failure prints
  the numbers.

## Limits worth seeing

- A block with **several cuts** is reused only while every segment still fits
  its page. If a segment grows past a page (or an existing cut no longer
  describes the text), the whole document is merged and re-planned once; the
  mutation counter jumps.
- **Export parity** is handled: `buildStatic()` leaves an empty
  `.page-break-inline` span at each cut and the Lua filter turns it into the
  target's native break (`w:br`, `#pagebreak()`, `\newpage`), so a `.docx`
  keeps one paragraph *and* the break. Try *File → Export → Word* on a
  fragmented document.
- **The feature is off in the shipped app.** `setFragmenting()` is session-only;
  a saved file carries the semantic paragraph. Enabling it by mode is still the
  last step in the plan.
