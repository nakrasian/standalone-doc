import { test } from "node:test";
import assert from "node:assert/strict";
/* The citations plugin's pure half, as CI sees it.
 *
 * This imports `plugins/citations/citations.js` — the shipped file, not a copy of it — because
 * a tested copy is how `É` once left `École` without a test noticing. It started life in
 * `lab/017-inline-marks/sources.test.mjs` and moved here the day the plugin was published: a
 * bundle whose parsers have no CI coverage is a bundle nobody is checking.
 */
import {
  betterBibtexKey,
  fetchZoteroLibrary,
  isReferenceItem,
  zoteroUrl,
  bibOrder,
  decodeLatex,
  entryLine,
  keyOf,
  labelFor,
  normaliseZotero,
  numberKeys,
  parseBib,
  parseCslJson,
  pruneToCited,
  reconcile,
  splitTopLevel,
} from "../../plugins/citations/citations.js";

/* 017 — the reference layer, against the cases that actually break parsers.
   Every case here is lifted from `archive/docs/05-citations.md` §6 or from a measured
   Zotero response; none of them is invented to make the code look good. */

const BIB = String.raw`
@article{stoddard2011,
  author  = {Stoddard, Barry L.},
  title   = {Homing Endonucleases: From Microbial Genetic Invaders to Reagents for Targeted {DNA} Modification},
  journal = {Quarterly Reviews of Biophysics},
  year    = {2011},
  volume  = {44},
  number  = {1},
  pages   = {1--11},
  doi     = {10.1017/S0033583510000219}
}

@article{schonberg1999,
  author  = {Sch{\"o}nberg, Arnold},
  title   = {{\"U}ber {Xanthobacter {flavus} 301} and other things},
  journal = {Journal of Fancy Names},
  year    = 1999,
  month   = mar
}

@book{who2020,
  author    = {{World Health Organization} and Smith, John},
  title     = {Guidance},
  publisher = {WHO},
  address   = {Geneva},
  year      = {2020},
  edition   = {2nd}
}

@inproceedings(key2021,
  author    = {Doe, Jane and Roe, Richard and Poe, Edgar},
  booktitle = {Proceedings of Things},
  title     = {A Paper},
  year      = {2021}
)
`;

test("a .bib parses into CSL-JSON, keys and all", () => {
  const {entries, warnings} = parseBib(BIB);
  assert.deepEqual(Object.keys(entries).sort(), ["key2021", "schonberg1999", "stoddard2011", "who2020"]);
  assert.deepEqual(warnings, []);

  const stoddard = entries.stoddard2011;
  assert.equal(stoddard.type, "article-journal");
  assert.equal(stoddard["container-title"], "Quarterly Reviews of Biophysics");
  assert.deepEqual(stoddard.issued, {"date-parts": [[2011]]});
  assert.equal(stoddard.page, "1–11", "an en-dash, not two hyphens");
  assert.equal(stoddard["citation-key"], "stoddard2011");
  /* Case protection is stripped, the words survive: `{DNA}` is not a different title. */
  assert.match(stoddard.title, /Targeted DNA Modification/);
});

test("braces protect structure, not just case", () => {
  const {entries} = parseBib(BIB);
  /* Nested braces inside a title: one title, braces gone. */
  assert.match(entries.schonberg1999.title, /^Über Xanthobacter flavus 301 and other things$/);
  assert.equal(entries.schonberg1999.author[0].family, "Schönberg");
  /* `month = mar` with no braces is legal and must not swallow the next field. */
  assert.deepEqual(entries.schonberg1999.issued["date-parts"][0], [1999, 3]);
});

test("a corporate author stays one author", () => {
  const {entries} = parseBib(BIB);
  assert.equal(entries.who2020.author.length, 2, "named `and` at depth 0 splits; a braced one does not");
  assert.deepEqual(entries.who2020.author[0], {literal: "World Health Organization"});
  assert.deepEqual(entries.who2020.author[1], {family: "Smith", given: "John"});
  assert.equal(entries.who2020["publisher-place"], "Geneva");
});

