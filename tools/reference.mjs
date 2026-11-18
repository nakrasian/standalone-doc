#!/usr/bin/env node
/* tools/reference.mjs — derive this project's Word styles from the engine that will use them.
 *
 *   node tools/reference.mjs                     tools/reference.docx (Letter, 0.9 in)
 *   node tools/reference.mjs --page=a4 --margin=1in
 *   node tools/reference.mjs --pandoc=… --out=…
 *
 * Why derive rather than ship a hand-made file: a reference docx is only useful because the
 * writer copies *its* named styles. Those styles must be the ones the writer actually emits,
 * and pandoc's set changes between versions. So: ask pandoc for a document that exercises
 * every style (title, headings, body, block quote, code, table, captioned figure), then
 * replace the handful of style definitions that carry the document's look, and pin the
 * page geometry in its section properties. The result is a small binary whose provenance is
 * a reproducible command, not a story about who made it in Word.
 *
 * The output is reproducible (tools/reproducible.mjs), so re-running it is a no-op.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rewrite, normalise } from "./reproducible.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const pandoc = flag("pandoc", "pandoc");
const out = path.resolve(flag("out", path.join(HERE, "reference.docx")));
const page = flag("page", "letter");
const margin = flag("margin", "0.9in");

/* Twips: 1/1440 inch, which is what Word stores. */
const twips = (value) => {
  const hit = /^([\d.]+)(in|cm|mm|pt)?$/.exec(String(value).trim());
  if (!hit) throw new Error(`cannot read a length from "${value}"`);
  const n = Number(hit[1]);
  return Math.round(n * {"": 1440, in: 1440, cm: 566.929, mm: 56.6929, pt: 20}[hit[2] || ""]);
};
const PAGES = {letter: [12240, 15840], a4: [11906, 16838]};
if (!PAGES[page]) {
  console.error(`reference: unknown page "${page}" (letter | a4)`);
  process.exit(2);
}
const [width, height] = PAGES[page];
const pad = twips(margin);

/* The look, in Word's own vocabulary. Sizes are half-points (22 = 11 pt), spacing is
   twentieths of a point, and colors are hex without the hash. */
const LOOK = {
  Normal: {
    pPr: `<w:spacing w:after="0" w:line="384" w:lineRule="auto"/>`,
    rPr: `<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="1B1F24"/>`,
  },
  Title: {
    pPr: `<w:spacing w:before="0" w:after="160"/><w:keepNext/>`,
    rPr: `<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="52"/><w:szCs w:val="52"/><w:color w:val="14181D"/>`,
  },
  Heading1: {
    pPr: `<w:spacing w:before="360" w:after="120"/><w:keepNext/><w:outlineLvl w:val="0"/>`,
    rPr: `<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/><w:color w:val="14181D"/>`,
  },
  Heading2: {
    pPr: `<w:spacing w:before="280" w:after="80"/><w:keepNext/><w:outlineLvl w:val="1"/>`,
    rPr: `<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/><w:color w:val="2F3540"/>`,
  },
  Heading3: {
    pPr: `<w:spacing w:before="240" w:after="60"/><w:keepNext/><w:outlineLvl w:val="2"/>`,
    rPr: `<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="23"/><w:szCs w:val="23"/><w:color w:val="2F3540"/>`,
  },
  BlockText: {
    pPr: `<w:ind w:left="720" w:right="360"/><w:spacing w:before="120" w:after="180"/>`,
    rPr: `<w:i/><w:color w:val="555C66"/>`,
  },
  SourceCode: {
    pPr: `<w:spacing w:before="120" w:after="180"/><w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/>`,
    rPr: `<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/><w:szCs w:val="18"/>`,
  },
  ImageCaption: {
    pPr: `<w:jc w:val="center"/><w:spacing w:before="100" w:after="280"/>`,
    rPr: `<w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI"/><w:sz w:val="19"/><w:szCs w:val="19"/><w:color w:val="555C66"/>`,
  },
  CaptionedFigure: {
    pPr: `<w:jc w:val="center"/><w:keepNext/>`,
    rPr: ``,
  },
};

