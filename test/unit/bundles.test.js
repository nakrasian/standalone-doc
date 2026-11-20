import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleProblems } from "../../tools/publish-plugin.mjs";

/* A published binary is fetched by url, and the CDN decides whether that url is even
   readable. jsDelivr refuses a list of extensions (403) and serves nothing extensionless
   (404); v0.8.1 shipped `reference.docx` that way and lost the Word reference styling in
   silence. `bundleProblems()` is where that class dies, before a tag exists. */

const INTEGRITY = "sha384-" + "A".repeat(64);

function manifestWith(url) {
  return {
    schema: 1, id: "widget", label: "Widget", version: "0.1.0", api: 1,
    island: "sealed", entry: "widget",
    assets: [{
      id: "widget", kind: "js", role: "module", order: 300, mode: "online",
      category: "plugin", plugin: "widget", requiredBy: ["*"],
      bytes: 10, factory: "createWidget", integrity: INTEGRITY, url,
    }],
  };
}

/* cdnBase points somewhere else on purpose: these are the url-only claims, and the disk
   check for bytes this repository publishes is exercised by the build tests. */
const options = { cdnBase: "https://example.invalid/cdn" };

test("a blocked extension on jsDelivr is refused at build time", () => {
  const problems = bundleProblems(manifestWith("https://cdn.jsdelivr.net/gh/o/r@v1/reference.docx"), options);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /jsDelivr refuses \.docx \(403\)/);
});

test("an extensionless jsDelivr url is refused too", () => {
  const problems = bundleProblems(manifestWith("https://cdn.jsdelivr.net/gh/o/r@v1/reference"), options);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no extensionless file \(404\)/);
});

test("the measured-good extensions and npm pins are accepted", () => {
  for (const url of [
    "https://cdn.jsdelivr.net/gh/o/r@v1/reference.bin",
    "https://cdn.jsdelivr.net/gh/o/r@v1/filter.lua",
    "https://cdn.jsdelivr.net/npm/pandoc-wasm@1.1.0/src/pandoc.wasm",
    /* Someone else's host is not ours to police: raw.githubusercontent serves .docx. */
    "https://raw.githubusercontent.com/o/r/v1/reference.docx",
  ]) {
    assert.deepEqual(bundleProblems(manifestWith(url), options), [], url);
  }
});

/* The cap that broke v0.12.0's Word export: 58.6 MB of pandoc.wasm, pinned on jsDelivr,
   answered 403 "File size exceeded the configured limit of 50 MB". The manifest declares the
   size, so the refusal belongs here rather than in somebody's console. */
test("a jsDelivr pin declared over 50 MB is refused", () => {
  const manifest = manifestWith("https://cdn.jsdelivr.net/npm/pandoc-wasm@1.1.0/src/pandoc.wasm");
  manifest.assets[0].bytes = 58_580_800;
  const problems = bundleProblems(manifest, options);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /refuses a file over 50 MB \(403, 58580800 bytes declared\)/);
});

test("the same bytes on a host without the cap are accepted", () => {
  const manifest = manifestWith("https://unpkg.com/pandoc-wasm@1.1.0/src/pandoc.wasm");
  manifest.assets[0].bytes = 58_580_800;
  assert.deepEqual(bundleProblems(manifest, options), []);
});