test("the paren form and the `Last, First` / `First Last` split both work", () => {
  const {entries} = parseBib(BIB);
  assert.equal(entries.key2021.type, "paper-conference");
  assert.deepEqual(entries.key2021.author[2], {family: "Poe", given: "Edgar"});
});

test("a malformed record is a warning, never a throw", () => {
  /* Delimiters that do not match are common in hand-edited files; the rest of the library
     must still import, and the broken key must be named. */
  const {entries, warnings} = parseBib("@misc{a1, title={Fine}}\n@book{b2, title={Broken}\n");
  assert.deepEqual(Object.keys(entries), ["a1"]);
  assert.match(warnings.join(" "), /b2/);
});

test("splitTopLevel is brace-blind by design", () => {
  assert.deepEqual(splitTopLevel("A and {B and C} and D", " and "), ["A", "{B and C}", "D"]);
  assert.deepEqual(splitTopLevel("a, b, c", ","), ["a", " b", " c"], "the separator is not trimmed");
});

test("LaTeX we do not know keeps its letters, never its backslash", () => {
  assert.equal(decodeLatex(String.raw`\emph{On} \& {\o}ff`), "emphOn & øff");
  assert.equal(decodeLatex(String.raw`M\"{u}ller and \'Ecole`), "Müller and École");
  /* The case that regressed when the parsers were copied: an uppercase accented vowel. */
  assert.equal(decodeLatex(String.raw`\'Ecole \c{C}a \~N`), "École Ça Ñ");
  assert.equal(decodeLatex(String.raw`1--2 --- 3`), "1–2 — 3");
});

test("CSL-JSON accepts a bare array, a {items} wrapper, and one object", () => {
  const one = [{"citation-key": "a1", type: "book", title: "One"}];
  assert.deepEqual(Object.keys(parseCslJson(JSON.stringify(one)).entries), ["a1"]);
  assert.deepEqual(Object.keys(parseCslJson({items: one}).entries), ["a1"]);
  assert.deepEqual(Object.keys(parseCslJson(one[0]).entries), ["a1"]);
  assert.equal(parseCslJson({items: [{title: "no type"}]}).warnings.length, 1);
});

test("a key is recovered from Zotero's `library/itemKey` id, deterministically", () => {
  /* Measured shape: format=csljson returns id "<libraryID>/<itemKey>" and no citation-key. */
  /* The item key, not "<library>/<itemKey>": the library id is not part of a citation, and
     the item key is what `normaliseZotero` joins on and what a re-sync matches. */
  assert.equal(keyOf({id: "2656243/5ATPD6FT", type: "document"}), "5ATPD6FT");
  assert.equal(keyOf({id: "2656243/5ATPD6FT", type: "document"}), "5ATPD6FT");
  assert.equal(keyOf({"citation-key": "smith2020", id: "1/X"}), "smith2020");
  assert.equal(keyOf({type: "book", title: "The Book", issued: {"date-parts": [[1999]]}}), "thebook1999");
});

test("Better BibTeX keys come from `extra`, and the two Zotero payloads are joined by key", () => {
  assert.equal(betterBibtexKey("Citation Key: smith2020a\nfoo: bar"), "smith2020a");
  assert.equal(betterBibtexKey("citation key : x1"), "x1");
  assert.equal(betterBibtexKey("nothing here"), "");

  const csl = {items: [
    {id: "1234/AAAA1111", type: "article-journal", title: "One", issued: {"date-parts": [[2020]]}},
    {id: "1234/BBBB2222", type: "book", title: "Two", issued: {"date-parts": [[2021]]}},
  ]};
  const json = [
    {key: "AAAA1111", data: {extra: "Citation Key: smith2020"}},
    {key: "BBBB2222", data: {extra: ""}},
  ];
  const {entries, warnings} = normaliseZotero({csl, json});
  assert.deepEqual(Object.keys(entries).sort(), ["BBBB2222", "smith2020"]);
  assert.equal(entries.smith2020["zotero-item-key"], "AAAA1111", "the item key is kept, so a re-sync can find it");
  assert.equal(warnings.length, 0, "one BBT key is enough to know the mapping works");

  const none = normaliseZotero({csl, json: [{key: "AAAA1111", data: {}}]});
  assert.match(none.warnings.join(" "), /Better BibTeX/, "a library with no keys at all must say so once");
});

