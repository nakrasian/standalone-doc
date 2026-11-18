#!/usr/bin/env node
/* tools/pdf.mjs — the second stage of a PDF, and nothing more.
 *
 * Pandoc has no PDF writer: it writes a format, and a typesetter turns that into paper. For
 * this project the format is `.typ` — the one target that is both a first-class writer and a
 * readable artefact — so the pipeline is `pandoc → .typ` then `typst → .pdf`, and the `.typ`
 * is written whether or not the typesetter is available.
 *
 * Deliberately no dependency: `typst` is a tool on PATH, like pandoc. The lab has a
 * `typst-pdf.mjs` that drives a Node binding of the same compiler, and it is not promoted here
 * for one measured reason: that build cannot decode images (`read()` returns bytes,
 * `image()` fails), so a document with figures needs the real binary or the browser.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

export function typstVersion(binary = "typst") {
  const run = spawnSync(binary, ["--version"], {encoding: "utf8"});
  if (run.error || run.status !== 0) return null;
  return (run.stdout || "").trim().split("\n")[0] || "typst";
}

/**
 * @param {{typ: string, out: string, binary?: string, figures: number}} request
 * @returns {{ok: boolean, bytes: number, note: string}}
 */
export function compilePdf({typ, out, binary = "typst", figures = 0}) {
  const version = typstVersion(binary);
  if (!version) {
    return {
      ok: false,
      bytes: 0,
      note: `no "${binary}" on PATH. The .typ is written: ${typ}\n`
        + `  Compile it with \`typst compile ${typ} ${out}\`, install typst (brew install typst),\n`
        + `  or use the browser's PDF (Save as… ▸ PDF ▸ Captured figures).`,
    };
  }
  const run = spawnSync(binary, ["compile", "--root", "/", typ, out], {encoding: "utf8"});
  if (run.status !== 0) {
    return {ok: false, bytes: 0, note: `${version} failed: ${(run.stderr || "").trim().split("\n").slice(0, 3).join(" ")}`};
  }
  return {
    ok: true,
    bytes: fs.statSync(out).size,
    note: `${version}${figures ? ` · ${figures} figure(s)` : ""}`,
  };
}
