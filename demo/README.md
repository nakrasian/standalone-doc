# Demo pages

## Comments demo

A real editor with a real document and three comments, for clicking the review
round-trip by hand. Generated, not committed:

```sh
npm run demo:comments      # writes .test-tmp/comments-demo.html
npm run dev                # in another shell
```

Open <http://127.0.0.1:8080/.test-tmp/comments-demo.html>.

The page seeds five comments at load: one on the title, one across a heading, one
across the page break inside the long paragraph, one on a body paragraph, and one
already resolved. They appear in the rail beside the page — hover a highlight to
preview its card, click to pin it, ⌘⌥M to comment on a selection. The collapsed
"Demo steps" panel lists the review round-trip: make a review copy, open it, add a
comment, import it back. Its two buttons call the same `toolbar.copy()` and
`toolbar.exportCommentsOnly()` the menus call.

Served over `http://`, the page re-points its own asset manifest at this
origin's `dist/cdn`, so **Edit a copy…** in the downloaded review copy fetches
*this working tree's* editor rather than the last release's. That is why the demo
must be served: from `file://` the pins would name the published tag, and an
unreleased `doc-bar` would not be there to fetch.

---

## Fragmentation workbench

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
| **Shrink head 600 chars** | deletes 600 characters from the start of the long paragraph; the same pre-paint pass re-cuts and pulls the next lines up from the tail, so the page stays full and `cut stale` stays `false` |
| **Toggle fragmentation** | `pagination.setFragmenting()` — the session-only switch; the file never carries it |
| **Force a pass** | `pagination.refresh()` |
| **Type at the cut** | puts the caret eight characters before the first cut, types `x`, and forces a pass |
| **Type 10 chars** | types ten characters, one every 40 ms, at the current caret |
| **Put caret at the seam** | places the caret at the first character of the first fragment |
| **Backspace ×5** / **Delete ×5** / **Enter at the seam** | dispatches the key at the seam five times (re-placing the caret each time); the editor's seam guard removes exactly one character per key / splits the paragraph |
| **67% / 100% / 200%** | `zoom.set()`, then a pass |
| **Toggle geometry outlines** | outlines `[data-frag]` (blue, dashed) and `[data-page-start]` (amber) in the frame |
| **Print document** | prints the editor frame, not the workbench page (which would include the panel and the frame's viewport) |
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
  tail on its page top, `from/to` meeting, no orphan margin, and every whole
  block on the page the plan named. A failure prints the numbers.
- **A deletion refills the page in the same pass.** Delete inside a fragmented
  paragraph (or at the seam): the pass sees that the block got shorter, merges
  that block, re-plans it and re-splits it before paint. `first cut` moves
  forward by the amount the tail now fills, the head still ends at the page
  bottom, and `cut stale` stays `false`. A page disappears in that same pass
  when the block no longer needs it.
- **No intermediate paint.** While fragmenting, the pass runs inside the
  `MutationObserver` callback — after the edit, before paint — instead of after a
  120 ms debounce. Typing *Type 10 chars* never shows an un-cut paragraph in the
  page gap; the no-churn path is what keeps it affordable.
- **The viewport does not follow the caret.** The pass remembers
  `scrollTop` before it changes the flow and restores it after. The two late rAF
  corrections (for WebKit/Firefox revealing the caret a frame later) belong to
  the pass that scheduled them: a new pass cancels them, and a pass that did not
  re-set the selection schedules none, so a correction cannot reset a
  `scrollTop` the reader just chose. A cut that pushes the caret to the next
  page leaves the reader on the page they were reading; `scrollTop` and
  `last scroll Δ` show it.
- **Editing at the seam is guarded.** The tail is a block box inside the
  paragraph, and all three engines treat its start as a boundary: Backspace one
  character *before* the seam deletes two, Delete at or just before it deletes
  two in Chromium and WebKit, and a selection that touches the seam loses an
  extra character. The editor owns every deletion whose range reaches a seam
  (collapsed or selected, Backspace or Delete) and removes exactly that range;
  a cut that touches a seam carries clean `text/plain` and `text/html` on the
  clipboard. Watch `#content mutations` and the fragment count after
  *Backspace ×5* and *Delete ×5*.
- **Print and PDF.** The live print stylesheet is asserted in all three engines:
  `[data-frag]` and `[data-page-start]` are block breaks, gaps reset, sheets
  hidden, and the stage drops its 8.5in screen width so the printable box is
  the same 6.7in measure as the screen — the font and line breaks match rather
  than the printer scaling an 8.5in stage down to 6.7in. `afterprint` re-plans
  at the restored viewport, so the editor does not keep the print preview's
  page boxes. The PDF half runs in Chromium only because Playwright's
  `page.pdf()` is headless-Chromium-only; the real `buildStatic()` output is
  printed and its page count checked against the plan.

## Limits worth seeing

- A block with **several cuts** is reused only while every segment still fits
  its page. A deletion re-cuts that one block immediately; a segment that grows
  past a page (or an existing cut that no longer describes the text) merges the
  block and re-plans it. The whole document is merged only for a structural
  repair (the block now fits a page, or a segment became empty); the mutation
  counter jumps in those cases.
- **Export parity** is handled: `buildStatic()` leaves an empty
  `.page-break-inline` span at each cut and the Lua filter turns it into the
  target's native break (`w:br`, `#pagebreak()`, `\newpage`), so a `.docx`
  keeps one paragraph *and* the break. Try *File → Export → Word* on a
  fragmented document.
- **The feature is on by default in the shipped app.** `setFragmenting()` is
  session-only; a saved file carries the semantic paragraph, and the next pass
  re-fragments it on load. *Toggle fragmentation* is the off switch for a session.
