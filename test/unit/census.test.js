import { test } from "node:test";
import assert from "node:assert/strict";
import { CENSUS, compare, fromAst, report } from "../../tools/census.mjs";

/* The audit's contract, without a browser or an engine: given the same document read
 * twice, which differences are a failed export and which are a format's honest limit.
 *
 * The ASTs below are hand-written in pandoc's JSON shape — positional attrs, Caption as
 * [short, blocks], TableBody without a tag — because that is what the code has to read.
 */

const attr = (id = "", classes = [], kv = []) => [id, classes, kv];
const str = (text) => ({t: "Str", c: text});
const space = {t: "Space"};
const para = (...inline) => ({t: "Para", c: inline});
const image = (src) => ({t: "Image", c: [attr(), [str("alt")], [src, ""]]});

/** A document with one of everything the census counts. */
function ast(overrides = {}) {
  const blocks = [
    {t: "Header", c: [1, attr("intro"), [str("Title")]]},
    {t: "Para", c: [str("One"), space, {t: "Underline", c: [str("two")]}, space,
      {t: "Link", c: [attr(), [str("three")], ["https://example.org", ""]]}]},
    {t: "BulletList", c: [[para(str("a"))], [para(str("b"))]]},
    {t: "CodeBlock", c: [attr(), "code = 1"]},
    {t: "BlockQuote", c: [para(str("quoted"))]},
    {t: "Figure", c: [attr("", ["figure"]), [null, [para(str("caption"))]],
      [{t: "Plain", c: [image("fig-01.png")]}]]},
    {t: "Table", c: [
      attr(), [null, []], [[{t: "AlignDefault"}, ["col"]]],
      [attr(), [[attr(), [{t: "Plain", c: [str("head")]}]]]],
      [[attr(), 1, [], [[attr(), [{t: "Plain", c: [str("cell")]}]]]]],
      [attr(), []],
    ]},
    {t: "Div", c: [attr("", ["page-spacer"]), []]},
    ...(overrides.extra || []),
  ];
  return {blocks, meta: {}};
}

/* What the DOM side reports for that document. */
const dom = {
  headings: 1, paragraphs: 2, listItems: 2, tables: 1, tableRows: 2, figures: 1,
  images: 1, pageBreaks: 1, links: 1, placeholderLinks: 0, underline: 1, codeBlocks: 1,
  quotes: 1, emptyParagraphs: 0, words: 11,
};

test("the census reads pantoc's shapes: attrs, captions, table bodies, raw page breaks", () => {
  const counts = fromAst(ast());
  assert.equal(counts.headings, 1);
  assert.equal(counts.listItems, 2);
  assert.equal(counts.tables, 1);
  assert.equal(counts.tableRows, 2, "one header row and one body row");
  assert.equal(counts.figures, 1);
  assert.equal(counts.images, 1, "an image inside a figure is still an image");
  assert.equal(counts.underline, 1);
  assert.equal(counts.quote ?? counts.quotes, 1);
  assert.equal(counts.pageBreaks, 1, "a surviving Div.page-spacer is a page break");
});

test("a page break that became raw openxml is still counted", () => {
  const counts = fromAst(ast({
    extra: [{t: "RawBlock", c: ["openxml", '<w:p><w:r><w:br w:type="page"/></w:r></w:p>']}],
  }));
  assert.equal(counts.pageBreaks, 2);
});

test("a matching document has no problems, whatever the format's limits", () => {
  const {rows, problems} = compare(dom, fromAst(ast()));
  assert.deepEqual(problems, []);
  const breaks = rows.find((row) => row.key === "pageBreaks");
  assert.equal(breaks.state, "ok");
});

test("a dropped heading or figure is a loss, not a drop", () => {
  const less = fromAst(ast());
  less.headings = 0;
  less.figures = 0;
  const {rows, problems} = compare(dom, less);
  assert.deepEqual(problems, ["headings h1–h4 1 → 0", "figures 1 → 0"]);
  assert.equal(rows.filter((row) => row.state === "loss").length, 2);
});

test("a page that a text target cannot carry is a drop, with its reason", () => {
  const less = fromAst(ast());
  less.pageBreaks = 0;               /* markdown: NO_PAGE, the filter says so and drops it */
  less.emptyParagraphs = 0;
  const {rows, problems} = compare({...dom, pageBreaks: 1, emptyParagraphs: 1}, less);
  assert.deepEqual(problems, [], "a may-drop difference is not a failure");
  assert.equal(rows.find((row) => row.key === "pageBreaks").state, "drop");
  assert.match(rows.find((row) => row.key === "pageBreaks").note, /no page/);
});

test("prose that changes by more than the tolerance is a loss", () => {
  const less = fromAst(ast());
  const {problems} = compare({...dom, words: 100}, {...less, words: 50});
  assert.deepEqual(problems, ["words 100 → 50"]);
});

test("every census key has a rule, and the report prints one line each", () => {
  for (const spec of CENSUS) {
    assert.match(spec.rule, /^(match|may-drop|fuzzy)$/, spec.key);
    if (spec.rule === "may-drop") assert.ok(spec.why, `${spec.key} must say why`);
  }
  const {lines} = report(compare(dom, fromAst(ast())));
  assert.equal(lines.length, CENSUS.length);
});
