#!/usr/bin/env node
/* tools/export.mjs — a document in, a document out.
 *
 *   node tools/export.mjs doc.html                       what the file's own settings say
 *   node tools/export.mjs doc.html --to=docx,typ,md       one materialize, three conversions
 *   node tools/export.mjs doc.html --to=docx --out=build/
 *   node tools/export.mjs doc.html --to=docx --keep=tmp   keep the materialized HTML
 *   node tools/export.mjs doc.html --dry-run              stop before pandoc
 *
 * The pipeline, and why it has three stages:
 *
 *   1. materialize — the document's *own* export module captures its figures and writes
 *      `buildStatic(media: "files")`: scripts gone, chrome gone, `fig-01.png` beside it.
 *      Nothing here reimplements that, because a second idea of "a figure" would disagree
 *      with the HTML export about figure 4.
 *   2. convert — pandoc, with one Lua filter that knows this editor's vocabulary.
 *   3. audit — the materialized DOM is counted, then pandoc's AST is counted, and the two
 *      are compared. A difference is a failed export, not a warning. This is the stage
 *      that turns "it produced a file" into "it produced the document".
 *
 * No dependency is added to this repository: the browser is the one the test suite already
 * installs, and pandoc is a tool on PATH (or --pandoc=…). A wasm pandoc works too — that
 * is what lab/011 uses — but it is the browser's engine, not this one's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { compare, fromAst, report } from "./census.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FILTER = path.join(HERE, "sd-export.lua");

/* ---------------------------------------------------------------- arguments -- */
const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  const hit = /^--([^=]+)(?:=(.*))?$/.exec(arg);
  if (hit) flags[hit[1]] = hit[2] ?? true;
}
const input = args.find((arg) => !arg.startsWith("--"));
if (!input || flags.help) usage(flags.help ? 0 : 2);

function usage(code) {
  console.error(`usage: node tools/export.mjs <document.html> [options]

  --to=<list>        comma-separated targets: docx, typ, md, latex, rst, html, txt
                     (default: the document's #export-settings, else docx)
  --out=<dir>        where the results go (default: .)
  --pandoc=<path>    the engine (default: pandoc on PATH)
  --on-missing=      fail | placeholder   (default: fail)
  --audit=           fail | warn          (default: fail)
  --keep=<dir>       keep the materialized HTML and its figures
  --dry-run          materialize and audit, do not convert
  --quiet            only print failures
  --help`);
  process.exit(code);
}

const TARGETS = {
  docx: {format: "docx", ext: "docx"},
  typ: {format: "typst", ext: "typ"},
  /* markdown-smart: plain `markdown` rewrites every em dash in the prose as `---`. */
  md: {format: "markdown-smart", ext: "md"},
  latex: {format: "latex", ext: "tex"},
  rst: {format: "rst", ext: "rst"},
  html: {format: "html", ext: "html"},
  txt: {format: "plain", ext: "txt"},
};

const wanted = String(flags.to || "docx").split(",").map((s) => s.trim()).filter(Boolean);
for (const target of wanted) {
  if (!TARGETS[target]) fail(`unknown target "${target}" (one of: ${Object.keys(TARGETS).join(", ")})`);
}
const onMissing = String(flags.onMissing ?? flags["on-missing"] ?? "fail");
const auditMode = String(flags.audit || "fail");
const outDir = path.resolve(String(flags.out || "."));
const slug = path.basename(input).replace(/\.html?$/i, "").replace(/[^\w.-]+/g, "-").slice(0, 80) || "document";

function fail(message, code = 1) {
  console.error(`export: ${message}`);
  process.exit(code);
}

if (!fs.existsSync(input)) fail(`no such file: ${input}`);
fs.mkdirSync(outDir, { recursive: true });

/* ------------------------------------------------------------------ engine -- */
/* Pandoc 3 is the floor: this filter builds a `Figure` node, which 2.x does not have. */
function engineVersion(bin) {
  const check = spawnSync(bin, ["--version"], {encoding: "utf8"});
  if (check.error || check.status !== 0) return null;
  const version = /^pandoc(?:\.exe)?\s+(\d+)\.(\d+)(?:\.(\d+))?/m.exec(check.stdout || "");
  return version ? {text: `${version[1]}.${version[2]}${version[3] ? "." + version[3] : ""}`, major: Number(version[1])} : null;
}

const pandocBin = String(flags.pandoc || "pandoc");
const engine = engineVersion(pandocBin);
if (!engine) {
  fail(`cannot run "${pandocBin}".
  Install pandoc 3 (brew install pandoc, or https://pandoc.org/installing.html), or
  point at one with --pandoc=/path/to/pandoc.`);
}
if (engine.major < 3) fail(`pandoc ${engine.text} is too old; this filter needs a Figure node (pandoc 3+)`);

/* ------------------------------------------------------------- materialize -- */
/* The document boots its own runtime, so the file must be an editable document whose
 * assets resolve. Inline (a saved editor file) works from disk; anything that fetches
 * needs a served URL — the same rule as `npm run dev`. */
const source = path.resolve(input);
const url = /^https?:/.test(input) ? input : pathToFileURL(source).href;

