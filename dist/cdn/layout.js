/* One coordinate space for pagination, the caret layer and comments.
 *
 * The rule, measured four times in lab/016: every geometry number that outlives a pass
 * must be **stage-local layout px** — a client rect minus the stage's client origin,
 * divided by the zoom factor. The bugs the lab found were all the same bug:
 *
 *   - `applyFragments()` measured a fragment with `getBoundingClientRect().top / zoom`,
 *     a viewport coordinate that still contained the stage's 117.6 px offset, and pushed
 *     the tail 82 px instead of 200 px — "the cut is not at the page boundary" (§12.1);
 *   - the comment overlay drew `range.getClientRects()` raw and painted the page gap,
 *     because the plan and the overlay disagreed about where zero is (§2);
 *   - `measureH()` divided by zoom, `pageAt()` divided by zoom, and one new call site
 *     forgot — a units question that looked like a gap (§6).
 *
 * So the arithmetic is here and nowhere else. `pagination` asks for `rect()`, the
 * fragment pass asks for `rect()`, and a caller that has only a client point uses
 * `point()`. A test asserts the property that matters: moving the scroll position,
 * changing the zoom, or repaginating must not change a layout coordinate.
 *
 * The probe elements (`#probe-*`) live *outside* `#stage` on purpose: page size is a
 * CSS custom property and must not scale with zoom, so it is measured with
 * `getBoundingClientRect()` directly and never converted here.
 */

/** A length in layout px. Pure, so the invariance test needs no DOM. */
export function toLayout(px, scale = 1) {
  return px / (scale || 1);
}

/**
 * A client point → the same point in `#stage` layout px.
 * `origin` is `{left, top, scale}` as `ctx.origin()` returns it.
 */
export function layoutPoint(clientX, clientY, origin) {
  const scale = origin.scale || 1;
  return {
    x: (clientX - origin.left) / scale,
    y: (clientY - origin.top) / scale,
  };
}

/** A client rect (`DOMRect`) → the same rect in `#stage` layout px. */
export function layoutRect(box, origin) {
  const scale = origin.scale || 1;
  return {
    left: (box.left - origin.left) / scale,
    top: (box.top - origin.top) / scale,
    right: (box.right - origin.left) / scale,
    bottom: (box.bottom - origin.top) / scale,
    width: box.width / scale,
    height: box.height / scale,
  };
}

/** The content edge of a planned page. `page` is `{top, avail}` in the plan's space. */
export function pageContentTop(page, pad) {
  return page.top + pad;
}

export function pageContentBottom(page, pad) {
  return page.top + page.avail + pad;
}

export function createLayout(deps = {}) {
  const {zoom, env = globalThis} = deps;
  const {document} = env;

  const stage = document.getElementById("stage");
  const viewport = document.getElementById("viewport");

  const scale = () => zoom.value || 1;

  /* The stage's client box is the origin, and it moves with the scroll position; that is
     why it is read once per measurement set, not stored. */
  function origin() {
    const box = stage.getBoundingClientRect();
    return {left: box.left, top: box.top, scale: scale()};
  }

  /** Layout px for an element. The only conversion a block measurement needs. */
  function rect(el) {
    return layoutRect(el.getBoundingClientRect(), origin());
  }

  /** The height `plan()` accumulates: excludes margins by construction (a page gap is a
      margin, and measuring it would double-count the gap). */
  function measureH(el) {
    return el.getBoundingClientRect().height / scale();
  }

  /** An offset from the viewport's own top (not an absolute client y) → layout px.
      `pageAt()`'s input is such an offset: the reader's eye, not a pointer event. */
  function viewportY(offset) {
    return (viewport.scrollTop + offset) / scale();
  }

  return {origin, rect, measureH, viewportY, scale, pageContentTop, pageContentBottom};
}
