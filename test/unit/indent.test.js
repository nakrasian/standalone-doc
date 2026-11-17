import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dedentCode, indentCode, scanTemplateLines } from "../../lib/indent.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const maskedLines = (text) => scanTemplateLines(text).flatMap((inside, i) => (inside ? [i] : []));

test("plain code is dedented and restored", () => {
  const src = ["    const a = 1;", "    function f() {", "      return a;", "    }"].join("\n");
  const { text, indent } = dedentCode(src);
  assert.equal(indent, "    ");
  assert.equal(text, ["const a = 1;", "function f() {", "  return a;", "}"].join("\n"));
  assert.equal(indentCode(text, indent), src);
});

test("blank lines never gain indentation", () => {
  const src = "    const a = 1;\n\n    const b = 2;";
  const { text, indent } = dedentCode(src);
  assert.equal(indentCode(text, indent), src);
  assert.ok(!text.includes("  \n"), "no trailing spaces introduced");
});

test("template literal content at column 0 is never re-indented", () => {
  const src = [
    "    const shim = `(function(){",
    "function inner(){}",
    "})();`;",
    "    const b = 2;",
  ].join("\n");
  const mask = maskedLines(src);
  assert.deepEqual(mask, [1, 2], "lines 1 and 2 start inside the literal");

  const { text, indent } = dedentCode(src);
  assert.equal(indent, "    ");
  assert.equal(
    text,
    ["const shim = `(function(){", "function inner(){}", "})();`;", "const b = 2;"].join("\n"),
    "literal lines keep their bytes; only code lines lose the indent",
  );
  assert.equal(indentCode(text, indent), src);
});

test("indentation inside ${} is code and may be re-indented", () => {
  const src = ["    const s = `a ${", "      value", "    } b`;", "    const c = 1;"].join("\n");
  const mask = maskedLines(src);
  assert.deepEqual(mask, [], "the ${} region is code, so nothing is masked");
  const { text, indent } = dedentCode(src);
  assert.equal(indentCode(text, indent), src);
});

test("a nested template inside ${} masks only its own lines", () => {
  const src = [
    "    const s = `outer ${ `inner",
    "still inner` } tail`;",
    "    const c = 1;",
  ].join("\n");
  const mask = maskedLines(src);
  assert.deepEqual(mask, [1], "line 1 begins inside the nested literal");
});

test("escaped backticks do not open or close a template", () => {
  const src = ["    const s = `a \\` b", "still inside`;", "    const c = 1;"].join("\n");
  assert.deepEqual(maskedLines(src), [1]);
});

test("backticks in comments and quoted strings are ignored", () => {
  const src = [
    "    // a ` in a comment",
    "    /* and ` here */",
    '    const s = "tick ` inside";',
    "    const t = 'also `';"    ,
    "    const c = 1;",
  ].join("\n");
  assert.deepEqual(maskedLines(src), [], "no line starts inside a template");
});

test("a regex containing quotes and slashes does not desync the scanner", () => {
  const src = [
    "    const slug = String(v).replace(/[\\/:*?\"<>|]+/g, \"-\");",
    "    const n = a / b / c;",
    "    const s = `real",
    "template`;",
  ].join("\n");
  assert.deepEqual(maskedLines(src), [3], "only the genuine template line is masked");
});

test("division is not mistaken for a regex", () => {
  const src = "    const half = total / 2;\n    const s = `x`;";
  assert.deepEqual(maskedLines(src), []);
});

test("dedent/indent is the identity when there is no common indent", () => {
  const src = "const a = 1;\n  const b = 2;";
  const { text, indent } = dedentCode(src);
  assert.equal(indent, "");
  assert.equal(text, src);
  assert.equal(indentCode(text, indent), src);
});

test("round trip across every asset body in index.html", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const markers = [...html.matchAll(/^<!-- @asset id="([^"]+)"[^>]*-->$/gm)];
  assert.ok(markers.length >= 11);
  for (const [index, m] of markers.entries()) {
    const start = m.index + m[0].length + 1;
    const end = html.indexOf("<!-- /@asset -->", start);
    const raw = html.slice(start, end);
    const firstNL = raw.indexOf("\n");
    const lastNL = raw.lastIndexOf("\n", raw.length - 2);
    const body = raw.slice(firstNL + 1, lastNL);
    const { text, indent } = dedentCode(body);
    assert.equal(indentCode(text, indent), body, `${m[1]}: round trip must be byte-identical`);
    if (m[1] !== "figures") continue;
    /* figures embeds the snapshot shim/bridge: its literal lines must survive. */
    const literalBefore = body.split("\n").filter((_, i) => scanTemplateLines(body)[i]);
    const literalAfter = text.split("\n").filter((_, i) => scanTemplateLines(text)[i]);
    assert.deepEqual(literalAfter, literalBefore, "figures: template literal content changed");
  }
});
