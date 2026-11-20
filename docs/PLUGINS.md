# Writing a plugin

A plugin is a bundle of assets a document pins by `url` + `sha384`, loaded on demand,
verified before anything runs, and removable again. This is the contract between a document
and that code: what a plugin receives, what it may declare, and what it may not assume.

Nothing here is stable enough to promise compatibility across major versions yet. A plugin
declares `api` (see [Versioning](#versioning)); a document refuses a plugin that asks for a
newer host than it has.

---

## 1. What a plugin is

A plain ES module. It exports **one** of two shapes:

```js
// a factory, for a plugin that needs the host
export function createWhiteboard(deps = {}) { … }

// or, for a library with nothing to declare
export const nanoid = …
```

The manifest entry says which to expect:

```json
{ "id": "whiteboard", "kind": "js", "category": "plugin", "plugin": "whiteboard",
  "factory": "createWhiteboard", "mode": "online", "url": "…", "integrity": "sha384-…" }
```

No `factory` means the module's **namespace** is the plugin. That is how a pinned npm
package works without a wrapper.

**A plugin's code runs at document level.** It is a same-origin module in the page, like the
editor itself — it can add menus, read settings, and touch the DOM. That is what makes a
plugin able to extend the chrome at all, and it is not a setting. What *is* a setting is the
island its **content** mounts into (see [§4](#4-islands)).

## 2. Activating

`factory(deps)` is called once, when something needs the plugin (`require()`), and may be
async — a plugin that awaits its own template or wasm is normal. The returned object may have
an `activate(host)`; it runs next, may also be async, and returns an object of contributions
plus an optional `deactivate()`.

```js
export async function createWhiteboard(deps = {}) {
  return {
    async activate(host) {
      const template = await host.text("whiteboard-template"); // its own bytes
      const wasm = await host.bytes("whiteboard-runtime");     // its own binary
      const { instance } = await WebAssembly.instantiate(wasm);

      return {
        insert: { board: async () => ({ html: "<body>…</body>", caption: "Board" }) },
        deactivate() { /* advisory; the host has already withdrawn what it gave you */ },
      };
    },
  };
}
```

### The host

| member | meaning |
|---|---|
| `host.api` | the host API version (a number) |
| `host.plugin` | `{id, label, version, island}` — the manifest's description of *this* plugin |
| `host.text(assetId)` | the text of one of **its own** assets (throws on a binary: use `bytes`) |
| `host.bytes(assetId)` | the bytes of one of its own assets, as an `ArrayBuffer` |
| `host.use(name)` | a capability this document provides, or a throw with `kind: "unavailable"` |
| `host.track(fn)` | register cleanup; the host runs it on unload whether or not you do |
| `host.on(event, fn)` | subscribe to a registry event, tracked like `track` |
| `host.settings()` | a **copy** of the document's normalised settings |
| `host.manifest()` | the document's own manifest |

Capabilities today: `figures` (`insertHTML`, `scan`, `usage`), `editor` (`insertBlock`,
`insertInline`, `exec`, `setBlock`, `blockAt`), `pagination` (`defineBlock`, `strategy`),
`status` (`refresh`, `markDirty`), and `settings` (`open({tab})` — the host's own Document
settings sheet, which is where a runtime update lives). A capability exists only when the
module providing it was built — a view-mode document has no `editor` and no `settings`.

`insertBlock()` leaves a text block below the atomic block it inserted (a contenteditable
region cannot hold a caret inside `contenteditable="false"` content), reusing the block
that is already there when the insertion lands mid-document. A plugin inserting its own
non-editable markup gets the same guarantee for free.

`insertInline(node, {removeBefore})` is its inline twin, and the only way a plugin may put an
atomic thing *inside* a paragraph: it inserts at the caret, spends `removeBefore` characters
of the typed trigger (`@@` → `2`), leaves the caret in a text node after the node, and does the
three things a content change owes this document — **one history entry**, the dirty flag, and a
repagination. A plugin that does its own DOM surgery has to remember all three; one that
forgets the history entry has shipped a bug nobody can reproduce.

An inline element may also declare itself **unbreakable** with `data-atomic`: the planner
will not cut a page inside it. It is not a citation feature — it is the inline counterpart of
a block's strategy, and the rule is one attribute with no class or tag attached. Keep it
separate from `contenteditable="false"`, which stops the *caret* entering, not the page
breaking.

**Rule: a plugin extends the surface, it never occupies it.** Do not write markup into the
toolbar, the menus or `#content`. Ask the host: `figures.insertHTML()` owns the store, the
editor and the dirty flag; a panel gets a body to fill; a menu entry is a declaration.

**Rule: `track()` everything.** `deactivate()` is a promise nobody can verify. The host
withdraws what it handed you either way; what you created yourself is yours to clean up.

**Rule: document-level CSS is the exception that must survive a save.** A plugin may write one
`<style data-plugin-style="<its id>">` into `<head>`, idempotent by id, and it will be saved
with the file. That is the only way a plugin can style content that must render when the
plugin is *absent* — a citation's `[3]` and its reference list are ordinary markup, and a
reader who never loads the bundle still needs the rule that makes them legible. It must not be
`data-runtime="ephemeral"`, which is for chrome the session invented.

## 3. Declaring contributions

A plugin declares what it offers in the manifest, and implements it on the object
`activate()` returns. The host renders the declaration and calls the implementation — a
plugin cannot add a menu item that is not in its declaration.

```json
"contributes": {
  "insert":  [{ "id": "board", "label": "Whiteboard", "island": "sealed" }],
  "inline":  [{ "id": "citation", "label": "Citation…" }],
  "export":  [{ "id": "png", "label": "Whiteboard as PNG…" }],
  "panel":   [{ "id": "inspector", "label": "Board inspector" }],
  "command": [{ "id": "clear", "label": "Clear all boards" }]
}
```

| kind | implementation | the host does |
|---|---|---|
| `insert` | `insert[id](ctx) → {html, caption?, island?, assets?, exports?, width?, height?}` | inserts a figure, writes the pin into the store |
| `inline` | `inline[id](ctx) → void` | closes the menu and calls you; **you** insert with `editor.insertInline()` |
| `export` | `export[id]() → {name, mime, text \| bytes}` | builds the Blob and the download |
| `panel` | `panel[id](body)` | creates a modal dialog and hands you an empty body |
| `command` | `command[id]()` | runs it; you act through capabilities |

`insert` and `inline` both render into the **Insert** menu, and the difference is where the
result goes: `insert` adds a *block* and the host owns it (the store, the editor, the dirty
flag); `inline` lands *at the caret inside a paragraph*, where only the plugin knows what it
means — so the host closes the menu and hands over, and the plugin inserts through
`editor.insertInline()`. A citation belongs in the second group; so would a date chip or an
inline formula.

Contributions that only exist as UI (`insert`, `inline`, `export`, `panel`, `command`) make the
plugin **build at boot** in an editor — a menu entry cannot be lazy. A plugin that only
contributes a runtime waits for a figure to ask.

An export returns `text` for a text format and `bytes` (`ArrayBuffer`, typed array or `Blob`)
for everything a writer actually emits — a `.docx` is a zip, and as a string it would be a
lie. `mime` defaults to `text/plain` for `text` and is required in practice for `bytes`;
the host builds the Blob, so the plugin never touches a download anchor.

A contribution returns **one** file. If a target needs companions — a `.typ` that references
`fig-01.png` — say so and refuse, or produce a format that embeds them. There is no archive
step for a plugin to borrow.

**A note on text assets.** There is no way to pin a file that is *data*: a `js` asset is
evaluated (so a Lua filter in a `js` slot fails to parse), and `bin` is the only kind that is
never evaluated — `host.bytes()` plus `TextDecoder` is how the pandoc plugin carries its
filter. A `kind: "text"` (or `json`) would be the honest primitive; until then, `bin` is the
workaround and it costs nothing but a decoder.

## 4. Islands

A figure's content mounts into an `iframe srcdoc` with a profile:

| profile | what the content can do | default for |
|---|---|---|
| `sealed` | no network, no storage, no parent, no dynamic code generation. WebAssembly still compiles | a plugin's own content |
| `compute` | as `sealed`, plus `'unsafe-eval'` — it may compile expressions at run time | a pinned charting engine (GenomeSpy, and every Vega derivative, builds filters with `new Function`) |
| `sandboxed` | may fetch; no storage, no parent | user-supplied HTML |
| `trusted` | `allow-same-origin`: can read and modify this document | nothing — it is a decision |

`sealed` is enforced with a Content-Security-Policy in the island
(`connect-src 'none'`, `frame-src 'none'`, `'wasm-unsafe-eval'`). The profile is stored **on
the figure**, decided at insert time, so a later plugin version cannot widen it.

`compute` exists because "no eval" and "no network" are different promises, and a
document that can say only both-or-neither either lies about a chart or refuses to draw it.
It is `sealed` plus one CSP source, `'unsafe-eval'`: the engine still cannot fetch, store or
reach the document, and the code it compiles is the code this file pinned and verified — a
compiler, not an address. It is measured, not assumed: in all three engines a GenomeSpy
bundle imported from a `blob:` in a `compute` island renders, and the same bundle in a
`sealed` island dies in `createExpression` (`Evaluating a string as JavaScript violates …
'unsafe-eval'`). An island profile that denies eval is also why a capture of it is mounted
with the serializer **inlined as code** instead of handed over as a string: the host does not
ask content for a capability its profile says it has not got.

`trusted` asks the author once, when the plugin is added or turned back on. There is no
separate "allowed" flag: the plugin entry in the file is the record. A reader is never asked
and never can be — the figure carries a *runs unsandboxed* badge instead.

### `restore`

`host.on("restore", fn)` fires after **undo, redo** (and any future surface that replaces
`#content` wholesale), with `{cause: "undo" | "redo"}`. It exists because undo is this
editor's own snapshot stack, not the browser's: `restore()` writes `content.innerHTML` inside
`signals.mute(...)`, so no `input` event is emitted and a plugin that renders *from* the
document hears nothing. The snapshot an insert recorded was taken before the plugin's own
relabel ran, so a redo restores the pre-relabel DOM — a citation mark reading `smith2020a`
instead of `[3]`, and no bibliography. If your plugin derives anything from the content,
relabel in this handler.

`permissions` is separate from the profile; it becomes the iframe's `allow=`:

```json
{ "id": "board", "kind": "html", "permissions": ["fullscreen"] }
```

Downloads, links, the clipboard and file pickers are **host-mediated**, not sandbox flags.

### A figure may draw its own export

Rasterizing an island is the fallback, not the contract. A contribution whose content holds
a vector source (a chart engine's `imageExport.svg()`, a canvas whose real output is SVG)
declares what it can produce, and the export asks it first:

```js
// the insert contribution
return { html, caption: "Locus", island: "compute", assets: ["genomespy", "genome-view"],
         exports: ["svg"], width: 1, height: 0.26 };
```

The island then exposes one function, and `figure-export` is the only message it answers:

```js
window.__figureExport = async ({format}) => ({
  format,                                  // "svg"
  text: await chart.api.imageExport.svg({background: "white"}),
});
```

`text` (an SVG document) or `dataUrl` is accepted; the host turns the first into
`data:image/svg+xml`. `exports` and `width`/`height` are stored **on the figure**, beside
`island` and `assets`: the file says which engine drew it, at what aspect, and what it can
still produce. A declared exporter that throws or times out is logged and the rasterizer
takes over, so the worst case is quality, never a missing figure.

What the *target* asks for is its own decision, and the reason the formats are a list: the
static-HTML and print paths ask for `["svg"]` first, while `materialize()` asks for nothing
unless its caller opts in — a `.docx` image path is not a browser.

## 5. Pinning and storage

Installing a plugin writes, into the document's own manifest:

- one asset entry per file, with `url` + `integrity` (and `bytes`), and
- a `plugins[id]` record naming its assets, label, version, island and declarations.

`mode: "online"` means the bytes are fetched at load; `mode: "inline"` means they are in the
document. The choice is per asset and belongs to the save policy — Document settings, not the
plugin — so "content inline, runtime online" is expressible.

A binary asset (`kind: "bin"`) is **base64 on one line** inline, and published as `.wasm`
(wasm is the only binary this project ships). Sizes and hashes are over the **decoded**
bytes, so the block and the file are one asset in two places.

**The url must be absolute.** A relative url resolves over http and fails from disk in two of
three engines; the sheet refuses one before fetching it.

## 6. Publishing a catalog entry

`plugins.json` at the repository root is curated; `node build.mjs combine` publishes it as
`dist/registry.json`, and the build folds the same rows into `dist/plugins/index.json` (the
file the sheet actually reads when a document names a `pluginIndex`) together with the
published bundle versions. `check` validates both.

```json
{ "id": "nanoid", "label": "Nano ID", "island": "sandboxed",
  "versions": [{ "version": "5.0.9", "url": "https://…", "sha384": "sha384-…",
                 "bytes": 477, "factory": null, "contributes": {} }] }
```

**A version's url must serve one self-contained ES module.** The loader evaluates verified
bytes from a `blob:`, where bare and relative specifiers cannot resolve — and no CDN gives you
that for a real library (`esm.sh/…?bundle` is a shim importing a relative path; esm.sh's real
bundle imports `/node/process.mjs`; jsDelivr's `+esm` imports `/npm/dayjs@…`). `verify-cdn`
fetches every entry and refuses one that imports anything, so the failure lands in CI rather
than in someone's sheet.

A catalog is **advisory**. A document embeds the `url` + `sha384` it installed; the catalog
only proposes. A document may also carry its catalog inline (`#plugin-catalog`) so the list
works offline.

### Bundles are folders, published at their own tags

A plugin that is a *bundle* — one plugin, many assets — has no entry in `assets`: that table is
one self-contained module per proposal. A bundle is a **folder** under `plugins/`, and its
`plugin.json` is the authored description of the version:

```json
{
  "schema": 1, "id": "pandoc-export", "label": "Pandoc export",
  "version": "0.1.1", "api": 1, "island": "sealed", "entry": "pandoc-export",
  "publishBase": "runtime",
  "orderBase": 300, "pinBase": 400,
  "copies": [ { "id": "sd-export-lua", "kind": "bin", "file": "tools/sd-export.lua", "as": "sd-export.lua" } ],
  "pins":   [ { "id": "pandoc", "kind": "bin", "bytes": 58580800, "url": "https://…", "integrity": "sha384-…" } ],
  "contributes": { "export": [ { "id": "docx", "label": "Word (.docx)…" } ] }
}
```

`publishBase` decides the address its bytes ride:

- `"tag"` (the default) — its own git tag, `plugin-<id>-v<version>`. **This is the point of the
  scheme:** a plugin version does not wait for a runtime release, and publishing one is a change
  to that folder plus a tag.
- `"runtime"` — the runtime tag this tree publishes. It exists only as the migration state for
  the versions that shipped inside a runtime release before plugin tags existed
  (`pandoc-export 0.1.1`, `citations 0.1.2`). Remove it when that plugin next bumps.

Tags are **flat** (`plugin-citations-v0.3.0`, not `plugin/citations/v0.3.0`): jsDelivr parses
`gh/user/repo@ref/path`, and a ref containing `/` — or a second `@` — is ambiguous with the
path. A plugin tag is immutable and is never deleted; it is an address a document may pin
forever.

**Discovery is the plugin index**, `dist/plugins/index.json`, generated from those tags by
`node build.mjs catalog` (the same rule as the runtime index: an entry may only claim bytes a
tag shipped). Its `bundles` section keeps the shape the sheet already reads, plus `versions`:

```json
"pandoc-export": {
  "label": "Pandoc export", "version": "0.1.1", "api": 1, "island": "sealed",
  "entry": "pandoc-export",
  "manifest": "https://cdn.jsdelivr.net/gh/<owner>/<repo>@plugin-pandoc-export-v0.1.1/dist/plugins/pandoc-export.json",
  "bytes": 4440, "sha384": "sha384-…",
  "assets": 8, "assetBytes": 87198155,
  "about": "Word, typeset PDF, …",
  "minRuntime": "v0.1.0",
  "versions": [ { "version": "0.1.1", "…": "the same row" } ]
}
```

| field | meaning |
|---|---|
| `manifest` | Absolute when the bytes ride the plugin's tag, relative when they still ride the runtime (migration, and a dev build). Absolute is what makes an install independent of the runtime tag a document pins. |
| `sha384`, `bytes` | Of that manifest file. The runtime fetches the manifest with `prefetch`, refuses it if the hash disagrees, and only then trusts the pins inside. An index can propose pins; it cannot rewrite them. |
| `versions` | Every published version, newest first. The top-level fields are the newest row, so an older reader that only knows one version keeps working. |
| `minRuntime` | The oldest runtime whose `hostApi` satisfies this version. `null` when no published release does — the sheet says so instead of offering a dead button. |
| `assets`, `assetBytes`, `entry`, `api`, `island`, `about` | What the row can show without reading the manifest. |

The index is addressed by `manifest.json`'s **`pluginIndex`**, not by `<cdnBase>/../`: plugin
versions are tagged independently, so the index is one moving file (`@main`) and every version
it names is immutable. A document written before the field existed falls back to the legacy
`<cdnBase>/../registry.json`, which is also still generated (and still names the migration
plugins) for the documents that pin an older tag.

**An extension is part of the address.** jsDelivr refuses a published list of extensions with
`403` and serves nothing extensionless (`404`), so a pin at, say, `reference.docx` is a url no
document can read — v0.8.1 shipped exactly that and the Word export silently lost its reference
styling. `bundleProblems()` refuses a jsDelivr pin at a blocked extension and at a url with no
extension at all; the measured-good set is `.bin`, `.dat`, `.zip`, `.txt`, `.b64`, `.json`.
Publish an awkward binary under a boring name and let the plugin rename it in memory.

**Size is part of the address too.** jsDelivr refuses any file over **50 MB** with `403 File size
exceeded the configured limit of 50 MB` — a *hard* 403 on a url that looks perfectly ordinary,
and one that no hash in a manifest can reveal. v0.12.0 pinned `pandoc.wasm` (58.6 MB) there, so
the Word export's first fetch could never succeed; the pin is now on unpkg. `bundleProblems()`
refuses a jsDelivr pin whose declared `bytes` exceed the cap (offline, before a tag), and
`verify-cdn` sends a HEAD to every third-party pin so a host that changes its mind is a red job.
A large binary belongs on a host that will serve it, and the sha384 the document carries is what
makes that choice reversible.

`bundles` is **generated, never authored**: `tools/publish-plugin.mjs` owns the manifest, `check`
fails when the index and the tag disagree (including a tag whose name does not match the
manifest it points at), and `verify-cdn` fetches the index, every manifest it names, and every
asset this repository serves. A published plugin nobody can discover is the failure that is
easiest to ship and hardest to notice.

Installing one writes N asset entries and one `plugins` entry, carrying `api` with it (absent
means `1`). The assets are **not** fetched at install time: a 58 MB engine is a first-export
cost, and the loader verifies each pin when it is used.

### Publishing a plugin version

```
1. bump plugins/<id>/plugin.json's version (and drop publishBase: "runtime" if it is there)
2. node build.mjs build                  # manifests, dist/plugins/index.json
3. node build.mjs check                  # tags, index and bytes agree
4. git tag -a plugin-<id>-v<version> -m "…"
5. git push origin main && git push origin plugin-<id>-v<version>
6. node build.mjs purge --main          # only the index is mutable
7. node build.mjs verify-cdn             # fetches the index and the version it names
```

The build is deterministic and the manifest already names the tag it is about to get, so the
bytes at the tag are the bytes the index advertises; there is no second build after tagging.
A tag is never moved or deleted.

**Testing one before its release.** `node build.mjs build --base=<url> --out=<dir>` writes a
whole publication, not just documents: the cdn bytes, `registry.json`, `plugins/index.json`, and
each bundle's manifest, every url re-pointed at the base. Because the built documents carry
`pluginIndex` = `<base>/../plugins/index.json`, the base's parent directory has to be where
`<dir>` is served — `--base=http://127.0.0.1:8080/.test-tmp/build/cdn` with the default `--out`
does exactly that. Point `--base` somewhere else and the sheet reads *that* address's index,
which is usually the last release: correct behaviour, and the reason a dev build used to offer
nothing.

### Updating an installed plugin

The Plugins panel compares each installed plugin's `version` with the index's newest row: a
*module* against `assets[id].versions[0]`, a *bundle* against `bundles[id].versions[0]`. A newer
version puts **Update to x.y.z** on that plugin's row, and only there. But a version whose `api`
this file cannot provide is **blocked** before that comparison: the row offers **Update runtime
to `<minRuntime>`** instead, because no plugin update can fix a host that lacks the contract.
The Runtime panel notices a count on the tab; it never moves a plugin pin as a side effect of a
runtime update.

The pin *is* the install, so an upgrade is an install that may overwrite: the entry is
rewritten, the assets the new version no longer names are dropped, and `enabled` survives (an
author who switched a plugin off did not ask for it back on by accepting an update). A level of
trust is a consent, not a field: an update that does not widen the island reuses the existing
record, and one that widens asks again.

**The same version carrying different bytes is not an update.** The row says *Bytes differ* and
the action refuses: that is a different plugin wearing the same name, and calling it an upgrade
would launder the substitution.

## 7. Versioning

`plugins[id].api` is the host API the plugin needs; absent means `1`. The registry refuses a
plugin asking for a newer host (`kind: "api"`) before calling `activate()`. The contract will
change; a plugin that wants to survive that should declare the version it was written against.

| host api | what it added |
|---|---|
| 1 | the table above minus the last two rows: `figures`, `editor.insertBlock`, `status` |
| 2 | `editor.insertInline`, `pagination.defineBlock`, the `inline` contribution kind, `host.on("restore")`, `data-atomic`, and the `data-plugin-style` rule |
| 3 | an `insert` contribution states its own `width`/`height` and its `exports`; the `compute` island profile; `figure-export` (a figure draws its own vector export) |

A plugin that inserts inline content must declare `2`: on an older host it would activate and
then fail halfway through an insertion, which is precisely what the field prevents.

**What a reader of an older document sees.** Plugin discovery is no longer the runtime tag's
business: the sheet reads `pluginIndex`, so a plugin published after the document's runtime tag
is visible, and installing it does not require moving the runtime. What can still refuse is the
**API**: a plugin version may need a `HOST_API` the file's loader does not provide.

That refusal has a route, and it names a release rather than a direction. The index records
`hostApi` per runtime release; a plugin row whose `api` is too new becomes **Update runtime to
v0.13.0** (the oldest release that provides it), which opens Document settings → Runtime. The
pin moves for the file, the session keeps the runtime it booted with, and the new `HOST_API`
arrives on reopen — at which point the install succeeds. When no published release provides the
API yet, the row says exactly that and disables the action; a dead button is not a remedy.

Two refusals exist for the cases that can still happen, and both name the remedy. The sheet
refuses an install whose manifest asks for a newer host than this runtime provides, and
`require()` refuses an *already pinned* plugin the same way — before `activate()`, with
`kind: "api"`, so a document that pins a runtime older than its plugin stays readable and
says why.

**Every release records the API it provides.** `dist/runtime/<tag>.json` carries `hostApi`,
read from that tag's own `src/registry.js` (a release older than the contract reports 1), and
`dist/runtime.json` repeats it per release. That is what lets a surface answer "which runtime
would make this plugin work?" instead of only "this runtime is too old": the refusal's
`need` is the plugin's `api`, the index's `hostApi` is each release's answer, and the smallest
satisfying release is the target. The loader never guesses from its current constant — an
index entry is a claim about the past and has to come from the past.

## 8. Failure

A plugin that fails never takes the document with it: `require()` records the failure, the
figure that asked shows a card with the reason and a click to retry, and the document stays
readable. Failure kinds a plugin will see: `unresolved` (no pinned copy in this document),
`disabled` (switched off here), `integrity` (bytes do not match the pin), `api` (needs a newer
host), `construct` (threw while building or activating), `unavailable` (asked for a capability
this document lacks), `forbidden` (asked for another plugin's bytes).

There is no automatic retry. A failing plugin must not refetch on every scroll; a click is
deliberate.

**The soft lane is one asset wide.** Plugin *assets* have always been non-fatal — they are
built by `require()`, never by `boot()`. The only runtime module that may now fail without
stopping the document is `plugins` (`critical: false` in the manifest): the editor opens, the
content and saving work, and a **Ready — with limitations** card names the missing feature and
its remedy. Everything else is still fail-closed on purpose; a document that claims to be
ready with a broken editor or paginator is a worse lie than a failure card. A soft module's
`fragments` are declared so boot can skip it rather than construct it against missing DOM.

**Every failure carries a remedy.** `failure()` attaches `{action, target?, need?, why?}` to
the record, and every surface renders the same answer: the boot card, the figure notice, the
Plugins row, and `diagnostics()` (`next: retry — nothing in the file has changed`). The
actions are `retry`, `update-runtime`, `update-plugin`, `refresh-catalog`, `reopen`,
`open-editor-copy`, and `none`. `none` is a real answer, not an empty button: it carries the
reason, because "this file cannot fix it" is what stops a reader clicking forever. A figure's
notice only says "click to retry" when retrying could work; an `api` refusal names the
runtime update instead, because a retry would loop.
