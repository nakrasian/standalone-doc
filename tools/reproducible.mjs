#!/usr/bin/env node
/* tools/reproducible.mjs — make a .docx (or .pptx/.odt/.epub) byte-identical across runs.
 *
 *   node tools/reproducible.mjs in.docx out.docx
 *   import { normalise } from "./reproducible.mjs"
 *
 * Pandoc writes two kinds of wall-clock into a docx, and `cmp -l` shows both:
 *
 *   1. every zip entry's DOS timestamp (local header + central directory);
 *   2. `docProps/core.xml` — `dcterms:created` and `dcterms:modified`, ISO seconds.
 *
 * `SOURCE_DATE_EPOCH` is the standard answer and pandoc knows it (the string is in the
 * 3.10 binary), but a browser cannot hand the wasm instance an environment
 * (`pandoc-wasm` instantiates WASI with `env = []`), so the same document would be
 * reproducible from the CLI and not from the document. This pass is engine-independent:
 * it rewrites the archive, not the writer.
 *
 * No dependency: zlib is in Node, and a zip's layout is small enough to read honestly.
 * Entries are copied *compressed*, so a 12 MB figure is inflated only when it is core.xml.
 * The fixed date is the zip epoch (1980-01-01), not 1970: DOS time cannot express it.
 */
import fs from "node:fs";
import zlib from "node:zlib";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const DOS_DATE = 0x0021; /* 1980-01-01 */
const DOS_TIME = 0x0000;
const EPOCH = "1980-01-01T00:00:00Z";

/* The one entry whose *content* carries a clock. Everything else is bytes. */
const DATED = /^docProps\/core\.xml$/;

/** Rewrite the dates inside core.xml without caring which of them are present. */
function stampCore(xml) {
  return xml.replace(
    /(<dcterms:(?:created|modified)\b[^>]*>)[^<]*(<\/dcterms:(?:created|modified)>)/g,
    (_, open, close) => open + EPOCH + close,
  );
}

function parseEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let at = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(at) !== SIG_CENTRAL) throw new Error(`central directory is corrupt at ${at}`);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localOffset = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    if (flags & 0x08) throw new Error(`${name}: data descriptor (streamed) entries are not supported`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataAt = localOffset + 30 + localNameLen + localExtraLen;
    entries.push({name, method, crc, compSize, size, dataAt, data: buf.subarray(dataAt, dataAt + compSize)});
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Rebuild an archive, letting `transform(name, bytes)` return replacement content for
 * chosen entries (or null to copy them compressed and untouched). Everything else — every
 * timestamp, every extra field — is normalised on the way through, so a docx built by this
 * function is reproducible by construction.
 */
export function rewrite(buf, transform = () => null) {
  const entries = parseEntries(buf);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    let {method, crc, compSize, size, data} = entry;
    const replacement = transform(entry.name, method === 0 ? data : zlib.inflateRawSync(data));
    if (replacement) {
      const deflated = zlib.deflateRawSync(Buffer.from(replacement), {level: 9});
      data = deflated;
      method = 8;
      compSize = deflated.length;
      size = replacement.length;
      crc = zlib.crc32 ? zlib.crc32(replacement) : crc32(replacement);
    }

    const name = Buffer.from(entry.name, "utf8");
    /* The extra field is dropped on purpose: 0x5455 (extended timestamp) carries a Unix
       mtime that would survive every other fix. Nothing here needs it to extract. */
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);          /* version needed */
    local.writeUInt16LE(0x0800, 6);      /* UTF-8 names */
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compSize, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(SIG_CENTRAL, 0);
    dir.writeUInt16LE(20, 4);            /* version made by */
    dir.writeUInt16LE(20, 6);            /* version needed */
    dir.writeUInt16LE(0x0800, 8);        /* flags: UTF-8 */
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compSize, 20);
    dir.writeUInt32LE(size, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);            /* disk start */
    dir.writeUInt16LE(0, 36);            /* internal attrs */
    dir.writeUInt32LE(0, 38);            /* external attrs: 0 for every entry */
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + data.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);             /* no comment */
  return Buffer.concat([...chunks, cd, eocd]);
}

/** The archive's contents, inflated — for tests and for anything that must look inside. */
export function entries(buf) {
  return parseEntries(buf).map((entry) => ({
    name: entry.name,
    data: entry.method === 0 ? Buffer.from(entry.data) : zlib.inflateRawSync(entry.data),
  }));
}

/** The docx-specific default: pin core.xml's clock, copy everything else. */
export function normalise(buf) {
  return rewrite(buf, (name, bytes) =>
    DATED.test(name) ? Buffer.from(stampCore(bytes.toString("utf8")), "utf8") : null);
}

/* zlib.crc32 arrived in Node 20.12; the fallback keeps this usable on 20.0–20.11. */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ------------------------------------------------------------------- CLI ---- */
if (process.argv[1] && process.argv[1].endsWith("reproducible.mjs")) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    console.error("usage: node tools/reproducible.mjs in.docx out.docx");
    process.exit(2);
  }
  const out = normalise(fs.readFileSync(from));
  fs.writeFileSync(to, out);
  console.log(`${from} → ${to}: ${out.length} bytes, ${EPOCH} throughout`);
}