test("numbers come from first appearance, so the label is derived", () => {
  const numbers = numberKeys([["b"], ["a", "b"], ["c"], ["a"]]);
  assert.deepEqual([...numbers], [["b", 1], ["a", 2], ["c", 3]]);
});

test("labels: numeric, vancouver and author-date", () => {
  const {entries} = parseBib(BIB);
  const store = entries;
  assert.equal(labelFor(["who2020"], "numeric", store), `[${numberKeys([["who2020"]]).get("who2020")}]`);
  assert.equal(labelFor(["who2020", "key2021"], "vancouver", store), "(1,2)");
  /* 2 authors → ampersand; 3 → et al. */
  /* A corporate author is its literal name. Shortening it to "WHO" is a CSL style's job
     (it needs the abbreviation and the second-use rule), not a hand-rolled formatter's. */
  assert.equal(labelFor(["who2020"], "author-date", store), "(World Health Organization & Smith, 2020)");
  assert.equal(labelFor(["key2021"], "author-date", store), "(Doe et al., 2021)");
  assert.equal(labelFor(["stoddard2011", "key2021"], "author-date", store), "(Stoddard, 2011; Doe et al., 2021)");
  assert.equal(labelFor(["nope"], "numeric", store), "[?]", "an unknown key is visible, never silent");
  /* A document-wide map, which is what the relabel pass actually holds. */
  const docWide = numberKeys([["stoddard2011"], ["key2021"], ["nope"]], {store});
  assert.equal(labelFor(["key2021"], "numeric", store, docWide), "[2]");
  assert.equal(docWide.has("nope"), false, "a key with no entry is never numbered");
});

test("the bibliography sorts by appearance for numeric and by family for author-date", () => {
  const {entries} = parseBib(BIB);
  const cited = ["who2020", "stoddard2011", "key2021"];
  assert.deepEqual(bibOrder(cited, "numeric", entries), cited);
  assert.deepEqual(bibOrder(cited, "author-date", entries), ["key2021", "stoddard2011", "who2020"]);
});

