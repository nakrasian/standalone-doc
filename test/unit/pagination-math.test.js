import { test } from "node:test";
import assert from "node:assert/strict";
import {
  layoutPoint,
  layoutRect,
  pageContentBottom,
  pageContentTop,
  toLayout,
} from "../../src/layout.js";
import {
  DEFAULT_STRATEGIES,
  checkPass,
  chooseCut,
  lineForRoom,
  strategyForTag,
  wordBoundary,
} from "../../src/pagination.js";

/* The lab's premise, restated as a test: assert relationships between numbers, not
   appearances, and put the numbers in the failure message. Everything below is the pure
   half of pagination — the half that can be fuzzed in node without a browser. */

/* Deterministic PRNG: a failing case must be reproducible from its seed. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/* ------------------------------------------------------------ layout invariance */

test("a layout point ignores where the stage happens to be scrolled", () => {
  const rnd = random(1);
  for (let i = 0; i < 500; i++) {
    const scale = 0.5 + rnd() * 2.5;
    const origin = {left: rnd() * 200, top: rnd() * 400, scale};
    /* Layout point the block really occupies. */
    const y = rnd() * 3000;
    const x = rnd() * 700;
    /* Scrolling moves both the origin and the client point by the same amount. */
    const scroll = rnd() * 5000;
    const here = layoutPoint(origin.left + x * scale, origin.top + y * scale, origin);
    const scrolled = layoutPoint(
      origin.left + x * scale,
      origin.top + y * scale - scroll,
      {left: origin.left, top: origin.top - scroll, scale},
    );
    assert.equal(Math.round(here.y * 100), Math.round(scrolled.y * 100), `scroll ${scroll} changed y`);
    assert.equal(Math.round(here.x * 100), Math.round(scrolled.x * 100), `scroll ${scroll} changed x`);
    assert.equal(Math.round(here.y), Math.round(y), `expected ${Math.round(y)}, got ${here.y}`);
  }
});

test("a layout point ignores zoom: the client pixels scale, the coordinate does not", () => {
  const rnd = random(2);
  for (let i = 0; i < 500; i++) {
    const origin = {left: 40 + rnd() * 60, top: 30 + rnd() * 60, scale: 1};
    const x = rnd() * 700;
    const y = rnd() * 3000;
    const base = layoutPoint(origin.left + x, origin.top + y, origin);
    for (const scale of [0.5, 0.67, 1, 1.5, 2, 3]) {
      const zoomed = layoutPoint(origin.left + x * scale, origin.top + y * scale, {...origin, scale});
      assert.equal(Math.round(zoomed.x * 100), Math.round(base.x * 100), `zoom ${scale} changed x`);
      assert.equal(Math.round(zoomed.y * 100), Math.round(base.y * 100), `zoom ${scale} changed y`);
    }
  }
});

test("toLayout is only a division, and page edges are the plan's arithmetic", () => {
  assert.equal(toLayout(100, 2), 50);
  assert.equal(toLayout(100, 0), 100, "a zero scale is not a division by zero");
  const page = {top: 1040, avail: 780};
  assert.equal(pageContentTop(page, 86), 1126);
  assert.equal(pageContentBottom(page, 86), 1906);
  assert.equal(pageContentBottom(page, 86) - pageContentTop(page, 86), page.avail);
});

test("a rect's corners are the points layoutPoint would name", () => {
  const origin = {left: 10, top: 20, scale: 2};
  const box = {left: 30, top: 60, right: 90, bottom: 120, width: 60, height: 60};
  const rect = layoutRect(box, origin);
  const topLeft = layoutPoint(box.left, box.top, origin);
  const bottomRight = layoutPoint(box.right, box.bottom, origin);
  assert.deepEqual({left: rect.left, top: rect.top}, {left: topLeft.x, top: topLeft.y});
  assert.deepEqual({left: rect.right, top: rect.bottom}, {left: bottomRight.x, top: bottomRight.y});
  assert.equal(rect.width, 30);
  assert.equal(rect.height, 30);
});

/* ----------------------------------------------------------------- word boundary */

test("the cut backs up to the start of the word it landed in", () => {
  const text = "alpha beta gamma delta";
  assert.equal(wordBoundary(text, 6), 6, "already at a word start");
  assert.equal(wordBoundary(text, 8), 6, "inside beta");
  assert.equal(wordBoundary(text, 11), 11, "at gamma");
  assert.equal(wordBoundary(text, text.length), 17, "inside delta");
});

