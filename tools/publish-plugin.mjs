#!/usr/bin/env node
/* tools/publish-plugin.mjs — one folder per plugin, exported as a thing a document can install.
 *
 *   node tools/publish-plugin.mjs            write dist/cdn/plugins/… and the manifest
 *   node tools/publish-plugin.mjs --check    fail if either is stale (run by `check`)
 *
 * "Publishing" here means what it means everywhere else in this repository: the bytes live in
 * `dist/`, which is committed and served at a tag, and a JSON file records id, kind, size and
 * sha384 for each one. A document installs by copying those entries into `#asset-manifest` and
 * adding a `plugins` block — nothing fetches, nothing is guessed, every byte is verified.
 *
 * The authored description is `plugins/<id>/plugin.json`; this tool turns it into the bytes and
 * the manifest, and decides which tag they ride. A plugin released at its own
 * `plugin-<id>-v<version>` tag is independent of the runtime's release cadence; the two
 * versions that shipped inside a runtime release keep `publishBase: "runtime"` until they next
 * bump. `docs/PLUGINS.md` §6 has the publish ritual.
 *
 * The three big assets are *not* copied: a 58 MB binary and a 27 MB compiler belong on npm,
 * where jsDelivr already serves them immutably, not in a git tag. Their pins are recorded in
 * the folder's `plugin.json`, which is the same arrangement `plugins.json` uses for nanoid —
 * the hash is the promise, the URL is only the address.
 *
 * Why a separate manifest file and not `plugins.json`: the curated catalog describes one ES
 * module per plugin, and a bundle is many assets. The catalog does not grow a second shape for
 * it — it grows a *pointer*: `dist/plugins/index.json` (and the legacy `dist/registry.json`)
 * carries a `bundles` section whose entries name this manifest, its size, and its own sha384.
 * The projection below is the only place the catalog learns about a bundle, and it is derived
 * from the same bytes `published()` emits, so the advertised hash and the manifest cannot
 * drift apart.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const sha384 = (buffer) => "sha384-" + createHash("sha384").update(buffer).digest("base64");
/* Paths in messages are repo-relative in every other tool here; keep it that way. */
const rel = (file) => path.relative(ROOT, file).split(path.sep).join("/");

/**
 * The plugin descriptions, one `plugin.json` per folder under `plugins/`.
 *
 * A plugin is a *folder*: its label, version, host API, published copies and npm pins live
 * beside its source, so publishing one is a change to that directory and nothing else.
 *
 * `publishBase` is the address its bytes ride:
 *
 *   "tag"     its own `plugin-<id>-v<version>` tag (the default) — independent versions
 *   "runtime" the runtime tag this tree publishes — the migration state for a plugin that
 *             shipped inside a runtime release before plugin tags existed
 */
/**
 * The island profiles a plugin's *content* may mount into. `compute` is `sealed` plus
 * `'unsafe-eval'` — a pinned engine that compiles expressions (GenomeSpy, any Vega
 * derivative) — and it is not a trust level: no network, no storage, no parent.
 */
export const ISLAND_PROFILES = ["sealed", "compute", "sandboxed", "trusted"];

export function pluginConfigs() {
  const dir = path.join(ROOT, "plugins");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name, "plugin.json"))
    .filter((file) => fs.existsSync(file))
    .map((file) => JSON.parse(fs.readFileSync(file, "utf8")))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** Every way a plugin folder is not publishable. Empty array means it is. */
