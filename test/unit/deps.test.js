import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditContract, extractContract, LEGACY_GLOBALS, stripComments } from "../../lib/deps.mjs";
import { MODULES } from "../../lib/compile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/* The tripwire map the build uses: these globals are no longer published, so any
   reference to one is an undeclared edge and must fail the audit. */
const GLOBALS = LEGACY_GLOBALS;

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

test("catches a bare legacy global, which is how Pagination.schedule() hid", () => {
  /* The failure that motivated this: `Pagination.schedule()` resolved through the
     published global, so removing the global broke figure resize/remove with a
     ReferenceError that no spec saw. */
  const bare = extractContract(
    factory(`  const {signals} = deps;
  Pagination.schedule();
  return {x};`),
    { globals: GLOBALS },
  );
  assert.deepEqual(bare.implicitGlobals, ["pagination"]);
});

test("prose about a module is not a dependency", () => {
  const prose = extractContract(
    factory(`  const {signals} = deps;
  // Pagination.schedule() used to live here; Status.refresh() too.
  /* Figures.scan() as well */
  return {x};`),
    { globals: GLOBALS },
  );
  assert.deepEqual(prose.implicitGlobals, []);
});

test("stripComments keeps comment markers inside strings", () => {
  const source = 'const url = "http://x/y"; // real comment\nconst re = /a\\/b/;\n';
  const out = stripComments(source);
  assert.ok(out.includes("http://x/y"), "a // inside a string survives");
  assert.ok(!out.includes("real comment"), "a line comment is removed");
});

test("a declared dependency is never an implicit global", () => {
  const declared = extractContract(
    factory(`  const {signals, pagination} = deps;
  const figures = deps.late("figures");
  Pagination.schedule();
  Figures.scan();
  figures().scan();
  return {x};`),
    { globals: GLOBALS },
  );
  assert.deepEqual(declared.implicitGlobals, []);
});

test("audit: an implicit global is a problem, not a warning", () => {
  /* Phase 3, commit 5 removed the published bindings. A reference that survives
     would only work by load order, so the build refuses it. */
  const index = new Map([
    ["a", {id: "a", order: 10}],
    ["figures", {id: "figures", order: 80}],
  ]);
  const audited = auditContract("a", {deps: [], late: [], provides: [], implicitGlobals: ["figures"]}, index);
  assert.match(audited.problems[0], /through a global/);
  assert.deepEqual(audited.warnings, []);
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

test("extracts optional edges separately from construction deps", () => {
  const c = extractContract(
    factory(`  const {signals} = deps;
  const status = deps.optional("status");
  const editor = deps.optional("editor");
  return {x, status, editor};`),
    { globals: GLOBALS },
  );
  assert.deepEqual(c.deps, ["signals"]);
  assert.deepEqual(c.optional, ["status", "editor"]);
});

test("audit: an always-present module cannot depend on a mode-gated one", () => {
  /* figures is needed by every document; status only by an editable one. A plain
     dependency would leave a view-mode document unable to boot. */
  const index = new Map([
    ["status", {id: "status", order: 60, requiredBy: ["edit"]}],
    ["figures", {id: "figures", order: 80, requiredBy: ["*"]}],
  ]);
  const empty = {deps: [], late: [], optional: [], provides: [], implicitGlobals: []};

  const bad = auditContract("figures", {...empty, deps: ["status"]}, index);
  assert.match(bad.problems[0], /only needed by edit/);

  const good = auditContract("figures", {...empty, optional: ["status"]}, index);
  assert.deepEqual(good.problems, []);
});

test("audit: optional on an always-present module is needless", () => {
  const index = new Map([
    ["signals", {id: "signals", order: 30, requiredBy: ["*"]}],
    ["figures", {id: "figures", order: 80, requiredBy: ["*"]}],
  ]);
  const empty = {deps: [], late: [], optional: [], provides: [], implicitGlobals: []};
  const audited = auditContract("figures", {...empty, optional: ["signals"]}, index);
  assert.match(audited.warnings[0], /always present/);
  assert.deepEqual(audited.problems, []);
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

test("the real sources match the manifest and their signatures", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const index = new Map(manifest.assets.map((a) => [a.id, a]));
  for (const id of Object.keys(MODULES)) {
    const source = fs.readFileSync(path.join(ROOT, `src/${id}.js`), "utf8");
    const derived = extractContract(source, { globals: GLOBALS });
    const recorded = manifest.assets.find((a) => a.id === id);
    assert.deepEqual(derived.deps, recorded.deps, `${id}: manifest deps match the signature`);
    assert.deepEqual(derived.late, recorded.late ?? [], `${id}: manifest late edges match`);
    assert.deepEqual(derived.optional, recorded.optional ?? [], `${id}: manifest optional edges match`);
    assert.deepEqual(derived.provides, recorded.provides, `${id}: manifest provides match`);
    assert.deepEqual(derived.implicitGlobals, [], `${id}: no global reaches`);
    const audited = auditContract(id, derived, index);
    assert.deepEqual(audited.problems, [], `${id}: no audit problems`);
  }
});