test("text with no whitespace keeps the geometric cut", () => {
  const text = "x".repeat(40);
  assert.equal(wordBoundary(text, 17), 17, "a URL has no boundary to back up to");
  const cjk = "日本語の文章です";
  assert.equal(wordBoundary(cjk, 4), 4, "CJK prose has no spaces either");
});

test("wordBoundary is a pure function of its offset and never grows it", () => {
  const rnd = random(3);
  for (let i = 0; i < 2000; i++) {
    const words = 1 + Math.floor(rnd() * 12);
    const text = Array.from({length: words}, () => "w".repeat(1 + Math.floor(rnd() * 6))).join(" ");
    const offset = 1 + Math.floor(rnd() * text.length);
    const at = wordBoundary(text, offset);
    assert.ok(at >= 1 && at <= offset, `offset ${offset} → ${at}`);
    assert.equal(wordBoundary(text, at), at, `not idempotent at ${at}`);
    if (at !== offset) {
      assert.match(text[at - 1], /\s/, `cut ${at} is not a word start in ${JSON.stringify(text)}`);
    }
  }
});

/* ----------------------------------------------------------------- the line choice */

test("lineForRoom needs at least two lines of head and never splits a block that fits", () => {
  const lines = [{top: 0, bottom: 18}, {top: 18, bottom: 36}, {top: 36, bottom: 54}];
  assert.equal(lineForRoom(lines, 0, 100), -1, "the block fits: nothing to cut");
  assert.equal(lineForRoom(lines, 0, 40), 1, "two lines fit");
  assert.equal(lineForRoom(lines, 0, 20), -1, "a one-line head is a widow: push the block");
  assert.equal(lineForRoom(lines, 0, 5), -1);
  assert.equal(lineForRoom([], 0, 100), -1);
});

test("chooseCut recomputes the head height after the word-boundary back-off", () => {
  /* Two normal lines, then a long unbreakable word that starts exactly at line 3 and runs
     through line 5. The geometric cut is line 5 (four lines of head); the word back-off
     moves the cut to the word's start on line 3, so the head is two lines. A plan that
     kept the pre-back-off height would under-count the tail by two lines. */
  const text = "aa bb cc dd ee ff " + "Z".repeat(30) + " end";
  const breaks = [9, 18, 28, 38]; // line 0,1,2,3 end before these offsets
  const lineOf = new Array(text.length).fill(0);
  for (let i = 0; i < text.length; i++) {
    lineOf[i] = breaks.filter((at) => i >= at).length;
  }
  const lines = [0, 1, 2, 3, 4].map((i) => ({top: i * 18, bottom: (i + 1) * 18}));
  const topAt = (offset) => (offset < 1 ? -Infinity : lines[lineOf[offset - 1]].top);
  const bottomAt = (offset) => (offset < 1 ? -Infinity : lines[lineOf[offset - 1]].bottom);

  const cut = chooseCut({
    text,
    lines,
    blockTop: 0,
    room: 76, // four lines fit; the block has five
    lineTopAt: topAt,
    lineBottomAt: bottomAt,
  });
  assert.ok(cut, "a two-line head is a legal split");
  assert.equal(cut.offset, 18, "the tail starts at the long word");
  assert.equal(text.slice(cut.offset, cut.offset + 1), "Z");
  assert.equal(cut.headBottom, lines[1].bottom, `head bottom ${cut.headBottom}, expected ${lines[1].bottom}`);
  assert.equal(cut.headHeight, 36, "two lines, not the geometric four");
  assert.ok(cut.headHeight <= 76, "the head fits the room");
  assert.equal(cut.geometric, 39, `geometric ${cut.geometric}, expected 39`);
});

