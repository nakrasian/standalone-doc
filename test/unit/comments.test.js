import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anchorOf,
  commentAt,
  merge,
  normalizeWithMap,
  parseStore,
  replyTo,
  resolveAnchor,
  segmentsOf,
  serializeStore,
  textIndex,
  validComment,
} from "../../src/comments.js";

/* The storage half of comments is pure, so the questions that lose a reviewer's work
   are testable without a browser: does an anchor survive an edit, and does a merge ever
   drop or silently overwrite a record. Both sets are derived from lab/016, which measured
   the four anchor shapes; only the shape that won (A2) is implemented. */

const BLOCKS = [
  {id: "b_alpha", text: "Ship the first draft before Friday and note where the reader is confused, because that is the paragraph this review is about."},
  {id: "b_beta", text: "Second paragraph: the phrase this is about sits here, in the middle of a sentence that keeps going for a while."},
  {id: "b_gamma", text: "Third paragraph has other words entirely, and none of them repeat."},
  {id: "b_delta", text: "Fourth: a closing note, short."},
];

const index = textIndex(BLOCKS);
/* Cross the beta/gamma boundary on purpose: the whole point of lab/016. */
const FROM = index.stream("b_beta", 18);
const TO = index.stream("b_gamma", 26);

/** A deterministic stand-in for crypto, so ids are comparable across runs. */
const RANDOM = (() => {
  let n = 0;
  return {getRandomValues(words) {for (let i = 0; i < words.length; i++) words[i] = (n++ * 2654435761) >>> 0;}};
})();

const edit = (blocks, id, fn) => blocks.map((block) => (block.id === id ? {id, text: fn(block.text)} : block));

/* The eight edits from the lab's matrix, applied at the anchor's first block. */
const MUTATIONS = {
  "insert before, same block": (blocks, at) => edit(blocks, at.blockId, (text) => "NOTE " + text),
  "insert inside the quote": (blocks, at) => edit(blocks, at.blockId, (text) => text.slice(0, at.offset + 4) + " (x) " + text.slice(at.offset + 4)),
  "rewrite the quoted words": (blocks, at) => edit(blocks, at.blockId, (text) => text.slice(0, at.offset) + "REWRITTEN" + text.slice(at.offset + 12)),
  "delete the first anchored block": (blocks, at) => blocks.filter((block) => block.id !== at.blockId),
  "split the first anchored block mid-quote": (blocks, at) => {
    const i = blocks.findIndex((block) => block.id === at.blockId);
    const cut = at.offset + 6;
    return [...blocks.slice(0, i), {id: `${at.blockId}s`, text: blocks[i].text.slice(0, cut)}, {id: at.blockId, text: blocks[i].text.slice(cut)}, ...blocks.slice(i + 1)];
  },
  "merge the anchored block into the next": (blocks, at) => {
    const i = blocks.findIndex((block) => block.id === at.blockId);
    return [...blocks.slice(0, i), {id: at.blockId, text: `${blocks[i].text} ${blocks[i + 1].text}`}, ...blocks.slice(i + 2)];
  },
  "swap two other blocks": (blocks, at) => {
    const other = blocks.filter((block) => block.id !== at.blockId);
    const next = [...blocks];
    const [a, b] = [next.indexOf(other[0]), next.indexOf(other[1])];
    [next[a], next[b]] = [next[b], next[a]];
    return next;
  },
  "repeat the quoted words elsewhere": (blocks, at) => {
    const source = blocks.find((block) => block.id === at.blockId);
    const quoted = source.text.slice(at.offset, at.offset + 40);
    return blocks.map((block, i) => (i === blocks.length - 1 ? {id: block.id, text: `${block.text} ${quoted}`} : block));
  },
};

test("an anchor names one stream range and derives its blocks", () => {
  const anchor = anchorOf(index, FROM, TO);
  assert.equal(anchor.from, FROM);
  assert.equal(anchor.to, TO);
  assert.deepEqual(anchor.blocks, ["b_beta", "b_gamma"], "a cross-block selection names both blocks");
  assert.equal(anchor.quote, "the phrase this is about sits here, in t");
  assert.equal(anchor.quote.length, 40, "the quote is a repair hint: 40 characters, never the whole range");

  const segments = segmentsOf(index, anchor.from, anchor.to);
  assert.deepEqual(segments.map((segment) => segment.blockId), ["b_beta", "b_gamma"]);
  assert.equal(segments[0].from, 18);
  assert.equal(segments[1].to, 26);
});

