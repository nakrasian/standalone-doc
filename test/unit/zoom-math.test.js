import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX, MIN, STEPS, TYPE_MAX, TYPE_MIN, clamp, nearest, parsePercent } from "../../src/zoom.js";

/* Importing src/zoom.js must not touch the DOM: everything environment-bound
   lives inside createZoom(). That is what makes these tests possible, and it is
   enforced by the module-shape rule in CONTRIBUTING. */

test("parsePercent accepts the shapes a person types", () => {
  assert.equal(parsePercent("150"), 150);
  assert.equal(parsePercent("150%"), 150);
  assert.equal(parsePercent(" 150 % "), 150);
  assert.equal(parsePercent("1,5"), 1.5, "comma decimal");
  assert.equal(parsePercent("067"), 67, "leading zero is not octal");
});

test("parsePercent rejects nonsense", () => {
  assert.equal(parsePercent("abc"), null);
  assert.equal(parsePercent(""), null);
  assert.equal(parsePercent("%%"), null);
  assert.equal(parsePercent(undefined), null);
});

test("clamp holds the typed-value range", () => {
  assert.equal(clamp(0.05), TYPE_MIN);
  assert.equal(clamp(9), TYPE_MAX);
  assert.equal(clamp(1), 1);
  assert.equal(clamp(TYPE_MIN), TYPE_MIN);
});

test("nearest picks stops in log space, not linear space", () => {
  for (const stop of STEPS) assert.equal(nearest(stop), stop, `exact stop ${stop}`);
  assert.equal(nearest(0.72), 0.75);
  assert.equal(nearest(0.55), 0.5);
  /* 2.2 is 9.1% above 2 but 13.6% below 2.5; in log space it is closer to 2. */
  assert.equal(nearest(2.2), 2);
});

test("the boundary between two stops is their geometric mean", () => {
  const mid = Math.sqrt(2 * 2.5); // ≈ 2.2360
  assert.equal(nearest(mid - 0.001), 2);
  assert.equal(nearest(mid + 0.001), 2.5);
  /* Stops are not evenly spaced, so the mirrored value of 1.05 does not pick
     the mirrored stop: 1.1 is 4.65% above 1.05, 1 is 4.88% below. */
  assert.equal(nearest(1.05), 1.1);
  assert.equal(nearest(0.95), 1);
});

test("the step table is ordered and spans the button limits", () => {
  assert.deepEqual([...STEPS].sort((a, b) => a - b), STEPS);
  assert.equal(MIN, STEPS[0]);
  assert.equal(MAX, STEPS[STEPS.length - 1]);
  assert.ok(MIN >= TYPE_MIN && MAX <= TYPE_MAX);
});