test("chooseCut can cut a segment that starts mid-block", () => {
  /* Six lines of ordinary text; the second segment starts at line 4's first character and
     may use two lines. The cut must be after `start`, and the head height is measured from
     the segment's top, not the block's. */
  const text = "aa bb cc dd ee ff gg hh ii jj kk ll mm nn oo pp qq rr ss";
  const lineOf = new Array(text.length).fill(0);
  const breaks = [9, 18, 27, 36, 45, 54];
  for (let i = 0; i < text.length; i++) lineOf[i] = breaks.filter((at) => i >= at).length;
  const lines = [0, 1, 2, 3, 4, 5, 6].map((i) => ({top: i * 18, bottom: (i + 1) * 18}));
  const start = 36; // first character of line 4 (0-based)
  const cut = chooseCut({
    text,
    lines: lines.slice(4),
    blockTop: lines[4].top,
    room: 37, /* two lines of the segment */
    lineTopAt: (offset) => (offset < 1 ? -Infinity : lines[lineOf[offset - 1]].top),
    lineBottomAt: (offset) => (offset < 1 ? -Infinity : lines[lineOf[offset - 1]].bottom),
    start,
  });
  assert.ok(cut, "a two-line segment is a legal cut");
  assert.ok(cut.offset > start, `cut ${cut.offset} must be after the segment start ${start}`);
  assert.ok(cut.headHeight <= 36, `head ${cut.headHeight} exceeds the segment room`);
  assert.equal(cut.headBottom, lines[lineOf[cut.offset - 1]].bottom);
});

test("chooseCut pushes a block whose head the back-off shrank below the widow guard", () => {
  /* "aaaa " then a word that starts on line 2 and runs to line 3: backing up leaves one
     line of head, so the block moves whole instead of leaving a line alone on a page. */
  const text = "aaaa bbbbbbbbbbbbbbbbbbbbbb";
  const lineOf = new Array(text.length).fill(0).map((_, i) => (i < 5 ? 0 : i < 15 ? 1 : 2));
  const lines = [0, 1, 2].map((i) => ({top: i * 18, bottom: (i + 1) * 18}));
  const cut = chooseCut({
    text,
    lines,
    blockTop: 0,
    room: 36,
    lineTopAt: (o) => (o < 1 ? -Infinity : lines[lineOf[o - 1]].top),
    lineBottomAt: (o) => (o < 1 ? -Infinity : lines[lineOf[o - 1]].bottom),
  });
  assert.equal(cut, null);
});

test("chooseCut's invariants survive a seeded document generator", () => {
  const rnd = random(4);
  for (let i = 0; i < 3000; i++) {
    const words = 3 + Math.floor(rnd() * 40);
    const text = Array.from({length: words}, () => "w".repeat(1 + Math.floor(rnd() * 9))).join(" ");
    const lineCount = 2 + Math.floor(rnd() * 14);
    /* Assign every character to a line, monotonically; lines may break mid-word. */
    const lineOf = new Array(text.length).fill(0);
    const breakpoints = [];
    for (let line = 1; line < lineCount; line++) {
      breakpoints.push(1 + Math.floor(rnd() * (text.length - 1)));
    }
    breakpoints.sort((a, b) => a - b);
    for (let c = 0; c < text.length; c++) {
      lineOf[c] = breakpoints.filter((at) => c >= at).length;
    }
    const height = 12 + rnd() * 20;
    const lines = Array.from({length: lineCount}, (_, l) => ({
      top: l * height,
      bottom: (l + 1) * height,
    }));
    const room = height + rnd() * height * (lineCount - 1);
    const blockTop = rnd() * 10;
    const topAt = (offset) => (offset < 1 ? -Infinity : lines[lineOf[offset - 1]].top);
    const bottomAt = (offset) => (offset < 1 ? -Infinity : lines[lineOf[offset - 1]].bottom);
    /* Half the cases start mid-block, at a line boundary: the N-cut path. The caller
       passes the segment's lines and the segment's top, not the block's. */
    let start = 0;
    let segmentLines = lines;
    let segmentTop = blockTop;
    if (rnd() < 0.5) {
      const line = Math.floor(rnd() * Math.max(1, lineCount - 1));
      start = lineOf.findIndex((value) => value >= line);
      if (start < 0 || start >= text.length - 1) start = 0;
      const first = lineOf[start] ?? 0;
      segmentLines = lines.slice(first);
      segmentTop = lines[first].top;
    }

    const cut = chooseCut({
      text,
      lines: segmentLines,
      blockTop: segmentTop,
      room,
      lineTopAt: topAt,
      lineBottomAt: bottomAt,
      start,
    });
    if (!cut) continue;
    assert.ok(cut.offset >= Math.max(1, start + 1) && cut.offset <= text.length - 1, `case ${i}: offset ${cut.offset} of ${text.length}, start ${start}`);
    assert.ok(cut.offset <= cut.geometric, `case ${i}: back-off grew the offset`);
    assert.ok(cut.headHeight >= 0, `case ${i}: negative head`);
    assert.ok(cut.headHeight <= room + 1, `case ${i}: head ${cut.headHeight} > room ${room}`);
    assert.equal(cut.headBottom, bottomAt(cut.offset), `case ${i}: head bottom is not the measured one`);
    /* Either the cut is at the geometric line start, or the character before it is the
       whitespace that proves a word boundary. */
    /* A word that straddles the segment start is clamped to start + 1, which is
       necessarily mid-word; every other back-off must be a word start. */
    if (cut.offset !== cut.geometric && cut.offset !== start + 1) {
      assert.match(text[cut.offset - 1], /\s/, `case ${i}: cut ${cut.offset} is not a word start`);
    }
  }
});