test("an entry formats without losing the fields a style needs", () => {
  const {entries} = parseBib(BIB);
  const apa = entryLine("stoddard2011", "author-date", entries);
  assert.match(apa, /^Stoddard, B\. L\. \(2011\)\. Homing Endonucleases/);
  assert.match(apa, /Quarterly Reviews of Biophysics, 44\(1\), 1–11\./);
  assert.match(apa, /https:\/\/doi\.org\/10\.1017/);
  const vancouver = entryLine("key2021", "vancouver", entries);
  assert.match(vancouver, /^Doe J, Roe R, Poe E\. A Paper\./);
  assert.match(entryLine("gone", "numeric", entries), /not in this document's library/, "a missing entry is a line, not a crash");
});

test("only cited entries travel, and a pin survives pruning", () => {
  const {entries} = parseBib(BIB);
  const pruned = pruneToCited(entries, new Set(["who2020"]), {keep: ["key2021"]});
  assert.deepEqual(Object.keys(pruned).sort(), ["key2021", "who2020"]);
});

/* ------------------------------------------------------- import twice, and who wins */

/* The update path (lab/017 §10b). A reference that is already cited must never change because
   a `.bib` was re-read: the document's copy is what a reader sees, and two copies of one
   reference is a decision rather than a merge rule. */

const SMITH = {
  id: "smith2020a", type: "article-journal", "citation-key": "smith2020a",
  author: [{family: "Smith", given: "John"}], issued: {"date-parts": [[2020]]},
  title: "A study of citations", "container-title": "Journal of Documentation",
};

test("a first import is all new, and nothing is a conflict", () => {
  const report = reconcile({incoming: {smith2020a: SMITH}, entries: {}, pool: {}});
  assert.deepEqual(report.added, ["smith2020a"]);
  assert.deepEqual(report.changed, []);
  assert.deepEqual(report.same, []);
});

test("re-importing the same bytes is `same`, not `changed`", () => {
  /* Key order in the JSON must not matter: a `.bib` parser and a Zotero response emit the
     same citation with different field order, and that is not a change. */
  const reordered = Object.fromEntries(Object.entries(SMITH).reverse());
  const report = reconcile({incoming: {smith2020a: reordered}, entries: {smith2020a: SMITH}, pool: {}});
  assert.deepEqual(report.changed, [], "field order is not a change");
  assert.deepEqual(report.same, ["smith2020a"]);
});

test("a corrected year comes back as a decision, with both copies", () => {
  const corrected = {...SMITH, issued: {"date-parts": [[2021]]}};
  const report = reconcile({incoming: {smith2020a: corrected}, entries: {smith2020a: SMITH}, pool: {}});
  assert.equal(report.changed.length, 1);
  const [row] = report.changed;
  assert.equal(row.key, "smith2020a");
  assert.equal(row.mine.issued["date-parts"][0][0], 2020, "the document's copy is offered, not replaced");
  assert.equal(row.theirs.issued["date-parts"][0][0], 2021, "the library's copy is offered beside it");
  assert.deepEqual(report.added, [], "an existing key is never `new`");
});

test("uncited keys are new even when the pool already had them", () => {
  /* The pool is this session's library; the document's entries are the truth. A key with no
     citation has no document copy to protect. */
  const report = reconcile({incoming: {doe2021: {...SMITH, id: "doe2021"}}, entries: {}, pool: {doe2021: {...SMITH, id: "doe2021"}}});
  assert.deepEqual(report.added, ["doe2021"]);
  assert.deepEqual(report.changed, []);
});

test("only cited entries are kept, and a pin survives", () => {
  const report = reconcile({incoming: {smith2020a: SMITH}, entries: {}, pool: {}});
  assert.equal(report.added.length, 1);
  const kept = pruneToCited({smith2020a: SMITH, who2020: {id: "who2020"}}, new Set(["smith2020a"]), {keep: ["who2020"]});
  assert.deepEqual(Object.keys(kept).sort(), ["smith2020a", "who2020"]);
  assert.deepEqual(Object.keys(pruneToCited({a: {id: "a"}, b: {id: "b"}}, new Set(["a"]))), ["a"]);
});

/* ------------------------------------------------- Zotero: a library is not a bibliography */

/* The bug this section exists for: importing a real library added its PDFs, its notes and
   every highlight in them. Zotero serialises an attachment as a CSL `document` — the same type
   a real document item uses — so the CSL side cannot tell them apart. The **item JSON** can. */

const item = (key, data) => ({key, data});

test("a reference is top level, not deleted, and not an attachment, note or annotation", () => {
  assert.equal(isReferenceItem({itemType: "journalArticle"}), true);
  assert.equal(isReferenceItem({itemType: "book"}), true);
  assert.equal(isReferenceItem({itemType: "document"}), true, "a real document item is a reference");
  assert.equal(isReferenceItem({itemType: "attachment"}), false);
  assert.equal(isReferenceItem({itemType: "note"}), false);
  assert.equal(isReferenceItem({itemType: "annotation"}), false, "a highlight is not a citation");
  /* A child item of any type is not a citation of its own. */
  assert.equal(isReferenceItem({itemType: "bookSection", parentItem: "ABCD1234"}), false);
  assert.equal(isReferenceItem({itemType: "journalArticle", deleted: true}), false);
  assert.equal(isReferenceItem(null), false);
  assert.equal(isReferenceItem(undefined), false);
});

test("a mixed page keeps the references and counts what it dropped", () => {
  /* Shapes measured against a live library: `key` beside `data`, `extra` for Better BibTeX,
     annotations carrying `annotationText` and a `parentItem` that points at the attachment. */
  const json = [
    item("AAAABBBB", {itemType: "journalArticle", title: "A paper", extra: "Citation Key: smith2020a"}),
    item("CCCCDDDD", {itemType: "attachment", title: "paper.pdf", parentItem: "AAAABBBB",
      contentType: "application/pdf"}),
    item("EEEEFFFF", {itemType: "note", note: "<p>read this again</p>", parentItem: "AAAABBBB"}),
    item("GGGGHHHH", {itemType: "annotation", annotationType: "highlight",
      annotationText: "the sentence the author underlined", parentItem: "CCCCDDDD"}),
    item("IIIIJJJJ", {itemType: "bookSection", title: "A chapter", parentItem: "KKKKLLLL"}),
    item("KKKKLLLL", {itemType: "book", title: "The book", extra: "Citation Key: doe2021"}),
    item("MMMMNNNN", {itemType: "book", title: "Trashed", deleted: true}),
    item("OOOO0000", {itemType: "webpage", title: "No key in extra", extra: ""}),
  ];
  /* The CSL side looks entirely plausible: attachments arrive as `document`, annotations as
     `document` with the highlighted text as their title. */
  const csl = {items: [
    {id: "1234/AAAABBBB", type: "article-journal", title: "A paper", issued: {"date-parts": [[2020]]}},
    {id: "1234/CCCCDDDD", type: "document", title: "paper.pdf"},
    {id: "1234/EEEEFFFF", type: "document", title: "read this again"},
    {id: "1234/GGGGHHHH", type: "document", title: "the sentence the author underlined"},
    {id: "1234/IIIIJJJJ", type: "chapter", title: "A chapter"},
    {id: "1234/KKKKLLLL", type: "book", title: "The book", issued: {"date-parts": [[2021]]}},
    {id: "1234/MMMMNNNN", type: "book", title: "Trashed"},
    {id: "1234/OOOO0000", type: "webpage", title: "No key in extra"},
  ]};
  const {entries, warnings, skipped, references} = normaliseZotero({csl, json});
  assert.deepEqual(Object.keys(entries).sort(), ["OOOO0000", "doe2021", "smith2020a"]);
  assert.equal(references, 3);
  assert.deepEqual(skipped, {attachment: 1, note: 1, annotation: 1, child: 1, deleted: 1});
  /* Not one warning per attachment: the Better BibTeX note is about references, and two of
     these three have a key. */
  assert.deepEqual(warnings, []);
  assert.equal(entries.smith2020a[`zotero-item-key`], "AAAABBBB");
});

test("a library with no Better BibTeX keys says so once, about references", () => {
  const json = [
    item("AAAABBBB", {itemType: "book", title: "One", extra: ""}),
    item("CCCCDDDD", {itemType: "attachment", title: "one.pdf", parentItem: "AAAABBBB"}),
  ];
  const csl = {items: [
    {id: "1/AAAABBBB", type: "book", title: "One"},
    {id: "1/CCCCDDDD", type: "document", title: "one.pdf"},
  ]};
  const {warnings, entries} = normaliseZotero({csl, json});
  assert.deepEqual(Object.keys(entries), ["AAAABBBB"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Better BibTeX/);
});

test("the items url excludes attachments server-side and nothing else", () => {
  /* Measured: `itemType=-attachment||note` is `400 Invalid itemType`, so the one filter that
     can be asked for is asked for, and the rest is decided on the item JSON. */
  const json = zoteroUrl({library: "groups/459003", format: "json", start: 200, limit: 100});
  const url = new URL(json);
  assert.equal(url.host, "api.zotero.org");
  assert.equal(url.pathname, "/groups/459003/items");
  assert.equal(url.searchParams.get("itemType"), "-attachment");
  assert.equal(url.searchParams.get("format"), "json");
  assert.equal(url.searchParams.get("include"), "data", "`extra` is where the Better BibTeX key lives");
  assert.equal(url.searchParams.get("start"), "200");
  assert.equal(url.searchParams.get("limit"), "100");
  assert.equal(json.includes("||"), false, "the API rejects a list");

  const csl = new URL(zoteroUrl({library: "users/1234567", format: "csljson"}));
  assert.equal(csl.searchParams.get("format"), "csljson");
  assert.equal(csl.searchParams.get("itemType"), "-attachment");
  assert.equal(csl.searchParams.get("include"), null, "not an item-JSON parameter");
});

test("the reader pages by total-results, stops on a short page, and reports what it took", async () => {
  /* A stub that behaves like the API: `total-results` on every response, a page per `start`,
     and the last page short. This is the loop the panel runs; a fake is the only way to test
     "did it stop" without a library of a thousand items. */
  const seen = [];
  const page = (start) => {
    const size = Math.min(100, Math.max(0, 250 - start));
    const csl = {items: []};
    const json = [];
    for (let i = 0; i < size; i++) {
      const key = `K${String(start + i).padStart(6, "0")}`;
      /* One attachment child per ten references, to prove they never reach the pool. */
      if (i % 10 === 9) {
        json.push({key: `${key}A`, data: {itemType: "attachment", parentItem: key, title: "x.pdf"}});
        csl.items.push({id: `1/${key}A`, type: "document", title: "x.pdf"});
        continue;
      }
      json.push({key, data: {itemType: "journalArticle", title: `Paper ${start + i}`, extra: `Citation Key: ref${start + i}`}});
      csl.items.push({id: `1/${key}`, type: "article-journal", title: `Paper ${start + i}`});
    }
    return {
      ok: true,
      headers: {get: (name) => (name.toLowerCase() === "total-results" ? "250" : null)},
      json: async () => JSON.parse(JSON.stringify(csl)),
    };
  };
  const jsonPage = (start) => {
    const size = Math.min(100, Math.max(0, 250 - start));
    const json = [];
    for (let i = 0; i < size; i++) {
      const key = `K${String(start + i).padStart(6, "0")}`;
      if (i % 10 === 9) {
        json.push({key: `${key}A`, data: {itemType: "attachment", parentItem: key, title: "x.pdf"}});
        continue;
      }
      json.push({key, data: {itemType: "journalArticle", title: `Paper ${start + i}`, extra: `Citation Key: ref${start + i}`}});
    }
    return {
      ok: true,
      headers: {get: (name) => (name.toLowerCase() === "total-results" ? "250" : null)},
      json: async () => json,
    };
  };
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    seen.push({format: parsed.searchParams.get("format"), start: Number(parsed.searchParams.get("start"))});
    const start = Number(parsed.searchParams.get("start"));
    return parsed.searchParams.get("format") === "csljson" ? page(start) : jsonPage(start);
  };

  const result = await fetchZoteroLibrary({library: "groups/1", fetchImpl});
  assert.equal(result.total, 250);
  assert.equal(result.pages, 3, "100 + 100 + 50");
  assert.equal(result.taken, 250);
  assert.equal(result.references, 225, "a tenth of them are attachment children");
  assert.equal(Object.keys(result.entries).length, 225);
  assert.equal(result.skipped.attachment, 25);
  assert.equal(Object.keys(result.entries).some((key) => key.endsWith("A")), false);
  /* Both representations were asked for, page by page, with the one filter the API accepts. */
  assert.deepEqual(seen.map((row) => row.start), [0, 0, 100, 100, 200, 200]);
  assert.equal(seen.every((row) => ["json", "csljson"].includes(row.format)), true);
});

test("the reader refuses a library with no name, and surfaces an http failure", async () => {
  await assert.rejects(() => fetchZoteroLibrary({library: "", fetchImpl: async () => ({ok: true})}), /no library/);
  await assert.rejects(
    () => fetchZoteroLibrary({library: "groups/1", fetchImpl: async () => ({ok: false, status: 403})}),
    /HTTP 403/,
  );
});
