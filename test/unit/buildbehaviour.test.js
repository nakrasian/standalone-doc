import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
        island: "sealed",
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

/* A `bin` asset is bytes in a text file: the document carries base64, the repository
   carries the binary, and verify is a byte comparison of bodies. So the encoding has to
   be canonical and the round trip has to decode on the way in and encode on the way out. */
const WASM_ADD = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

/* figures.js builds island documents as strings and contains a literal `</body>`, so the
   probe block has to go before the *last* one. */
function appendToBody(html, block) {
  const at = html.lastIndexOf("</body>");
  assert.ok(at > 0, "no closing body");
  return html.slice(0, at) + block + html.slice(at);
}

test("a bin asset round-trips: base64 in the document, bytes in src/, hashes over bytes", () => {
  const htmlFile = path.join(ROOT, "index.html");
  const manifestFile = path.join(ROOT, "manifest.json");
  const wasmFile = path.join(ROOT, "src/__probe_bin.wasm");
  const htmlOriginal = fs.readFileSync(htmlFile, "utf8");
  const manifestOriginal = fs.readFileSync(manifestFile, "utf8");
  try {
    const block = '<!-- @asset id="__probe_bin" kind="bin" order="999" -->\n'
      + `<script type="application/wasm" id="__probe_bin">\n${WASM_ADD.toString("base64")}\n</script>\n`
      + "<!-- /@asset -->\n\n";
    fs.writeFileSync(htmlFile, appendToBody(htmlOriginal, block));

    run(["split"]);
    const written = fs.readFileSync(wasmFile);
    assert.deepEqual(written, WASM_ADD, "src/ holds the decoded bytes, not the base64");
    const entry = JSON.parse(fs.readFileSync(manifestFile, "utf8")).assets.find((a) => a.id === "__probe_bin");
    assert.equal(entry.kind, "bin");
    assert.equal(entry.bytes, WASM_ADD.length, "bytes are counted on the decoded file");
    assert.equal(
      entry.sha384,
      "sha384-" + createHash("sha384").update(WASM_ADD).digest("base64"),
      "the hash is over the decoded bytes",
    );

    /* Editing the binary must reach the document, re-encoded canonically. */
    const edited = Buffer.concat([WASM_ADD, Buffer.from([0])]);
    fs.writeFileSync(wasmFile, edited);
    run(["combine"]);
    const html = fs.readFileSync(htmlFile, "utf8");
    assert.ok(html.includes(edited.toString("base64")), "combine splices the new base64 body");
    assert.ok(!html.includes(WASM_ADD.toString("base64")), "the old body is gone");
    assert.match(run(["verify"]), /verify: ok/);
  } finally {
    fs.writeFileSync(htmlFile, htmlOriginal);
    fs.writeFileSync(manifestFile, manifestOriginal);
    fs.rmSync(wasmFile, { force: true });
    run(["split"]);
  }
});

test("a wrapped base64 body is refused, because it could not round-trip", () => {
  const htmlFile = path.join(ROOT, "index.html");
  const htmlOriginal = fs.readFileSync(htmlFile, "utf8");
  try {
    const wrapped = WASM_ADD.toString("base64").replace(/(.{16})/g, "$1\n");
    const block = '<!-- @asset id="__probe_bin" kind="bin" order="999" -->\n'
      + `<script type="application/wasm" id="__probe_bin">\n${wrapped}\n</script>\n`
      + "<!-- /@asset -->\n\n";
    fs.writeFileSync(htmlFile, appendToBody(htmlOriginal, block));
    const output = runFailing(["split"]);
    assert.ok(output, "split should have failed");
    assert.match(output, /one line of unwrapped base64/);
  } finally {
    fs.writeFileSync(htmlFile, htmlOriginal);
    run(["split"]);
  }
});

/* The catalog is authored in plugins.json and published as dist/registry.json. It is
   advisory — a document embeds its own pins — so the gate's job is to refuse a proposal
   that could not work, and to notice when the published copy drifts from the authored one. */
