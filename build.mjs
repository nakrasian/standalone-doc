#!/usr/bin/env node
/**
 * build.mjs — standalone-doc build tool. Zero dependencies.
 *
 *   node build.mjs split      index.html  -> src/*.{css,js} + manifest.json
 *   node build.mjs combine    src/ + manifest.json -> index.html
 *   node build.mjs verify     round-trip and hash checks (read-only)
 *   node build.mjs check      verify + schema + guarded-file scan  (CI gate)
 *   node build.mjs build      dist/editor.html + dist/size-report.json
 *   node build.mjs report     size table; --baseline rewrites size-baseline.json
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
const SRC = "src";
const DIST = "dist";
const BASELINE = "size-baseline.json";
const DEFAULT_CDN_BASE = "https://cdn.jsdelivr.net/gh/nakrasian/standalone-doc@main/dist/cdn";
const DOC_MANIFEST_ID = "asset-manifest";
const DOC_SETTINGS_ID = "doc-settings";
/* Authoring defaults for the document's own behaviour. manifest.json is the place a
   human edits these; build materialises them into #doc-settings. */
const DEFAULT_SETTINGS = { mode: "edit", editable: true, toolbar: true, saveThresholdBytes: 2097152 };
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
  { id: "page-styles", kind: "css", order: 10, requiredBy: ["*"] },
  { id: "toolbar-styles", kind: "css", order: 20, requiredBy: ["edit"] },
  { id: "boot-ui-styles", kind: "css", order: 25, requiredBy: ["*"] },
  { id: "registry", kind: "js", order: 5, requiredBy: ["*"] },
  { id: "boot-ui", kind: "js", order: 6, requiredBy: ["*"] },
  { id: "apply-settings", kind: "js", order: 7, requiredBy: ["*"] },
  { id: "signals", kind: "js", order: 30, requiredBy: ["*"] },
  { id: "zoom", kind: "js", order: 40, requiredBy: ["*"] },
  { id: "pagination", kind: "js", order: 50, requiredBy: ["*"] },
  { id: "progress", kind: "js", order: 45, requiredBy: ["edit"] },
  { id: "status", kind: "js", order: 60, requiredBy: ["edit"] },
  { id: "editor", kind: "js", order: 70, requiredBy: ["edit"] },
  { id: "figures", kind: "js", order: 80, requiredBy: ["*"] },
  { id: "policy", kind: "js", order: 85, requiredBy: ["edit"] },
  { id: "toolbar", kind: "js", order: 90, requiredBy: ["edit"] },
  { id: "export", kind: "js", order: 100, requiredBy: ["edit"] },
  { id: "bootstrap", kind: "js", order: 120, requiredBy: ["*"] },
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
    const { text: fileText, indent } = dedent(body);
    /* Only trust dedent if it is exactly reversible. */
    const reversible = reindent(fileText, indent) === body;

    assets.push({
      id,
      kind: attrs.kind || (tag === "style" ? "css" : "js"),
      order: Number(attrs.order ?? assets.length * 10 + 10),
      tag,
      file: `${SRC}/${id}.${tag === "style" ? "css" : "js"}`,
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
    const tag = region.kind === "css" ? "style" : "script";
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
    const text = read(a.file);
    const before = keep.get(a.id);
    const meta = REGIONS.find((r) => r.id === a.id) || {};
    const mode = before?.mode ?? meta.mode ?? "inline";
    const requiredBy = before?.requiredBy ?? meta.requiredBy ?? ["*"];
    if (before && (before.mode !== (meta.mode ?? "inline") || String(before.requiredBy) !== String(meta.requiredBy ?? ["*"]))) preserved++;
    const entry = {
      id: a.id,
      kind: a.kind,
      order: a.order,
      tag: a.tag,
      file: a.file,
      bytes: nbytes(text),
      sha384: sha384(text),
      mode,
      requiredBy,
    };
    entry.role = INFRA.has(a.id) ? "infra" : "module";
    if (isConverted(a.id)) {
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
  return {
    schema: 1,
    cdnBase: base,
    timeoutMs: manifest.timeoutMs || 8000,
    assets: manifest.assets.map((a) => {
      const ext = a.kind === "css" ? "css" : "js";
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
      if (a.deps?.length) entry.deps = a.deps;
      if (a.late?.length) entry.late = a.late;
      if (a.optional?.length) entry.optional = a.optional;
      if (isConverted(a.id)) entry.factory = MODULES[a.id].factory;
      /* Every non-infra asset carries where it lives and what it hashes to, even
         when it is inline today. That is what lets a save policy move an asset
         between inline and online with no network: the target state is already
         known. Infrastructure has no url on purpose — see inMode()'s sibling rule
         in check(): the loader and its failure UI cannot be fetched. */
      if (a.role !== "infra") {
        entry.url = `${base}/${a.id}.${ext}`;
        entry.integrity = a.sha384;
      }
      return entry;
    }),
  };
}

const manifestBlock = (doc) =>
  `<script id="${DOC_MANIFEST_ID}" type="application/json">${JSON.stringify(doc)}</script>`;

/**
 * The document's own behaviour — mode, content lock, toolbar, save threshold.
 * Separate from the asset manifest on purpose: the manifest answers "what does
 * this document need", settings answer "how does it behave". `mode` used to live
 * in the manifest and is read from there as a fallback for one release.
 */
function docSettings(manifest, { mode } = {}) {
  const authored = manifest.settings || {};
  const docMode = mode ?? authored.mode ?? DEFAULT_SETTINGS.mode;
  return {
    schema: 1,
    mode: docMode,
    editable: authored.editable ?? docMode === "edit",
    toolbar: authored.toolbar ?? docMode !== "view",
    saveThresholdBytes: authored.saveThresholdBytes ?? DEFAULT_SETTINGS.saveThresholdBytes,
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
    write(a.file, sourceTextFor(a));
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
    if (nbytes(disk) !== entry.bytes) problems.push(`${a.id}: ${a.file} is ${nbytes(disk)} bytes, manifest says ${entry.bytes}`);
    if (sha384(disk) !== entry.sha384) problems.push(`${a.id}: ${a.file} hash does not match manifest (re-run split)`);
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

async function cmdCheck() {
  const { problems, html } = verify({ quiet: true });
  const all = [...problems];

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
  if (exists(`${DIST}/editor.html`) && read(`${DIST}/editor.html`) !== html) {
    all.push(`${DIST}/editor.html is stale — run: node build.mjs build`);
  }
  try {
    if (exists(`${DIST}/slim.html`) && read(`${DIST}/slim.html`) !== buildSlim(html, readManifest())) {
      all.push(`${DIST}/slim.html is stale — run: node build.mjs build`);
    }
  } catch (err) {
    all.push(`manifest: ${err.message}`);
  }

  /* dependency-graph audit: order constraints, late-vs-plain, drift against the
     MODULES table, and freshness of the generated reference artifacts */
  const depWarnings = [];
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
      const ext = asset.kind === "css" ? "css" : "js";
      const published = `${DIST}/cdn/${asset.id}.${ext}`;
      if (!exists(published)) all.push(`${published} is missing — run: node build.mjs build`);
      else if (sha384(read(published)) !== asset.sha384) all.push(`${published} does not match the manifest hash — run: node build.mjs build`);
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
      if (!REGIONS.some((r) => r.id === a.id)) all.push(`${a.id} is missing from REGIONS (marker recovery would skip it)`);
    }
  } catch (err) {
    all.push(err.message);
  }

  /* schema sanity */
  try {
    const m = readManifest();
    if (m.schema !== 1) all.push(`manifest.json schema is ${m.schema}, expected 1`);
    for (const a of m.assets) {
      if (!["css", "js"].includes(a.kind)) all.push(`${a.id}: unknown kind "${a.kind}"`);
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
  process.exit(all.length ? 1 : 0);
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

function cmdBuild() {
  const { problems, html } = verify({ quiet: true });
  if (problems.length) {
    console.error(`build: refusing to build, verify failed (${problems.length})`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  write(`${DIST}/editor.html`, html);

  /* Byte copies of the sources: what integrity pins is exactly what we publish. */
  const manifest = readManifest();
  for (const asset of manifest.assets) {
    if (asset.role === "infra") continue;
    const ext = asset.kind === "css" ? "css" : "js";
    write(`${DIST}/cdn/${asset.id}.${ext}`, read(asset.file));
  }

  write(`${DIST}/slim.html`, buildSlim(html, manifest));

  const m = measure();
  const report = {
    schema: 1,
    /* no timestamp: dist/ is committed, so output must be deterministic */
    ...m,
  };
  write(`${DIST}/size-report.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(`build: dist/editor.html (${kb(m.flavors["index.html"])} KB, byte-identical to ${SOURCE})`);
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
      res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(fs.readFileSync(file));
    })
    .listen(port, "127.0.0.1", () => {
      console.log(`dev: http://127.0.0.1:${port}/  (serving ${rel(ROOT)})`);
      console.log("dev: index.html over http:// — use this for anything that fetches");
    });
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
    cmdBuild();
    break;
  case "report":
    cmdReport({ baseline: flags.includes("--baseline") });
    break;
  case "dev":
    cmdDev();
    break;
  case "help":
  default:
    console.log(read("build.mjs").split("\n").slice(1, 22).join("\n").replace(/^\/\*\*?| \*\/?/gm, "").trim());
    if (!["help", "--help", "-h"].includes(cmd)) process.exit(1);
}
