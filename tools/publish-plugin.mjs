#!/usr/bin/env node
/* tools/publish-plugin.mjs — the exporter, as a thing a document can install.
 *
 *   node tools/publish-plugin.mjs            write dist/cdn/plugins/… and the manifest
 *   node tools/publish-plugin.mjs --check    fail if either is stale (run by `check`)
 *
 * "Publishing" here means what it means everywhere else in this repository: the bytes live in
 * `dist/`, which is committed and served at a tag, and a JSON file records id, kind, size and
 * sha384 for each one. A document installs by copying those entries into `#asset-manifest` and
 * adding a `plugins` block — nothing fetches, nothing is guessed, every byte is verified.
 *
 * The three big assets are *not* copied: a 58 MB binary and a 27 MB compiler belong on npm,
 * where jsDelivr already serves them immutably, not in a git tag. Their pins are recorded here
 * as constants (`LARGE`), which is the same arrangement `plugins.json` uses for nanoid — the
 * hash is the promise, the URL is only the address.
 *
 * Why a separate manifest file and not `plugins.json`: the curated catalog describes one ES
 * module per plugin, and this plugin is a bundle of eight assets. The catalog does not grow a
 * second shape for it — it grows a *pointer*: `dist/registry.json` carries a `bundles` section
 * whose entries name this manifest, its size, and its own sha384. The projection below is the
 * only place the catalog learns about a bundle, and it is derived from the same bytes
 * `published()` emits, so the advertised hash and the manifest cannot drift apart.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PUBLISHED = "dist/cdn/plugins/pandoc-export";
const MANIFEST = "dist/plugins/pandoc-export.json";

const sha384 = (buffer) => "sha384-" + createHash("sha384").update(buffer).digest("base64");
/* Paths in messages are repo-relative in every other tool here; keep it that way. */
const rel = (file) => path.relative(ROOT, file).split(path.sep).join("/");

/* Copied into dist/, in the order a document builds them. `as` is the published filename; the
 * id is what the document's manifest and the plugin's `host.bytes()` use. */
const BUNDLE = [
  {id: "sd-export-lua", kind: "bin", file: "tools/sd-export.lua", as: "sd-export.lua"},
  {id: "sd-template-typ", kind: "bin", file: "tools/sd-template.typ", as: "sd-template.typ"},
  {id: "sd-reference", kind: "bin", file: "tools/reference.docx", as: "reference.docx"},
  {id: "wasi-shim", kind: "js", file: "plugins/pandoc-export/wasi-shim.js", as: "wasi-shim.js"},
  /* `factory` is what makes the module a plugin rather than a library: without it the loader
     treats the namespace as the plugin, and a namespace has no `export` contributions. */
  {id: "pandoc-export", kind: "js", file: "plugins/pandoc-export/pandoc-export.js", as: "pandoc-export.js",
    factory: "createPandocExport"},
];

/* Kept on npm, pinned here. Re-derive with:
 *   node -e 'const fs=require("fs"),c=require("crypto");const b=fs.readFileSync(process.argv[1]);console.log(b.length,"sha384-"+c.createHash("sha384").update(b).digest("base64"))' <file> */
const LARGE = [
  {
    id: "pandoc", kind: "bin", bytes: 58580800, mode: "online",
    url: "https://cdn.jsdelivr.net/npm/pandoc-wasm@1.1.0/src/pandoc.wasm",
    integrity: "sha384-ujgShzUfczF0wuIDXDu1wxK9eSWiUiaq32X9Wz3Yt2HQhABCkxsNYBBVjT3u7Iow",
    local: "node_modules/pandoc-wasm/src/pandoc.wasm",
  },
  {
    id: "typst-bundle", kind: "bin", bytes: 211268, mode: "online",
    url: "https://cdn.jsdelivr.net/npm/@myriaddreamin/typst.ts@0.7.0/dist/esm/contrib/all-in-one-lite.bundle.js",
    integrity: "sha384-EJFFdZPsds9hPomUuylsX218dPBLIlif5DzJW4aFW5ofF0hjMPPlFljqBDthNql+",
    local: "node_modules/@myriaddreamin/typst.ts/dist/esm/contrib/all-in-one-lite.bundle.js",
  },
  {
    id: "typst-compiler", kind: "bin", bytes: 28325178, mode: "online",
    url: "https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-web-compiler@0.7.0/pkg/typst_ts_web_compiler_bg.wasm",
    integrity: "sha384-YB32Rpk4pOvEGytOZweRBgdbuwNueLVpzJUQojjit/A8AveMWxDW8eT9ROz98jDo",
    local: "node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm",
  },
];