/* A document that makes the writer emit every style above, including a figure, because
   ImageCaption only exists in a document that had a caption. */
const EXERCISE = `<!doctype html><html><head><meta charset="utf-8">
<title>Reference</title></head><body><article>
<h1>A heading</h1>
<p>A paragraph of body text, long enough to be a paragraph. <b>Bold</b>, <em>italic</em>,
and <u>underlined</u> runs are here so their character styles exist too.</p>
<h2>A subheading</h2>
<ul><li>a list item</li><li>another</li></ul>
<blockquote><p>A quotation.</p></blockquote>
<pre>const code = true;</pre>
<table><thead><tr><th>Column</th><th>Other</th></tr></thead>
<tbody><tr><td>a</td><td>b</td></tr></tbody></table>
<h2>A figure</h2>
<figure class="figure" data-kind="image" data-figure-id="ref" data-w="0.7">
  <div class="figure-frame"><img src="ref.png" alt="A caption" width="70%"></div>
  <figcaption>A caption, which is what creates the caption styles.</figcaption>
</figure>
<h3>A third level</h3>
<p>Trailing text.</p>
</article></body></html>`;

/* One transparent pixel: the writer needs real bytes to emit a drawing. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "sd-reference-"));
try {
  fs.writeFileSync(path.join(work, "exercise.html"), EXERCISE);
  fs.writeFileSync(path.join(work, "ref.png"), PNG);
  const run = spawnSync(pandoc, [
    "-f", "html", "-t", "docx", "-o", path.join(work, "raw.docx"),
    "--lua-filter", path.join(HERE, "sd-export.lua"),
    "--resource-path", work,
    path.join(work, "exercise.html"),
  ], {encoding: "utf8"});
  if (run.status !== 0) {
    console.error(`reference: pandoc failed\n  ${(run.stderr || "").trim()}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(path.join(work, "raw.docx"));
  const styled = rewrite(raw, (name, bytes) => {
    const xml = bytes.toString("utf8");
    if (name === "word/document.xml") {
      /* The section properties are the page. A reference docx with none gives a document
         with no page size at all — which is what this project shipped until now. */
      const sectPr = `<w:sectPr><w:pgSz w:w="${width}" w:h="${height}"/>`
        + `<w:pgMar w:top="${pad}" w:right="${pad}" w:bottom="${pad}" w:left="${pad}" `
        + `w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
      if (!/<w:sectPr\b[\s\S]*?<\/w:sectPr>/.test(xml)) throw new Error("no section properties to replace");
      return Buffer.from(xml.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/, sectPr), "utf8");
    }
    if (name === "word/styles.xml") {
      let patched = xml;
      for (const [id, look] of Object.entries(LOOK)) {
        const block = new RegExp(`<w:style\\b[^>]*w:styleId="${id}"[\\s\\S]*?</w:style>`);
        if (!block.test(patched)) throw new Error(`styles.xml has no "${id}" — this pandoc emits a different set`);
        patched = patched.replace(block, (style) => {
          /* Replace only the properties that carry the look; keep name/basedOn/next so
             Word's own behaviour (outline level, style inheritance) is untouched. */
          let next = style
            .replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, "")
            .replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, "");
          const props = (look.pPr ? `<w:pPr>${look.pPr}</w:pPr>` : "")
            + (look.rPr ? `<w:rPr>${look.rPr}</w:rPr>` : "");
          return next.replace(/<\/w:style>$/, `${props}</w:style>`);
        });
      }
      return Buffer.from(patched, "utf8");
    }
    return null;
  });

  const final = normalise(styled);
  fs.writeFileSync(out, final);
  const pg = /<w:pgSz w:w="(\d+)" w:h="(\d+)"\/>/.exec(final.toString("utf8").length ? "" : "");
  console.log(`reference: ${path.relative(process.cwd(), out)} · ${(final.length / 1024).toFixed(1)} KB · `
    + `${Object.keys(LOOK).length} styles · ${page} ${width}×${height} twips · margin ${pad}`);
} finally {
  fs.rmSync(work, {recursive: true, force: true});
}
