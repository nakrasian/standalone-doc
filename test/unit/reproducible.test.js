import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { entries, normalise, rewrite } from "../../tools/reproducible.mjs";

/* A .docx is a zip, and a zip carries the clock twice: every entry's DOS timestamp, and
 * `docProps/core.xml`'s dcterms:created/modified. Pandoc writes both from the wall clock,
 * so two exports of one document differ in bytes — and "verified export" needs one answer.
 *
 * The fix must not depend on the writer: `SOURCE_DATE_EPOCH` works when the engine can read
 * an environment (the CLI, and our own wasm glue), and a browser package that instantiates
 * WASI with `env = []` cannot. So the archive is rewritten instead.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** A zip with stored entries and a chosen DOS timestamp — enough to be read back. */
function zip(entries, {time = 0x6000, date = 0x5a21} = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);       /* stored */
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(SIG_CENTRAL, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const CORE = '<?xml version="1.0"?><cp:coreProperties>'
  + "<dcterms:created>2026-11-18T03:32:21Z</dcterms:created>"
  + "<dcterms:modified>2026-11-18T03:32:21Z</dcterms:modified></cp:coreProperties>";

test("two exports that differ only by the clock normalise to the same bytes", () => {
  const first = zip({"[Content_Types].xml": "<Types/>", "docProps/core.xml": CORE});
  const second = zip({"[Content_Types].xml": "<Types/>", "docProps/core.xml": CORE},
    {time: 0x7000, date: 0x5b22});
  assert.notEqual(first.toString("base64"), second.toString("base64"), "the fixture must differ");
  assert.equal(normalise(first).toString("base64"), normalise(second).toString("base64"));
});

test("the timestamps are the zip epoch, and core.xml is stamped", () => {
  const fixed = normalise(zip({"[Content_Types].xml": "<Types/>", "docProps/core.xml": CORE}));
  /* Local header offset 10 is DOS time, 12 is DOS date: 1980-01-01, midnight. */
  assert.equal(fixed.readUInt16LE(10), 0);
  assert.equal(fixed.readUInt16LE(12), 0x0021);
  const core = entries(fixed).find((entry) => entry.name === "docProps/core.xml").data.toString("utf8");
  assert.match(core, /1980-01-01T00:00:00Z/);
  assert.doesNotMatch(core, /2026-11-18/);
});

test("normalising twice is a no-op", () => {
  const once = normalise(zip({"[Content_Types].xml": "<Types/>", "docProps/core.xml": CORE}));
  const twice = normalise(once);
  assert.equal(once.toString("base64"), twice.toString("base64"));
});

test("rewrite() can replace any entry, and the archive still reads", () => {
  const source = zip({"word/document.xml": "<w:document/>", "docProps/core.xml": CORE});
  const patched = rewrite(source, (name, bytes) =>
    name === "word/document.xml" ? Buffer.from(`<w:patched>${bytes.length}</w:patched>`) : null);
  const document = entries(patched).find((entry) => entry.name === "word/document.xml").data.toString("utf8");
  assert.match(document, /<w:patched>13<\/w:patched>/);
  /* A rewritten archive is still a zip, and normalise()'s own output is a fixed point. */
  assert.equal(entries(patched).length, 2);
  const once = normalise(patched);
  assert.equal(normalise(once).toString("base64"), once.toString("base64"));
});

test("a non-zip is refused by name, not by accident", () => {
  assert.throws(() => normalise(Buffer.from("<!doctype html>")), /end-of-central-directory/);
});
