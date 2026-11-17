# Changelog

## v0.2.0 — 2025-11-17

The document gains a settings sheet, and its own behaviour becomes editable without
hand-editing JSON.

### Added

- **Document settings** (gear in the toolbar, `Mod+,`): mode, content lock, toolbar,
  the size threshold, the storage preset and per-capability rows (inline / CDN /
  absent), and the load timeout. Behaviour applies on next open; storage applies
  when you save. Clicking the size readout opens the same sheet at Size & loading.
- **Chrome preference** is part of the file: `settings.ui` remembers ribbon vs
  minimal, restored at boot before first paint.
- The gear menu replaces the standalone keyboard-shortcuts button; it carries
  *Document settings…* and *Keyboard shortcuts*, and no Save.

### Changed

- **`timeoutMs` moved from `#asset-manifest` to `#doc-settings`.** A timeout is
  behaviour, not an asset. Documents saved before this keep their timeout: the loader
  falls back to the manifest's copy, then to 8000 ms.
- **The keyboard-shortcuts button folded into the gear menu**, in both bars.
- **The dirty dot is honest**: toggling the chrome no longer marks the file dirty, and
  neither does opening the settings sheet and pressing Done without changes. A plain
  save no longer invents `policy: "inline"` — a document that never chose a policy
  stores nothing, because inline is the default.

### Format

`schema: 1`, still preliminary. Two additive fields (`settings.ui`, `settings.timeoutMs`)
and one subtraction: `policy` is only written when it differs from the default.

## v0.1.0 — 2025-11-17

The first published runtime. `manifest.json.cdnBase` points at
`…/standalone-doc@v0.1.0/dist/cdn`, so a document saved by this version pins an
immutable tag and verifies every asset by SHA-384 before running it.

### What works

- **One file, self-saving.** `dist/editor.html` contains the editor, the content and
  every asset inline. It opens from `file://`, edits, and saves back to one file.
- **Two other flavours**, built from the same source: `dist/slim.html` (infrastructure
  inline, everything else fetched from the tag) and `dist/viewer.html` (view mode, the
  editing capability absent rather than offloaded).
- **A loader with a contract.** `boot()` reads the document's `#asset-manifest`, loads
  in parallel, verifies each hash, then constructs in manifest order. Failures are
  reported per kind (`offline`, `unreachable`, `http`, `timeout`, `integrity`,
  `import`, `missing`, `construct`) and fail closed: no partial boot, no "open anyway".
- **Document settings.** `#doc-settings` carries `mode` (`edit` / `view`), whether the
  content is editable, whether chrome shows, and the size threshold. The loader applies
  it; a hand-edited document cannot claim to be editable when the file says otherwise.
- **Document dependencies declared, not discovered.** Each asset declares the modes
  that need it, an optional back-edge is explicit (`deps.optional`), and the build
  audits the graph: a construction dependency must exist in every mode its dependent
  exists in.
- **Save policies.** `inline` (default), `smart` (body inline, authoring online) and
  `slim` (everything but the loader online), applied per asset. A save over the
  document's own threshold asks once, per capability, with measured sizes; "keep
  inline" is remembered until the file doubles.
- **Chrome as fragments.** The sprite, toolbar, figure tools and edit-only dialogs are
  `kind="html"` assets: markup that can be inline, fetched and hash-verified, or absent.
- **One global.** `StandaloneDoc`. Everything else arrives through the manifest.

### Format

`schema: 1`. **Preliminary.** Fields are added as phases land and there is no migration
contract yet; a document saved by this version opens in later ones, but a later document
may use fields this version does not know. `schema` becomes meaningful when the editor
is stable enough to promise migrations.

### Verifying a release

```sh
node build.mjs check                       # the tree agrees with itself
node build.mjs verify-cdn --tag=v0.1.0     # every published byte matches its hash
```

The second command is also a nightly job (`.github/workflows/cdn.yml`).

### Not in this release

- The plugin manager, and plugin discovery via a registry. A figure cannot yet require
  a plugin; when it can, the plugin's URL and hash will be pinned in the document that
  uses it.
- The `update-runtime` flow: a document can be re-saved with a newer pin, but nothing
  offers it.
- A settings panel: `#doc-settings` is edited by hand today.
- Public authoring docs for plugins and the manifest (`docs/`).
