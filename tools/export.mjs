#!/usr/bin/env node
/* tools/export.mjs — a document in, a document out.
 *
 *   npm run export -- doc.html                          the document's own settings, else docx
 *   npm run export -- doc.html --to=docx,typ,md,pdf     one materialize, four conversions
 *   npm run export -- doc.html --to=docx --engine=wasm  the same pandoc the browser runs
 *   npm run export -- doc.html --dry-run                stop before the engine
 *
 * Three stages, each answering a different question:
 *
 *   1. materialize — the document's *own* export module captures its figures and writes
 *      `buildStatic(media: "files")`: scripts gone, chrome gone, `fig-01.png` beside it.
 *      Nothing here reimplements that: a second idea of "a figure" would disagree with the
 *      HTML export about figure 4.
 *   2. convert — one engine (native pandoc, or the wasm build the plugin uses), one filter.
 *   3. audit — the materialized DOM is counted, pandoc's AST is counted, and the two are
 *      compared per target. A difference is a failed export, not a warning.
 *
 * PDF is two stages and says so: `.typ` is written always, and a typesetter turns it into
 * paper if one is installed. See tools/pdf.mjs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { compare, fromAst, report } from "./census.mjs";
import { normalise } from "./reproducible.mjs";
import { nativeVersion, openEngine } from "./engine.mjs";
import { compilePdf, typstVersion } from "./pdf.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILTER = path.join(HERE, "sd-export.lua");
const REFERENCE = path.join(HERE, "reference.docx");
const TEMPLATE = path.join(HERE, "sd-template.typ");

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

  --to=<list>        docx, typ, md, latex, rst, html, txt, pdf   (default: docx)
                     pdf = .typ + a typesetter (typst on PATH)
  --out=<dir>        where the results go (default: .)
  --engine=          native | wasm   (default: native when pandoc is on PATH, else wasm)
  --pandoc=<path>    the native engine (default: pandoc on PATH)
  --on-missing=      fail | placeholder   (default: fail)
  --audit=           fail | warn          (default: fail)
  --keep=<dir>       keep the materialized HTML and its figures
  --dry-run          materialize and audit, do not convert
  --no-reproducible  leave a zip's timestamps alone (default: pinned to 1980-01-01)
  --quiet            only print failures
  --help`);
  process.exit(code);
}

const FORMATS = {
  docx: {format: "docx", ext: "docx", zip: true},
  typ: {format: "typst", ext: "typ", text: true},
  /* markdown-smart: plain `markdown` rewrites every em dash in the prose as `---`. */
  md: {format: "markdown-smart", ext: "md", text: true},
  latex: {format: "latex", ext: "tex", text: true},
  rst: {format: "rst", ext: "rst", text: true},
  html: {format: "html", ext: "html", text: true},
  txt: {format: "plain", ext: "txt", text: true},
  /* PDF is not a writer: it is typst, then a typesetter. */
  pdf: {format: "typst", ext: "pdf", via: "typst"},
};

