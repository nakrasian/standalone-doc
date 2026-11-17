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

test("dist/editor.html, when present, is byte-identical to index.html", () => {
  const dist = path.join(ROOT, "dist/editor.html");
  if (!fs.existsSync(dist)) return;
  assert.equal(
    fs.readFileSync(dist, "utf8"),
    fs.readFileSync(path.join(ROOT, "index.html"), "utf8"),
    "dist/editor.html is stale — run npm run build",
  );
});