test("a catalog proposal must be absolute, hashed, and an identifier factory", () => {
  const file = path.join(ROOT, "plugins.json");
  const original = fs.readFileSync(file, "utf8");
  try {
    const catalog = JSON.parse(original);
    const broken = JSON.parse(original);
    broken.assets.bad = {
      label: "",
      island: "whatever",
      versions: [{ version: "", url: "./relative.js", sha384: "sha384-nope", bytes: 0, factory: "not an identifier" }],
    };
    fs.writeFileSync(file, JSON.stringify(broken));
    const output = runFailing(["check"]);
    assert.ok(output, "check should have failed");
    assert.match(output, /catalog "bad": label is required/);
    assert.match(output, /url must be absolute https:\/\//);
    assert.match(output, /sha384 must be/);
    assert.match(output, /bytes must be a positive integer/);
    assert.match(output, /factory must be an identifier/);
    assert.match(output, /island must be sealed, sandboxed or trusted/);

    /* And the published copy must match what the authored file would emit. */
    fs.writeFileSync(file, JSON.stringify(catalog));
    run(["combine"]);
    assert.match(JSON.parse(fs.readFileSync(path.join(ROOT, "dist/registry.json"), "utf8")).generated, /advisory only/);
    fs.appendFileSync(path.join(ROOT, "dist/registry.json"), "\n");
    const stale = runFailing(["check"]);
    assert.match(stale, /dist\/registry\.json is stale/);
  } finally {
    fs.writeFileSync(file, original);
    run(["combine"]);
  }
});

test("build --base re-points the documents without touching a hash", () => {
  const out = path.join(".test-tmp", "base-build");
  const target = path.join(ROOT, out);
  fs.rmSync(target, { recursive: true, force: true });
  try {
    const published = manifestOf(fs.readFileSync(path.join(ROOT, "dist/slim.html"), "utf8"));
    const before = fs.readFileSync(path.join(ROOT, "dist/slim.html"), "utf8");

    run(["build", "--base=http://127.0.0.1:8080/dist/cdn", `--out=${out}`]);

    const dev = manifestOf(fs.readFileSync(path.join(target, "slim.html"), "utf8"));
    assert.equal(dev.cdnBase, "http://127.0.0.1:8080/dist/cdn");
    assert.equal(published.assets.length, dev.assets.length);
    for (const [i, asset] of published.assets.entries()) {
      assert.equal(dev.assets[i].integrity, asset.integrity, `${asset.id}: a base moves the address, never the hash`);
      assert.equal(dev.assets[i].bytes, asset.bytes, `${asset.id}: bytes are the tree's`);
      if (asset.url) assert.ok(dev.assets[i].url.startsWith("http://127.0.0.1:8080/dist/cdn/"), `${asset.id}: url re-pointed`);
      else assert.equal(dev.assets[i].url, undefined, `${asset.id}: infra has no url to move`);
      assert.equal(dev.assets[i].mode, asset.mode, `${asset.id}: materialisation is not the base's business`);
    }
    assert.equal(dev.assets.find((a) => a.id === "editor").url, "http://127.0.0.1:8080/dist/cdn/editor.js");

    /* The release artefacts are not touched: a dev base must never be committed. */
    assert.equal(fs.readFileSync(path.join(ROOT, "dist/slim.html"), "utf8"), before);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("build --base refuses to write into dist/", () => {
  const output = runFailing(["build", "--base=http://127.0.0.1:8080/dist/cdn", "--out=dist"]);
  assert.ok(output, "build should have refused");
  assert.match(output, /must not write into dist\//);
});

test("check refuses a document base that is not a release tag", () => {
  const file = path.join(ROOT, "manifest.json");
  const original = fs.readFileSync(file, "utf8");
  try {
    const manifest = JSON.parse(original);
    manifest.cdnBase = "http://127.0.0.1:8080/dist/cdn";
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
    run(["combine"]);
    const output = runFailing(["check"]);
    assert.ok(output, "check should have failed");
    assert.match(output, /cdnBase is not a release tag/);
  } finally {
    fs.writeFileSync(file, original);
    run(["combine"]);
  }
});

/** The document's own manifest block, read the way the loader reads it. */
function manifestOf(html) {
  return JSON.parse(/<script id="asset-manifest" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
}

test("the runtime catalog describes each tag and nothing newer than the tree", () => {
  try {
    run(["catalog"]);
    const indexFile = path.join(ROOT, "dist/runtime.json");
    const first = fs.readFileSync(indexFile, "utf8");
    const index = JSON.parse(first);

    /* Deterministic: a view of the tags, so regenerating cannot drift. */
    run(["catalog"]);
    assert.equal(fs.readFileSync(indexFile, "utf8"), first);

    const tags = execFileSync("git", ["tag", "--list", "v*"], { cwd: ROOT, encoding: "utf8" })
      .split("\n").map((t) => t.trim()).filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
    for (const tag of tags) assert.ok(index.releases.some((r) => r.tag === tag), `${tag} must be listed`);

    /* Every entry names its own tag's base, and its hashes are that tag's hashes. */
    for (const release of index.releases) {
      const entry = JSON.parse(fs.readFileSync(path.join(ROOT, "dist", release.manifest), "utf8"));
      assert.equal(entry.tag, release.tag);
      assert.ok(entry.base.includes(`@${release.tag}/`), `${release.tag}: base names its own tag`);
      assert.ok(entry.assets.length > 0);
      /* 6a's input: an address, a hash and a size for every reusable asset. */
      for (const asset of entry.assets) {
        assert.ok(asset.url.startsWith(entry.base + "/"), `${asset.id}: url is under the base`);
        assert.match(asset.sha384, /^sha384-[A-Za-z0-9+/=]+$/);
        assert.ok(asset.bytes > 0);
      }
    }
  } finally {
    run(["catalog"]);
  }
});

test("a hand-edited runtime catalog entry fails check", () => {
  const file = path.join(ROOT, "dist/runtime/v0.3.1.json");
  const original = fs.readFileSync(file, "utf8");
  try {
    const entry = JSON.parse(original);
    entry.assets.find((a) => a.id === "editor").sha384 = "sha384-" + "A".repeat(64);
    fs.writeFileSync(file, JSON.stringify(entry, null, 2) + "\n");
    const output = runFailing(["check"]);
    assert.ok(output, "check should have failed");
    assert.match(output, /dist\/runtime\/v0\.3\.1\.json is stale/);
  } finally {
    fs.writeFileSync(file, original);
  }
});

test("a catalog file for no tag fails check", () => {
  const extra = path.join(ROOT, "dist/runtime/v9.9.9.json");
  try {
    fs.writeFileSync(extra, "{}\n");
    const output = runFailing(["check"]);
    assert.ok(output, "check should have failed");
    assert.match(output, /v9\.9\.9\.json describes no tag/);
  } finally {
    fs.rmSync(extra, { force: true });
  }
});

test("an unreleased package version becomes the pending catalog entry", () => {
  const file = path.join(ROOT, "package.json");
  const original = fs.readFileSync(file, "utf8");
  /* Ahead of every tag, whatever the repository has released so far. */
  const newest = execFileSync("git", ["tag", "--list", "v*", "--sort=-v:refname"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")[0].trim();
  const next = `v${Number(newest.replace(/^v/, "").split(".")[0]) + 1}.0.0`;
  try {
    const pkg = JSON.parse(original);
    pkg.version = next.slice(1);
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    run(["catalog"]);
    const index = JSON.parse(fs.readFileSync(path.join(ROOT, "dist/runtime.json"), "utf8"));
    assert.equal(index.latest, next, "the release being prepared is the newest entry");
    const pending = JSON.parse(fs.readFileSync(path.join(ROOT, "dist", `runtime/${next}.json`), "utf8"));
    /* Built from the tree, because the tag does not exist yet: exactly the release
       commit's own manifest, once `release` bumps cdnBase. */
    assert.equal(pending.tag, next);
    assert.ok(pending.assets.length > 0);
  } finally {
    fs.writeFileSync(file, original);
    run(["catalog"]);
  }
});

test("release refuses a version that is not newer, and a missing CHANGELOG section", () => {
  const oldest = runFailing(["release", "0.0.1"]);
  assert.ok(oldest, "release should have refused");
  assert.match(oldest, /is not newer than|already exists/);

  const missing = runFailing(["release", "99.0.0"]);
  assert.ok(missing, "release should have refused");
  assert.match(missing, /CHANGELOG\.md has no "## v99\.0\.0/);
});

test("release --dry-run prints the plan and writes nothing", () => {
  const changelog = path.join(ROOT, "CHANGELOG.md");
  const manifest = path.join(ROOT, "manifest.json");
  const original = fs.readFileSync(changelog, "utf8");
  const beforeManifest = fs.readFileSync(manifest, "utf8");
  try {
    fs.writeFileSync(changelog, original.replace("# Changelog\n", "# Changelog\n\n## v99.0.0 — 2026-01-01\n\nDry run.\n"));
    const out = run(["release", "99.0.0", "--dry-run"]);
    assert.match(out, /release: v99\.0\.0/);
    assert.match(out, /cdnBase .* → .*@v99\.0\.0\/dist\/cdn/);
    assert.match(out, /--dry-run, nothing written/);
    assert.equal(fs.readFileSync(manifest, "utf8"), beforeManifest, "a dry run must not write");
    assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version.endsWith("99.0.0"), false);
  } finally {
    fs.writeFileSync(changelog, original);
  }
});
