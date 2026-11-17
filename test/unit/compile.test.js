import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODULES,
  assertConvertible,
  compileBody,
  isConverted,
  parseProblem,
  uncompileBody,
} from "../../lib/compile.mjs";

/* MODULES is a table of converted assets; these tests register a fixture module
   so the transform is exercised without touching a real asset. */

const ENTRY = { factory: "createDemo", file: "src/demo.js" };

function withModule(fn) {
  MODULES.demo = ENTRY;
  try {
    return fn();
  } finally {
    delete MODULES.demo;
  }
}

async function withModuleAsync(fn) {
  MODULES.demo = ENTRY;
  try {
    return await fn();
  } finally {
    delete MODULES.demo;
  }
}

/* No deps parameter, so the contract extractor requires no destructuring. */
const SRC = `export function createDemo() {
  return {ok: true};
}

export function double(n) {
  return n * 2;
}
`;

const HEADER = "/*@compiled-from src/demo.js — envelope is build-owned; edit the body or src/*/";
const REGISTER = '\nStandaloneDoc.register("demo", createDemo);';

test("an asset absent from MODULES is a pass-through", () => {
  assert.equal(isConverted("not-converted-yet"), false);
  assert.deepEqual(compileBody("not-converted-yet", "const X = 1;"), { body: "const X = 1;" });
  assert.equal(uncompileBody("not-converted-yet", "anything"), "anything");
});

test("compile is the source plus one line at each end", () => {
  withModule(() => {
    const { body } = compileBody("demo", SRC);
    assert.equal(body, `${HEADER}\n${SRC.trimEnd()}${REGISTER}`);
    assert.ok(body.includes("export function createDemo()"), "module blocks keep `export`");
    assert.ok(!body.includes("use strict"), "module blocks are strict without a directive");
    assert.ok(!body.includes("(function ()"), "module scope makes the IIFE unnecessary");
  });
});

test("uncompile is the exact inverse", () => {
  withModule(() => {
    const { body } = compileBody("demo", SRC);
    assert.equal(uncompileBody("demo", body), SRC);
  });
});

test("compile(uncompile(compile(x))) is stable", () => {
  withModule(() => {
    const first = compileBody("demo", SRC).body;
    const back = uncompileBody("demo", first);
    assert.equal(back, SRC);
    assert.equal(compileBody("demo", back).body, first);
  });
});

test("uncompile refuses when the envelope anchors are gone, and says what to do", () => {
  withModule(() => {
    assert.throws(
      () => uncompileBody("demo", "function createDemo() {}"),
      /Edit src\/demo\.js and run "npm run combine"/,
    );
  });
});

test("uncompile refuses a body whose registration line was renamed", () => {
  withModule(() => {
    const { body } = compileBody("demo", SRC);
    assert.throws(() => uncompileBody("demo", body.replace(", createDemo)", ", createDemo2)")), /envelope anchors/);
  });
});

test("rejects import syntax, but not the word inside strings and comments", () => {
  withModule(() => {
    assert.throws(() => compileBody("demo", 'import x from "./y.js";\nexport function createDemo() {}\n'), /import declaration/);
    assert.throws(() => compileBody("demo", 'export function createDemo() { await import("./y.js"); }\n'), /dynamic import/);
    assert.throws(() => compileBody("demo", "export function createDemo() { return import.meta.url; }\n"), /import\.meta/);

    /* The word itself is ordinary text. */
    const { body } = compileBody(
      "demo",
      'export function createDemo() {\n  console.error("figure import failed");\n  // we never import here\n}\n',
    );
    assert.ok(body.includes("figure import failed"));
  });
});

test("rejects a top-level declaration that is not exported", () => {
  withModule(() => {
    assert.throws(
      () => compileBody("demo", "const helper = 1;\nexport function createDemo() {}\n"),
      /top-level declaration of "helper" that is not exported/,
    );
  });
});

test("rejects export default, export lists, duplicate factories and </script>", () => {
  withModule(() => {
    assert.throws(() => compileBody("demo", "export default function createDemo() {}\n"), /export default/);
    assert.throws(() => compileBody("demo", "export function createDemo() {}\nexport {createDemo};\n"), /export \{…\}/);
    assert.throws(
      () => compileBody("demo", "export function createDemo() {}\nexport function createOther() {}\n"),
      /exactly one create<Name>/,
    );
    assert.throws(
      () => compileBody("demo", 'export function createDemo() { return "</script>"; }\n'),
      /literal <\/script>/,
    );
  });
});

test("rejects a factory whose name does not match the module table", () => {
  withModule(() => {
    assert.throws(() => compileBody("demo", "export function createWrong() {}\n"), /module table expects createDemo/);
  });
});

test("assertConvertible accepts a valid module", () => {
  withModule(() => {
    assert.equal(assertConvertible("demo", SRC), true);
  });
});

test("parseProblem parses a module asset and reports a real syntax error", async () => {
  await withModuleAsync(async () => {
    assert.equal(await parseProblem("demo", SRC), null);
    assert.match(await parseProblem("demo", "export function createDemo() { return 1 +; }\n"), /Unexpected token|SyntaxError/);
  });
});

test("parseProblem catches a DOM read at module evaluation time", async () => {
  /* CONTRIBUTING rule 6, made executable: the block's top level only declares.
     Importing the source is what turns a silent ordering assumption into a
     build failure. */
  await withModuleAsync(async () => {
    const bad = 'export function createDemo() {}\nconst title = document.title;\n';
    assert.match(await parseProblem("demo", bad), /document is not defined/);
  });
});

test("parseProblem accepts top-level await in a pass-through asset", async () => {
  /* bootstrap is a pass-through classic script that awaits boot(). */
  assert.equal(await parseProblem("bootstrap", "const x = 1;\nawait Promise.resolve(x);\n"), null);
  assert.match(await parseProblem("bootstrap", "await (\n"), /Unexpected|SyntaxError/);
});