const CONTRIBUTES = {
  export: [
    {id: "docx", label: "Word (.docx)…"},
    {id: "typ", label: "Typst (.typ)…"},
    {id: "md", label: "Markdown (.md)…"},
    {id: "pdf", label: "PDF (typeset)…"},
  ],
};

/** Everything publishing writes, as a map of path → bytes. Pure: no writes, no clock. */
/**
 * Every published byte, keyed by the path it is committed at.
 *
 * `base` re-points the derived urls — the same arrangement `build --base` gives a document.
 * A dev build has to carry its own manifest, or the plugin it advertises pins the tag the tree
 * was built from instead of the bytes beside it.
 */
export function published({ base = null } = {}) {
  const cdnBase = String(base || JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).cdnBase)
    .replace(/\/$/, "");
  const out = new Map();
  const assets = [];

  for (const [index, entry] of BUNDLE.entries()) {
    const bytes = fs.readFileSync(path.join(ROOT, entry.file));
    out.set(`${PUBLISHED}/${entry.as}`, bytes);
    assets.push({
      id: entry.id,
      kind: entry.kind,
      role: "module",
      order: 300 + index,
      mode: "online",
      category: "plugin",
      plugin: "pandoc-export",
      requiredBy: ["*"],
      bytes: bytes.length,
      url: `${cdnBase.replace(/\/$/, "")}/plugins/pandoc-export/${entry.as}`,
      integrity: sha384(bytes),
      ...(entry.factory ? {factory: entry.factory} : {}),
    });
  }
  for (const [index, entry] of LARGE.entries()) {
    assets.push({
      id: entry.id, kind: entry.kind, role: "module", order: 400 + index, mode: "online",
      category: "plugin", plugin: "pandoc-export", requiredBy: ["*"],
      bytes: entry.bytes, url: entry.url, integrity: entry.integrity,
    });
  }

  const manifest = {
    schema: 1,
    id: "pandoc-export",
    label: "Pandoc export",
    version: "0.1.0",
    /* The host contract this plugin is written against (`docs/PLUGINS.md` §Versioning). The
       registry refuses a plugin that asks for a newer host, which is what makes it safe for a
       plugin to be versioned — and tagged — independently of the runtime. */
    api: 1,
    island: "sealed",
    entry: "pandoc-export",
    about: "Word, typeset PDF, Typst and Markdown, converted in the tab by pandoc.wasm. "
      + "The engine itself is fetched on the first export; nothing is uploaded.",
    assets,
    contributes: CONTRIBUTES,
  };
  out.set(MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
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
  const bundles = [];
  for (const [file, bytes] of published({ base })) {
    if (!/^dist\/plugins\/[^/]+\.json$/.test(file)) continue;
    const manifest = JSON.parse(bytes.toString("utf8"));
    bundles.push({
      file,
      manifest,
      entry: {
        label: manifest.label,
        version: manifest.version,
        api: manifest.api ?? 1,
        island: manifest.island,
        entry: manifest.entry,
        manifest: file.replace(/^dist\//, ""),
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
  if (!["sealed", "sandboxed", "trusted"].includes(manifest.island)) say("island must be sealed, sandboxed or trusted");
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
    const manifest = JSON.parse(files.get(MANIFEST).toString("utf8"));
    const copied = BUNDLE.length;
    console.log(`publish-plugin: ${copied} file(s) + ${LARGE.length} npm pins → ${PUBLISHED}/`);
    console.log(`publish-plugin: ${MANIFEST} (${manifest.assets.length} assets, `
      + `${(manifest.assets.reduce((n, asset) => n + asset.bytes, 0) / 1e6).toFixed(1)} MB declared)`);
  }
}
