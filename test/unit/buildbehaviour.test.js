import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* These tests mutate the working tree, so they restore it in a finally block.
   Run the suite with --test-concurrency=1 (see package.json) so no other test
   file observes a half-mutated repo. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const run = (args) => execFileSync(process.execPath, ["build.mjs", ...args], { cwd: ROOT, encoding: "utf8" });
const runFailing = (args) => {
  try {
    run(args);
    return null;
  } catch (err) {
    return `${err.stdout || ""}${err.stderr || ""}`;
  }
};

test("split preserves hand-edited mode and requiredBy", () => {
  const file = path.join(ROOT, "manifest.json");
  const original = fs.readFileSync(file, "utf8");
  try {
    const manifest = JSON.parse(original);
    const target = manifest.assets.find((a) => a.id === "signals");
    target.mode = "online";
    target.requiredBy = ["edit", "view"];
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");

    run(["split"]);

    const after = JSON.parse(fs.readFileSync(file, "utf8")).assets.find((a) => a.id === "signals");
    assert.equal(after.mode, "online", "hand-edited mode must survive a split");
    assert.deepEqual(after.requiredBy, ["edit", "view"], "hand-edited requiredBy must survive a split");
  } finally {
    fs.writeFileSync(file, original);
    run(["split"]);
  }
});

test("an orphan file in src/ fails verify", () => {
  const orphan = path.join(ROOT, "src/__orphan_probe.js");
  try {
    fs.writeFileSync(orphan, "// this file has no @asset marker\n");
    const output = runFailing(["verify"]);
    assert.ok(output, "verify should have failed");
    assert.match(output, /__orphan_probe\.js/);
    assert.match(output, /orphan/i);
  } finally {
    if (fs.existsSync(orphan)) fs.unlinkSync(orphan);
  }
  assert.match(run(["verify"]), /verify: ok/, "the repo must be clean again");
});

test("a modified src file is caught before combine", () => {
  const file = path.join(ROOT, "src/signals.js");
  const original = fs.readFileSync(file, "utf8");
  try {
    fs.writeFileSync(file, original + "\n// drift probe\n");
    const output = runFailing(["verify"]);
    assert.ok(output, "verify should have failed");
    assert.match(output, /signals/);
  } finally {
    fs.writeFileSync(file, original);
  }
  assert.match(run(["verify"]), /verify: ok/);
});