const wanted = String(flags.to || "docx").split(",").map((s) => s.trim()).filter(Boolean);
for (const target of wanted) {
  if (!FORMATS[target]) fail(`unknown target "${target}" (one of: ${Object.keys(FORMATS).join(", ")})`);
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
fs.mkdirSync(outDir, {recursive: true});

/* ------------------------------------------------------------------ engine -- */
const pandocBin = String(flags.pandoc || "pandoc");
const engineMode = String(flags.engine || (nativeVersion(pandocBin) ? "native" : "wasm"));
if (!["native", "wasm"].includes(engineMode)) fail(`--engine must be native or wasm, not "${engineMode}"`);
if (engineMode === "native" && !nativeVersion(pandocBin)) {
  fail(`no pandoc on PATH. Install pandoc 3, or use --engine=wasm (a devDependency).`);
}

/* ------------------------------------------------------------- materialize -- */
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
    fail(`the document's assets failed to load:\n  ${failures.map((e) => e.message || e).join("\n  ")}\n`
      + `  A saved file with online assets needs a base it can reach: pass a served URL, e.g.\n`
      + `  npm run dev & then node tools/export.mjs http://127.0.0.1:8080/…`);
  }
  if (!(await page.evaluate(() => Boolean(globalThis.StandaloneDoc.modules.export)))) {
    fail(`this document has no export module — it is a viewer, or its "export" asset is online and\n`
      + `  unreachable. An export needs an editable document.`);
  }

  const materialized = await page.evaluate(async () => {
    const settings = JSON.parse(document.getElementById("export-settings")?.textContent || "null");
    const recipe = settings?.recipe || {};
    const out = await globalThis.StandaloneDoc.modules.export.materialize({
      format: recipe.figureFormat || "png",
      media: "files",
    });
    return out && {html: out.html, files: out.files, problems: out.problems, recipe};
  });
  if (!materialized) fail("materialization was cancelled");

  await page.addScriptTag({path: path.join(HERE, "census.dom.js")});
  const dom = await page.evaluate((html) =>
    globalThis.sdCensusDom(new DOMParser().parseFromString(html, "text/html")), materialized.html);

  staged = fs.mkdtempSync(path.join(os.tmpdir(), "sd-export-"));
  fs.writeFileSync(path.join(staged, `${slug}.html`), materialized.html);
  for (const file of materialized.files) {
    const base64 = file.dataUrl.slice(file.dataUrl.indexOf(",") + 1);
    fs.writeFileSync(path.join(staged, file.name), Buffer.from(base64, "base64"));
  }

  /* A `<script` with no `</script>` is not a style bug, it is a parse bug: pandoc treats
     everything after an unclosed script as script text, so the document converts to two
     paragraphs of whatever came next. It happened — a CSS *comment* inside a `<style>` block
     that mentioned the tag by name. Cheap to detect, otherwise very confusing. */
  const opens = (materialized.html.match(/<script\b/gi) || []).length;
  const closes = (materialized.html.match(/<\/script\s*>/gi) || []).length;
  if (opens !== closes) {
    fail(`the materialized document has ${opens} "<script" and ${closes} "</script>".\n`
      + `  An engine will read everything after the unclosed one as script text. Look for a\n`
      + `  <style> block whose content mentions the tag — a CSS comment did, once.`);
  }

  const missing = materialized.problems.filter((problem) => /no captured source/.test(problem));
  if (missing.length && onMissing === "fail") {
    fail(`not exported — ${missing.join("; ")}.\n`
      + `  A figure with no source is a card, not a figure. Fix the figure, or --on-missing=placeholder.`);
  }

  /* Text targets reference their figures by name, so the bytes travel beside them: a .typ
     with `image("fig-01.png")` and no fig-01.png is not a document. A docx embeds them. */
  if (wanted.some((target) => FORMATS[target].text) && !flags["dry-run"]) {
    for (const file of materialized.files) {
      const base64 = file.dataUrl.slice(file.dataUrl.indexOf(",") + 1);
      const destination = path.join(outDir, file.name);
      const bytes = Buffer.from(base64, "base64");
      if (fs.existsSync(destination) && fs.readFileSync(destination).equals(bytes)) continue;
      fs.writeFileSync(destination, bytes);
    }
  }

  /* --------------------------------------------------------------- convert -- */
  const engine = await openEngine({
    mode: engineMode, binary: pandocBin, staged, slug, filter: FILTER,
    referenceDoc: REFERENCE, template: TEMPLATE,
  });

  const usesReference = fs.existsSync(REFERENCE);
  const usesTemplate = fs.existsSync(TEMPLATE);
  const headings = Number(flags["shift-heading-level-by"] ?? materialized.recipe.headingShift ?? 0);
  const results = [];
  /* A PDF is `.typ` plus a typesetter, so the .typ is produced even when only `pdf` was
     asked for — it is the artefact the PDF came from, and the fallback when no typesetter
     is installed. */
  const plan = [...new Set([...(wanted.includes("pdf") ? ["typ"] : []), ...wanted])];
  const synthesised = new Set(plan.filter((target) => !wanted.includes(target)));

  for (const target of plan) {
    const spec = FORMATS[target];
    const output = path.join(outDir, `${slug}.${spec.ext}`);
    if (flags["dry-run"]) {
      results.push({target, output: null, bytes: 0});
      continue;
    }
    /* A PDF does not go through pandoc at all: `.typ` was written by the plan above, and a
       typesetter turns it into paper. Passing `-o out.pdf` to pandoc would make it try to
       become a PDF writer, which it is not. */
    if (spec.via === "typst") {
      const typ = path.join(outDir, `${slug}.typ`);
      if (!fs.existsSync(typ)) fail(`pdf: expected ${typ} — the plan writes .typ before it`);
      const pdf = compilePdf({typ, out: output, figures: materialized.files.length});
      results.push({target, output, bytes: pdf.ok ? pdf.bytes : 0, notes: [], pdf});
      continue;
    }
    /* The look is attached per writer: a reference docx for Word, a template for Typst. */
    const extra = ["--shift-heading-level-by", String(headings)];
    if (spec.format === "docx" && usesReference) extra.push("--reference-doc", REFERENCE);
    if (spec.format === "typst" && usesTemplate) extra.push("--template", TEMPLATE);
    const pandocOptions = {
      "shift-heading-level-by": headings,
      ...(spec.format === "docx" && usesReference ? {"reference-doc": "reference.docx"} : {}),
      ...(spec.format === "typst" && usesTemplate ? {template: "sd-template.typ"} : {}),
    };
    if (materialized.recipe.numberSections) {
      extra.push("--number-sections");
      pandocOptions["number-sections"] = true;
    }

    const run = await engine.convert({format: spec.format, output, extra, options: pandocOptions});
    if (!run.ok) fail(`${target}: ${engine.name} failed\n  ${run.stderr.trim().split("\n").slice(0, 4).join("\n  ")}`);
    if (run.bytes) fs.writeFileSync(output, run.bytes);

    const notes = run.stderr.split("\n").filter((line) => /sd-export/.test(line));
    let reproducible = false;
    if (spec.zip && !flags["no-reproducible"]) {
      const raw = fs.readFileSync(output);
      const fixed = normalise(raw);
      if (!fixed.equals(raw)) fs.writeFileSync(output, fixed);
      reproducible = true;
    }

    results.push({target, output, bytes: fs.statSync(output).size, notes, reproducible});
  }

  /* ----------------------------------------------------------------- audit -- */
  /* One AST per target: the filter decides page breaks and figure shape *by target*, and
     `-M sd-target=<family>` is what lets a JSON read see that decision. */
  const losses = [];
  const audited = [];
  for (const target of plan) {
    if (synthesised.has(target)) continue; /* the .typ is audited as `typ` when asked for */
    const spec = FORMATS[target];
    const family = spec.format.split(/[+-]/)[0];
    const auditOutput = path.join(staged, `audit.${family}.json`);
    const run = await engine.convert({
      format: "json",
      output: auditOutput,
      extra: ["-M", `sd-target=${family}`],
      /* The key travels as metadata: pandoc's defaults parser refuses an unknown top-level
         option, which is how `sd-target` announced itself the first time. */
      options: {metadata: {"sd-target": family}},
    });
    if (!run.ok) fail(`audit: no AST for ${target}\n  ${run.stderr.trim().split("\n").slice(0, 4).join("\n  ")}`);
    const ast = JSON.parse(run.bytes.toString("utf8"));
    const verdict = report(compare(dom, fromAst(ast)));
    audited.push({target, verdict});
    losses.push(...verdict.problems.map((problem) => `${target}: ${problem}`));
  }

  if (!flags.quiet) {
    console.log(`\n${path.relative(process.cwd(), source)} → ${path.relative(process.cwd(), outDir) || "."}/`);
    console.log(`${engine.name} ${engine.version} · filter sd-export.lua · ${materialized.files.length} figure file(s)`);
    console.log(`look: ${usesReference ? "reference.docx" : "pandoc default docx"}`
      + ` · ${usesTemplate ? "sd-template.typ" : "pandoc default typst"}`
      + (typstVersion() ? ` · ${typstVersion()}` : ""));
    for (const result of results) {
      if (!result.output) { console.log(`  ${result.target.padEnd(6)} (dry run)`); continue; }
      if (result.pdf && !result.pdf.ok) {
        console.log(`  ${result.target.padEnd(6)} not written — ${result.pdf.note.split("\n")[0]}`);
        continue;
      }
      if (synthesised.has(result.target) && !wanted.includes(result.target)) continue;
      console.log(`  ${result.target.padEnd(6)} ${(result.bytes / 1024).toFixed(1)} KB  ${path.basename(result.output)}`
        + (result.reproducible ? "  (timestamps pinned)" : "")
        + (result.pdf ? `  (${result.pdf.note})` : ""));
      for (const note of result.notes) console.log(`         ${note}`);
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

  const failedPdf = results.find((result) => result.pdf && !result.pdf.ok);
  if (failedPdf && !flags.quiet) console.error(`\nexport: ${failedPdf.pdf.note}`);
  if (failedPdf) process.exitCode = 1;

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
