# The blocks in a document

A document is HTML that describes itself. Three JSON blocks carry what a reader's browser
needs to run it; one is required, two are optional. This is the reference for editing them
by hand, and for knowing which of their fields the toolchain will overwrite.

The counterpart is [`PLUGINS.md`](PLUGINS.md): that is the contract between a document and
a plugin's code, this is the contract between a document and its own runtime.

Nothing here is a stable API yet — but the promise is **additive**: a new field is optional,
a document that predates it keeps working, and the one-release shims are listed at the end.

---

## 1. `#asset-manifest` — required

```html
<script id="asset-manifest" type="application/json">{"schema":1,…}</script>
```

One line (the build writes it compact; `combine` and the save path each rewrite the whole
block). The loader reads it before anything else and will not boot without it.

```json
{
  "schema": 1,
  "cdnBase": "https://cdn.jsdelivr.net/gh/<owner>/<repo>@v0.5.1/dist/cdn",
  "catalog": "https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/dist/runtime.json",
  "plugins": { },
  "assets": [ { "id": "editor", "…": "see below" } ]
}
```

| field | who writes it | meaning |
|---|---|---|
| `schema` | build | `1`. A loader refuses a schema it does not know. |
| `cdnBase` | **author** (`manifest.json`), build (derived into documents) | The tag this document pins, with `/dist/cdn` on the end. Every derived `url` is `cdnBase/<id>.<ext>`. Not a licence to fetch: a hash that does not match is a failed boot, not a warning. |
| `catalog` | **author** (optional) | Where to hear about newer releases. Absent, the loader derives the moving sibling of `cdnBase` (`@main/dist/runtime.json`); a dev base has no sibling, so no offer is made. A recovery address, never a dependency: a document that cannot reach it still opens. |
| `plugins` | `plugins.install()` | Present only when the file has plugins. See [§4](#4-plugins-in-the-manifest). |
| `assets` | build, save policy | One entry per asset, sorted by `order`. See below. |

### An asset entry

| field | required | meaning |
|---|---|---|
| `id` | yes | Unique; also the DOM id of the block that carries it (`<script id="editor">`). |
| `kind` | yes | `js` · `css` · `html`. Decides the wrapper element and the file extension on the CDN. |
| `role` | yes | `module` (a capability) · `infra` (the loader and its failure UI). Infra is always inline and has **no** `url`: the thing that verifies hashes cannot be a thing that might fail to arrive. |
| `order` | yes | Construction order. `boot()` builds in this order, whatever the document order of the blocks is. |
| `mode` | yes | `inline` (the bytes are in the file) or `online` (fetch `url`, verify, then run). |
| `requiredBy` | yes (defaults to `["*"]`) | `["*"]` for every mode, `["edit"]` for authoring only, `["view"]` for a viewer's chrome. A mode not listed means the asset is not built there — and in a restricted document, not carried either. |
| `bytes` | yes | Size of the body. Used for the size ledger and the save threshold. |
| `url`, `integrity` | unless `role: "infra"` | Carried **even when `mode: "inline"`**: the target state is known in advance, which is what lets the save policy move an asset between inline and online with no network. `integrity` is `sha384-` + base64, of the exact bytes. |
| `deps` | for `js` | Named capabilities to inject as `deps`. Resolved from `factory` exports, in `order`. |
| `late`, `optional` | for `js` | `deps.late("export")` is a getter that throws if used before that asset exists; `optional` names may be absent. |
| `factory` | for converted `js` | The exported function the loader calls with `deps`. Absent means the module's namespace is the asset. |
| `label` | optional | Human name, used by the sheet's ledger and the boot dialog's rows. |
| `open` | `kind: "html"` | The element the fragment is wrapped in (`<header id="toolbar" …>`), so a fetched fragment can be injected without the file knowing its chrome. |
| `insert` | `kind: "html"` | Where a fetched fragment lands: `before:<selector>` or `append:<selector>`. Default `before:#viewport`. |
| `category`, `plugin` | plugins only | `category: "plugin"` plus the plugin's id, which groups the asset under that plugin's switch. |

An asset entry with an unknown `kind`, a `url` that is not absolute `https://` (for an
online asset), or an `id` that no block provides is a **check** failure, not a boot failure:
the file would still open, and that is exactly the class of error the gate exists to catch.

## 2. `#doc-settings` — required

```html
<script id="doc-settings" type="application/json">{"schema":1,"mode":"edit",…}</script>
```

What the *file* has decided about itself. The loader reads it before it builds anything, so
these are enforced by code rather than by markup: a copy whose `<body>` was hand-edited
cannot claim to be editable when this block says otherwise.

| field | default | meaning |
|---|---|---|
| `schema` | `1` | Refused if unknown. |
| `mode` | `edit` | `edit` · `view` · `comment`. Decides which `requiredBy` groups are built. **Not writable from a document you are editing**: a view-mode save marks the editing assets `absent`, so a file rewritten that way can never be edited again. A viewer is an export (`File → Save as… → HTML → Viewer`), which makes a copy. |
| `editable` | `true` in edit mode | `false` locks `#content` regardless of the markup. A setting can restrict a mode, never grant one: `true` in view mode is still read-only. |
| `toolbar` | `mode !== "view"` | **Show chrome** — the editor's ribbon, or a viewer's bar. Not "show the editor": a view-mode document has chrome of its own. A file saved before this meant "ribbon" never authored it, so it keeps its chrome-less look. |
| `ui` | `ribbon` | `ribbon` or `minimal` — which editor chrome to paint. Presentation only; applied before first paint so a minimal file never flashes its ribbon. |
| `saveThresholdBytes` | `2097152` | Ask before saving a file larger than this. |
| `thresholdDeclined` | absent | The size at which the author said "don't ask again". The prompt re-arms at twice this. |
| `author` | absent | The document's own author, as it signs a comment (`author.kind === "author"`). Absent means nobody has authored a comment; an empty string is a change for nothing. A reviewer's name never lives here: it is `localStorage`, per document. |
| `capabilities` | absent | `{comments: "off" \| "read" \| "write", edit: "copy" \| "off"}`. **A capability the file does not declare is `absent`** (invariant 28): the loader skips the asset and `policy.target()` marks it absent, so a document that never uses comments does not carry the comments bundle. `"off"` is a declared *no* and behaves like absent; only an export (or the module that wrote the first comment) writes this field. |
| `timeoutMs` | `8000` | Per-asset load timeout. Behaviour, so it lives here and not in the manifest. |
| `policy` | absent | The save preset the author chose: `inline`, `smart`, `slim`. Absent means `inline`. |
| `assets` | absent | An explicit `{id: "inline" \| "online" \| "absent"}` map. **Wins over `policy`** and replaces it on write: a preset is a shorthand for a map, and writing both would be two answers to one question. `absent` means the author removed the asset; an asset that is merely outside the current `mode` leaves the file but keeps its declaration, so the other mode can still be produced (an export, a viewer). |
| `cloud` | absent | `{id, api?}` — the library this document belongs to. `id` is the object key (3–64 of `[a-z0-9-]`); `api` defaults to `/api/docs` and must be **relative**, so a document copied to another host does not drag its old origin with it. Absent, malformed, **or opened from `file://`** means a file: the endpoint is relative, so a copy re-opened from disk cannot address it, and a document that cannot reach its library downloads instead of failing. |

`policy` and `assets` are what the save sheet edits, along with `editable` and `toolbar`.
`mode` also travels here, but only a build flavour or an export writes it: the settings sheet
reads it and preserves it, and offers no control for it.

`cloud` changes what Save *is*, without changing the button: a document that names a library
is written back to it (and its assets stay `online`, so every document in the library shares
one runtime), while a document that names none is downloaded as before. A published copy is
made by saving **in view mode** and then removing `cloud` from it — a copy is not a source, so
a reader who saves it as an editor cannot PUT over the document it came from.

## 3. `#plugin-catalog` — optional

```html
<script id="plugin-catalog" type="application/json">{"schema":1,"tag":"v0.8.2","assets":{},"bundles":{}}</script>
```

An in-file copy of the plugin catalog (the same shape `dist/registry.json` publishes, plus a
`tag`), so an offline document can offer plugins with zero requests: a `file://` page cannot
fetch a relative url (`lab/007`), which is exactly where a document is most useful. The
Plugins panel prefers the block when present and falls back to the catalog at `cdnBase`'s
sibling.

**It is an option, and it is generated.** `manifest.json`'s `"pluginCatalog": true` makes every
flavour carry it (`build.mjs#pluginCatalogBlock`); the block is never hand-written, `check`
refuses one the manifest did not ask for, and refuses one taken at a different tag than the
document pins. This repository leaves it **off** — a catalog that grows would be bytes in every
document, and the built flavours are what the browser fixtures start from, so a baked-in
snapshot would silently shadow every fixture catalog. A distribution that ships plugins flips
the one field.

Two rules that make the snapshot honest rather than merely present:

- **`tag` is the tag the snapshot was taken at**, and it is what makes staleness a fact. A
  bundle's `manifest` is *relative* (`plugins/<id>.json`) and `installBundle()` resolves it
  against this document's own `cdnBase` — so snapshot and manifest agree by construction, and
  a re-pin is what breaks that agreement. The panel says so ("taken at v0.8.2; this file pins
  v0.9.0") and offers **Refresh**, which re-reads `<cdnBase>/../registry.json` and rewrites the
  block (a document change: it marks the file dirty).
- **A parseable block with no tables is not a catalog.** The panel falls through to the network
  rather than showing an empty "Available" list, which reads exactly like "nothing is
  published".

## 4. `#comment-store` — optional

```html
<script id="comment-store" type="application/json">{"schema":1,"comments":[…]}</script>
```

Comments are **content, not a mode**: this block and the blocks' `data-bid` attributes travel
in every file and every export, the way `#figure-store` does. The mode decides only which
chrome exists and who may write. **Absent means no comments** — not an empty `{"comments":[]}`,
which would be a change to the file for nothing.

```json
{
  "id": "c_9f2a61b4",
  "anchor": {"from": 412, "to": 447, "quote": "the phrase this is about", "blocks": ["b_1a2b3c4d", "b_5e6f7a8b"]},
  "author": {"name": "Nadia", "kind": "author"},
  "createdAt": "2026-11-18T10:12:03Z",
  "updatedAt": "2026-11-18T10:12:03Z",
  "body": "This paragraph contradicts §2.",
  "resolved": false,
  "replies": [
    {"id": "r_7d1e", "author": {"name": "Reader"}, "at": "2026-11-18T11:02:00Z", "body": "Agreed."}
  ]
}
```

- **`anchor` is one range over the document's text stream.** `from`/`to` are offsets in the
  concatenation of the blocks' `textContent` (blocks joined by `"\n\n"`); `blocks` names the
  blocks the range touches, and the per-block segments the overlay paints are *derived*, never
  stored. `quote` is the first 40 normalized characters, a repair hint only.
- **`data-bid` is on a top-level child of `#content`**, `b_` + 8 base36 characters. It is
  assigned **only when a comment first needs it** — never on load, never on save — so a
  document with no comments is byte-identical to one written before comments existed. It is
  content, so `session.strip()` never removes it.
- **Repair is deterministic, never fuzzy:** exact range, then a unique `quote` inside the named
  blocks (or the document, when none of them survive), then a block-level marker, then
  **orphan** — kept, listed, never dropped (invariant 29).
- **A comment is immutable except `resolved` and `replies`.** A reply is append-only and an
  "edit" is a reply that says so. That is what makes a file merge possible without a CRDT.
- The block's id is `comment-store`, not `comments`: an asset's block carries
  `id="<assetId>"`, so `#comments` would be shadowed by the module's own `<script>` — the same
  collision `doc-bar`'s predecessor already paid for.
- `check` validates the schema, unique ids, integral ranges, 40-character quotes, `b_` ids, and
  refuses `capabilities.comments === "off"` in a file that carries this block.

## 5. Plugins in the manifest

Written by `plugins.install()`, read by the loader and the Plugins sheet. Only present when
the file has at least one.

```json
"plugins": {
  "whiteboard": {
    "label": "Whiteboard",
    "version": "1.2.0",
    "island": "sealed",
    "enabled": true,
    "entry": "whiteboard",
    "assets": ["whiteboard", "whiteboard-template"],
    "contributes": { "insert": [ { "id": "board", "label": "Board" } ] }
  }
}
```

| field | meaning |
|---|---|
| `enabled` | The author's switch. `false` means the plugin does not run and its assets are `absent` on save — unless a figure needs it, in which case the switch is refused rather than silently producing a broken file. |
| `island` | Which profile the plugin's own content mounts into: `sealed` (default) · `sandboxed` · `trusted`. Stored on the *plugin* here and on the *figure* at insert time, so a later version cannot widen what an existing figure may do. |
| `assets` | The asset ids that belong to this plugin. They carry `category: "plugin"` and `plugin: "<id>"`, which is what lets the save ledger show one row per plugin instead of one per file. |
| `contributes` | What the plugin declared when it was installed. Stored, not re-read: an installed plugin that once contributed a menu keeps contributing it even if it cannot be built right now. |
| `version` | Displayed and recorded. Nothing compares it to anything yet — see the warts in `HANDOFF.md`. |

A pin whose `integrity` changes *under the same version* is not an upgrade; it is a tampered
plugin. The integrity check does not care what the version says: it compares bytes.

---

## 6. Authored, derived, preserved

Two files are authored and both are checked in: `index.html` (the whole document) and
`src/` (one file per asset). `manifest.json` is authored **for five fields only** —
`cdnBase`, `catalog`, `settings` (the document's `author` and `capabilities`), and each
asset's `mode` / `requiredBy` / `capability` (plus plugin `url`/`integrity` for a pinned
third party). Everything else in it is derived from `index.html` and `src/`.

`npm run combine` rewrites `index.html` from `src/`; `npm run split` does the reverse. Both
preserve the rest of the document verbatim. What neither touches:

- the `#asset-manifest` and `#doc-settings` **contents** (`combine` rebuilds the manifest
  block from `manifest.json`; `split` leaves both alone);
- the `#plugin-catalog` block, if present;
- `<head>` metadata, `<body>` order, hand-written markup outside asset blocks;
- any `@asset` block whose body already matches its source (that is what makes the
  round-trip an equality check rather than a reconstruction).

A **save** rewrites the same two blocks: what travels (`mode`), the hashes of what was
re-materialised, and the settings the sheet edited. Everything a session rendered is
stripped first — the list is in `src/session.js`, and `validate()` checks the output against
it before the download starts.

## 7. What the checks enforce

| gate | question |
|---|---|
| `npm run verify` | Does `index.html` reproduce `src/` byte for byte? |
| `npm run check` | Is every block the build's, is every `url` a tag's, does every `js` asset parse, is `dist/` current for all three flavours, is the catalog current, and is `dist/cdn` the tag its documents pin? |
| `verify-cdn` | Does the CDN serve the bytes a **tag** published? (The tag's tree, not the working tree.) |
| browser tests | Does the file boot, and does a saved copy reopen as the same document? |

## 8. Compatibility shims (remove at the next breaking change)

A document saved by an older build may be missing fields that now live elsewhere. The loader
reads them from their old home rather than refusing the file:

| shim | reads | remove when |
|---|---|---|
| `mode` | `#doc-settings` absent → the manifest's `mode` (no longer written, so this now lands on the default) | a breaking `schema` bump |
| `timeoutMs` | same | same |
| `toolbar` | absent → `mode !== "view"` | same |
| `requiredBy` | absent → `["*"]` | same |
| `data-scale` on a figure | legacy alias for `data-w` | same |

Two facts are *not* shims and will not go away: `cdnBase` must name a tag (`check` refuses a
branch or a local address, because only a tag is both immutable and public), and a document's
`integrity` values describe its own bytes rather than the tag's — which is why an update
rewrites the manifest and never re-fetches to "check".

### The one caveat worth knowing

A `catalog` entry names a tag's **tree** — and `git show` of a tag is not the same thing as
the bytes that tag publishes if the tree was ever rebuilt after tagging. `check` therefore
compares `dist/cdn` with `git show <tag>:dist/cdn/*`, and `npm run catalog` reads
`git show <tag>:manifest.json`, never the working tree. The v0.4.0 release is the historical
example: its tag tree predates a rebuild, so its own `dist/` does not boot; the catalog
carries the corrected table and a document pinned there still works, because a document
carries its own pins and does not read the catalog to boot.