export function pluginConfigProblems(config) {
  const problems = [];
  const say = (problem) => problems.push(`plugin folder "${config?.id ?? "?"}": ${problem}`);
  if (!config || typeof config !== "object") return ["plugin.json is not an object"];
  if (config.schema !== 1) say(`schema is ${config.schema}, expected 1`);
  if (!SLUG_RE.test(String(config.id || ""))) say("id must be a slug");
  if (!config.label) say("label is required");
  if (!/^\d+\.\d+\.\d+$/.test(String(config.version || ""))) say(`version must be x.y.z, not ${JSON.stringify(config.version)}`);
  if (!Number.isInteger(config.api) || config.api < 1) say("api must be a positive integer");
  if (!ISLAND_PROFILES.includes(config.island)) say(`island must be one of ${ISLAND_PROFILES.join(", ")}`);
  if (!config.entry) say("entry is required (the asset whose factory is the plugin)");
  if (!["runtime", "tag"].includes(config.publishBase ?? "tag")) say(`publishBase must be "runtime" or "tag"`);
  if (!Number.isInteger(config.orderBase)) say("orderBase must be an integer");
  if (!Number.isInteger(config.pinBase)) say("pinBase must be an integer");

  const copies = Array.isArray(config.copies) ? config.copies : [];
  if (!copies.length) say("copies must be a non-empty array");
  for (const copy of copies) {
    if (!SLUG_RE.test(String(copy?.id || ""))) { say(`copy "${copy?.id}": id must be a slug`); continue; }
    if (!["js", "css", "html", "bin"].includes(copy.kind)) say(`copy "${copy.id}": kind must be js, css, html or bin`);
    if (!copy.file) say(`copy "${copy.id}": file is required`);
    else if (!fs.existsSync(path.join(ROOT, copy.file))) say(`copy "${copy.id}": ${copy.file} is missing`);
    if (!copy.as || /[\\/]/.test(String(copy.as))) say(`copy "${copy.id}": as must be a bare filename`);
  }
  const pins = Array.isArray(config.pins) ? config.pins : [];
  for (const pin of pins) {
    if (!SLUG_RE.test(String(pin?.id || ""))) { say(`pin "${pin?.id}": id must be a slug`); continue; }
    if (!["js", "css", "html", "bin"].includes(pin.kind)) say(`pin "${pin.id}": kind must be js, css, html or bin`);
    if (!Number.isInteger(pin.bytes) || pin.bytes <= 0) say(`pin "${pin.id}": bytes must be a positive integer`);
    if (!/^https:\/\//.test(String(pin.url || ""))) say(`pin "${pin.id}": url must be absolute https://`);
    if (!SHA384_RE.test(String(pin.integrity || ""))) say(`pin "${pin.id}": integrity must be "sha384-" + 64 base64 characters`);
  }
  return problems;
}

/**
 * The base one plugin's bytes ride.
 *
 * A plugin tag is the default because a plugin's version must not wait for the runtime's:
 * `plugin-<id>-v<version>` names exactly the bytes that version published. `"runtime"` is
 * the migration state, and it is explicit so that forgetting to flip it cannot silently
 * move a published plugin's address.
 */
export function pluginBaseFor(config, cdnBase) {
  if ((config.publishBase || "tag") === "runtime") return cdnBase;
  const slug = /cdn\.jsdelivr\.net\/gh\/([^/@]+\/[^/@]+)@/.exec(String(cdnBase || ""))?.[1];
  /* Another host may not have a tag namespace we can name; publishing there stays on the
     runtime base rather than inventing an address. */
  if (!slug) return cdnBase;
  return `https://cdn.jsdelivr.net/gh/${slug}@plugin-${config.id}-v${config.version}/dist/cdn`;
}


/**
 * Every published byte, keyed by the path it is committed at.
 *
 * `base` re-points the derived urls — the same arrangement `build --base` gives a document.
 * A dev build has to carry its own manifest, or the plugin it advertises pins the tag the tree
 * was built from instead of the bytes beside it.
 */
export function published({ base = null } = {}) {
  const cdnBase = String(base || authoredCdnBase()).replace(/\/$/, "");
  const out = new Map();

  for (const bundle of pluginConfigs()) {
    /* A `base` is a dev address for every byte this tree publishes, so it wins. Otherwise
       each plugin rides its own tag unless its folder says it still rides the runtime's. */
    const origin = base || pluginBaseFor(bundle, cdnBase);
    const dir = `plugins/${bundle.id}`;
    const assets = [];

    bundle.copies.forEach((entry, index) => {
      const bytes = fs.readFileSync(path.join(ROOT, entry.file));
      out.set(`dist/cdn/${dir}/${entry.as}`, bytes);
      assets.push({
        id: entry.id,
        kind: entry.kind,
        role: "module",
        order: bundle.orderBase + index,
        mode: "online",
        category: "plugin",
        plugin: bundle.id,
        requiredBy: ["*"],
        bytes: bytes.length,
        url: `${origin}/${dir}/${entry.as}`,
        integrity: sha384(bytes),
        ...(entry.factory ? {factory: entry.factory} : {}),
      });
    });
    bundle.pins.forEach((entry, index) => {
      assets.push({
        id: entry.id, kind: entry.kind, role: "module", order: bundle.pinBase + index, mode: "online",
        category: "plugin", plugin: bundle.id, requiredBy: ["*"],
        bytes: entry.bytes, url: entry.url, integrity: entry.integrity,
      });
    });

    const manifest = {
      schema: 1,
      id: bundle.id,
      label: bundle.label,
      version: bundle.version,
      api: bundle.api,
      island: bundle.island,
      entry: bundle.entry || bundle.copies.at(-1).id,
      about: bundle.about,
      assets,
      contributes: bundle.contributes,
    };
    out.set(`dist/plugins/${bundle.id}.json`, Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  }
  return out;
}

/**
 * Every published plugin manifest, parsed, with the catalog row derived from it.
 *
 * Derived, never authored: a bundle's pins are bytes in this tree, and hand-copying them into
 * a JSON file is how a catalog starts lying. `bundles[id].manifest` is relative to the
 * catalog's own directory (`dist/`), which is what makes an install ride the tag the
 * *document* pins rather than whichever sibling the catalog happened to be read from.
 */
export function publishedBundles({ base = null } = {}) {
  const cdnBase = String(base || authoredCdnBase()).replace(/\/$/, "");
  const files = published({ base });
  const bundles = [];
  for (const config of pluginConfigs()) {
    const file = `dist/plugins/${config.id}.json`;
    const bytes = files.get(file);
    if (!bytes) continue;
    const manifest = JSON.parse(bytes.toString("utf8"));
    const origin = base || pluginBaseFor(config, cdnBase);
    /* Relative when the manifest lives at the runtime tag the document pins (the legacy
       arrangement, and a dev build); absolute when the plugin rides its own tag, because a
       relative path would resolve to a runtime tag that never carried those bytes. */
    const manifestPath = origin === cdnBase
      ? file.replace(/^dist\//, "")
      : `${origin.replace(/\/cdn$/, "")}/plugins/${config.id}.json`;
    bundles.push({
      file,
      manifest,
      entry: {
        label: manifest.label,
        version: manifest.version,
        api: manifest.api ?? 1,
        island: manifest.island,
        entry: manifest.entry,
        manifest: manifestPath,
        bytes: bytes.length,
        sha384: sha384(bytes),
        assets: manifest.assets.length,
        assetBytes: manifest.assets.reduce((sum, asset) => sum + (Number(asset.bytes) || 0), 0),
        about: manifest.about,
      },
    });
  }
  return bundles;
}

/** The cdnBase the current manifest.json pins; the authority for "bytes we publish". */
function authoredCdnBase() {
  return String(JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).cdnBase || "")
    .replace(/\/$/, "");
}

const SHA384_RE = /^sha384-[A-Za-z0-9+/]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

/* jsDelivr refuses a published list of extensions (HTTP 403) and serves nothing without one
 * (404). Measured 2026-11-18 by pinning the same bytes at every candidate under a throwaway
 * tag: .bin, .dat, .zip, .txt, .b64, .json → 200; extensionless → 404; .docx → 403. A pin
 * that cannot be fetched is a document that cannot load, and the failure has to land before
 * the tag, not after it — which is how v0.8.1 shipped `reference.docx` and silently lost the
 * Word reference styling. */
const BLOCKED_EXTENSIONS = new Set(["docx"]);

/* The second thing jsDelivr refuses, and the one that cost a release: a file over 50 MB is
 * answered with `403 File size exceeded the configured limit of 50 MB`. Measured 2026-11-19
 * on `pandoc.wasm` (58.6 MB), pinned at `pandoc-wasm@1.1.0` since v0.12.0 — every hash in
 * the manifest was right, and the Word export still could not fetch the engine it runs on.
 * The manifest already declares `bytes`, so this is a build-time fact, not a network call. */
const JSDELIVR_MAX_BYTES = 50_000_000;
const servedByJsDelivr = (url) => {
  try {
    return new URL(String(url)).hostname === "cdn.jsdelivr.net";
  } catch {
    return false;
  }
};

/**
 * Everything about a bundle manifest that would make an install fail, a document lie, or the
 * catalog advertise a pin nobody can satisfy. Empty array means publishable.
 *
 * The hash check is the half `check` was missing: the manifest says what each asset's bytes
 * hash to, and for the assets this repository serves, dist/ is where those bytes are. A
 * manifest is only worth its promise if the promise is checked before it is published.
 */
export function bundleProblems(manifest, { cdnBase = authoredCdnBase() } = {}) {
  const problems = [];
  const say = (problem) => problems.push(`bundle ${JSON.stringify(manifest?.id)}: ${problem}`);
  if (!manifest || typeof manifest !== "object") return ["bundle is not an object"];
  if (manifest.schema !== 1) say(`schema is ${manifest.schema}, expected 1`);
  if (!SLUG_RE.test(String(manifest.id || ""))) say("id must be a slug");
  if (!manifest.label) say("label is required");
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version || ""))) say(`version must be x.y.z, not ${JSON.stringify(manifest.version)}`);
  if (!Number.isInteger(manifest.api) || manifest.api < 1) say("api must be a positive integer");
  if (!ISLAND_PROFILES.includes(manifest.island)) say(`island must be one of ${ISLAND_PROFILES.join(", ")}`);
  if (!manifest.entry) say("entry is required (the asset whose factory is the plugin)");

  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  if (!assets.length) say("assets must be a non-empty array");
  const seen = new Set();
  for (const asset of assets) {
    const where = `asset ${JSON.stringify(asset?.id)}`;
    if (!SLUG_RE.test(String(asset?.id || ""))) { problems.push(`${where}: id must be a slug`); continue; }
    if (seen.has(asset.id)) problems.push(`${where}: id is used twice`);
    seen.add(asset.id);
    if (!["js", "css", "html", "bin"].includes(asset.kind)) problems.push(`${where}: kind must be js, css, html or bin`);
    if (!["inline", "online"].includes(asset.mode)) problems.push(`${where}: mode must be inline or online`);
    if (!Number.isInteger(asset.order)) problems.push(`${where}: order must be an integer`);
    if (!Array.isArray(asset.requiredBy) || !asset.requiredBy.length) problems.push(`${where}: requiredBy must be a non-empty array`);
    if (asset.category !== "plugin") problems.push(`${where}: category must be "plugin"`);
    if (asset.plugin !== manifest.id) problems.push(`${where}: plugin must be ${JSON.stringify(manifest.id)}`);
    if (!/^https:\/\//.test(String(asset.url || ""))) problems.push(`${where}: url must be absolute https://`);
    if (!SHA384_RE.test(String(asset.integrity || ""))) problems.push(`${where}: integrity must be "sha384-" + 64 base64 characters`);
    if (!Number.isInteger(asset.bytes) || asset.bytes <= 0) problems.push(`${where}: bytes must be a positive integer`);

    if (servedByJsDelivr(asset.url)) {
      const ext = path.posix.extname(new URL(String(asset.url)).pathname).slice(1).toLowerCase();
      if (!ext) problems.push(`${where}: jsDelivr serves no extensionless file (404) — give it one`);
      else if (BLOCKED_EXTENSIONS.has(ext)) problems.push(`${where}: jsDelivr refuses .${ext} (403) — publish it as .bin`);
      if (Number.isInteger(asset.bytes) && asset.bytes > JSDELIVR_MAX_BYTES) {
        problems.push(`${where}: jsDelivr refuses a file over 50 MB (403, ${asset.bytes} bytes declared) — pin it on a host without that cap`);
      }
    }

    /* Bytes this repository serves are in dist/ at a path derived from cdnBase, so the
       manifest's promise can be checked here, offline, before anyone pins it. */
    const url = String(asset.url || "");
    if (!cdnBase || !url.startsWith(`${cdnBase}/`)) continue;
    const file = path.join(ROOT, "dist", "cdn", url.slice(cdnBase.length + 1));
    if (!fs.existsSync(file)) { problems.push(`${where}: ${rel(file)} is missing — run: node build.mjs build`); continue; }
    const bytes = fs.readFileSync(file);
    if (sha384(bytes) !== asset.integrity) problems.push(`${where}: ${rel(file)} does not match its integrity`);
    else if (bytes.length !== asset.bytes) problems.push(`${where}: ${rel(file)} is ${bytes.length} bytes, the manifest says ${asset.bytes}`);
  }

  const entry = assets.find((asset) => asset?.id === manifest.entry);
  if (manifest.entry && !entry) say(`entry "${manifest.entry}" is not one of its assets`);
  else if (entry && !entry.factory) say(`entry "${manifest.entry}" carries no factory (a namespace is not a plugin)`);
  return problems;
}

