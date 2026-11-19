import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/* Step 5 of the resilience plan is deliberately narrow: `plugins` is the only soft asset.
   These tests hold the two facts that make it safe — softness is authored and travels into
   the document, and a fragment a module needs is a declared, ordered dependency. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

function runFailing(args) {
  try {
    execFileSync(process.execPath, [path.join(ROOT, "build.mjs"), ...args], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return null;
  } catch (error) {
    return `${error.stdout || ""}${error.stderr || ""}`;
  }
}

const manifest = () => JSON.parse(read("manifest.json"));
const docManifest = (file = "dist/slim.html") => JSON.parse(
  /<script id="asset-manifest" type="application\/json">([\s\S]*?)<\/script>/.exec(read(file))[1],
);

test("only plugins is soft, and the document carries that decision", () => {
  const authored = manifest();
  const soft = authored.assets.filter((asset) => asset.critical === false).map((asset) => asset.id);
  assert.deepEqual(soft, ["plugins"], "a document may survive a missing Plugins sheet, nothing else");

  const doc = docManifest();
  const plugins = doc.assets.find((asset) => asset.id === "plugins");
  assert.equal(plugins.critical, false, "the loader decides from the document, not from a build-time guess");
  assert.deepEqual(plugins.fragments, ["dialogs"], "the panel lives in the dialogs fragment");
  for (const id of ["toolbar", "doc-bar"]) {
    const asset = doc.assets.find((candidate) => candidate.id === id);
    assert.ok(asset.fragments?.length, `${id} reads DOM it should declare`);
  }
});

test("check refuses a fragment that is missing or built too late", () => {
  const file = path.join(ROOT, "manifest.json");
  const original = fs.readFileSync(file, "utf8");
  try {
    const authored = JSON.parse(original);
    authored.assets.find((asset) => asset.id === "plugins").fragments = ["not-an-asset"];
    fs.writeFileSync(file, JSON.stringify(authored, null, 2) + "\n");
    assert.match(runFailing(["check"]), /needs fragment "not-an-asset", which is not an asset/);

    authored.assets.find((asset) => asset.id === "plugins").fragments = ["export"];
    fs.writeFileSync(file, JSON.stringify(authored, null, 2) + "\n");
    assert.match(runFailing(["check"]), /fragment "export" must be built before it/);
  } finally {
    fs.writeFileSync(file, original);
    assert.equal(runFailing(["check"]), null, "the tree is green again");
  }
});

test("check refuses a soft infrastructure asset", () => {
  const file = path.join(ROOT, "manifest.json");
  const original = fs.readFileSync(file, "utf8");
  try {
    const authored = JSON.parse(original);
    authored.assets.find((asset) => asset.id === "registry").critical = false;
    fs.writeFileSync(file, JSON.stringify(authored, null, 2) + "\n");
    assert.match(runFailing(["check"]), /registry: infrastructure cannot be soft/);
  } finally {
    fs.writeFileSync(file, original);
    assert.equal(runFailing(["check"]), null, "the tree is green again");
  }
});
