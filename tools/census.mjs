/* audit.mjs — what the AST *actually* contains, and how the two readings compare.
 *
 * The contract, in three classes:
 *
 *   match     the count must be equal. A difference is a loss, and a loss is a
 *             failed export — not a warning.
 *   may-drop  a difference is allowed, but must be explained in one line. This is
 *             where a format's honest limits live (markdown has no page).
 *   fuzzy     compare with a tolerance, for prose length: a few characters either
 *             way is normal, 20 % is a dropped section.
 */

export const CENSUS = [
  { key: "headings", label: "headings h1–h4", rule: "match" },
  { key: "listItems", label: "list items", rule: "match" },
  { key: "tables", label: "tables", rule: "match" },
  { key: "tableRows", label: "table rows", rule: "match" },
  { key: "figures", label: "figures", rule: "match" },
  { key: "images", label: "images", rule: "match" },
  { key: "underline", label: "underline runs", rule: "match" },
  { key: "codeBlocks", label: "code blocks", rule: "match" },
  { key: "quotes", label: "block quotes", rule: "match" },
  { key: "links", label: "links", rule: "may-drop", why: 'a "#" placeholder is unwrapped, not linked' },
  { key: "pageBreaks", label: "page breaks", rule: "may-drop", why: "a text target has no page" },
  { key: "emptyParagraphs", label: "empty paragraphs", rule: "may-drop", why: "a caret paragraph is not content" },
  { key: "words", label: "words", rule: "fuzzy", tolerance: 0.03 },
];

/** Count from a pandoc JSON AST. */
export function fromAst(ast) {
  const n = {
    headings: 0, listItems: 0, tables: 0, tableRows: 0, figures: 0, images: 0,
    underline: 0, codeBlocks: 0, quotes: 0, links: 0, pageBreaks: 0,
    emptyParagraphs: 0, words: 0,
  };
  /* One text accumulator for the whole document. Image alt text is deliberately not
     counted: it is not body text, and the DOM's textContent does not contain it either
     (otherwise every figure would look like a 10-character gain). */
  const parts = [];
  const blocks = (list) => (list || []).forEach(block);
  function block(b) {
    if (!b || typeof b !== "object") return;
    switch (b.t) {
      case "Header": n.headings += 1; inlines(b.c[2]); break;
      case "Para":
        if (!textOf(b.c).trim()) n.emptyParagraphs += 1;
        inlines(b.c);
        break;
      case "Plain": inlines(b.c); break;
      case "BulletList": n.listItems += b.c.length; b.c.forEach(blocks); break;
      case "OrderedList": n.listItems += b.c[1].length; b.c[1].forEach(blocks); break;
      case "Table": {
        n.tables += 1;
        const head = Array.isArray(b.c[3]) ? b.c[3][1] : b.c[3]?.c?.[1];
        n.tableRows += (head || []).length;
        for (const body of b.c[4] || []) {
          const rows = Array.isArray(body) ? body[3] : body.c?.[2];
          n.tableRows += (rows || []).length;
          (rows || []).forEach((row) => cells(row));
        }
        (head || []).forEach((row) => cells(row));
        inlines(b.c[1]);
        break;
      }
      case "Figure":
        n.figures += 1;
        blocks(b.c[2]);
        inlines(b.c[1]);
        break;
      case "Div":
        /* A page break is the one Div that is *meant* to survive as a marker. */
        if (Array.isArray(b.c[0]) && (b.c[0][1] || []).includes("page-spacer")) n.pageBreaks += 1;
        blocks(b.c[1]);
        break;
      case "CodeBlock": n.codeBlocks += 1; parts.push(b.c[1] || ""); break;
      case "BlockQuote": n.quotes += 1; blocks(b.c); break;
      case "RawBlock": if (/pagebreak|newpage|w:br/.test(b.c[1] || "")) n.pageBreaks += 1; break;
      default: blocks([b]);
    }
  }
  function cells(row) {
    const cs = Array.isArray(row) ? row[1] || row.c?.[1] : row.c;
    (cs || []).forEach((cell) => blocks(Array.isArray(cell) ? cell[4] : cell.c?.[4]));
  }
  function inlines(x) {
    if (x == null) return;
    if (Array.isArray(x)) return x.forEach(inlines);
    if (typeof x !== "object") return;
    if (x.t === "Underline") n.underline += 1;
    if (x.t === "Link") n.links += 1;
    if (x.t === "Image") n.images += 1;
    if (x.t === "Str") { parts.push(x.c); return; }
    if (x.t === "Space" || x.t === "SoftBreak" || x.t === "LineBreak") { parts.push(" "); return; }
    if (x.t === "Code") { parts.push(x.c[1]); return; }
    if (x.t === "Image") return;
    inlines(x.c);
  }
  blocks(ast.blocks);
  const words = parts.join(" ").replace(/\s+/g, " ").trim();
  n.words = words ? words.split(" ").length : 0;
  return n;
}

export function textOf(x) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  if (Array.isArray(x)) return x.map(textOf).join("");
  if (typeof x !== "object") return "";
  if (x.t === "Str") return x.c;
  if (x.t === "Space" || x.t === "SoftBreak" || x.t === "LineBreak") return " ";
  if (x.t === "Code") return x.c[1];
  if (x.t === "Image" || x.t === "Link") return textOf(x.c[1]);
  return textOf(x.c);
}

/** Compare the two readings. Returns rows and the problems that must fail a build. */
export function compare(dom, ast) {
  const rows = [];
  const problems = [];
  for (const spec of CENSUS) {
    const before = dom[spec.key] ?? 0;
    const after = ast[spec.key] ?? 0;
    const row = { ...spec, before, after, state: "ok", note: "" };
    if (spec.rule === "fuzzy") {
      const delta = before ? (after - before) / before : 0;
      if (Math.abs(delta) > (spec.tolerance ?? 0.02)) {
        row.state = "loss";
        row.note = `${(delta * 100).toFixed(1)} %`;
        problems.push(`${spec.label} ${before} → ${after}`);
      } else if (delta !== 0) {
        row.note = `${(delta * 100).toFixed(1)} %`;
      }
    } else if (before !== after) {
      if (spec.rule === "may-drop" && after < before) {
        row.state = "drop";
        row.note = spec.why || "";
      } else {
        row.state = "loss";
        problems.push(`${spec.label} ${before} → ${after}`);
      }
    }
    rows.push(row);
  }
  return { rows, problems };
}

export function report({ rows, problems }) {
  const pad = (s, n) => String(s).padEnd(n);
  const lines = rows.map((r) => {
    const mark = r.state === "loss" ? "LOSS" : r.state === "drop" ? "drop" : r.before === r.after ? "ok  " : "ok  ";
    const counts = pad(`${r.before} → ${r.after}`, 12);
    return `  ${pad(r.label, 18)} ${counts} ${pad(mark, 5)} ${r.note}`.trimEnd();
  });
  return { lines, problems };
}