/** Compare what would be written with what is on disk. */
export function stale() {
  const problems = [];
  for (const config of pluginConfigs()) problems.push(...pluginConfigProblems(config));
  for (const [file, bytes] of published()) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) { problems.push(`${file} is missing`); continue; }
    const disk = fs.readFileSync(full);
    if (!disk.equals(bytes)) problems.push(`${file} is stale`);
  }
  return problems;
}

if (process.argv[1] && process.argv[1].endsWith("publish-plugin.mjs")) {
  if (process.argv.includes("--check")) {
    const problems = stale();
    if (problems.length) {
      console.error(`publish-plugin: ${problems.join("; ")} — run: node tools/publish-plugin.mjs`);
      process.exit(1);
    }
    console.log("publish-plugin: ok");
  } else {
    const files = published();
    for (const [file, bytes] of files) {
      fs.mkdirSync(path.dirname(path.join(ROOT, file)), {recursive: true});
      fs.writeFileSync(path.join(ROOT, file), bytes);
    }
    for (const bundle of pluginConfigs()) {
      const file = `dist/plugins/${bundle.id}.json`;
      const manifest = JSON.parse(files.get(file).toString("utf8"));
      const declared = manifest.assets.reduce((n, asset) => n + asset.bytes, 0) / 1e6;
      console.log(`publish-plugin: ${bundle.copies.length} file(s) + ${bundle.pins.length} npm pin(s) `
        + `→ dist/cdn/plugins/${bundle.id}/`);
      console.log(`publish-plugin: ${file} (${manifest.assets.length} asset(s), ${declared.toFixed(1)} MB declared)`);
    }
  }
}
