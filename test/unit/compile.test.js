import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODULES,
  assertConvertible,
  compileBody,
  isConverted,
  moduleExportNames,
  syntaxError,
  uncompileBody,
} from "../../lib/compile.mjs";

/* MODULES is empty until an asset is converted; these tests register a fixture
   module so the transform is exercised before any real asset changes shape. */

const ENTRY = { factory: "createDemo", global: "Demo", file: "src/demo.js" };

function withModule(fn) {
  MODULES.demo = ENTRY;
  try {
    return fn();
  } finally {
    delete MODULES.demo;
  }
}

const SRC = `export function createDemo(deps = {}) {
  "use strict";
  return {ok: true, deps};
}

export function double(n) {
  return n * 2;
}
`;

test("an asset absent from MODULES is a pass-through", () => {
  assert.equal(isConverted("not-converted-yet"), false);
  assert.deepEqual(compileBody("not-converted-yet", "const X = 1;"), { body: "const X = 1;", exports: [] });
  assert.equal(uncompileBody("not-converted-yet", "anything"), "anything");
});

test("compile produces the envelope and records the export list", () => {
  withModule(() => {
    const { body, exports } = compileBody("demo", SRC);
    assert.deepEqual(exports, ["createDemo", "double"]);
    assert.ok(body.startsWith("/*@compiled-from src/demo.js"), "envelope header first");
    assert.match(body, /^var Demo = globalThis\.Demo \|\| \(function \(\) \{$/m);
    assert.ok(body.includes("function createDemo(deps = {}) {"), "export keyword stripped");
    assert.ok(!/^export /m.test(body), "no export keyword survives");
    assert.ok(body.endsWith("return createDemo();\n})();"), "invocation is last");
  });
});

test("uncompile is the exact inverse", () => {
  withModule(() => {
    const { body, exports } = compileBody("demo", SRC);
    assert.equal(uncompileBody("demo", body, exports), SRC);
  });
});

test("compile(uncompile(compile(x))) is stable", () => {
  withModule(() => {
    const first = compileBody("demo", SRC).body;
    const back = uncompileBody("demo", first, ["createDemo", "double"]);
    assert.equal(compileBody("demo", back).body, first);
  });
});

test("moduleExportNames preserves source order", () => {
  withModule(() => {
    assert.deepEqual(moduleExportNames(SRC), ["createDemo", "double"]);
  });
});

test("rejects the token import anywhere, comments included", () => {
  withModule(() => {
    assert.throws(
      () => compileBody("demo", "// we could import things\nexport function createDemo() {}\n"),
      /contains the token `import`/,
    );
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

test("uncompile refuses when the envelope anchors are gone, and says what to do", () => {
  withModule(() => {
    assert.throws(() => uncompileBody("demo", "function createDemo() {}", ["createDemo"]), /Edit src\/demo\.js and run "npm run combine"/);
  });
});

test("uncompile refuses when the manifest export list is missing", () => {
  withModule(() => {
    const { body } = compileBody("demo", SRC);
    assert.throws(() => uncompileBody("demo", body), /no exports list/);
  });
});

test("uncompile refuses a body that declares something the manifest does not list", () => {
  withModule(() => {
    const { body } = compileBody("demo", SRC);
    /* Simulate a hand edit inside index.html: a new top-level declaration. */
    const edited = body.replace("\nreturn createDemo();", "\nfunction sneaky() {}\nreturn createDemo();");
    assert.throws(() => uncompileBody("demo", edited, ["createDemo", "double"]), /declares "sneaky"/);
  });
});

test("a column-0 declaration inside a template literal is refused at compile time", () => {
  withModule(() => {
    const source = `export function createDemo() {
  const text = \`
function fake() {}
\`;
  return text;
}
`;
    assert.throws(() => compileBody("demo", source), /top-level declaration of "fake"/);
  });
});

test("an export at the start of a template literal line is refused", () => {
  withModule(() => {
    const source = `export function createDemo() {
  const text = \`
export function fake() {}
\`;
  return text;
}
`;
    assert.throws(() => compileBody("demo", source), /inside a template literal/);
  });
});

test("assertConvertible returns the export names for a valid module", () => {
  withModule(() => {
    assert.deepEqual(assertConvertible("demo", SRC), ["createDemo", "double"]);
  });
});

test("syntaxError parses without executing", () => {
  assert.equal(syntaxError("var x = 1;"), null);
  assert.match(syntaxError("var x = ;"), /Unexpected token/);
  assert.match(syntaxError("export function f() {}"), /Unexpected token 'export'/);
});
