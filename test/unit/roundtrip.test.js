import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("npm run verify passes", () => {
  const out = execFileSync(process.execPath, ["build.mjs", "verify"], { cwd: ROOT, encoding: "utf8" });
  assert.match(out, /verify: ok/);
  assert.match(out, /round trip byte-identical/);
});

test("dist/editor.html is the source minus the chrome only a viewer builds", () => {
  const dist = path.join(ROOT, "dist/editor.html");
  if (!fs.existsSync(dist)) return;
  const editor = fs.readFileSync(dist, "utf8");
  const source = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

  /* `index.html` is the source of every asset; a flavour is a mode. Anything an editor does
     not build leaves the file, and its manifest entry keeps the pin so a document that
     becomes a viewer can fetch it. */
  for (const id of ["viewer-bar-markup", "viewer-bar-styles", "viewer-bar"]) {
    assert.ok(!editor.includes(`id="${id === "viewer-bar-markup" ? "viewer-bar" : id}"`), `${id} must not be in the editor flavour`);
    const entry = JSON.parse(/<script id="asset-manifest" type="application\/json">([\s\S]*?)<\/script>/.exec(editor)[1])
      .assets.find((asset) => asset.id === id);
    assert.equal(entry.mode, "online", `${id}: an offloaded asset is still described`);
    assert.ok(entry.url && entry.integrity, `${id}: and still pinned, so a viewer save can fetch it`);
  }
  /* Everything edit mode builds is still there. */
  for (const id of ["editor", "signals", "toolbar-markup", "viewer-bar-markup"]) {
    const inSource = source.includes(`@asset id="${id}"`);
    const inEditor = editor.includes(`@asset id="${id}"`);
    assert.equal(inEditor, id !== "viewer-bar-markup" && inSource, `${id}: presence must match the mode, not the source`);
  }
  assert.ok(editor.includes('id="editor"'), "the editor itself is in the editor flavour");
});
