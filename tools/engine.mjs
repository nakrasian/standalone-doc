#!/usr/bin/env node
/* tools/engine.mjs — one recipe, two engines.
 *
 *   native: `pandoc` on PATH — fast, every writer, PDF through an external typst
 *   wasm:   pandoc-wasm (a devDependency) — the same binary the browser plugin runs, so a
 *           document exported here and there cannot disagree about the document
 *
 * Both are handed the same staged directory (the materialized HTML plus its `fig-01.png`
 * files) and the same recipe; each reads it the way it can. A native pandoc opens the files;
 * the wasm build has no filesystem, so the bytes go in a map. That difference is the whole
 * adapter, and keeping it here is what stops the recipe from forking.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Native pandoc's version, or null when it is not runnable. */
export function nativeVersion(binary = "pandoc") {
  const check = spawnSync(binary, ["--version"], {encoding: "utf8"});
  if (check.error || check.status !== 0) return null;
  const hit = /^pandoc(?:\.exe)?\s+(\d+)\.(\d+)(?:\.(\d+))?/m.exec(check.stdout || "");
  return hit ? {text: [hit[1], hit[2], hit[3]].filter(Boolean).join("."), major: Number(hit[1])} : null;
}

/**
 * @param {object} options
 * @param {"native"|"wasm"} options.mode
 * @param {string} [options.binary]          native pandoc
 * @param {string} options.staged            directory holding `<slug>.html` and its figures
 * @param {string} options.slug
 * @param {string} options.filter            path to sd-export.lua
 * @param {string} [options.referenceDoc]    path to reference.docx
 * @param {string} [options.template]        path to sd-template.typ
 */
export async function openEngine(options) {
  const {mode, staged, slug, filter} = options;

  if (mode === "native") {
    const binary = options.binary || "pandoc";
    const version = nativeVersion(binary);
    if (!version) {
      throw new Error(`cannot run "${binary}" — install pandoc 3, or use --engine=wasm`);
    }
    if (version.major < 3) {
      throw new Error(`pandoc ${version.text} is too old: the filter builds a Figure node (pandoc 3+)`);
    }
    return {
      name: "pandoc on PATH",
      version: version.text,
      needsBytes: false,
      /** @returns {{ok: boolean, stderr: string, bytes: Buffer|null}} */
      convert({format, output, extra = []}) {
        const args = [
          "-f", "html", "--lua-filter", filter,
          "--resource-path", staged,
          ...extra,
          "-t", format, "-o", output,
          path.join(staged, `${slug}.html`),
        ];
        const run = spawnSync(binary, args, {encoding: "utf8"});
        return {
          ok: run.status === 0,
          stderr: run.stderr || "",
          bytes: run.status === 0 ? fs.readFileSync(output) : null,
        };
      },
    };
  }

  /* --- wasm: the engine has no filesystem, so every input is a byte array in a map --- */
  const {convert, query} = await import("pandoc-wasm");
  const version = await query({query: "version"});
  const media = {};
  for (const name of fs.readdirSync(staged)) {
    if (name === `${slug}.html`) continue;
    /* A Blob, not a Buffer: pandoc-wasm's writer calls `data.arrayBuffer()` on anything that
       is not a string, and a Node Buffer has no such method. */
    media[name] = new Blob([fs.readFileSync(path.join(staged, name))]);
  }
  const html = fs.readFileSync(path.join(staged, `${slug}.html`), "utf8");
  const shared = {"sd-export.lua": fs.readFileSync(filter, "utf8"), ...media};
  if (options.referenceDoc && fs.existsSync(options.referenceDoc)) {
    shared["reference.docx"] = new Blob([fs.readFileSync(options.referenceDoc)]);
  }
  if (options.template && fs.existsSync(options.template)) {
    shared["sd-template.typ"] = fs.readFileSync(options.template, "utf8");
  }

  return {
    name: "pandoc.wasm (devDependency)",
    version,
    needsBytes: true,
    async convert({format, output, extra = [], options: pandocOptions = {}}) {
      const ext = path.extname(output).slice(1) || "out";
      const outputFile = `out.${ext}`;
      /* pandoc-wasm reports the filter's stderr by console.warn-ing every line; the caller
         reads `stderr` from the result, so the duplicate is noise. */
      const warn = console.warn;
      console.warn = () => {};
      let result;
      try {
        result = await convert(
          {from: "html", to: format, standalone: true, filters: ["sd-export.lua"], ...pandocOptions, "output-file": outputFile},
          html,
          shared,
        );
      } finally {
        console.warn = warn;
      }
      const blob = result.files[outputFile];
      const bytes = blob ? Buffer.from(new Uint8Array(await blob.arrayBuffer())) : null;
      const stderr = result.stderr || "";
      return {ok: Boolean(bytes) && !/^ERROR/m.test(stderr), stderr, bytes};
    },
  };
}