test("an untouched document resolves exactly", () => {
  const anchor = anchorOf(index, FROM, TO);
  const resolved = resolveAnchor(anchor, textIndex(BLOCKS));
  assert.equal(resolved.how, "exact");
  assert.equal(resolved.segments.length, 2);
});

test("the lab's eight edits never lose the words: exact, then shifted, then block", () => {
  const anchor = anchorOf(index, FROM, TO);
  /* The anchor's first block and local offset — where each mutation edits. */
  const at = index.local(anchor.from);
  const tally = {exact: 0, shifted: 0, block: 0, orphan: 0};
  const seen = {};
  for (const [label, mutate] of Object.entries(MUTATIONS)) {
    const resolved = resolveAnchor(anchor, textIndex(mutate(BLOCKS, at)));
    seen[label] = resolved.how;
    tally[resolved.how] += 1;
    assert.ok(["exact", "shifted", "block", "orphan"].includes(resolved.how), `${label}: unknown outcome ${resolved.how}`);
  }
  assert.deepEqual(seen, {
    "insert before, same block": "shifted",
    "insert inside the quote": "block",
    "rewrite the quoted words": "block",
    "delete the first anchored block": "block",
    "split the first anchored block mid-quote": "block",
    /* The lab's table says `shifted` for these two. It compared the whole range to a
       40-character quote, so *only* a range that changed could ever land there; appending
       text after the range does not move it, and `exact` is the honest answer. This is the
       one measured row the production port deliberately contradicts. */
    "merge the anchored block into the next": "exact",
    "swap two other blocks": "shifted",
    "repeat the quoted words elsewhere": "exact",
  });
  assert.equal(tally.exact, 2, "two edits leave the anchored words exactly where they were");
  assert.equal(tally.shifted, 2, "two move the range and keep it pointing at the words");
  assert.equal(tally.block, 4, "four lose the words or make them ambiguous");
  assert.equal(tally.exact + tally.shifted + tally.block + tally.orphan, 8);
});

test("a repair keeps the range's length, not the quote's", () => {
  const blocks = [
    {id: "b_a", text: "one two three four five six seven eight nine ten"},
  ];
  const local = textIndex(blocks);
  /* A 30-character range with a 10-character quote: a repair must not shrink to 10. */
  const anchor = {from: 4, to: 34, quote: "two three ", blocks: ["b_a"]};
  const shifted = textIndex([{id: "b_a", text: "XXX one two three four five six seven eight nine ten"}]);
  const resolved = resolveAnchor(anchor, shifted);
  assert.equal(resolved.how, "shifted");
  assert.equal(resolved.anchor.to - resolved.anchor.from, 30, "the range keeps its length");
});

test("a comment whose blocks are all gone is an orphan, never dropped", () => {
  const anchor = anchorOf(index, FROM, TO);
  const resolved = resolveAnchor(anchor, textIndex([{id: "b_other", text: "nothing to do with it"}]));
  assert.equal(resolved.how, "orphan");
  assert.deepEqual(resolved.segments, []);
});

test("whitespace is collapsed for matching but offsets still index the raw text", () => {
  const {normalized, map} = normalizeWithMap("a\n\n  b   c");
  assert.equal(normalized, "a b c");
  /* Every normalized character maps to the raw character that produced it. */
  assert.equal("a\n\n  b   c"[map[0]], "a");
  assert.equal("a\n\n  b   c"[map[2]], "b");
  assert.equal("a\n\n  b   c"[map[4]], "c");
});

test("the store refuses a record it cannot address and keeps the rest", () => {
  const good = {
    id: "c_1",
    anchor: {from: 0, to: 3, quote: "abc", blocks: ["b_a"]},
    author: {name: "Nadia", kind: "author"},
    body: "hi",
    resolved: false,
    replies: [],
  };
  assert.equal(validComment(good), true);
  assert.equal(validComment({...good, id: undefined}), false, "no id means it cannot be merged");
  assert.equal(validComment({...good, anchor: {}}), false, "no anchor means it cannot be shown");
  assert.equal(validComment({...good, author: {}}), false, "no author means it cannot be attributed");

  const parsed = parseStore(JSON.stringify({schema: 1, comments: [good, {id: "c_2"}]}));
  assert.deepEqual(parsed.comments.map((comment) => comment.id), ["c_1"]);
  assert.deepEqual(parseStore("not json"), {schema: 1, comments: []});
  assert.equal(serializeStore(parsed), JSON.stringify({schema: 1, comments: [good]}));
});

