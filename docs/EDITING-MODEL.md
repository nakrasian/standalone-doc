# The editing model

What a document *is* while it is being edited, in one place. The pagination engine
(`src/pagination.js`) already documents how a page is planned; this is the layer above it:
what the planner may assume about `#content`, how foreign HTML becomes blocks, and which
gestures are model operations rather than `execCommand` calls.

The motivation is a measured one. Three of five editing complaints in a real session had a
single cause — nothing maintains the shape of `#content` — and the other two fell out of
that shape being wrong (a list is not a paragraph, and a page gap is not a page). Fixing
symptoms one at a time is how the editor gets a fourth place that knows what a block is.

---

## 1. The invariant

> **Every child of `#content` is a block, and every block is one of the tags in the
> strategy table.** Nothing else is a child of `#content`, at any time a pass can run.

```
p · h1–h6 · blockquote · pre · ul · ol · figure · table · hr · div (as a last resort)
```

A *text block* is `p` or `h1–h6`. A *container* is `blockquote`, `ul`, `ol`, `table`.
`figure`, `pre`, `hr` are atomic.

The invariant is what lets the planner be as small as it is: `collectBlocks()` returns
`#content.children`, `strategy(el)` reads `el.localName`, and a cut is a character offset in
`block.textContent`. A wrapper that is not a block (`<div>`, `<span>`, the `<b
id="docs-internal-guid-…">` Google Docs pastes) is invisible to everything below and is
classified `atomic` by the table's default — so it gets *a page as tall as itself*
(`plan()`'s `page.avail = h`) instead of being paginated.

Measured before the model existed (Chromium, `#content` = 883 px):

| input | children | pages | sheet heights |
|---|---|---|---|
| 30 `<p>`s | 30 `p` | 4 | 4 × 1056 |
| the same 30 `<p>`s inside one `<div>` | `p`, `div` | 2 | 1056, **1882** |
| one `<ul>` of 44 items | `ul` | 1 | **1149** |
| Google Docs payload (20 `<p>` in a `<b>`) | `p`, `span` | 1 | 1056 |

The invariant is restored by `normalizeContent()` (§3), and *nothing else may append to
`#content`*. A plugin uses `insertBlock` / `insertInline`; a paste goes through the
ingestion pipeline (§2).

## 2. Coordinates

Three coordinate spaces, and every one of them is owned by exactly one module.

| space | unit | owner | survives |
|---|---|---|---|
| caret / history / comments | `{block index, id, character offset}` | `selection.js` | a fragment pass, a re-cut |
| layout | stage-local px ÷ zoom | `layout.js` | scroll, zoom, repagination |
| plan | `{page, item, from/to}` | `pagination.js` | one pass |

Two rules follow, and they are why this document exists:

- **A cut is a character offset**, never a node path. `Range.extractContents()` preserves
  text; a path does not survive the wrapper it creates.
- **A list cut is an item index**, never a character offset. Lists are not cut into two
  elements (see §4.3); the item that starts a page is the coordinate.

`from`/`to` in a plan item are therefore **character offsets for a `lines` block and item
indices for a `list` block**. The item's `kind` says which. A consumer that reads `from`
without reading `kind` is a bug.

## 3. Normalization

`normalizeContent(content)` is one idempotent pass with four rules. It runs:

1. once at construction, then `status.rebase()` re-captures the dirty baseline — the repair
   is not an edit the reader made, and without the rebase every pasted-into document would
   open dirty;
2. after every ingestion (paste, drop);
3. after every structural command (`setBlock`, list toggle, indent, outdent).

It does **not** run on typing. A paragraph typed into is already a block.

```
1. Unwrap a non-block child with block descendants.   span/b/font/div/section →
                                                      its children, in place.
2. Wrap a non-block child without block descendants.  span/b/text → p.
3. Lift blocks out of a text block.                    p > ul, h2 > table → the text
                                                      runs stay p/h, the block is a sibling.
4. Make a list a list.                                 ul > (p|div|text) → li; li with no
                                                      children → <br>; li outside a list →
                                                      wrapped in ul.
5. Make a table a table.                               tr > (text|span) → td; a cell with no
                                                      children → <br>.
```

`div` is the only element allowed to survive as a block besides the table's entries, and
only when it has block children (a container an export produced). A `div` with only inline
content becomes a `p`; a `div`-in-a-`div` unwraps. This is deliberate: the model has one
text block type, and `div` is not it.

`normalizeContent` never removes an empty `<p><br></p>`. A blank line is content; an editor
that deletes it is an editor that loses a keystroke.

**Post-conditions** (asserted in `test/browser/editing-model.spec.js`):

- every child of `#content` is in the strategy table;
- no `p`/`h*` has a block-level descendant;
- no `ul`/`ol` has a non-`li` child, and no `li` is a child of anything but a list;
- `normalize(normalize(x))` changes nothing (idempotent — the second call writes nothing,
  so it cannot mark a document dirty);
- running it on a document with a fragment, a page-start margin, or a figure changes
  nothing.

## 4. Ingestion (paste and drop)

`paste` and a text `drop` are the only two paths that bring foreign HTML into the model.
Both go through `ingest()` in `src/editor.js`; the figure module's file paste is a
different path and keeps its `preventDefault`.

### 4.1 Sanitize, then map, then drop attributes

The pipeline is deliberately ordered, because each step needs the previous one's evidence:

1. **Remove** the tags that can execute or fetch: `script`, `style`, `link`, `meta`,
   `base`, `title`, `head`, `noscript`, `iframe`, `object`, `embed`, `form`, `input`,
   `button`, `select`, `textarea`, `svg`, `canvas`.
2. **Read what is about to be thrown away.** Word's `mso-list` lives in a `style`
   attribute, and Google Docs' nesting lives in `class`. Before stripping attributes,
   `mso-list:l0 level2` is rewritten into an ordinal on the paragraph, and consecutive
   marked paragraphs are grouped into a `ul`/`ol` with the marker text removed. This is the
   only place a style attribute is read.
3. **Map semantic tags.** `b → strong`, `i → em`, `strike/s/del → s`, `tt → code`,
   `h4–h6` kept. Everything else unknown is unwrapped (§3 rule 1), not renamed.
4. **Drop every attribute** except: `href` on `a` (http, https, mailto, `#`, relative —
   anything else unwraps the link), `src`/`alt` on `img` (http, https, `data:`), `start` on
   `ol`, `colspan`/`rowspan` on `td`/`th`. `style`, `class`, `id`, `data-*`, `dir`,
   `align`, `mso-*` all go. A pasted `line-height:1.38` is why a document's spacing is
   inconsistent; the model owns leading (§6).
5. **Normalize** with the §3 pass.

Plain text is converted first: blank lines separate paragraphs, single newlines become
`<br>` inside one paragraph. A single non-empty line is *not* a paragraph insert — see
§4.3.

### 4.2 The paste payload can lie

Clipboard HTML is attacker-controlled: a `script` in it runs in the page, an `href` of
`javascript:` runs on click, a `src` of `file:` exfiltrates nothing but does read the
reader's disk on some engines, and a `<div>` wrapper disables pagination for the whole
document (§1). The allowlist is therefore a *drop list plus a small keep list*, never the
reverse.

### 4.3 Insertion, not replacement

The caret decides the shape of the insert, and there are only three cases:

| caret is | payload is | what happens |
|---|---|---|
| in a text block, collapsed | one `p` of inline content | the children are inserted **inline** at the caret (no split) |
| in a text block | blocks | the block splits at the caret; payload blocks go between head and tail |
| in an `li` | paragraph blocks | the item splits; the list splits around the tail `li`; payload goes between |
| in an `li` | `li` items | the items are spliced into the item's list at the caret |
| anywhere, selection | anything | the selection is deleted first, then one of the above |

Before the split, the affected block is merged (`pagination.merge()`), because a fragment
is a session wrapper and a structural edit must not inherit one. The next pass re-cuts.

The caret lands at the start of the tail block (or at the end of the insert when there is
no tail) — never inside the inserted fragment. One history entry, one dirty flag, one
scheduled pass: the same three duties `insertBlock` already performs.

## 5. Page breaks

There are exactly three ways content crosses a page boundary, and they are different
primitives because the DOM requirements differ:

### 5.1 A block gap (a page that opens between blocks)

`margin-block-start` on the block that starts the page (`[data-page-start]`), planned from
the gap between pages. Never a node: a `.page-spacer` under a live caret moved the block a
page and every engine scrolled to the wrong offset (lab/016).

### 5.2 A fragment (a page that opens inside a paragraph)

A `display:block` span inside the same `<p>` (`[data-frag="offset"]`), the tail pushed to
the next page's content top. The paragraph stays one paragraph; the export unwraps it.

### 5.3 An item break (a page that opens inside a list)

`margin-block-start` on the `<li>` that starts the page (`[data-page-break]`), and **the
list stays one element**.

This is not laziness. Splitting a `ul` into two `ul`s is the obvious implementation and it
is wrong four times:

- `<ol>` numbering restarts unless every tail carries `start`, which must then be
  recomputed on every edit;
- `#content.children` grows, so the caret's `{block index}` coordinate shifts *during* the
  pass that is supposed to preserve it;
- a `display:block` span inside a `ul` is not allowed content, so the span (the paragraph
  technique) cannot be used at all;
- deleting one item at a page top is now a merge of two elements, with its own undo and
  caret case.

An `li`'s `margin-block-start` gives the same visual result — the item is at the next
page's content top, its marker follows it — while the list remains one element, one plan
item, one caret coordinate. `<ol>` continues numbering for free because the `<ol>` was
never cut.

A single `<li>` taller than a page is not fragmented. **No cut exists inside it**, so its
page grows to the item's height — the same answer an atomic block gets, and the same rule in
the same place (`plan()` pushes the block index into `oversize`). Growing the page is the
honest alternative to letting the item paint over the gap. The demo's *List · one item taller
than a page* is this case; the page table shows `avail > contentH`.

The same happens to a tail of fewer than `minItems` items: a list that cannot satisfy two
items of head and two of tail moves whole rather than leaving a one-item orphan.

**Post-conditions for a list pass:** an `[data-page-break]` `li` sits at a page content
top within `tolerance`; its margin is the computed gap (not the previous pass's); a list
with no `[data-page-break]` has no break margins; total text is unchanged.

### 5.4 A table is a block

A table is inserted as one block (`Insert → Table…`, or `editor.insertTable({rows, cols,
header})`), normalized to rows of cells (§3.5), and paginated **atomic**: a table taller than
a page grows its page, exactly like a tall list item. Row-level breaks are the next primitive
and are not implemented; do not infer them from the list rule, because a table row is not an
item with a marker that can be repeated.

Editing follows contenteditable where it can and the model where it cannot:

- `Tab` walks the cells, `Shift-Tab` walks back, and `Tab` in the last cell appends a row and
  puts the caret in its first cell. The browser would move focus out of the document.
- `insertBlock(table)` leaves a paragraph after the table (`ensureTextAfter`), because a
  table has no "after" to type into — same reason a figure needs one.
- A cell always has a `<br>`, so an empty cell still has a caret to land in.

Styling is the document's, not the browser's: full measure, collapsed borders, a header
background, and cell padding. Without it a table is a run of unspaced lines, which is what
"the table does not render as anything" was.

## 6. Spacing

The planner sums `height` and **ignores margins by construction** (`measureH()`), because a
page gap is a margin and counting it would double-count the gap. Therefore:

> **Spacing inside the flow is `padding-block`, not `margin`.** A margin between two blocks
> is invisible to the plan, and a page overflows by one gap per block.

The flow model is one rule with one exception:

```css
#content > *,                                  /* top-level blocks            */
#content :is(li, blockquote, td, th) > *       /* the same blocks, nested     */
  { margin: 0; padding-block-end: var(--space-block); }
```

- `--space-block` is the paragraph-to-paragraph rhythm;
- `--space-lead` is added above a heading (`padding-block-start`), so a heading belongs to
  what follows it;
- `--space-item` is the gap between list items (`li + li`), because an item is not a
  paragraph;
- `--space-group` is the gap around a figure, code block, or rule, which are objects rather
  than text;
- the last child of a container drops its trailing space, so a list's last item does not
  add a paragraph gap inside the list.

Headings, list items, and quotes are *styled* here too (a `blockquote` with no indent was
indistinguishable from a paragraph; a `pre` in the document serif was not code). The
marker's `padding-inline-start` is the list's, not the item's, so an item break inherits it.
`list-style-position` is `outside`, which gives a list its **hanging indent**: the marker
sits in the list's padding, and every line of the item — the first, a wrapped line, and a
line after a `<br>` — starts at the same text column. A nested `<p>` inside an `<li>` is that
continuation line by another name, which is why it aligns and spaces like one.

A paragraph is one block but its *lines* are not: a page break can fall between them (§5.2).
A list item is one block and its lines are not cut, because the marker would be left behind.
That is the difference between "wraps like text" and "breaks like a block".

The same rule is what makes a pasted `line-height` harmless: ingestion removed it (§4.1),
and `body` carries `--doc-leading` once.

## 7. Page setup

Page geometry is **CSS custom properties carried by the document's own `#user-theme`
block**, written through one helper:

```
--sheet-w, --sheet-h                 page size (orientation swaps them)
--pad, --pad-top/right/bottom/left   margins; the four default to --pad
--doc-size, --doc-leading            type
```

Why the style block and not `#doc-settings`: the values *are* presentation, they must apply
before the first paint with no module built, and every consumer already reads computed CSS
(`export.js` reads `--sheet-w`/`--pad` for `@page`; the figure sizes read `--content-h`).
`settings()` stays behaviour. The one writer is `setThemeVars()`; `setFontSize` and the page
panel both go through it, so a font-size change cannot drop the margins and a margin change
cannot drop the type size.

`applyPage()` writes the variables and calls `pagination.refresh({merge: true})`: geometry
is an input to the plan, not a decoration. The print path uses the same numbers, and
`serialize()` writes the *whole* theme block, not just `--doc-size` (which used to drop
whatever else was there — the bug that made page setup unpersistable).

Presets are names, not numbers in the file: `letter`, `legal`, `a4`, `a5`, `tabloid`.
The file keeps the resolved lengths, so a reader without the preset table still lays out
correctly.

## 8. Commands

Editing gestures are model operations, not `execCommand` calls, wherever the engine's idea
of a block differs from ours. Three that did:

| gesture | engine result | model result |
|---|---|---|
| `setBlock("p")` with a list item selected | `<p><ul>…</ul></p>` (invalid) | the item is unwrapped into a `p`; the rest of the list survives |
| caret at end of `#content` (click below), type | text appended to the last `<li>` | a paragraph is created below the last block, caret in it |
| `Tab` in a list | focus leaves the document | the item indents; `Shift-Tab` outdents, and outdenting a top-level item converts it to a paragraph |
| typing `- ` / `* ` / `+ ` at the start of a block | a literal dash | a bulleted list, converted on the space's `beforeinput` so the marker never lands in the document |
| typing `1. ` / `3) ` at the start of a block | a literal number | a numbered list, starting at the number typed (`<ol start="3">`) |
| `Backspace` in an empty list item | the item merges into the one above (its text comes back up) | the line becomes a paragraph and the list splits around it; the tail of an `<ol>` keeps its numbering |
| `Tab` in a table cell | focus leaves the document | the next cell; from the last cell, a new row |

`click below` is implemented as a `mousedown` on the empty area (target is not inside a
block), which is the same thing every editor does: the paragraph appears because the reader
asked to type there. It is not pre-created, so a document does not carry one empty
paragraph it never used.

`setBlock` on a list goes through `unwrapListItem()` (which already existed for the list
toggle) and then renames the resulting block, so a heading/list conversion never leaves a
list inside a paragraph.

The shortcut's host is the **innermost text-like block**, not a direct child of `#content`:
a legacy `<div>`, a `<div>` wrapper, a `<blockquote>` (the list goes inside the quote), and
a non-breaking space as the typed space all reach the same conversion. The first version
only accepted `#content > p|h*`, which is why it "worked sometimes" — it silently did
nothing in a quote or a wrapper. A `<li>` and a plugin-owned block are the two deliberate
exclusions: a marker in an item is text, and a plugin's section is not the document's to
convert.

## 9. Keep with next, widows, orphans

Two rules the planner now states, because they are the difference between a page that looks
set and a page that looks broken:

- **`keepWithNext`**: a heading whose next block would not fit whole keeps its heading
  company by moving the page break *before the heading*. The flag was in the strategy table
  for two releases and nothing read it; it is enforced in `plan()` now.
- **widows/orphans**: `chooseCut()` already refused a one-line head. It now also refuses a
  cut that would leave fewer than `minLines` lines on the *tail*, so a paragraph does not
  end with a single stranded line. For lists, `minItems` does the same on both sides of an
  item cut.

Both are guards that return "move the block whole", which is the existing contract: a block
that cannot be cut is not cut.

## 10. What this model does not do

- **Tables do not break.** `table` is atomic; a table longer than a page still grows its
  page. Row-level breaks are the next primitive, not this one.
- **A single list item does not break; its page grows.** §5.3. The same is true of a
  nested sublist: only top-level items are cut points, so a long branch travels with its
  parent item.
- **A list with fewer than four items never splits** (`minItems` is two on each side). The
  strategy table is editable (`defineBlock`) if a document needs a different number.
- **No header/footer text.** The plan's `head` is empty; the folio is derived. A running
  head is content, and content needs an editing surface this model does not define.
- **No find/replace, outline, or section breaks.**
- **`execCommand` still drives inline marks.** Bold, italic, links and font size are still
  the engine's; their output (a `span`, a `font`, a `b`) is legal inline content and does
  not violate the invariant. Replacing it with a model is a separate project.

---

## Test map

| invariant | test |
|---|---|
| normalization rules and idempotency | `test/browser/editing-model.spec.js` → *normalize* |
| paste/drop sanitize and insert shape | same file → *paste* |
| list item breaks, `<ol>` continuity | same file → *lists* |
| spacing tokens on nested blocks | same file → *spacing* |
| page setup persists and re-plans | same file → *page setup* |
| keep-with-next, widows/orphans | unit (`pagination-math.test.js`) + browser *page breaks* |
| the whole model, step by step | `lab/018-editing-model/` |

The lab measures each layer **with and without itself** on the shipped modules: the
before case is produced through a public seam (`execCommand` for ingestion, `defineBlock()`
for the strategy table, an injected stylesheet for spacing, `applyPage`, `keepWithNext`),
never by reimplementing the old code. A regression can therefore be named as a seam.

```
npm run dev &                                          # then lab/018-editing-model/probe.html
node lab/018-editing-model/probe.mjs chromium webkit firefox
node lab/018-editing-model/probe.mjs chromium --shots  # PNGs in lab/018-editing-model/shots/
```
