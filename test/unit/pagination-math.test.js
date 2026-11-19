import { test } from "node:test";
import assert from "node:assert/strict";
import {
  layoutPoint,
  layoutRect,
  pageContentBottom,
  pageContentTop,
  toLayout,
} from "../../src/layout.js";

/* The lab's premise, restated as a test: assert relationships between numbers, not
   appearances, and put the numbers in the failure message. These are the pure half of
   pagination — the half that can be fuzzed in node without a browser. */

/* Deterministic PRNG: a failing case must be reproducible from its seed. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

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
