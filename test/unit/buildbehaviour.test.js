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

/* A plugin's grouping, label and category are authored, not derived: buildManifest
   rebuilds every entry from scratch, so the only thing that keeps them alive is the
   preservation list. This asserts both halves of the trip — manifest.json → split, and
   manifest.json → the document's own #asset-manifest on combine. */
test("a plugin's authored fields survive split, and reach the document on combine", () => {
  const manifestFile = path.join(ROOT, "manifest.json");
  const htmlFile = path.join(ROOT, "index.html");
  const manifestOriginal = fs.readFileSync(manifestFile, "utf8");
  const htmlOriginal = fs.readFileSync(htmlFile, "utf8");
  try {
    const manifest = JSON.parse(manifestOriginal);
    const target = manifest.assets.find((a) => a.id === "signals");
    target.category = "plugin";
    target.plugin = "demo";
    target.label = "Signals";
    target.url = "https://example.invalid/signals.js";
    target.integrity = target.sha384;
    manifest.plugins = {
      demo: {
        label: "Demo",
        version: "1.0.0",
        isolation: "sealed",
        enabled: true,
        entry: "signals",
        assets: ["signals"],
        contributes: { insert: [{ id: "demo", label: "Demo" }] },
      },
    };
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");

    run(["split"]);
    const afterSplit = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const kept = afterSplit.assets.find((a) => a.id === "signals");
    assert.equal(kept.category, "plugin", "category must survive split");
    assert.equal(kept.plugin, "demo", "the plugin group must survive split");
    assert.equal(kept.label, "Signals", "the label must survive split");
    assert.equal(afterSplit.plugins?.demo?.entry, "signals", "the plugin index must survive split");

    run(["combine"]);
    const html = fs.readFileSync(htmlFile, "utf8");
    assert.match(html, /"category":"plugin"/, "the document manifest must carry the category");
    assert.match(html, /"plugins":\{"demo"/, "the document manifest must carry the plugin index");
    /* A pinned url wins over the cdnBase-derived one, or a saved document would
       rewrite a third-party pin into a path this repository publishes. */
    assert.match(html, /"url":"https:\/\/example\.invalid\/signals\.js"/);
  } finally {
    fs.writeFileSync(manifestFile, manifestOriginal);
    fs.writeFileSync(htmlFile, htmlOriginal);
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
