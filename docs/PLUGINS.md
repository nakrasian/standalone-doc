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
`status` (`refresh`, `markDirty`). A capability exists only when the module providing it was
built — a view-mode document has no `editor`.

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
| `insert` | `insert[id](ctx) → {html, caption?, island?}` | inserts a figure, writes the pin into the store |
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
| `sealed` | no network, no storage, no parent. WebAssembly still compiles | a plugin's own content |
| `sandboxed` | may fetch; no storage, no parent | user-supplied HTML |
| `trusted` | `allow-same-origin`: can read and modify this document | nothing — it is a decision |

`sealed` is enforced with a Content-Security-Policy in the island
(`connect-src 'none'`, `frame-src 'none'`, `'wasm-unsafe-eval'`). The profile is stored **on
the figure**, decided at insert time, so a later plugin version cannot widen it.

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
`dist/registry.json`, and `check` validates it.

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

### Bundles

A plugin that is a *bundle* — one plugin, many assets — has no entry in `assets`: that table is
one self-contained module per proposal, and a bundle's pins live in a manifest it publishes
beside itself. The catalog carries a pointer instead, generated into `dist/registry.json` from
the same bytes `published()` emits:

```json
"bundles": {
  "pandoc-export": {
    "label": "Pandoc export", "version": "0.1.1", "api": 1, "island": "sealed",
    "entry": "pandoc-export",
    "manifest": "plugins/pandoc-export.json",
    "bytes": 4435, "sha384": "sha384-…",
    "assets": 8, "assetBytes": 87198155,
    "about": "Word, typeset PDF, …"
  }
}
```

| field | meaning |
|---|---|
| `manifest` | Path **relative to the catalog's own directory** (`<cdnBase>/../`), so an install rides the tag the *document* pins — not whichever sibling the catalog was read from. |
| `sha384`, `bytes` | Of that manifest file. The runtime fetches the manifest with `prefetch`, refuses it if the hash disagrees, and only then trusts the pins inside. A catalog can propose pins; it cannot rewrite them. |
| `assets`, `assetBytes` | What the sheet shows in the row. It never reads the manifest to draw a list. |
| `entry`, `api`, `island` | The plugin half, for the same preview and the same refusal an `assets` entry gets. |

**An extension is part of the address.** jsDelivr refuses a published list of extensions with
`403` and serves nothing extensionless (`404`), so a pin at, say, `reference.docx` is a url no
document can read — v0.8.1 shipped exactly that and the Word export silently lost its reference
styling. `bundleProblems()` refuses a jsDelivr pin at a blocked extension and at a url with no
extension at all; the measured-good set is `.bin`, `.dat`, `.zip`, `.txt`, `.b64`, `.json`.
Publish an awkward binary under a boring name and let the plugin rename it in memory.

`bundles` is **generated, never authored**: `tools/publish-plugin.mjs` owns the manifest, `check`
fails when the catalog and the manifest disagree, and fails again when a manifest exists in
`dist/plugins/` that the catalog does not name — a published plugin nobody can discover is the
failure that is easiest to ship and hardest to notice.

Installing one writes N asset entries and one `plugins` entry, carrying `api` with it (absent
means `1`). The assets are **not** fetched at install time: a 58 MB engine is a first-export
cost, and the loader verifies each pin when it is used.

**Testing one before its release.** `node build.mjs build --base=<url> --out=<dir>` writes a
whole publication, not just documents: the cdn bytes, `registry.json`, and each bundle's
manifest, every url re-pointed at the base. Because the sheet derives the catalog url from the
document's `cdnBase`, the base's parent directory has to be where `<dir>` is served —
`--base=http://127.0.0.1:8080/.test-tmp/build/cdn` with the default `--out` does exactly that.
Point `--base` somewhere else and the sheet reads *that* address's catalog, which is usually
the last release: correct behaviour, and the reason a dev build used to offer nothing.

### Updating an installed plugin

The Plugins panel compares each installed plugin's `version` with the catalog's: a *module*
against `assets[id].versions[0]`, a *bundle* against `bundles[id].version`. A newer version puts
**Update to x.y.z** on that plugin's row, and only there — the Runtime panel notices a count on
the tab, it never moves a plugin pin as a side effect of a runtime update.

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

A plugin that inserts inline content must declare `2`: on an older host it would activate and
then fail halfway through an insertion, which is precisely what the field prevents.

**What a reader of an older document sees.** The sheet reads the catalog at *the tag the
document itself pins* (`<cdnBase>/../registry.json`), so a plugin published after that tag is
not in the list at all — there is nothing to refuse. The route is the runtime, not the sheet:
**Document settings → Runtime → Check for updates…** re-pins the file, and the *next* open
reads the new tag's catalog with the new `HOST_API`, at which point the install succeeds. The
pin moves for the file and the session keeps the runtime it booted with, which is why the
plugin appears after a reopen rather than immediately.

Two refusals exist for the cases that can still happen, and both name the remedy. The sheet
refuses an install whose manifest asks for a newer host than this runtime provides, and
`require()` refuses an *already pinned* plugin the same way — before `activate()`, with
`kind: "api"`, so a document that pins a runtime older than its plugin stays readable and
says why.

## 8. Failure

A plugin that fails never takes the document with it: `require()` records the failure, the
figure that asked shows a card with the reason and a click to retry, and the document stays
readable. Failure kinds a plugin will see: `unresolved` (no pinned copy in this document),
`disabled` (switched off here), `integrity` (bytes do not match the pin), `api` (needs a newer
host), `construct` (threw while building or activating), `unavailable` (asked for a capability
this document lacks), `forbidden` (asked for another plugin's bytes).

There is no automatic retry. A failing plugin must not refetch on every scroll; a click is
deliberate.
