#!/usr/bin/env node
/**
 * build.mjs — standalone-doc build tool. Zero dependencies.
 *
 *   node build.mjs split      index.html  -> src/*.{css,js} + manifest.json
 *   node build.mjs combine    src/ + manifest.json -> index.html
 *   node build.mjs verify     round-trip and hash checks (read-only)
 *   node build.mjs check      verify + schema + guarded-file scan  (CI gate)
 *   node build.mjs build      dist/editor.html + dist/size-report.json
 *   node build.mjs build --base=<url> --out=<dir>
 *                             the same documents re-pointed at another base (dev);
 *                             never writes dist/, since only a tag is a release pair
 *   node build.mjs release <x.y.z>  the whole ritual: bump, rebuild, check, print the tag
 *   node build.mjs report     size table; --baseline rewrites baseline.json
 *   node build.mjs catalog    dist/runtime.json + one manifest per release, from the tags
 *   node build.mjs verify-cdn fetch every published asset and check its hash
 *   node build.mjs dev        static server on :8080
 *
 * Asset regions in index.html are delimited by flush-left marker comments:
 *
 *   <!-- @asset id="page-styles" kind="css" order="10" -->
 *     <style id="page-styles">
 *       ...
 *     </style>
 *   <!-- /@asset -->
 *
 * The markers are the only thing the build ever writes into index.html
 * (once, during `split --init`). combine() splices only the *body* between the
 * open tag line and the close tag line, so attributes, indentation and
 * everything outside the markers stay byte-identical.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileBody,
  isConverted,
  MODULES,
  parseProblem,
  uncompileBody,
} from "./lib/compile.mjs";
import { dedentCode as dedent, indentCode as reindent } from "./lib/indent.mjs";
import { auditContract, extractContract, LEGACY_GLOBALS } from "./lib/deps.mjs";

/** global name → asset id, for spotting implicit cross-module references. The
 *  bindings themselves are gone; this is a tripwire, not a publication list. */
const LEGACY_GLOBAL_TO_ID = LEGACY_GLOBALS;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = "index.html";
const MANIFEST = "manifest.json";
const CHANGELOG_FILE = "CHANGELOG.md";
const SRC = "src";
const DIST = "dist";
const BASELINE = "size-baseline.json";
const PLUGINS = "plugins.json";
const CATALOG = "dist/registry.json";
const DEFAULT_CDN_BASE = "https://cdn.jsdelivr.net/gh/nakrasian/standalone-doc@main/dist/cdn";
const DOC_MANIFEST_ID = "asset-manifest";
const DOC_SETTINGS_ID = "doc-settings";
/* Authoring defaults for the document's own behaviour. manifest.json is the place a
   human edits these; build materialises them into #doc-settings. */
const DEFAULT_SETTINGS = { mode: "edit", ui: "ribbon", editable: true, toolbar: true, saveThresholdBytes: 2097152 };
/* The only assets that are part of the loader itself. Everything else — CSS
   included — is content that can be inlined or fetched. */
const INFRA = new Set(["registry", "boot-ui", "boot-ui-styles", "bootstrap"]);

const MARKER_RE = /^[ \t]*<!--[ \t]*@asset[ \t]+([^>]*?)[ \t]*-->[ \t]*$/gm;
const END_MARKER = "<!-- /@asset -->";

/** Elements that legitimately carry an id but are runtime/data, not assets. */
const UNMARKED_OK = new Set(["user-theme", "print-page", "figure-store", "favicon", DOC_MANIFEST_ID, DOC_SETTINGS_ID, "boot-dialog"]);

/**
 * Bootstrap table, in document order. Used exactly once: to insert markers into
 * an index.html that has none (a hand-written file, or a bad `git checkout` of
 * the source). After that, index.html's own markers are the source of truth, and
 * `check` asserts this table still agrees with the manifest — a stale table would
 * silently rebuild a different dependency order on the day it is actually needed.
 */
const REGIONS = [
  { id: "page-styles", kind: "css", order: 10, label: "Page styles", requiredBy: ["*"]  },
  { id: "toolbar-styles", kind: "css", order: 20, label: "Toolbar styles", requiredBy: ["edit"]  },
  { id: "boot-ui-styles", kind: "css", order: 25, label: "Boot styles", requiredBy: ["*"]  },
  { id: "registry", kind: "js", order: 5, label: "Loader", requiredBy: ["*"]  },
  { id: "boot-ui", kind: "js", order: 6, label: "Boot dialog", requiredBy: ["*"]  },
  { id: "apply-settings", kind: "js", order: 7, label: "Settings", requiredBy: ["*"]  },
  { id: "sprite", kind: "html", order: 11, label: "Icons", requiredBy: ["edit"], tag: "svg"  },
  { id: "toolbar-markup", kind: "html", order: 12, label: "Toolbar", requiredBy: ["edit"], tag: "header"  },
  { id: "figure-tools", kind: "html", order: 13, label: "Figure tools", requiredBy: ["edit"], tag: "div"  },
  { id: "dialogs", kind: "html", order: 14, label: "Dialogs", requiredBy: ["edit"], tag: "div"  },
  { id: "viewer-bar-markup", kind: "html", order: 15, label: "Viewer bar", requiredBy: ["view"], tag: "header"  },
  { id: "viewer-bar-styles", kind: "css", order: 21, label: "Viewer bar styles", requiredBy: ["view"]  },
  { id: "signals", kind: "js", order: 30, label: "Signals", requiredBy: ["*"]  },
  { id: "zoom", kind: "js", order: 40, label: "Zoom", requiredBy: ["*"]  },
  { id: "pagination", kind: "js", order: 50, label: "Pagination", requiredBy: ["*"]  },
  { id: "progress", kind: "js", order: 45, label: "Progress dialog", requiredBy: ["edit"]  },
  { id: "status", kind: "js", order: 60, label: "Status line", requiredBy: ["edit"]  },
  { id: "editor", kind: "js", order: 70, label: "Editor", requiredBy: ["edit"]  },
  { id: "figures", kind: "js", order: 80, label: "Figures", requiredBy: ["*"]  },
  { id: "policy", kind: "js", order: 85, label: "Save policy", requiredBy: ["edit"]  },
  { id: "plugins", kind: "js", order: 95, label: "Plugins", requiredBy: ["edit"]  },
  { id: "toolbar", kind: "js", order: 90, label: "Toolbar binding", requiredBy: ["edit"]  },
  { id: "export", kind: "js", order: 100, label: "Export", requiredBy: ["edit"]  },
  { id: "viewer-bar", kind: "js", order: 92, label: "Viewer bar binding", requiredBy: ["view"]  },
  { id: "bootstrap", kind: "js", order: 120, label: "Bootstrap", requiredBy: ["*"]  },
];

/* ------------------------------------------------------------------ utils */

const abs = (p) => path.join(ROOT, p);
const read = (p) => fs.readFileSync(abs(p), "utf8");
const write = (p, s) => {
  fs.mkdirSync(path.dirname(abs(p)), { recursive: true });
  fs.writeFileSync(abs(p), s);
};
const exists = (p) => fs.existsSync(abs(p));
const sha384 = (s) => "sha384-" + createHash("sha384").update(s, "utf8").digest("base64");
const nbytes = (s) => Buffer.byteLength(s, "utf8");
/* A `bin` asset is bytes, not text: its file is binary, its inline body is base64, and
   every size and hash is over the *decoded* bytes so the two forms are one asset. */
const readBytes = (p) => fs.readFileSync(abs(p));
const writeBytes = (p, buffer) => {
  fs.mkdirSync(path.dirname(abs(p)), { recursive: true });
  fs.writeFileSync(abs(p), buffer);
};
const sha384Buffer = (buffer) => "sha384-" + createHash("sha384").update(buffer).digest("base64");
const base64Of = (buffer) => buffer.toString("base64");
const bytesOfBase64 = (text) => Buffer.from(String(text).replace(/\s+/g, ""), "base64");
/** Canonical: no wrapping, no padding oddities — decode then re-encode must be a no-op. */
const isCanonicalBase64 = (text) => {
  const clean = String(text).trim();
  return clean.length > 0 && base64Of(bytesOfBase64(clean)) === clean;
};
const kb = (n) => (n / 1024).toFixed(1);
const rel = (p) => path.relative(ROOT, p);

/** Every file under a directory, as repo-relative POSIX paths. */
function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(path.relative(ROOT, p).split(path.sep).join("/"));
    }
  };
  walk(abs(dir));
  return out.sort();
}