const AUTHOR = {name: "Nadia", kind: "author"};
const REVIEWER = {name: "Reader", kind: "reviewer"};
const T1 = "2026-11-18T10:00:00Z";
const T2 = "2026-11-18T11:00:00Z";
const T3 = "2026-11-18T12:00:00Z";

const comment = (overrides = {}) => ({
  id: "c_1",
  anchor: {from: FROM, to: TO, quote: anchorOf(index, FROM, TO).quote, blocks: ["b_beta", "b_gamma"]},
  author: AUTHOR,
  createdAt: T1,
  updatedAt: T1,
  body: "This paragraph contradicts §2.",
  resolved: false,
  replies: [],
  ...overrides,
});

const store = (...comments) => ({schema: 1, comments});

test("merging is idempotent: the same file twice adds nothing", () => {
  const incoming = store(comment(), comment({id: "c_2", body: "Another."}));
  const once = merge(store(), incoming, index);
  assert.equal(once.next.comments.length, 2);
  assert.equal(once.added, 2);
  const twice = merge(once.next, incoming, index);
  assert.deepEqual(twice.next, once.next);
  assert.equal(twice.added, 0);
  assert.equal(twice.replies, 0);
  assert.equal(twice.conflicts.length, 0);
});

test("an appended reply merges; it is not a conflict", () => {
  const local = store(comment());
  const reply = {id: "r_1", author: REVIEWER, at: T2, body: "Agreed."};
  const incoming = store(comment({replies: [reply], updatedAt: T2}));
  const result = merge(local, incoming, index);
  assert.equal(result.replies, 1);
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.next.comments[0].replies, [reply]);
});

test("a differing resolved flag is a conflict, not last-write-wins", () => {
  const local = store(comment({resolved: false}));
  const incoming = store(comment({resolved: true, updatedAt: T2}));
  const result = merge(local, incoming, index);
  assert.equal(result.next.comments[0].resolved, false, "the local value is not overwritten");
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0].incoming, {resolved: true, updatedAt: T2});

  const older = merge(local, store(comment({resolved: true, updatedAt: "2026-11-18T09:00:00Z"})), index);
  assert.equal(older.conflicts.length, 0, "an older disagreement changes nothing");
  assert.equal(older.unchanged, 1);
});

test("a reviewer's copy never replaces the author's own record", () => {
  const local = store(comment({author: AUTHOR, resolved: true, updatedAt: T3}));
  const incoming = store(comment({author: REVIEWER, resolved: false, updatedAt: T3}));
  const result = merge(local, incoming, index);
  assert.equal(result.next.comments[0].author.kind, "author");
  assert.equal(result.next.comments[0].resolved, true);
  assert.equal(result.conflicts.length, 0, "the author's word is not a conflict: it simply stands");
});

test("a reply from a reviewer still merges into the author's record", () => {
  const local = store(comment({author: AUTHOR, resolved: true}));
  const reply = {id: "r_7", author: REVIEWER, at: T2, body: "Fixed in the next draft."};
  const incoming = store(comment({author: REVIEWER, resolved: true, replies: [reply], updatedAt: T2}));
  const result = merge(local, incoming, index);
  assert.equal(result.replies, 1);
  assert.equal(result.next.comments[0].author.kind, "author");
});

test("an import whose blocks are gone is kept and counted as an orphan", () => {
  const incoming = store(comment({anchor: {from: 0, to: 5, quote: "gone", blocks: ["b_missing"]}}));
  const result = merge(store(), incoming, index);
  assert.equal(result.next.comments.length, 1, "never dropped");
  assert.equal(result.orphans, 1);
  assert.equal(result.added, 0);
});

test("a comment and a reply get ids from the two namespaces", () => {
  const anchor = anchorOf(index, FROM, TO);
  const created = commentAt({anchor, body: "  note  ", author: AUTHOR, now: T1, random: RANDOM});
  assert.match(created.id, /^c_[0-9a-z]{8}$/);
  assert.equal(created.body, "note", "the body is trimmed");
  assert.equal(created.resolved, false);
  assert.equal(created.replies.length, 0);

  const replied = replyTo(created, {body: "ok", author: REVIEWER, now: T2, random: RANDOM});
  assert.match(replied.replies[0].id, /^r_[0-9a-z]{8}$/);
  assert.equal(replied.updatedAt, T2);
  assert.equal(replied.body, created.body, "the parent is immutable");
  assert.equal(replied.replies.length, 1);
});
