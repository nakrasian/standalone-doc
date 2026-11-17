import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditContract, extractContract } from "../../lib/deps.mjs";
import { MODULES } from "../../lib/compile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GLOBALS = Object.fromEntries(Object.entries(MODULES).map(([id, entry]) => [entry.global, id]));

const factory = (body) => `export function createDemo(deps = {}) {\n${body}\n}\n`;

test("derives deps, env, late and provides", () => {
  const c = extractContract(
    factory(`  const {signals, zoom, env = globalThis} = deps;
  const figures = deps.late("figures");
  const {document} = env;
  return {start, stop, get value() {return 1;}};`),
    { globals: GLOBALS },
  );
  assert.deepEqual(c.deps, ["signals", "zoom"]);
  assert.deepEqual(c.late, ["figures"]);
  assert.equal(c.usesEnv, true);
  assert.deepEqual(c.provides, ["start", "stop", "value"]);
});

test("handles the `const api = {…}` return shape", () => {
  const c = extractContract(
    factory(`  const {signals} = deps;
  const api = {a, b, get c() {return 1;}};
  return api;`),
    { globals: GLOBALS },
  );
  assert.deepEqual(c.provides, ["a", "b", "c"]);
});

test("a dependency-free factory needs no destructuring", () => {
  const c = extractContract("export function createDemo() {\n  return {one};\n}\n");
  assert.deepEqual(c.deps, []);
  assert.deepEqual(c.provides, ["one"]);
});

test("refuses a destructuring with no deps parameter, or vice versa", () => {
  assert.throws(
    () => extractContract("export function createDemo() {\n  const {signals} = deps;\n}\n"),
    /does not accept a deps parameter/,
  );
  assert.throws(() => extractContract(factory("  return {x};")), /first statement is not/);
});

test("refuses renaming, a second destructuring, and destructuring late", () => {
  assert.throws(() => extractContract(factory("  const {signals: sig} = deps;\n  return {x};")), /cannot parse dependency/);
  assert.throws(
    () => extractContract(factory("  const {signals} = deps;\n  const {zoom} = deps;\n  return {x};")),
    /more than one/,
  );
  assert.throws(() => extractContract(factory("  const {late} = deps;\n  return {x};")), /do not destructure `late`/);
});

test("ignores nested return objects and reports an underivable surface as null", () => {
  const c = extractContract(
    factory(`  const {signals} = deps;
  function helper() { return {nested: true}; }
  return build();`),
    { globals: GLOBALS },
  );
  assert.equal(c.provides, null);
});

test("finds implicit globals that shadow a declared dependency", () => {
  const c = extractContract(
    factory(`  const {signals} = deps;
  if (globalThis.Figures) globalThis.Figures.scan();
  return {x};`),
    { globals: GLOBALS },
  );
  assert.deepEqual(c.implicitGlobals, ["figures"]);
});

test("audit: construction deps must come earlier than the declarer", () => {
  const index = new Map([
    ["a", {id: "a", order: 10}],
    ["b", {id: "b", order: 20}],
  ]);
  const forward = auditContract("a", {deps: ["b"], late: [], provides: [], implicitGlobals: []}, index);
  assert.match(forward.problems[0], /must come earlier/);
  const backward = auditContract("b", {deps: ["a"], late: [], provides: [], implicitGlobals: []}, index);
  assert.deepEqual(backward.problems, []);
});

test("audit: unknown, self, and needless late edges", () => {
  const index = new Map([
    ["a", {id: "a", order: 10}],
    ["b", {id: "b", order: 20}],
  ]);
  const empty = {deps: [], late: [], provides: [], implicitGlobals: []};
  assert.match(auditContract("a", {...empty, deps: ["ghost"]}, index).problems[0], /not an asset/);
  assert.match(auditContract("a", {...empty, deps: ["a"]}, index).problems[0], /itself/);
  assert.match(auditContract("a", {...empty, late: ["a"]}, index).problems[0], /late-bind itself/);
  assert.match(auditContract("b", {...empty, late: ["a"]}, index).warnings[0], /points backwards/);
});

test("the real sources match the MODULES table and the recorded manifest", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const index = new Map(manifest.assets.map((a) => [a.id, a]));
  for (const [id, entry] of Object.entries(MODULES)) {
    const source = fs.readFileSync(path.join(ROOT, `src/${id}.js`), "utf8");
    const derived = extractContract(source, { globals: GLOBALS });
    const recorded = manifest.assets.find((a) => a.id === id);
    assert.deepEqual(derived.deps, recorded.deps, `${id}: manifest deps match the signature`);
    assert.deepEqual(derived.late, recorded.late, `${id}: manifest late edges match`);
    assert.deepEqual(derived.provides, recorded.provides, `${id}: manifest provides match`);

    if (entry.deps) {
      assert.deepEqual(derived.deps, Object.keys(entry.deps), `${id}: signature matches the MODULES table`);
    }
    const audited = auditContract(id, derived, index);
    assert.deepEqual(audited.problems, [], `${id}: no audit problems`);
  }
});