/* --------------------------------------------------------------- post-conditions */

function fakePass({fragTop = 100, margin = "0px", text = "ab", textBefore = "ab", items, extraFrags = []} = {}) {
  /* One block object, shared: `checkPass` locates a cut block by identity in the plan,
     and requires the fragment to be a child of it. */
  const block = {id: "block", querySelectorAll: () => []};
  const frag = {
    dataset: {frag: "3"},
    style: {marginBlockStart: margin},
    textContent: "b",
    parentElement: block,
    querySelector: () => null,
  };
  const frags = [frag, ...extraFrags];
  const content = {
    textContent: text,
    querySelectorAll: (selector) => (selector === "[data-frag]" ? frags : []),
  };
  return checkPass({
    content,
    applied: [{block, offset: 3, targetTop: 100}],
    plan: {blocks: [block], pages: [{items: items ?? [{block: 0, from: 0, to: 3}, {block: 0, from: 3, to: null}]}]},
    pageTops: [100],
    pageBottoms: [200],
    textBefore,
    rectOf: () => ({top: fragTop}),
  });
}

test("checkPass accepts a pass that landed on the page top", () => {
  const check = fakePass();
  assert.equal(check.ok, true, check.failures.join("; "));
  assert.equal(check.failures.length, 0);
});

test("checkPass names the numbers when the tail misses the page top", () => {
  const check = fakePass({fragTop: 118});
  assert.equal(check.ok, false);
  assert.match(check.failures.join("; "), /tail at 118, target 100 \(off by 18\)/);
});

test("checkPass catches a merge that lost text", () => {
  const check = fakePass({text: "ab", textBefore: "abc"});
  assert.equal(check.ok, false);
  assert.match(check.failures.join("; "), /text changed by -1 characters/);
});

test("checkPass catches a from/to seam that does not meet", () => {
  const check = fakePass({items: [{block: 0, from: 0, to: 3}, {block: 0, from: 4, to: null}]});
  assert.equal(check.ok, false);
  assert.match(check.failures.join("; "), /from\/to do not meet at item 0 \(3 vs 4\)/);
});

test("checkPass counts fragments against cuts", () => {
  const extra = {
    dataset: {frag: "9"},
    style: {marginBlockStart: "0px"},
    textContent: "z",
    parentElement: {querySelectorAll: () => []},
    querySelector: () => null,
  };
  const check = fakePass({extraFrags: [extra]});
  assert.equal(check.ok, false);
  assert.match(check.failures.join("; "), /2 fragment\(s\) for 1 cut\(s\)/);
});


/* --------------------------------------------------------------- block strategies */

test("the strategy table names every block type the planner can meet", () => {
  for (const tag of ["p", "blockquote", "h1", "h2", "h3", "pre", "table", "figure", "hr", "ul", "ol", "li", "div"]) {
    assert.ok(DEFAULT_STRATEGIES[tag], `${tag} has no strategy`);
  }
  /* Defaults are the safe ones: an unknown tag is atomic. */
  assert.deepEqual(strategyForTag("video"), {kind: "atomic", keepWithNext: false});
});

test("a paragraph is lines; a replaced inline makes it atomic", () => {
  assert.equal(strategyForTag("p").kind, "lines");
  assert.equal(strategyForTag("p", {replaced: true}).kind, "atomic");
});

test("a blockquote is lines only when its children are inline", () => {
  assert.equal(strategyForTag("blockquote").kind, "lines");
  assert.equal(strategyForTag("blockquote", {blockChildren: true}).kind, "atomic");
});

test("headings are whole, and keepWithNext is a property, not a policy", () => {
  for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
    assert.equal(strategyForTag(tag).kind, "whole");
    assert.equal(strategyForTag(tag).keepWithNext, false, `${tag} must not move itself`);
  }
});
