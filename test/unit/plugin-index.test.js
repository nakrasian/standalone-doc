import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/* The plugin index is the decoupling point: a plugin version is addressed by its own tag, so
   the sheet must be able to see a plugin published after the runtime tag a document pins.
   These tests hold the two halves together — the folder that authors a version, and the tag
   that publishes it — without asking the network. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const sha384 = (bytes) => "sha384-" + createHash("sha384").update(bytes).digest("base64");

function run(args) {
  return execFileSync(process.execPath, [path.join(ROOT, "build.mjs"), ...args], {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
}

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

const configs = () => fs.readdirSync(path.join(ROOT, "plugins"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(ROOT, "plugins", entry.name, "plugin.json"))
  .filter((file) => fs.existsSync(file))
  .map((file) => JSON.parse(fs.readFileSync(file, "utf8")))
  .sort((a, b) => a.id.localeCompare(b.id));

const runtime = () => JSON.parse(read("dist/runtime.json"));
const index = () => JSON.parse(read("dist/plugins/index.json"));

test("every plugin folder is in the index, with a verifiable manifest", () => {
  const doc = index();
  const docBase = JSON.parse(read("manifest.json")).cdnBase.replace(/\/cdn$/, "");
  for (const config of configs()) {
    const bundle = doc.bundles?.[config.id];
    assert.ok(bundle, `${config.id} must be discoverable`);
    assert.equal(bundle.version, config.version, "the newest row is the folder's version");
    assert.equal(bundle.api, config.api, "the row carries the host API it needs");
    assert.equal(bundle.manifest, `${docBase}/plugins/${config.id}.json`,
      "a plugin still published at the runtime tag names that tag's manifest");
    assert.match(bundle.sha384, /^sha384-[A-Za-z0-9+/]{64}$/);
    const bytes = fs.readFileSync(path.join(ROOT, "dist", "plugins", `${config.id}.json`));
    assert.equal(bundle.sha384, sha384(bytes), "the row hashes the manifest it names");
  }
});

test("minRuntime is the oldest release that provides the plugin's API", () => {
  const doc = index();
  const releases = runtime().releases;
  for (const bundle of Object.values(doc.bundles || {})) {
    for (const row of bundle.versions || [bundle]) {
      const wanted = Number(row.api) || 1;
      const expected = releases.find((release) => (release.hostApi || 1) >= wanted)?.tag ?? null;
      assert.equal(row.minRuntime, expected, `${bundle.label}@${row.version} needs host API ${wanted}`);
    }
  }
});

test("a plugin tag moves its manifest to that tag, and check agrees with the index", () => {
  const config = configs()[0];
  const tag = `plugin-${config.id}-v${config.version}`;
  let created = false;
  try {
    execFileSync("git", ["tag", tag, "HEAD"], { cwd: ROOT, stdio: "ignore" });
    created = true;
    run(["catalog"]);
    const row = index().bundles[config.id].versions.find((candidate) => candidate.version === config.version);
    assert.equal(row.manifest, `https://cdn.jsdelivr.net/gh/nakrasian/standalone-doc@${tag}/dist/plugins/${config.id}.json`,
      "a tagged version is addressed by its own tag");
    assert.equal(runFailing(["check"]), null, "the index and the tag agree");
  } finally {
    if (created) execFileSync("git", ["tag", "-d", tag], { cwd: ROOT, stdio: "ignore" });
    run(["catalog"]);
    assert.equal(runFailing(["check"]), null, "the tree is green again");
  }
});

test("a document carries the authored pluginIndex, and a dev base re-points it", () => {
  const authored = JSON.parse(read("manifest.json"));
  const manifestOf = (html) => JSON.parse(/<script id="asset-manifest" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const doc = manifestOf(read("dist/slim.html"));
  assert.equal(doc.pluginIndex, authored.pluginIndex, "the document says where its plugin versions are discovered");

  const base = "http://127.0.0.1:8080/.test-tmp/plugin-index/cdn";
  const out = ".test-tmp/plugin-index";
  const target = path.join(ROOT, out);
  try {
    run(["build", `--base=${base}`, `--out=${out}`]);
    const dev = manifestOf(fs.readFileSync(path.join(target, "slim.html"), "utf8"));
    assert.equal(dev.pluginIndex, `${base.replace(/\/cdn$/, "")}/plugins/index.json`,
      "a dev build reads the index it wrote, not the published one");
    const index = JSON.parse(fs.readFileSync(path.join(target, "plugins/index.json"), "utf8"));
    const docBase = base.replace(/\/cdn$/, "");
    assert.ok(index.bundles[configs()[0].id].manifest.startsWith(`${docBase}/plugins/`),
      "the dev index names the manifests beside it");
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("a hand-edited plugin index fails check", () => {
  const file = path.join(ROOT, "dist/plugins/index.json");
  const original = fs.readFileSync(file, "utf8");
  try {
    const doc = JSON.parse(original);
    doc.bundles[configs()[0].id].version = "99.0.0";
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    const failed = runFailing(["check"]);
    assert.ok(failed, "check should have failed");
    assert.match(failed, /dist\/plugins\/index\.json is stale/);
  } finally {
    fs.writeFileSync(file, original);
    assert.equal(runFailing(["check"]), null, "the tree is green again");
  }
});
