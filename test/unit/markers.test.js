import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* Deliberately independent of build.mjs: if the tool and the test shared an
   implementation, a parsing bug would pass both. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

const ALLOW_UNMARKED = new Set(["user-theme", "print-page", "figure-store"]);

/** Split index.html into marked regions, without trusting build.mjs. */
function regions(source) {
  const out = [];
  const lines = source.split("\n");
  let open = null;
  lines.forEach((line, i) => {
    const start = /^<!--\s*@asset\s+(.*?)\s*-->$/.exec(line);
    if (start) {
      assert.equal(open, null, `line ${i + 1}: nested @asset marker`);
      const attrs = {};
      for (const m of start[1].matchAll(/([a-z-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
      open = { ...attrs, startLine: i };
      return;
    }
    if (line === "<!-- /@asset -->") {
      assert.ok(open, `line ${i + 1}: end marker with no start`);
      out.push({
        ...open,
        endLine: i,
        openLine: lines[open.startLine + 1],
        closeLine: lines[i - 1],
        bodyLines: lines.slice(open.startLine + 2, i - 1),
      });
      open = null;
    }
  });
  assert.equal(open, null, "unclosed @asset marker");
  return out;
}

const marked = regions(html);

test("every marked region is well formed", () => {
  assert.ok(marked.length > 0, "expected at least one @asset region");
  for (const r of marked) {
    assert.match(r.openLine.trim(), /^<(style|script)\b/, `${r.id}: the line after a marker must be the element`);
  }
});

test("ids and orders are unique", () => {
  const ids = marked.map((r) => r.id);
  const orders = marked.map((r) => r.order);
  assert.equal(new Set(ids).size, ids.length, "duplicate asset id");
  assert.equal(new Set(orders).size, orders.length, "duplicate order");
  for (const r of marked) {
    assert.ok(r.id, "marker without id");
    assert.ok(["css", "js"].includes(r.kind), `${r.id}: kind must be css or js`);
    assert.ok(/^\d+$/.test(r.order), `${r.id}: order must be an integer`);
  }
});

test("the element inside a region matches its declared kind", () => {
  for (const r of marked) {
    const open = r.openLine.trim();
    const close = r.closeLine.trim();
    const tag = r.kind === "css" ? "style" : "script";
    assert.ok(open.startsWith(`<${tag}`), `${r.id}: expected <${tag}>, got ${open}`);
    assert.equal(close, `</${tag}>`, `${r.id}: expected </${tag}>`);
    assert.ok(open.includes(`id="${r.id}"`), `${r.id}: the element must carry the same id`);
    assert.ok(r.bodyLines.length > 0, `${r.id}: body is empty`);
  }
});

test("no element with an id escapes the marker system", () => {
  const markedIds = new Set(marked.map((r) => r.id));
  for (const m of html.matchAll(/<(style|script)\b[^>]*\bid="([^"]+)"/g)) {
    const id = m[2];
    assert.ok(
      markedIds.has(id) || ALLOW_UNMARKED.has(id),
      `<${m[1]} id="${id}"> is neither marked nor in the runtime allowlist`,
    );
  }
});

test("manifest and markers describe the same set of assets", () => {
  assert.equal(manifest.schema, 1);
  const fromHtml = marked.map((r) => r.id).sort();
  const fromManifest = manifest.assets.map((a) => a.id).sort();
  assert.deepEqual(fromManifest, fromHtml);
});

test("each src file exists, is hashed correctly, and reproduces its body", () => {
  for (const asset of manifest.assets) {
    const file = path.join(ROOT, asset.file);
    assert.ok(fs.existsSync(file), `${asset.id}: missing ${asset.file}`);
    const disk = fs.readFileSync(file, "utf8");

    assert.equal(Buffer.byteLength(disk), asset.bytes, `${asset.id}: byte count drift`);
    const hash = "sha384-" + createHash("sha384").update(disk, "utf8").digest("base64");
    assert.equal(hash, asset.sha384, `${asset.id}: hash drift (re-run npm run split)`);

    const region = marked.find((r) => r.id === asset.id);
    const body = region.bodyLines.join("\n");

    /* Converted assets are compiled into a classic-script envelope, so src is
       ESM and the body is not a re-indentation of it. Assert the envelope
       invariants instead (deliberately without importing lib/compile.mjs, so
       this test stays independent of the implementation it checks). */
    if (body.includes("@compiled-from")) {
      assert.match(disk, /^export function create[A-Za-z0-9_$]*\(/m, `${asset.id}: src must be ESM`);
      assert.match(body, /^\s*StandaloneDoc\.register\("/m, `${asset.id}: registration line missing`);
      const factory = /^export function (create[A-Za-z0-9_$]*)\s*\(/m.exec(disk)?.[1];
      assert.ok(factory, `${asset.id}: no create<Name> export`);
      assert.ok(body.includes(`StandaloneDoc.register("${asset.id}", ${factory}, `), `${asset.id}: registration does not name ${factory}`);
      for (const m of disk.matchAll(/^export function ([A-Za-z_$][\w$]*)\s*\(/gm)) {
        assert.ok(body.includes(`function ${m[1]}(`), `${asset.id}: ${m[1]} is not present in the compiled body`);
      }
      return;
    }
    const srcLines = disk.replace(/\n$/, "").split("\n");

    /* Re-add the body's common indent, then compare line for line. */
    const indents = body
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => /^[ \t]*/.exec(l)[0]);
    const indent = indents.length ? indents.reduce((a, b) => (a.length <= b.length ? a : b)) : "";

    const rebuilt = srcLines.map((l) => (l === "" ? "" : indent + l)).join("\n");
    assert.equal(rebuilt, body, `${asset.id}: ${asset.file} does not match index.html`);
  }
});

test("every asset declares a mode and at least one mode that requires it", () => {
  for (const asset of manifest.assets) {
    assert.ok(["inline", "online", "disabled"].includes(asset.mode), `${asset.id}: bad mode ${asset.mode}`);
    assert.ok(Array.isArray(asset.requiredBy) && asset.requiredBy.length > 0, `${asset.id}: requiredBy`);
  }
});
