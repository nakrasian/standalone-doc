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
 * module per plugin, and this plugin is a bundle of eight assets. A catalog entry that can
 * describe a bundle is a schema change to a published, shipped file; the manifest is the
 * thing such a schema would point at.
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
export function published() {
  const cdnBase = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).cdnBase;
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
      + "Install by adding `assets` to #asset-manifest and this entry to its `plugins` map.",
    assets,
    contributes: CONTRIBUTES,
  };
  out.set(MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  return out;
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
