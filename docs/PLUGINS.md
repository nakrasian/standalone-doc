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
`exec`, `setBlock`, `blockAt`), `status` (`refresh`, `markDirty`). A capability exists only
when the module providing it was built — a view-mode document has no `editor`.

`insertBlock()` leaves a text block below the atomic block it inserted (a contenteditable
region cannot hold a caret inside `contenteditable="false"` content), reusing the block
that is already there when the insertion lands mid-document. A plugin inserting its own
non-editable markup gets the same guarantee for free.

**Rule: a plugin extends the surface, it never occupies it.** Do not write markup into the
toolbar, the menus or `#content`. Ask the host: `figures.insertHTML()` owns the store, the
editor and the dirty flag; a panel gets a body to fill; a menu entry is a declaration.

**Rule: `track()` everything.** `deactivate()` is a promise nobody can verify. The host
withdraws what it handed you either way; what you created yourself is yours to clean up.

## 3. Declaring contributions

A plugin declares what it offers in the manifest, and implements it on the object
`activate()` returns. The host renders the declaration and calls the implementation — a
plugin cannot add a menu item that is not in its declaration.

```json
"contributes": {
  "insert":  [{ "id": "board", "label": "Whiteboard", "island": "sealed" }],
  "export":  [{ "id": "png", "label": "Whiteboard as PNG…" }],
  "panel":   [{ "id": "inspector", "label": "Board inspector" }],
  "command": [{ "id": "clear", "label": "Clear all boards" }]
}
```

| kind | implementation | the host does |
|---|---|---|
| `insert` | `insert[id](ctx) → {html, caption?, island?}` | inserts a figure, writes the pin into the store |
| `export` | `export[id]() → {name, mime, text \| bytes}` | builds the Blob and the download |
| `panel` | `panel[id](body)` | creates a modal dialog and hands you an empty body |
| `command` | `command[id]()` | runs it; you act through capabilities |

Contributions that only exist as UI (`insert`, `export`, `panel`, `command`) make the plugin
**build at boot** in an editor — a menu entry cannot be lazy. A plugin that only contributes a
runtime waits for a figure to ask.

An export returns `text` for a text format and `bytes` (`ArrayBuffer`, typed array or `Blob`)
for everything a writer actually emits — a `.docx` is a zip, and as a string it would be a
lie. `mime` defaults to `text/plain` for `text` and is required in practice for `bytes`;
the host builds the Blob, so the plugin never touches a download anchor.

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

## 7. Versioning

`plugins[id].api` is the host API the plugin needs; absent means `1`. The registry refuses a
plugin asking for a newer host (`kind: "api"`) before calling `activate()`. The contract will
change; a plugin that wants to survive that should declare the version it was written against.

## 8. Failure

A plugin that fails never takes the document with it: `require()` records the failure, the
figure that asked shows a card with the reason and a click to retry, and the document stays
readable. Failure kinds a plugin will see: `unresolved` (no pinned copy in this document),
`disabled` (switched off here), `integrity` (bytes do not match the pin), `api` (needs a newer
host), `construct` (threw while building or activating), `unavailable` (asked for a capability
this document lacks), `forbidden` (asked for another plugin's bytes).

There is no automatic retry. A failing plugin must not refetch on every scroll; a click is
deliberate.