function parseAttrs(text) {
  const attrs = {};
  for (const m of text.matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

/* ------------------------------------------------------- parse / combine */

/**
 * Parse every marked asset out of an HTML string. Pure: no file system.
 * Returns asset records with absolute body offsets so combine() can splice
 * bodies without disturbing anything else.
 */
function parseSource(html) {
  const assets = [];
  for (const m of html.matchAll(MARKER_RE)) {
    const attrs = parseAttrs(m[1]);
    const id = attrs.id;
    if (!id) throw new Error(`marker without id at byte ${m.index}`);

    const markerEnd = m.index + m[0].length;
    const elementStart = html[markerEnd] === "\n" ? markerEnd + 1 : markerEnd;
    const endIdx = html.indexOf(END_MARKER, elementStart);
    if (endIdx < 0) throw new Error(`asset "${id}": no <!-- /@asset --> after its marker`);

    const raw = html.slice(elementStart, endIdx);
    if (!raw.endsWith("\n")) {
      throw new Error(`asset "${id}": end marker must start on its own line`);
    }
    if (raw.includes("<!-- @asset ")) {
      throw new Error(`asset "${id}": a start marker appears before its end marker (nested or misordered markers)`);
    }

    const firstNL = raw.indexOf("\n");
    const openLine = raw.slice(0, firstNL);
    const rest = raw.slice(firstNL + 1, raw.length - 1);
    const lastNL = rest.lastIndexOf("\n");
    const body = lastNL < 0 ? rest : rest.slice(0, lastNL);
    const closeLine = lastNL < 0 ? rest : rest.slice(lastNL + 1);

    const openTag = /^\s*<([a-zA-Z][\w-]*)\b/.exec(openLine);
    if (!openTag) throw new Error(`asset "${id}": line after the marker is not an element`);
    const tag = openTag[1].toLowerCase();
    const expectedClose = new RegExp(`^\\s*</${tag}>\\s*$`);
    if (!expectedClose.test(closeLine)) {
      throw new Error(`asset "${id}": expected </${tag}> on its own line, got ${JSON.stringify(closeLine)}`);
    }

    const bodyStart = elementStart + firstNL + 1;
    if ((attrs.kind || "") === "bin") {
      /* One line, unwrapped base64. A wrapped body would still decode, but then
         combine() could not reproduce it byte for byte, and verify() is a byte
         comparison of bodies. */
      const candidate = body.trim();
      if (!isCanonicalBase64(candidate)) {
        throw new Error(`asset "${id}": a bin body must be one line of unwrapped base64`);
      }
    }
    const { text: fileText, indent } = dedent(body);
    /* Only trust dedent if it is exactly reversible. */
    const reversible = reindent(fileText, indent) === body;

    assets.push({
      id,
      kind: attrs.kind || (tag === "style" ? "css" : "js"),
      order: Number(attrs.order ?? assets.length * 10 + 10),
      tag,
      file: `${SRC}/${id}.${extensionFor(attrs.kind || (tag === "style" ? "css" : "js"))}`,
      /* A fragment is published as its body; its own open tag is the thing that turns
         a body back into an element, so that travels in the manifest. */
      open: openLine.trim(),
      indent: reversible ? indent : "",
      body,
      bodyStart,
      bodyEnd: bodyStart + body.length,
      fileText: reversible ? fileText : body,
      reversible,
    });
  }
  return assets;
}

/** Extension for an asset kind: css and html are published as-is, js as .js. */
function extensionFor(kind) {
  if (kind === "css") return "css";
  if (kind === "html") return "html";
  /* wasm is the only binary this repository publishes, so the kind implies it. */
  if (kind === "bin") return "wasm";
  return "js";
}

/** Replace only asset bodies. Everything else in `html` is untouched. */
function combine(html, assets, readBody) {
  let out = html;
  for (const a of [...assets].sort((x, y) => y.bodyStart - x.bodyStart)) {
    const text = readBody(a);
    out = out.slice(0, a.bodyStart) + reindent(text, a.indent) + out.slice(a.bodyEnd);
  }
  return out;
}

/* -------------------------------------------------------- marker bootstrap */

function insertMarkers(html) {
  const found = [...html.matchAll(MARKER_RE)];
  if (found.length > 0) return { html, inserted: 0 };

  const inserts = [];
  for (const [i, region] of REGIONS.entries()) {
    const tag = region.tag || (region.kind === "css" ? "style" : "script");
    const openRe = new RegExp(`^([ \\t]*)<${tag}\\b[^>]*\\bid="${region.id}"[^>]*>`, "m");
    const m = openRe.exec(html);
    if (!m) throw new Error(`bootstrap: no <${tag} id="${region.id}"> found`);
    const lineStart = html.lastIndexOf("\n", m.index) + 1;
    const close = html.indexOf(`</${tag}>`, m.index);
    if (close < 0) throw new Error(`bootstrap: no </${tag}> for "${region.id}"`);
    const afterClose = html.indexOf("\n", close);
    if (afterClose < 0) throw new Error(`bootstrap: unterminated line for "${region.id}"`);

    /* seq runs in document order. Two inserts can share an offset (a close tag
       immediately followed by the next region's marker line); inserting at the
       same index places later inserts first, so ties must be applied in reverse
       document order. */
    inserts.push({ at: lineStart, seq: i * 2, text: `<!-- @asset id="${region.id}" kind="${region.kind}" order="${region.order}" -->\n` });
    inserts.push({ at: afterClose + 1, seq: i * 2 + 1, text: `${END_MARKER}\n` });
  }

  let out = html;
  for (const ins of inserts.sort((x, y) => y.at - x.at || y.seq - x.seq)) {
    out = out.slice(0, ins.at) + ins.text + out.slice(ins.at);
  }
  return { html: out, inserted: REGIONS.length };
}

/* --------------------------------------------------- manifest from src/ */

/**
 * Manifest entries derived from the files on disk. Both split and combine end
 * here, so "edit src → combine" can never leave a stale hash in the manifest.
 */
function buildManifest(assets, previous) {
  const keep = new Map((previous?.assets || []).map((entry) => [entry.id, entry]));
  let preserved = 0;
  const entries = assets.map((a) => {
    if (!exists(a.file)) throw new Error(`${a.file} is missing — run "npm run split"`);
    const binary = a.kind === "bin" ? readBytes(a.file) : null;
    const text = binary ? null : read(a.file);
    const before = keep.get(a.id);
    const meta = REGIONS.find((r) => r.id === a.id) || {};
    const mode = before?.mode ?? meta.mode ?? "inline";
    const requiredBy = before?.requiredBy ?? meta.requiredBy ?? ["*"];
    const label = before?.label ?? meta.label;
    if (before && (before.mode !== (meta.mode ?? "inline") || String(before.requiredBy) !== String(meta.requiredBy ?? ["*"]))) preserved++;
    const entry = {
      id: a.id,
      kind: a.kind,
      order: a.order,
      tag: a.tag,
      file: a.file,
      bytes: binary ? binary.length : nbytes(text),
      sha384: binary ? sha384Buffer(binary) : sha384(text),
      mode,
      requiredBy,
    };
    entry.role = INFRA.has(a.id) ? "infra" : "module";
    /* Author-editable fields that cannot be derived from src/. buildManifest rebuilds
       every entry from scratch, so a field omitted here disappears on the next
       combine — this list is what stops a plugin's grouping, label or category from
       being silently dropped. */
    if (label) entry.label = label;
    for (const key of ["category", "plugin"]) {
      if (before?.[key] != null) entry[key] = before[key];
    }
    /* A pinned plugin's bytes live wherever its author publishes them, so its url and
       hash are the pin itself and must survive a split. For everything this repository
       ships they stay derived, so a hand-edited hash cannot outlive the file it
       describes. */
    if (before?.category === "plugin") {
      for (const key of ["url", "integrity"]) {
        if (before[key] != null) entry[key] = before[key];
      }
    }
    if (a.kind === "html") entry.open = a.open;
    if (isConverted(a.id) && text != null) {
      const contract = extractContract(text, { globals: LEGACY_GLOBAL_TO_ID });
      entry.deps = contract.deps;
      if (contract.late.length) entry.late = contract.late;
      if (contract.optional.length) entry.optional = contract.optional;
      entry.provides = contract.provides;
      if (contract.usesEnv) entry.env = true;
      if (contract.usesSettings) entry.settings = true;
      if (contract.implicitGlobals.length) entry.implicit = contract.implicitGlobals;
    }
    return entry;
  });
  const manifest = {
    schema: 1,
    generated: "generated by node build.mjs — ids and files come from index.html; mode/requiredBy/cdnBase are yours to edit",
    source: SOURCE,
    cdnBase: previous?.cdnBase ?? DEFAULT_CDN_BASE,
    timeoutMs: previous?.timeoutMs ?? 8000,
    settings: previous?.settings ?? DEFAULT_SETTINGS,
    assets: entries,
  };
  /* The plugin index is authored, like `settings`: the build cannot derive a label,
     a default island profile or a contribution list. It travels verbatim. */
  if (previous?.plugins) manifest.plugins = previous.plugins;
  /* Where to look for a newer release. Authored, because only the document's owner knows
     which host may name one; the loader falls back to the base's moving sibling. */
  if (previous?.catalog) manifest.catalog = previous.catalog;
  return { manifest, preserved };
}

/**
 * Everything boot() needs, in the document itself.
 *
 * `mode` is the document's own mode (edit | view | comment) and `requiredBy` is
 * each asset's list of modes. Both travel with the document so a reader never
 * has to guess: a view-mode file boots without the editor even being fetched.
 */
function docManifest(manifest, overrides = {}) {
  const base = String(manifest.cdnBase || "").replace(/\/$/, "");
  const doc = {
    schema: 1,
    cdnBase: base,
    assets: manifest.assets.map((a) => {
      const ext = extensionFor(a.kind);
      const mode = overrides[a.id] ?? a.mode;
      const entry = {
        id: a.id,
        kind: a.kind,
        role: a.role || "module",
        order: a.order,
        mode,
        requiredBy: a.requiredBy || ["*"],
        bytes: a.bytes,
      };
      if (a.category) entry.category = a.category;
      if (a.plugin) entry.plugin = a.plugin;
      if (a.label) entry.label = a.label;
      if (a.deps?.length) entry.deps = a.deps;
      if (a.late?.length) entry.late = a.late;
      if (a.optional?.length) entry.optional = a.optional;
      if (isConverted(a.id)) entry.factory = MODULES[a.id].factory;
      if (a.kind === "html") {
        entry.open = a.open;
        /* Where a fetched fragment lands: `before:<selector>` or `append:<selector>`.
           The default suits chrome; a plugin fragment can name its own host. */
        entry.insert = a.insert || "before:#viewport";
      }
      /* Every non-infra asset carries where it lives and what it hashes to, even
         when it is inline today. That is what lets a save policy move an asset
         between inline and online with no network: the target state is already
         known. Infrastructure has no url on purpose — see inMode()'s sibling rule
         in check(): the loader and its failure UI cannot be fetched. */
      if (a.role !== "infra") {
        /* A pinned plugin's bytes live wherever its author publishes them, so an
           explicit url/integrity wins over the cdnBase-derived pair. Everything this
           repository ships keeps the derived one. */
        entry.url = a.url || `${base}/${a.id}.${ext}`;
        entry.integrity = a.integrity || a.sha384;
      }
      return entry;
    }),
  };
  /* Only when there is something to say: an empty index in every document would be
     bytes spent on saying nothing. */
  if (manifest.plugins && Object.keys(manifest.plugins).length) doc.plugins = manifest.plugins;
  /* A recovery address, not a dependency: a document that cannot reach it still opens. */
  if (manifest.catalog) doc.catalog = manifest.catalog;
  return doc;
}

const manifestBlock = (doc) =>
  `<script id="${DOC_MANIFEST_ID}" type="application/json">${JSON.stringify(doc)}</script>`;

/**
 * The document's own behaviour — mode, content lock, toolbar, save threshold.
 * Separate from the asset manifest on purpose: the manifest answers "what does
 * this document need", settings answer "how does it behave". `mode` used to live
 * in the manifest and is read from there as a fallback for one release.
 */
function docSettings(manifest, { mode, toolbar } = {}) {
  const authored = manifest.settings || {};
  const docMode = mode ?? authored.mode ?? DEFAULT_SETTINGS.mode;
  return {
    schema: 1,
    mode: docMode,
    ui: authored.ui === "minimal" ? "minimal" : "ribbon",
    /* A setting may restrict edit mode further (a locked document); it cannot
       contradict the mode. View and comment are read-only by definition. */
    editable: docMode === "edit" && (authored.editable ?? true),
    /* "Show chrome". A viewer has a bar of its own (`viewer-bar`), so view mode is no
       longer chrome-less by definition; an explicit override wins, and a file that never
       authored the key keeps the old default. */
    toolbar: toolbar ?? authored.toolbar ?? (docMode !== "view"),
    saveThresholdBytes: authored.saveThresholdBytes ?? DEFAULT_SETTINGS.saveThresholdBytes,
    /* Read by the loader, so it belongs here rather than in the asset manifest: a
       timeout is behaviour, not an asset. Falls back to the manifest for one release. */
    timeoutMs: Number(authored.timeoutMs ?? manifest.timeoutMs) || 8000,
  };
}

const settingsBlock = (settings) =>
  `<script id="${DOC_SETTINGS_ID}" type="application/json">${JSON.stringify(settings)}</script>`;

/** Insert or refresh the settings block, immediately before the manifest block. */
function withDocSettings(html, settings) {
  const block = settingsBlock(settings);
  const existing = new RegExp(`<script id="${DOC_SETTINGS_ID}" type="application/json">[\\s\\S]*?</script>`);
  if (existing.test(html)) return html.replace(existing, () => block);
  const at = html.indexOf(`<script id="${DOC_MANIFEST_ID}"`);
  if (at < 0) throw new Error("cannot place the document settings: no asset manifest block");
  const lineStart = html.lastIndexOf("\n", at) + 1;
  return html.slice(0, lineStart) + block + "\n" + html.slice(lineStart);
}

/** Insert or refresh the manifest block, immediately before the registry. */
function withDocManifest(html, doc) {
  const block = manifestBlock(doc);
  const existing = new RegExp(`<script id="${DOC_MANIFEST_ID}" type="application/json">[\\s\\S]*?</script>`);
  if (existing.test(html)) return html.replace(existing, () => block);
  const at = html.indexOf('<!-- @asset id="registry"');
  if (at < 0) throw new Error("cannot place the asset manifest: no registry block");
  const lineStart = html.lastIndexOf("\n", at) + 1;
  return html.slice(0, lineStart) + block + "\n" + html.slice(lineStart);
}

/** Read a document's own manifest block back out of built HTML. */
function docManifestOf(html) {
  const found = new RegExp(`<script id="${DOC_MANIFEST_ID}" type="application/json">([\\s\\S]*?)</script>`).exec(html);
  return found ? JSON.parse(found[1]) : null;
}

/**
 * Re-point a document at another base, leaving `integrity`, `bytes` and every `mode`
 * exactly as they were: the bytes are this tree's, so only the address moves. That is
 * the whole difference between a dev build and a release — and the reason a rebuild
 * committed against an older tag could promise bytes no tag served.
 *
 * Plugin pins carry explicit urls that are not derived from `cdnBase` (their author
 * publishes them), so they keep pointing where they were installed from.
 */
function retarget(html, base) {
  const doc = docManifestOf(html);
  if (!doc) throw new Error(`cannot retarget: no #${DOC_MANIFEST_ID} block`);
  const from = String(doc.cdnBase || "").replace(/\/$/, "");
  doc.cdnBase = base;
  for (const entry of doc.assets) {
    if (!entry.url || !from || !entry.url.startsWith(`${from}/`)) continue;
    entry.url = `${base}/${entry.url.slice(from.length + 1)}`;
  }
  return withDocManifest(html, doc);
}

/** Remove one marked asset block entirely. */
function withoutAsset(html, id) {
  const start = html.indexOf(`<!-- @asset id="${id}" `);
  if (start < 0) return html;
  const lineStart = html.lastIndexOf("\n", start) + 1;
  const endMarker = html.indexOf("<!-- /@asset -->", start) + "<!-- /@asset -->".length;
  const end = html.indexOf("\n", endMarker) + 1;
  return html.slice(0, lineStart) + html.slice(end);
}

/** deps.json: the machine-readable graph. */
function depsJson(manifest) {
  return {
    schema: 1,
    assets: manifest.assets
      .filter((a) => a.kind === "js")
      .map((a) => ({
        id: a.id,
        order: a.order,
        mode: a.mode,
        requiredBy: a.requiredBy,
        deps: a.deps ?? [],
        late: a.late ?? [],
        optional: a.optional ?? [],
        provides: a.provides ?? null,
      })),
  };
}

/** DEPS.md: the table and graph a human can read. */
function depsMarkdown(manifest) {
  const js = manifest.assets.filter((a) => a.kind === "js").sort((a, b) => a.order - b.order);
  const rows = js.map((a) => {
    const deps = (a.deps ?? []).join(", ") || "—";
    const late = [a.late ?? [], (a.optional ?? []).map((x) => `${x}?`)].flat().join(", ") || "—";
    const provides = a.role === "infra" ? "_infrastructure_" : a.provides ? a.provides.map((n) => `\`${n}\``).join(", ") : "_not derived_";
    const modes = (a.requiredBy ?? []).join(", ");
    return `| ${a.id} | ${a.order} | ${deps} | ${late} | ${provides} | ${modes} |`;
  });

  const edges = [];
  for (const a of js) {
    for (const d of a.deps ?? []) edges.push(`  ${d} --> ${a.id}`);
    for (const d of a.late ?? []) edges.push(`  ${d} -.->|late| ${a.id}`);
    for (const d of a.optional ?? []) edges.push(`  ${d} -.->|optional| ${a.id}`);
  }
  const implicit = js.filter((a) => a.implicit?.length);
  const implicitNote = implicit.length
    ? implicit.map((a) => `- **${a.id}** reaches ${a.implicit.map((x) => `\`${x}\``).join(", ")} through a global (becomes \`deps.late()\` in Phase 3).`).join("\n")
    : "- None: every cross-module reference is declared.";

  return `# Module dependency graph

Generated by \`node build.mjs split|combine\` from the factories' signatures. Do not
edit by hand; \`npm run check\` fails if this file is stale.

\`\`\`
| id | order | requires | late / optional | provides | needed by |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}
\`\`\`

\`\`\`mermaid
graph LR
${edges.join("\n")}
\`\`\`

## Implicit edges

${implicitNote}
`;
}

/**
 * The catalog: what this runtime may propose to an author.
 *
 * It is authored in `plugins.json` and published as `dist/registry.json`. It is not an
 * integrity authority — a document embeds the url + sha384 it installed — so the only
 * thing that can be wrong here is a proposal that could not work, and the gate refuses
 * those rather than letting the sheet offer them.
 */
const CATALOG_KINDS = ["insert", "export", "panel", "command", "toolbar"];

function readCatalog() {
  if (!exists(PLUGINS)) return { schema: 1, assets: {} };
  return JSON.parse(read(PLUGINS));
}

/** Every way the authored catalog can be unusable. Empty array means publishable. */
function catalogProblems(catalog) {
  const problems = [];
  if (!catalog || typeof catalog !== "object") return ["plugins.json is not an object"];
  if (catalog.schema !== 1) problems.push(`plugins.json schema is ${catalog.schema}, expected 1`);
  const assets = catalog.assets || {};
  for (const [id, asset] of Object.entries(assets)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) problems.push(`catalog "${id}": id must be a slug (it becomes an asset id)`);
    if (!asset || typeof asset !== "object") {
      problems.push(`catalog "${id}": must be an object`);
      continue;
    }
    if (!asset.label) problems.push(`catalog "${id}": label is required`);
    if (asset.island != null && !["sealed", "sandboxed", "trusted"].includes(asset.island)) {
      problems.push(`catalog "${id}": island must be sealed, sandboxed or trusted`);
    }
    const versions = Array.isArray(asset.versions) ? asset.versions : [];
    if (!versions.length) problems.push(`catalog "${id}": versions must be a non-empty array`);
    for (const version of versions) {
      const where = `catalog "${id}@${version?.version}"`;
      if (!version?.version) problems.push(`${where}: version is required`);
      /* `import(blob:)` cannot resolve a bare or relative specifier, and a file:// page
         cannot reach a relative url at all (lab/007), so a proposal is absolute https. */
      if (!/^https:\/\//.test(String(version?.url || ""))) problems.push(`${where}: url must be absolute https://`);
      if (!/^sha384-[A-Za-z0-9+/]{64}$/.test(String(version?.sha384 || ""))) problems.push(`${where}: sha384 must be "sha384-" + 64 base64 characters`);
      if (!Number.isInteger(version?.bytes) || version.bytes <= 0) problems.push(`${where}: bytes must be a positive integer`);
      if (version?.factory != null && !/^[A-Za-z_$][\w$]*$/.test(String(version.factory))) problems.push(`${where}: factory must be an identifier`);
      for (const [kind, items] of Object.entries(version?.contributes || {})) {
        if (!CATALOG_KINDS.includes(kind)) problems.push(`${where}: unknown contribution kind "${kind}"`);
        if (!Array.isArray(items)) problems.push(`${where}: contributes.${kind} must be an array`);
        else for (const item of items) {
          if (!item || !item.id) problems.push(`${where}: every ${kind} contribution needs an id`);
        }
      }
      if (version?.island != null && !["sealed", "sandboxed", "trusted"].includes(version.island)) {
        problems.push(`${where}: island must be sealed, sandboxed or trusted`);
      }
    }
  }
  return problems;
}

/** The published catalog: the authored file, minus the commentary. */
function catalogDocument(catalog) {
  return {
    schema: 1,
    generated: "generated by node build.mjs from plugins.json — advisory only; a document embeds its own pins",
    assets: catalog.assets || {},
  };
}

function previousManifest() {
  try {
    return JSON.parse(read(MANIFEST));
  } catch {
    return null;
  }
}

/** The src/ text for an asset: an ES module for converted assets. */
function sourceTextFor(a) {
  return isConverted(a.id) ? uncompileBody(a.id, a.fileText) : a.fileText + "\n";
}

/**
 * The unindented body that combine() splices. combine() re-applies a.indent
 * itself, so this must NOT be pre-indented.
 */
function readBodyFor(a, source) {
  /* For a bin asset the file is the truth, not the (text) source: encode it. */
  if (a.kind === "bin") return base64Of(readBytes(a.file));
  return isConverted(a.id) ? compileBody(a.id, source).body : source.replace(/\n$/, "");
}

/** The body index.html should contain, given the src/ text for that asset. */
function bodyFor(a, source) {
  return reindent(readBodyFor(a, source), a.indent);
}

/* -------------------------------------------------------------- commands */

function cmdSplit() {
  const original = read(SOURCE);
  const { html, inserted } = insertMarkers(original);
  if (inserted) write(SOURCE, html);

  const assets = parseSource(html);
  if (!assets.length) throw new Error("split: no @asset markers found");

  const previous = previousManifest();
  const keep = new Map((previous?.assets || []).map((entry) => [entry.id, entry]));

  const seen = new Set();
  for (const a of assets) {
    if (seen.has(a.id)) throw new Error(`split: duplicate asset id "${a.id}"`);
    seen.add(a.id);
    if (a.kind === "bin") writeBytes(a.file, bytesOfBase64(a.fileText));
    else write(a.file, sourceTextFor(a));
  }

  const { manifest, preserved } = buildManifest(assets, previous);
  saveManifest(manifest);

  const total = manifest.assets.reduce((n, a) => n + a.bytes, 0);
  console.log(`split: ${assets.length} assets -> ${SRC}/  (${kb(total)} KB)`);
  if (preserved) console.log(`split: preserved mode/requiredBy for ${preserved} asset(s) from the previous manifest`);
  if (inserted) console.log(`split: inserted ${inserted} marker pairs into ${SOURCE}`);
  for (const a of manifest.assets) {
    console.log(`  ${String(a.order).padStart(3)}  ${a.id.padEnd(16)} ${a.file.padEnd(24)} ${kb(a.bytes).padStart(8)} KB${isConverted(a.id) ? "  (compiled)" : ""}`);
  }
}

function cmdCombine() {
  const html = read(SOURCE);
  const assets = parseSource(html);

  /* Compile (or pass through) every src file, then derive the manifest from the
     same text, so editing src and combining can never leave a stale hash. */
  const next = combine(html, assets, (a) => {
    if (!exists(a.file)) throw new Error(`combine: missing ${a.file}`);
    return readBodyFor(a, read(a.file));
  });
  const changed = assets.filter((a) => bodyFor(a, read(a.file)) !== a.body).map((a) => a.id);

  const { manifest } = buildManifest(assets, previousManifest());
  saveManifest(manifest);

  const withManifest = withDocSettings(withDocManifest(next, docManifest(manifest)), docSettings(manifest));
  if (withManifest === html) {
    console.log(`combine: ${SOURCE} already matches src/ (no change)`);
    return;
  }
  write(SOURCE, withManifest);
  console.log(`combine: wrote ${SOURCE} (${changed.length} asset bodies changed: ${changed.join(", ") || "none"})`);
}

function saveManifest(manifest) {
  write(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  const catalog = readCatalog();
  const catalogIssues = catalogProblems(catalog);
  if (catalogIssues.length) throw new Error(`plugins.json is not publishable:\n  - ${catalogIssues.join("\n  - ")}`);
  write(CATALOG, JSON.stringify(catalogDocument(catalog), null, 2) + "\n");
  write("deps.json", JSON.stringify(depsJson(manifest), null, 2) + "\n");
  write("DEPS.md", depsMarkdown(manifest));
}

function readManifest() {
  if (!exists(MANIFEST)) throw new Error(`${MANIFEST} not found — run: node build.mjs split`);
  return JSON.parse(read(MANIFEST));
}

function verify({ quiet = false } = {}) {
  const problems = [];
  const html = read(SOURCE);
  let assets, manifest;
  try {
    assets = parseSource(html);
    manifest = readManifest();
  } catch (err) {
    return { problems: [err.message], assets: [], manifest: null, html };
  }

  if (!assets.length) problems.push("index.html contains no @asset markers");

  /* 1. manifest agrees with the markers */
  const byId = new Map(assets.map((a) => [a.id, a]));
  const mIds = manifest.assets.map((a) => a.id);
  for (const id of mIds) if (!byId.has(id)) problems.push(`manifest lists "${id}" but index.html has no marker for it`);
  for (const id of byId.keys()) if (!mIds.includes(id)) problems.push(`index.html marks "${id}" but manifest.json does not list it`);

  /* 2. per-asset: file exists, hash matches, body round-trips */
  for (const a of assets) {
    const entry = manifest.assets.find((m) => m.id === a.id);
    if (!entry) continue;
    if (!exists(a.file)) {
      problems.push(`${a.id}: missing ${a.file}`);
      continue;
    }
    if (!a.reversible) problems.push(`${a.id}: indentation is not reversible; keeping the body verbatim`);
    const disk = read(a.file);
    const diskBytes = a.kind === "bin" ? readBytes(a.file) : null;
    const diskSize = diskBytes ? diskBytes.length : nbytes(disk);
    const diskHash = diskBytes ? sha384Buffer(diskBytes) : sha384(disk);
    if (diskSize !== entry.bytes) problems.push(`${a.id}: ${a.file} is ${diskSize} bytes, manifest says ${entry.bytes}`);
    if (diskHash !== entry.sha384) problems.push(`${a.id}: ${a.file} hash does not match manifest (re-run split)`);
    let reproduced = null;
    try {
      reproduced = bodyFor(a, disk);
    } catch (err) {
      problems.push(`${a.id}: ${err.message}`);
    }
    if (reproduced !== null && reproduced !== a.body) {
      problems.push(`${a.id}: ${a.file} does not reproduce the body in index.html`);
    }
    if (entry.order !== a.order) problems.push(`${a.id}: order ${entry.order} in manifest vs ${a.order} in index.html`);
  }

  /* 3. whole-file round trip */
  let recombined = html;
  try {
    recombined = combine(html, assets, (a) => readBodyFor(a, read(a.file)));
  } catch (err) {
    problems.push(`round trip failed: ${err.message}`);
  }
  if (recombined !== html) {
    const at = firstDiff(html, recombined);
    problems.push(`round trip differs from index.html at byte ${at}: ${JSON.stringify(html.slice(at, at + 60))} vs ${JSON.stringify(recombined.slice(at, at + 60))}`);
  }

  /* 4. no unmarked element sneaks in */
  for (const m of html.matchAll(/<((?:style|script))\b[^>]*\bid="([^"]+)"/g)) {
    const id = m[2];
    if (byId.has(id) || UNMARKED_OK.has(id)) continue;
    problems.push(`<${m[1]} id="${id}"> is neither marked as an asset nor in the runtime allowlist`);
  }

  /* 5. no element appears twice */
  const dupes = new Set();
  const seen = new Set();
  for (const a of assets) {
    if (seen.has(a.id)) dupes.add(a.id);
    seen.add(a.id);
  }
  for (const id of dupes) problems.push(`asset "${id}" is marked more than once`);

  /* 6. no orphan files in src/. Anything there is published from the CDN, so it
     must be registered: an unregistered file is code nobody will ever load. */
  const registered = new Set(manifest.assets.map((a) => a.file));
  for (const file of listFiles(SRC)) {
    if (!registered.has(file)) {
      problems.push(`${file} is not referenced by manifest.json (orphan: add an @asset marker or delete the file)`);
    }
  }

  if (!quiet) {
    if (problems.length) {
      console.error(`verify: FAILED (${problems.length})`);
      for (const p of problems) console.error(`  - ${p}`);
    } else {
      const inline = assets.reduce((n, a) => n + nbytes(a.body), 0);
      console.log(`verify: ok — ${assets.length} assets, ${kb(inline)} KB of asset bodies, round trip byte-identical`);
      for (const a of assets) {
        console.log(`  ${String(a.order).padStart(3)}  ${a.id.padEnd(16)} ${kb(nbytes(a.body)).padStart(8)} KB  ${a.file}`);
      }
    }
  }
  return { problems, assets, manifest, html };
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

async function cmdCheck({ exit = true } = {}) {
  const { problems, html } = verify({ quiet: true });
  const all = [...problems];
  const depWarnings = [];

  /* Every js asset must parse as what it ships as: an ES module for converted
     assets (imported from a data: URL, which also proves the top level does
     nothing), an async function body for pass-through assets (bootstrap awaits). */
  try {
    for (const a of parseSource(html)) {
      if (a.kind !== "js") continue;
      const err = await parseProblem(a.id, read(a.file));
      if (err) all.push(`${a.id}: ${a.file} does not parse — ${err}`);
    }
  } catch (err) {
    all.push(err.message);
  }

  /* dist/ must be current. Lives here and not in verify(), because build
     itself cannot run if verify refuses while dist is stale. */
  try {
    const m = readManifest();
    if (exists(`${DIST}/editor.html`) && read(`${DIST}/editor.html`) !== buildEditor(html, m)) {
      all.push(`${DIST}/editor.html is stale — run: node build.mjs build`);
    }
    if (exists(`${DIST}/slim.html`) && read(`${DIST}/slim.html`) !== buildSlim(html, m)) {
      all.push(`${DIST}/slim.html is stale — run: node build.mjs build`);
    }
    if (exists(`${DIST}/viewer.html`) && read(`${DIST}/viewer.html`) !== buildViewer(html, m)) {
      all.push(`${DIST}/viewer.html is stale — run: node build.mjs build`);
    }
  } catch (err) {
    all.push(`manifest: ${err.message}`);
  }

  /* A base and its bytes are a release pair. Only a tag can be both immutable and
     public; a local or branch base is a dev build's address and must never reach a
     document that is committed, because every fetch from it then promises bytes no
     server keeps (that is exactly how the v0.3.0 slim stopped opening). */
  try {
    const authored = readManifest();
    if (authored.catalog && !/^https:\/\/\S+$/.test(authored.catalog)) {
      all.push(`manifest.json catalog must be an absolute https url: ${authored.catalog}`);
    }
    const base = String(authored.cdnBase || "");
    if (!/@v\d+\.\d+\.\d+(\/|$)/.test(base)) {
      all.push(`manifest.json cdnBase is not a release tag: ${base} — use \`build --base --out\` for a dev build`);
    }
  } catch (err) {
    all.push(`manifest: ${err.message}`);
  }

  /* Local bytes against the tag's. While the tree is ahead of the tag, a slim or viewer
     built from it promises hashes that tag does not serve — the failure that took slim down
     twice (v0.3.0, v0.4.0). It is a *warning*, because being ahead of the tag is the normal
     state of work in progress; `release` is what clears it, and `build --base` is how you
     get a bootable copy in the meantime. */
  try {
    const published = publishedState();
    if (published.released) {
      const drifted = published.manifest.assets
        .filter((asset) => asset.role !== "infra")
        .filter((asset) => {
          const file = `${DIST}/cdn/${asset.id}.${extensionFor(asset.kind)}`;
          const shipped = fileAt(published.tag, file);
          return !shipped || !Buffer.from(shipped).equals(fs.readFileSync(abs(file)));
        })
        .map((asset) => asset.id);
      if (drifted.length) {
        depWarnings.push(
          `dist/cdn differs from ${published.tag} (${drifted.length} asset${drifted.length === 1 ? "" : "s"}: ${drifted.slice(0, 3).join(", ")}${drifted.length > 3 ? ", …" : ""}) — ` +
          `dist/slim.html will not boot at that tag until you release, or build --base for a dev copy`,
        );
      }
    }
  } catch (err) {
    depWarnings.push(`could not compare dist/cdn with the tag: ${err.message}`);
  }

  /* The runtime catalog is what an older document reads to find a newer release, so its
     entries are read out of the tags themselves and must stay that way: a hand-edited
     entry would advertise bytes its tag never shipped, which is the one lie this repo
     cannot afford. A shallow clone has no tags; say so instead of failing. */
  try {
    const { index, releases, tags } = runtimeCatalog();
    if (!tags.length) {
      depWarnings.push("no release tags in this clone — dist/runtime.json was not verified");
    } else {
      const indexPath = `${DIST}/runtime.json`;
      let current = null;
      try {
        current = exists(indexPath) ? JSON.parse(read(indexPath)) : null;
      } catch {
        current = null;
      }
      if (!current || !sameIndex(current, index)) {
        all.push(`${indexPath} is stale — run: node build.mjs catalog`);
      }
      const known = new Set(releases.map(([tag]) => `${tag}.json`));
      for (const [tag, entry] of releases) {
        const file = `${RUNTIME}/${tag}.json`;
        if (!exists(file) || read(file) !== JSON.stringify(entry, null, 2) + "\n") {
          all.push(`${file} is stale — run: node build.mjs catalog`);
        }
      }
      if (exists(RUNTIME)) {
        for (const name of fs.readdirSync(abs(RUNTIME))) {
          if (!known.has(name)) all.push(`${RUNTIME}/${name} describes no tag — run: node build.mjs catalog`);
        }
      }
    }
  } catch (err) {
    all.push(`catalog: ${err.message}`);
  }

  /* dependency-graph audit: order constraints, late-vs-plain, drift against the
     MODULES table, and freshness of the generated reference artifacts */
  try {
    const m = readManifest();
    const index = new Map(m.assets.map((a) => [a.id, a]));
    for (const a of m.assets.filter((x) => x.kind === "js" && x.role === "module")) {
      const contract = {
        deps: a.deps ?? [],
        late: a.late ?? [],
        optional: a.optional ?? [],
        provides: a.provides ?? null,
        implicitGlobals: a.implicit ?? [],
      };
      const audited = auditContract(a.id, contract, index);
      for (const problem of audited.problems) all.push(`deps: ${problem}`);
      for (const warning of audited.warnings) depWarnings.push(`deps: ${warning}`);
    }
    if (exists("deps.json") && read("deps.json") !== JSON.stringify(depsJson(m), null, 2) + "\n") {
      all.push("deps.json is stale — run: node build.mjs combine");
    }
    if (exists("DEPS.md") && read("DEPS.md") !== depsMarkdown(m)) {
      all.push("DEPS.md is stale — run: node build.mjs combine");
    }
  } catch (err) {
    all.push(`deps: ${err.message}`);
  }

  /* the in-document manifest and the published copies must match the sources */
  try {
    const m = readManifest();
    if (!html.includes(manifestBlock(docManifest(m)))) {
      all.push("the in-document asset manifest is stale — run: node build.mjs combine");
    }
    if (!html.includes(settingsBlock(docSettings(m)))) {
      all.push("the in-document settings block is stale — run: node build.mjs combine");
    }
    /* Every asset a save policy may move to the CDN needs to know where it lives
       and what it hashes to, even while it is inline. */
    for (const asset of docManifest(m).assets) {
      if (asset.role === "infra") continue;
      if (!asset.url || !asset.integrity) {
        all.push(`${asset.id}: the document manifest must carry url + integrity for every non-infra asset`);
      }
    }
    /* The loader and its failure UI cannot arrive over the network: something has
       to verify bytes, and something has to report that it could not. */
    for (const asset of m.assets) {
      if (asset.role === "infra" && asset.mode === "online") {
        all.push(`${asset.id} is infrastructure and cannot have mode "online" (it is the root of trust and the failure UI)`);
      }
    }
    for (const asset of m.assets) {
      if (asset.role === "infra") continue;
      const docEntry = docManifest(m).assets.find((candidate) => candidate.id === asset.id);
      /* Bytes published by someone else are not in dist/cdn, and this repository is
         not their publisher. A pinned plugin is still hash-checked — by the catalog
         job, against the url its own manifest names. */
      if (!String(docEntry?.url || "").startsWith(`${String(m.cdnBase || "").replace(/\/$/, "")}/`)) continue;
      const published = `${DIST}/cdn/${asset.id}.${extensionFor(asset.kind)}`;
      /* Bytes, not text: the published copy of a bin asset is binary. */
      if (!exists(published)) all.push(`${published} is missing — run: node build.mjs build`);
      else if (sha384Buffer(readBytes(published)) !== asset.sha384) all.push(`${published} does not match the manifest hash — run: node build.mjs build`);
    }
    /* A plugin is a bundle, and the two halves of the claim have to agree in both
       directions: require() builds from the index, policy.usage() prices from the
       per-asset grouping, and neither can see the other's mistakes. */
    const doc = docManifest(m);
    const groups = doc.plugins || {};
    for (const [id, entry] of Object.entries(groups)) {
      /* `island` names the frame a contribution's content mounts into — sealed,
         sandboxed or trusted — never the plugin's own reach. */
      const island = entry.island || "sealed";
      if (!["sealed", "sandboxed", "trusted"].includes(island)) all.push(`plugin "${id}": unknown island "${entry.island}"`);
      if (!Array.isArray(entry.assets) || !entry.assets.length) {
        all.push(`plugin "${id}": assets must be a non-empty array (require() has nothing to build)`);
      } else {
        for (const assetId of entry.assets) {
          if (!doc.assets.some((asset) => asset.id === assetId)) all.push(`plugin "${id}" lists "${assetId}", which is not an asset`);
        }
      }
      if (entry.entry && !doc.assets.some((asset) => asset.id === entry.entry)) {
        all.push(`plugin "${id}": entry "${entry.entry}" is not an asset`);
      }
    }
    for (const asset of doc.assets) {
      if (asset.category === "plugin" && !asset.plugin) all.push(`${asset.id}: category "plugin" needs a plugin group`);
      if (asset.plugin && !groups[asset.plugin]) all.push(`${asset.id}: belongs to plugin "${asset.plugin}", which is not in the plugin index`);
    }
  } catch (err) {
    all.push(`manifest: ${err.message}`);
  }

  /* the marker bootstrap table must still describe this document: it is the
     recovery path for an index.html that lost its markers */
  try {
    const m = readManifest();
    for (const region of REGIONS) {
      const entry = m.assets.find((a) => a.id === region.id);
      if (!entry) all.push(`REGIONS lists "${region.id}", which is not an asset`);
      else if (entry.order !== region.order || entry.kind !== region.kind) {
        all.push(`REGIONS says ${region.id} is order ${region.order}/${region.kind}, manifest says ${entry.order}/${entry.kind}`);
      }
    }
    for (const a of m.assets) {
      /* A plugin is never a marker region in index.html: it is pinned into a document
         by the installer, and the repository's own file is just one such document. */
      if (a.category === "plugin") continue;
      if (!REGIONS.some((r) => r.id === a.id)) all.push(`${a.id} is missing from REGIONS (marker recovery would skip it)`);
    }
  } catch (err) {
    all.push(err.message);
  }

  /* the catalog: valid, and published as authored */
  try {
    const catalog = readCatalog();
    for (const problem of catalogProblems(catalog)) all.push(problem);
    if (exists(CATALOG)) {
      if (read(CATALOG) !== JSON.stringify(catalogDocument(catalog), null, 2) + "\n") {
        all.push(`${CATALOG} is stale — run: node build.mjs combine`);
      }
    } else {
      all.push(`${CATALOG} is missing — run: node build.mjs combine`);
    }
  } catch (err) {
    all.push(`catalog: ${err.message}`);
  }

  /* schema sanity */
  try {
    const m = readManifest();
    if (m.schema !== 1) all.push(`manifest.json schema is ${m.schema}, expected 1`);
    for (const a of m.assets) {
      if (!["css", "js", "html", "bin"].includes(a.kind)) all.push(`${a.id}: unknown kind "${a.kind}"`);
      if (a.category != null && a.category !== "plugin") all.push(`${a.id}: unknown category "${a.category}"`);
      if (!["inline", "online", "disabled"].includes(a.mode)) all.push(`${a.id}: unknown mode "${a.mode}"`);
      if (!Array.isArray(a.requiredBy) || !a.requiredBy.length) all.push(`${a.id}: requiredBy must be a non-empty array`);
    }
  } catch (err) {
    all.push(err.message);
  }

  /* size drift, warning only for now (Tier 3 becomes blocking in Phase 3) */
  const warnings = [];
  if (exists(BASELINE)) {
    const base = JSON.parse(read(BASELINE));
    const now = measure();
    for (const [key, size] of Object.entries(now.flavors)) {
      const was = base.flavors?.[key];
      if (!was) continue;
      const delta = size - was;
      if (delta > 0 && delta / was > 0.02) warnings.push(`${key} grew ${kb(delta)} KB (${((delta / was) * 100).toFixed(1)}%)`);
    }
  }

  if (all.length) {
    console.error(`check: FAILED (${all.length})`);
    for (const p of all) console.error(`  - ${p}`);
  } else {
    console.log("check: ok");
  }
  for (const w of [...depWarnings, ...warnings]) console.warn(`check: warning — ${w}`);
  if (exit) process.exit(all.length ? 1 : 0);
  return all.length === 0;
}

function measure() {
  const html = read(SOURCE);
  const assets = parseSource(html);
  const assetTotal = assets.reduce((n, a) => n + nbytes(a.body), 0);
  const markup = nbytes(html) - assetTotal;
  return {
    source: { bytes: nbytes(html) },
    assets: assets.map((a) => ({ id: a.id, kind: a.kind, bytes: nbytes(a.body) })),
    flavors: {
      "index.html": nbytes(html),
      "asset-bodies": assetTotal,
      "markup-and-runtime": markup,
      ...(exists(`${DIST}/slim.html`) ? { "dist/slim.html": nbytes(read(`${DIST}/slim.html`)) } : {}),
    },
  };
}

/** The slim flavour: every non-infra asset fetched from the CDN. Infrastructure
 *  (registry, boot UI, bootstrap) stays inline, because it does the fetching.
 *  Phase 4's save-time policies reuse this, so the flavour and the policy cannot
 *  drift apart. */
function buildSlim(html, manifest) {
  const online = Object.fromEntries(
    manifest.assets.filter((asset) => asset.role !== "infra").map((asset) => [asset.id, "online"]),
  );
  let slim = withDocManifest(html, docManifest(manifest, online));
  for (const asset of manifest.assets) {
    if (asset.role !== "infra") slim = withoutAsset(slim, asset.id);
  }
  return slim;
}

/** Assets a given mode needs — the build-time twin of the loader's filter. */
function inMode(asset, mode) {
  const requiredBy = asset.requiredBy || ["*"];
  return requiredBy.includes("*") || requiredBy.includes(mode);
}

/**
 * The viewer: the same document in view mode, with the editing capability *absent*
 * rather than offloaded. `inline` is the policy, so it opens from `file://` with no
 * network — which is the whole point of sending someone a read-only copy.
 */
/**
 * The editor flavour: the canonical document restricted to what edit mode builds. An asset
 * only a viewer needs leaves the file entirely — its manifest entry keeps `url` +
 * `integrity` + `mode: online`, so a document switched to view mode later fetches it from
 * the pin instead of an editor carrying chrome it never shows.
 *
 * This is why `dist/editor.html` is no longer byte-identical to `index.html`: `index.html`
 * is the source of *every* asset, and a flavour is a mode.
 */
function buildEditor(html, manifest) {
  const edit = new Set(manifest.assets.filter((asset) => inMode(asset, "edit")).map((asset) => asset.id));
  let out = withDocManifest(html, docManifest(manifest));
  for (const asset of manifest.assets) {
    if (!edit.has(asset.id)) out = withoutAsset(out, asset.id);
  }
  return out;
}

function buildViewer(html, manifest) {
  const view = new Set(manifest.assets.filter((asset) => inMode(asset, "view")).map((asset) => asset.id));
  /* Everything this flavour keeps is in the file, so it is declared inline even when the
     manifest says `online` for editors (the viewer bar). Otherwise a viewer would fetch
     what it already carries. */
  const inline = Object.fromEntries([...view].map((id) => [id, "inline"]));
  let out = withDocSettings(withDocManifest(html, docManifest(manifest, inline)), docSettings(manifest, {mode: "view", toolbar: true}));
  for (const asset of manifest.assets) {
    if (!view.has(asset.id)) out = withoutAsset(out, asset.id);
  }
  return out;
}

/* ------------------------------------------------------- runtime catalog */

const RUNTIME = `${DIST}/runtime`;

/** Every release tag in the clone, oldest first. Empty on a shallow checkout. */
function releaseTags() {
  try {
    return execFileSync("git", ["tag", "--list", "v*", "--sort=v:refname"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((line) => line.trim())
      .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  } catch {
    return [];
  }
}

/**
 * One release, described by the manifest that release shipped. This is what
 * `update-runtime` will diff against — `{id, kind, bytes, sha384, url}` per reusable
 * asset — so a document can re-pin without downloading and parsing an `editor.html`
 * to find the same table.
 */
function runtimeEntry(tag, manifest) {
  const base = String(manifest.cdnBase || "").replace(/\/$/, "");
  return {
    schema: 1,
    tag,
    base,
    assets: (manifest.assets || [])
      .filter((asset) => asset.role !== "infra")
      .map((asset) => {
        const entry = {
          id: asset.id,
          kind: asset.kind,
          bytes: asset.bytes,
          sha384: asset.sha384,
          /* A pinned plugin's bytes live wherever its author publishes them. */
          url: asset.url || `${base}/${asset.id}.${extensionFor(asset.kind)}`,
          requiredBy: asset.requiredBy || ["*"],
        };
        if (asset.plugin) entry.plugin = asset.plugin;
        return entry;
      }),
  };
}

const tagOf = (base) => /@([^/]+)\//.exec(String(base || ""))?.[1] ?? null;

/** A file as a tag shipped it, or null when this clone does not have that tag. */
function fileAt(tag, file) {
  try {
    /* `stdio` silences git's own "invalid object name" for a tag that does not exist yet:
       asking is how we find out, and it is not an error worth printing. */
    return execFileSync("git", ["show", `${tag}:${file}`], { cwd: ROOT, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** The authored manifest a tag shipped, or null. */
const manifestAt = (tag) => {
  const text = fileAt(tag, MANIFEST);
  try {
    return text ? JSON.parse(text.toString("utf8")) : null;
  } catch {
    return null;
  }
};

/**
 * What a release's tree published, for the checks that must judge *published* state
 * rather than the working tree: the tag's own manifest and its own document bytes.
 */
function publishedState({ tag = null } = {}) {
  const working = readManifest();
  const wanted = tag || tagOf(working.cdnBase);
  const released = wanted ? manifestAt(wanted) : null;
  if (!released) return { tag: wanted, manifest: working, released: false, base: String(working.cdnBase || "") };
  return { tag: wanted, manifest: released, released: true, base: String(released.cdnBase || "") };
}

const semverOf = (tag) => tag.replace(/^v/, "").split(".").map(Number);
const newer = (a, b) => {
  const [x, y] = [semverOf(a), semverOf(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/**
 * The catalog is a view of *history*, not of the working tree: every entry is read
 * out of the tag it describes, so an entry can never claim bytes its tag did not
 * ship — the failure mode this repository spent a release learning (see v0.3.1).
 *
 * The one exception is the release being prepared: `package.json`'s version has no tag
 * yet, so its entry is built from the tree that is about to be tagged. `release`
 * refuses a dirty tree, and once the tag exists both routes produce the same bytes.
 */
function runtimeCatalog() {
  const tags = releaseTags();
  const pending = `v${JSON.parse(read("package.json")).version}`;
  const releases = [];
  for (const tag of tags) {
    try {
      const manifest = JSON.parse(execFileSync("git", ["show", `${tag}:${MANIFEST}`], {
        cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"],
      }));
      releases.push([tag, runtimeEntry(tag, manifest)]);
    } catch {
      /* A tag without a manifest cannot be described; it is not a release of this
         runtime shape (or the clone is partial). Skip it rather than invent one. */
    }
  }
  if (!releases.some(([tag]) => tag === pending)) releases.push([pending, runtimeEntry(pending, readManifest())]);
  releases.sort((a, b) => (newer(a[0], b[0]) ? 1 : newer(b[0], a[0]) ? -1 : 0));

  const index = {
    schema: 1,
    generated: "generated by node build.mjs catalog from the tags themselves — advisory only; a document embeds its own pins",
    latest: releases.length ? releases[releases.length - 1][0] : null,
    releases: releases.map(([tag, entry]) => ({
      tag,
      date: tagDate(tag),
      base: entry.base,
      assets: entry.assets.length,
      manifest: `runtime/${tag}.json`,
    })),
  };
  return { index, releases, tags };
}

function tagDate(tag) {
  try {
    return execFileSync("git", ["for-each-ref", `refs/tags/${tag}`, "--format=%(taggerdate:short)"], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Write `dist/runtime.json` + one file per release. Returns what it wrote. */
function writeCatalog() {
  const { index, releases, tags } = runtimeCatalog();
  if (!tags.length) {
    /* A shallow clone (CI's default) has no tags: writing here would replace the
       catalog with the pending release alone, and pruning would delete the rest. */
    console.warn("catalog: no release tags in this clone — left as-is (fetch tags to regenerate)");
    return null;
  }
  fs.rmSync(abs(RUNTIME), { recursive: true, force: true });
  for (const [tag, entry] of releases) write(`${RUNTIME}/${tag}.json`, JSON.stringify(entry, null, 2) + "\n");
  write(`${DIST}/runtime.json`, JSON.stringify(index, null, 2) + "\n");
  return { latest: index.latest, count: releases.length };
}

/**
 * Two indexes describe the same history when they agree on everything but `date`: a
 * release commit's pending entry cannot know its own tag date (the tag does not exist
 * yet), and comparing it byte-for-byte would make every tag fail its own check the
 * moment it is created. `date` is display-only, so it stays out of the comparison.
 */
function sameIndex(a, b) {
  const strip = (index) => JSON.stringify({
    ...index,
    releases: (index.releases || []).map(({ date, ...release }) => release),
  });
  return strip(a) === strip(b);
}

function cmdCatalog() {
  const done = writeCatalog();
  if (!done) process.exit(1);
  console.log(`catalog: ${done.count} releases, latest ${done.latest} → ${DIST}/runtime.json`);
}

function cmdBuild({ base = null, out = null } = {}) {
  const { problems, html } = verify({ quiet: true });
  if (problems.length) {
    console.error(`build: refusing to build, verify failed (${problems.length})`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const manifest = readManifest();

  /* A dev base produces documents that are true only against a server you run, so it
     must not land where a release lives: the committed flavours are the only copy a
     reader ever sees, and `check` refuses a document whose base is not a tag. */
  if (base) {
    const dir = out || ".test-tmp/build";
    const resolved = path.resolve(ROOT, dir);
    if (resolved === path.resolve(ROOT, DIST) || resolved.startsWith(path.resolve(ROOT, DIST) + path.sep)) {
      console.error(`build: --base must not write into ${DIST}/ — a committed document is a release pair`);
      console.error(`build: try --out=.test-tmp/build`);
      process.exit(1);
    }
    const put = (doc) => retarget(doc, base);
    write(`${dir}/editor.html`, put(html));
    write(`${dir}/slim.html`, put(buildSlim(html, manifest)));
    write(`${dir}/viewer.html`, put(buildViewer(html, manifest)));
    console.log(`build: dev base ${base} → ${dir}/ (nothing published, nothing checked in)`);
    console.log(`build: open ${dir}/slim.html from disk, with ${DIST}/cdn served`);
    return;
  }

  write(`${DIST}/editor.html`, buildEditor(html, manifest));

  /* Byte copies of the sources: what integrity pins is exactly what we publish. */
  for (const asset of manifest.assets) {
    if (asset.role === "infra") continue;
    if (asset.kind === "bin") writeBytes(`${DIST}/cdn/${asset.id}.${extensionFor(asset.kind)}`, readBytes(asset.file));
    else write(`${DIST}/cdn/${asset.id}.${extensionFor(asset.kind)}`, read(asset.file));
  }

  write(`${DIST}/slim.html`, buildSlim(html, manifest));
  write(`${DIST}/viewer.html`, buildViewer(html, manifest));

  const m = measure();
  const report = {
    schema: 1,
    /* no timestamp: dist/ is committed, so output must be deterministic */
    ...m,
  };
  write(`${DIST}/size-report.json`, JSON.stringify(report, null, 2) + "\n");
  const catalog = writeCatalog();
  if (catalog) console.log(`build: catalog ${catalog.count} releases, latest ${catalog.latest}`);
  const editor = read(`${DIST}/editor.html`);
  console.log(`build: dist/editor.html (${kb(nbytes(editor))} KB) — ${SOURCE} is ${kb(nbytes(html))} KB, ` +
    `${kb(nbytes(html) - nbytes(editor))} KB of view-only chrome left out`);
  console.log(`build: ${kb(m.flavors["asset-bodies"])} KB assets + ${kb(m.flavors["markup-and-runtime"])} KB markup/runtime`);
}

function cmdReport({ baseline = false } = {}) {
  const m = measure();
  const width = Math.max(...m.assets.map((a) => a.id.length), 8);
  console.log("");
  console.log("asset".padEnd(width + 2) + "kind".padEnd(6) + "size");
  console.log("-".repeat(width + 20));
  for (const a of m.assets.sort((x, y) => y.bytes - x.bytes)) {
    console.log(a.id.padEnd(width + 2) + a.kind.padEnd(6) + `${kb(a.bytes).padStart(9)} KB`);
  }
  console.log("-".repeat(width + 20));
  console.log("asset bodies".padEnd(width + 2) + "".padEnd(6) + `${kb(m.flavors["asset-bodies"]).padStart(9)} KB`);
  console.log("markup/runtime".padEnd(width + 2) + "".padEnd(6) + `${kb(m.flavors["markup-and-runtime"]).padStart(9)} KB`);
  console.log("index.html".padEnd(width + 2) + "".padEnd(6) + `${kb(m.flavors["index.html"]).padStart(9)} KB`);
  console.log("");

  if (baseline) {
    write(BASELINE, JSON.stringify(m, null, 2) + "\n");
    console.log(`report: wrote ${BASELINE}`);
  }
}

/**
 * Check that the CDN actually serves what the documents pin.
 *
 * This is the only check that leaves the repository. It fetches every published
 * asset at `manifest.json`'s `cdnBase` (or `--tag <ref>`), hashes the bytes it gets
 * back, and compares them with the hash the document will verify on open. A tag is
 * immutable, so a mismatch here means the release itself is wrong; a branch is not,
 * so a mismatch on `@main` usually means the branch moved and the documents need
 * rebuilding.
 */
async function cmdVerifyCdn({ tag = null } = {}) {
  /* Verify what was *published*, not what is checked out. HEAD is routinely ahead of the
     tag (every feature branch is), and comparing HEAD's hashes with the tag's bytes made
     this job red for reasons that had nothing to do with the CDN. The tag's own manifest
     and its own document bytes are the thing to hold the CDN to. */
  const published = publishedState({ tag });
  const manifest = published.manifest;
  let base = published.base.replace(/\/$/, "");
  if (tag && !published.released) base = base.replace(/@[^/]+/, `@${tag}`);
  if (!/^https?:\/\//.test(base)) {
    console.error(`verify-cdn: cdnBase is not a URL: ${JSON.stringify(base)}`);
    process.exit(1);
  }
  const docBase = base.replace(/\/cdn$/, "");

  const targets = [];
  for (const asset of manifest.assets) {
    if (asset.role === "infra") continue;
    targets.push({
      id: `${asset.id}.${extensionFor(asset.kind)}`,
      url: `${base}/${asset.id}.${extensionFor(asset.kind)}`,
      expected: asset.sha384,
      local: null,
    });
  }
  /* Every catalog proposal, fetched and hashed. A broken catalog must be a CI failure, not
     something an author discovers when the sheet offers a plugin that cannot load. These
     are third-party urls: not tag-scoped, and not published by this repository. */
  let catalogTargets = 0;
  try {
    for (const [id, asset] of Object.entries(readCatalog().assets || {})) {
      for (const version of asset.versions || []) {
        catalogTargets += 1;
        targets.push({
          id: `${id}@${version.version}`,
          url: version.url,
          expected: version.sha384,
          local: null,
          selfContained: true,
        });
      }
    }
  } catch (error) {
    console.error(`verify-cdn: plugins.json is unreadable — ${error.message}`);
    process.exit(1);
  }

  /* The document is the thing people actually open, so it is checked too — as the tag
     published it, which is not what `dist/` holds while the tree is ahead. */
  for (const name of ["editor.html", "slim.html", "viewer.html"]) {
    const shipped = published.released ? fileAt(published.tag, `${DIST}/${name}`) : null;
    if (!shipped && !exists(`${DIST}/${name}`)) continue;
    targets.push({
      id: name,
      url: `${docBase}/${name}`,
      expected: "sha384-" + createHash("sha384").update(shipped || fs.readFileSync(abs(`${DIST}/${name}`))).digest("base64"),
      local: shipped ? null : `${DIST}/${name}`,
    });
  }

  const how = published.released ? `${published.tag}'s tree` : "the working tree (tag not in this clone)";
  console.log(`verify-cdn: ${targets.length} files at ${base} — expected hashes from ${how}`);
  const failures = [];

  /* Two attempts per file: this runs nightly over someone else's network, and a
     single dropped connection should not page anyone. */
  const fetchOnce = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!response.ok) return { error: `HTTP ${response.status}` };
      const bytes = Buffer.from(await response.arrayBuffer());
      return { bytes };
    } catch (error) {
      return { error: controller.signal.aborted ? "timed out" : (error && error.message) || "fetch failed" };
    } finally {
      clearTimeout(timer);
    }
  };

  for (const target of targets) {
    let result = await fetchOnce(target.url);
    if (result.error) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      result = await fetchOnce(target.url);
    }
    if (result.error) {
      console.log(`  unreachable  ${target.id}  ${result.error}`);
      failures.push({ ...target, why: result.error });
      continue;
    }
    const actual = "sha384-" + createHash("sha384").update(result.bytes).digest("base64");
    if (target.selfContained) {
      /* The loader evaluates verified bytes from a blob:, where a bare or relative
         specifier cannot resolve. A catalog entry that imports anything is unusable, and
         naming it here is cheaper than an author finding out. */
      const text = result.bytes.toString("utf8");
      const bad = /(^|\n)\s*(import|export)\b[^;\n]*\bfrom\s*["']|(^|\n)\s*import\s*["']/.exec(text);
      if (bad) {
        console.log(`  not standalone  ${target.id}  imports ${JSON.stringify(bad[0].trim().slice(0, 60))}`);
        failures.push({ ...target, why: "the module imports another file; a catalog entry must be self-contained" });
        continue;
      }
    }
    if (actual === target.expected) {
      console.log(`  ok           ${target.id}  ${result.bytes.length} bytes`);
    } else {
      console.log(`  MISMATCH     ${target.id}  expected ${target.expected.slice(0, 16)}… got ${actual.slice(0, 16)}…`);
      failures.push({ ...target, why: "hash does not match the manifest", actual });
    }
  }

  if (failures.length) {
    console.error(`verify-cdn: FAILED (${failures.length} of ${targets.length})`);
    for (const failure of failures) console.error(`  - ${failure.id}: ${failure.why}`);
    if (!tag) {
      console.error("  A branch ref is not a release. If the branch moved, rebuild and re-verify;");
      console.error("  if this is a release, run with --tag <version> against an immutable tag.");
    }
    process.exit(1);
  }
  console.log(`verify-cdn: ok — ${targets.length} files match the recorded hashes`);
}

function cmdDev() {
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
  const port = Number(process.env.PORT || 8080);
  http
    .createServer((req, res) => {
      const url = decodeURIComponent((req.url || "/").split("?")[0]);
      const target = url === "/" ? "index.html" : url.replace(/^\/+/, "");
      const file = path.join(ROOT, target);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      /* CORS for everything: this server exists to be fetched from, including from a
         `file://` document. Without this header Chromium and WebKit refuse the request
         (measured — lab/007), which would mean a plugin pinned to a local url could
         never be tested the way a reader would open the file. */
      res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(fs.readFileSync(file));
    })
    .listen(port, "127.0.0.1", () => {
      console.log(`dev: http://127.0.0.1:${port}/  (serving ${rel(ROOT)})`);
      console.log("dev: index.html over http:// — use this for anything that fetches");
    });
}

/**
 * `node build.mjs release <x.y.z>` — the ritual, once, in order.
 *
 * It refuses anything it cannot do safely and performs only the mechanical part: bump the
 * two version facts, rebuild every derived artefact, re-seed the size baseline, and pass
 * the gate. It never tags and never pushes — those stay human — but it prints them along
 * with the purges a brand-new tag needs, because jsDelivr caches a failed fetch forever
 * and the first person to hit it is a reader.
 */
async function cmdRelease({ version, dryRun = false } = {}) {
  const usage = "release: usage: node build.mjs release <major.minor.patch> [--dry-run]";
  if (!/^\d+\.\d+\.\d+$/.test(String(version || ""))) {
    console.error(usage);
    process.exit(1);
  }
  const tag = `v${version}`;
  const problems = [];
  const tags = releaseTags();
  if (!tags.length) problems.push("no tags in this clone — fetch tags before releasing");
  if (tags.includes(tag)) problems.push(`${tag} already exists`);
  const newest = tags[tags.length - 1];
  if (newest && !newer(tag, newest)) problems.push(`${tag} is not newer than ${newest}`);
  if (!new RegExp(`^## ${tag.replace(/\./g, "\\.")}\\b`, "m").test(read(CHANGELOG_FILE))) {
    problems.push(`${CHANGELOG_FILE} has no "## ${tag} — <date>" section (it has to be in the tag's tree)`);
  }
  let dirty = "";
  try {
    dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    problems.push("not a git checkout");
  }
  if (dirty && !dryRun) problems.push(`the tree is not clean — commit first:\n${dirty.split("\n").map((line) => `  ${line}`).join("\n")}`);
  if (problems.length) {
    console.error(`release: refusing (${problems.length})`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  const manifest = readManifest();
  const pkg = JSON.parse(read("package.json"));
  const nextBase = String(manifest.cdnBase || "").replace(/@[^/]+/, `@${tag}`);
  const steps = [
    `manifest.json cdnBase ${manifest.cdnBase} → ${nextBase}`,
    `package.json version ${pkg.version} → ${version}`,
    "combine → build → catalog → report --baseline → check",
  ];
  console.log(`release: ${tag}`);
  for (const step of steps) console.log(`  ${step}`);
  if (dryRun) {
    console.log("release: --dry-run, nothing written");
    return;
  }

  manifest.cdnBase = nextBase;
  write(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  pkg.version = version;
  write("package.json", JSON.stringify(pkg, null, 2) + "\n");

  cmdCombine();
  cmdBuild();
  cmdCatalog();
  cmdReport({ baseline: true });
  if (!(await cmdCheck({ exit: false }))) {
    console.error(`release: ${tag} was NOT prepared — the gate above has the reasons. Nothing is tagged.`);
    console.error("  (the version bump and the rebuild are in place; fix, commit, and run release again)");
    process.exit(1);
  }

  /* jsDelivr: a new tag is a new set of paths, and it caches a failed fetch. Purging the
     files that changed (all of them, on a first release) is cheaper than debugging it. */
  const slug = /cdn\.jsdelivr\.net\/gh\/([^/@]+\/[^/@]+)@/.exec(nextBase)?.[1];
  const files = ["dist/editor.html", "dist/slim.html", "dist/viewer.html",
    ...manifest.assets.filter((asset) => asset.role !== "infra").map((asset) => `dist/cdn/${asset.id}.${extensionFor(asset.kind)}`)];

  console.log("");
  console.log("release: the mechanical part is done and green. Next, by hand:");
  console.log(`  1. tag it   git tag -a ${tag} -m "${tag} — <one line>"`);
  console.log(`  2. push     git push origin main && git push origin ${tag}`);
  if (slug) {
    console.log(`  3. purge    jsDelivr caches a new tag's paths (and a failed fetch, forever):`);
    console.log(`     for f in ${files.join(" ")}; do curl -s "https://purge.jsdelivr.net/gh/${slug}@${tag}/$f" > /dev/null; done`);
    console.log(`     curl -s "https://purge.jsdelivr.net/gh/${slug}@main/dist/runtime.json" > /dev/null`);
    console.log(`  4. verify   node build.mjs verify-cdn --tag=${tag}`);
  } else {
    console.log(`  3. purge    not a jsDelivr base — purge ${files.length} paths on your host, then verify`);
  }
  console.log(`  5. catalog  npm run catalog && git commit -am "chore(catalog): ${tag}'s entry now carries its date" && git push`);
}

/* -------------------------------------------------------------------- cli */

const [cmd = "help", ...flags] = process.argv.slice(2);
switch (cmd) {
  case "split":
    cmdSplit();
    break;
  case "combine":
    cmdCombine();
    break;
  case "verify":
    process.exit(verify().problems.length ? 1 : 0);
    break;
  case "check":
    await cmdCheck();
    break;
  case "build":
    cmdBuild({
      base: flags.find((flag) => flag.startsWith("--base="))?.slice("--base=".length) ?? null,
      out: flags.find((flag) => flag.startsWith("--out="))?.slice("--out=".length) ?? null,
    });
    break;
  case "report":
    cmdReport({ baseline: flags.includes("--baseline") });
    break;
  case "catalog":
    cmdCatalog();
    break;
  case "release":
    await cmdRelease({
      version: flags.find((flag) => !flag.startsWith("--")),
      dryRun: flags.includes("--dry-run"),
    });
    break;
  case "verify-cdn":
    await cmdVerifyCdn({ tag: flags.find((flag) => flag.startsWith("--tag="))?.slice("--tag=".length) ?? null });
    break;
  case "dev":
    cmdDev();
    break;
  case "help":
  default:
    console.log(read("build.mjs").split("\n").slice(1, 22).join("\n").replace(/^\/\*\*?| \*\/?/gm, "").trim());
    if (!["help", "--help", "-h"].includes(cmd)) process.exit(1);
}