const browser = await chromium.launch();
let staged = null;
try {
  const page = await browser.newPage();
  const blocked = [];
  page.on("pageerror", (error) => blocked.push(error.message));

  await page.goto(url);
  const booted = await page
    .waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, {timeout: 20_000})
    .then(() => true, () => false);
  if (!booted) fail(`the document did not boot:\n  ${blocked.join("\n  ") || "no reason reported"}`);

  const failures = await page.evaluate(() => globalThis.StandaloneDoc.errors || []);
  if (failures.length) {
    fail(`the document's assets failed to load:\n  ${failures.map((e) => e.message || e).join("\n  ")}\n` +
      `  A saved file with online assets needs a base it can reach: pass a served URL, e.g.\n` +
      `  npm run dev & then node tools/export.mjs http://127.0.0.1:8080/…`);
  }

  const hasExport = await page.evaluate(() => Boolean(globalThis.StandaloneDoc.modules.export));
  if (!hasExport) {
    fail(`this document has no export module — it is a viewer, or its "export" asset is online and\n` +
      `  unreachable. An export needs an editable document.`);
  }

  const materialized = await page.evaluate(async () => {
    const settings = JSON.parse(document.getElementById("export-settings")?.textContent || "null");
    const recipe = settings?.recipe || {};
    const out = await globalThis.StandaloneDoc.modules.export.materialize({
      format: recipe.figureFormat || "png",
      media: "files",
    });
    return out && {
      html: out.html,
      files: out.files,
      problems: out.problems,
      recipe,
      title: (document.querySelector("[data-title]")?.value || document.title || "document").trim(),
    };
  });
  if (!materialized) fail("materialization was cancelled");

  /* The census reads the materialized document, in the same browser that produced it. */
  await page.addScriptTag({path: path.join(HERE, "census.dom.js")});
  const dom = await page.evaluate((html) =>
    globalThis.sdCensusDom(new DOMParser().parseFromString(html, "text/html")), materialized.html);

  /* ---------------------------------------------------------- the staging -- */
  staged = fs.mkdtempSync(path.join(os.tmpdir(), "sd-export-"));
  fs.writeFileSync(path.join(staged, `${slug}.html`), materialized.html);
  for (const file of materialized.files) {
    const base64 = file.dataUrl.slice(file.dataUrl.indexOf(",") + 1);
    fs.writeFileSync(path.join(staged, file.name), Buffer.from(base64, "base64"));
  }

  const missing = materialized.problems.filter((problem) => /no captured source/.test(problem));
  if (missing.length && onMissing === "fail") {
    fail(`not exported — ${missing.join("; ")}.\n` +
      `  A figure with no source is a card, not a figure. Fix the figure, or --on-missing=placeholder.`);
  }

  /* --------------------------------------------------------------- convert -- */
  const imports = flags["shift-heading-level-by"] ?? materialized.recipe.headingShift ?? 0;
  const common = [
    "-f", "html",
    "--lua-filter", FILTER,
    "--resource-path", staged,
    "--shift-heading-level-by", String(imports),
  ];
  if (flags.quiet) common.push("--quiet");

  const results = [];
  for (const target of wanted) {
    const {format, ext} = TARGETS[target];
    const output = path.join(outDir, `${slug}.${ext}`);
    if (flags["dry-run"]) {
      results.push({target, output: null, bytes: 0});
      continue;
    }
    const run = spawnSync(pandocBin, [...common, "-t", format, "-o", output, path.join(staged, `${slug}.html`)],
      {encoding: "utf8"});
    if (run.status !== 0) fail(`${target}: pandoc failed\n  ${(run.stderr || "").trim()}`);
    const notes = (run.stderr || "").split("\n").filter((line) => /sd-export/.test(line));
    results.push({target, output, bytes: fs.statSync(output).size, notes});
  }

  /* ----------------------------------------------------------------- audit -- */
  /* One AST per target, because the filter decides page breaks and figure shape *by
   * target*. `-M sd-target=<family>` is what makes that honest: a plain `-t json` would
   * take the html branch of every such decision, and the audit would be protecting a
   * document nobody asked for. */
  const losses = [];
  const audited = [];
  for (const target of wanted) {
    const family = TARGETS[target].format.split(/[+-]/)[0];
    const json = spawnSync(pandocBin, [...common, "-M", `sd-target=${family}`,
      "-t", "json", path.join(staged, `${slug}.html`)], {encoding: "utf8", maxBuffer: 64 * 1024 * 1024});
    if (json.status !== 0) fail(`audit: pandoc could not produce an AST for ${target}\n  ${(json.stderr || "").trim()}`);
    const verdict = report(compare(dom, fromAst(JSON.parse(json.stdout))));
    audited.push({target, verdict});
    losses.push(...verdict.problems.map((problem) => `${target}: ${problem}`));
  }

  if (!flags.quiet) {
    console.log(`\n${path.relative(process.cwd(), source)} → ${path.relative(process.cwd(), outDir)}/`);
    console.log(`pandoc ${engine.text} · filter sd-export.lua · ${materialized.files.length} figure file(s)`);
    for (const result of results) {
      if (!result.output) console.log(`  ${result.target.padEnd(6)} (dry run)`);
      else console.log(`  ${result.target.padEnd(6)} ${(result.bytes / 1024).toFixed(1)} KB  ${path.basename(result.output)}`);
      for (const note of result.notes || []) console.log(`         ${note}`);
    }
    for (const {target, verdict} of audited) {
      console.log(`\naudit ${target} (materialized DOM → AST)`);
      for (const line of verdict.lines) console.log(line);
    }
  }

  if (flags.keep) {
    const keep = path.resolve(String(flags.keep));
    fs.mkdirSync(keep, {recursive: true});
    for (const name of fs.readdirSync(staged)) fs.copyFileSync(path.join(staged, name), path.join(keep, name));
    if (!flags.quiet) console.log(`\nkept: ${path.relative(process.cwd(), keep)}/`);
  }

  if (losses.length) {
    console.error(`\nexport: ${losses.length} loss(es) — ${losses.join("; ")}`);
    if (auditMode !== "warn") process.exitCode = 1;
  } else if (!flags.quiet) {
    console.log("\nno losses");
  }
} finally {
  await browser.close();
  if (staged && !flags.keep) fs.rmSync(staged, {recursive: true, force: true});
}
