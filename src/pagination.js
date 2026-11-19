/* Page planning: the gap between pages is a margin on a block, not a spacer node.
 *
 * v0.9.0 inserted a page-spacer div before the first block of every page.
 * The lab measured two consequences, in all three engines:
 *
 *   - the spacer is inside a cross-block selection, so `range.getClientRects()` reports
 *     it as a 948 px rect covering the page gap — any highlight drawn from the selection
 *     lies about what is selected;
 *   - `applySpacers()` removed and inserted that node while the caret was in the flow, so
 *     the block moved a page under the caret and the browser scrolled to keep the caret
 *     on screen (+882 / +490 / +1097 px in Chromium / WebKit / Firefox).
 *
 * A `margin-block-start` on the first block of a page has neither problem: there is no
 * node in the range, and nothing is inserted or removed. The plan is identical by
 * construction, because `measureH()` measures a block's border box and margins are not
 * part of it — a margin is layout, not content.
 *
 * The page model stays block-atomic: `page.items` names which blocks belong to a page.
 * Splitting a paragraph across pages is a separate mechanism (a `display:block` span
 * inside the same `<p>`) and lives on the fragments branch until the caret and history
 * deltas are in. This file deliberately does not carry it: a document always paginates
 * the same way, and a rollback is a commit revert, not a migration.
 *
 * Everything measured here is in **stage-local layout px** via `src/layout.js`. The
 * probes (`#probe-*`) live outside `#stage` on purpose and are already layout px.
 */

export function createPagination(deps = {}) {
  const {signals, zoom, layout, env = globalThis} = deps;
  const {document} = env;

  const content = document.getElementById("content");
  const sheets = document.getElementById("sheets");
  const stage = document.getElementById("stage");
  const viewport = document.getElementById("viewport");

  /* Calculate the height, pitch, and padding of the probe element. */
  const prContent = document.getElementById("probe-content-h");
  const prPitch = document.getElementById("probe-pitch");
  const prPad = document.getElementById("probe-pad");

  function geometry() {
    const px = (el) => el.getBoundingClientRect().height;

    const contentH = px(prContent);
    const pitch = px(prPitch);
    const pad = px(prPad);

    return {
      contentH,
      pitch,
      pad,
      chromeGap: pitch - contentH,
    };
  }

  function collectBlocks() {
    return [...content.children].filter(
      (el) => !el.classList.contains("page-spacer")
    );
  }

  function plan() {
    const g = geometry();
    const blocks = collectBlocks();

    const pages = [{top: 0, avail: g.contentH, items: []}];
    const spacers = [];
    const oversize = [];
    let cursor = 0;

    for (let i = 0; i < blocks.length; i++) {
      const el = blocks[i];
      const h = layout.measureH(el);
      const tall = h > g.contentH; // Check if larger than page height
      let page = pages[pages.length - 1];

      // Check if block overflows and adds page + gap
      if (page.items.length && cursor + h > page.top + page.avail) {
        const nextTop = page.top + page.avail + g.chromeGap;

        spacers.push({
          before: el,
          height: nextTop - cursor,
        });

        page = {top: nextTop, avail: g.contentH, items: []};
        pages.push(page);
        cursor = nextTop;
      }
      // Resizes page size to size of oversized block
      if (tall) {
        page.avail = h;
        oversize.push(i);
      }

      page.items.push({block: i, from: 0, to: null});
      cursor += h;

      if (tall && i < blocks.length - 1) {
        const nextTop = page.top + page.avail + g.chromeGap;
        page = {top: nextTop, avail: g.contentH, items: []};
        pages.push(page);
        cursor = nextTop;
      }
    }

    return {
      blocks, pages, spacers, oversize, ...g,
      /* Page content edges in layout px: the coordinate a comment overlay, a print rule
         and a future fragment pass must all agree with. */
      pageTops: pages.map((page) => layout.pageContentTop(page, g.pad)),
      pageBottoms: pages.map((page) => layout.pageContentBottom(page, g.pad)),
    };
  }

  // The page gap lives on the block that starts the page, not in a node before it.
  // `plan()` already names exactly those blocks (`p.spacers[].before`), so the arithmetic
  // does not change — only how the gap is realised.
  function applyGaps(p) {
    /* A spacer from an older session is removed, never added. No file the current save
       path writes carries one; this is the one-way migration for a live DOM. */
    for (const sp of [...content.querySelectorAll(".page-spacer")]) sp.remove();

    const wanted = new Map(p.spacers.map((s) => [s.before, Math.round(s.height)]));

    // Anything that no longer starts a page loses its margin, in this pass, not later.
    for (const el of [...content.querySelectorAll("[data-page-start]")]) {
      if (wanted.has(el)) continue;
      el.style.marginBlockStart = "";
      el.removeAttribute("data-page-start");
      if (!el.getAttribute("style")) el.removeAttribute("style");
    }

    for (const [block, height] of wanted) {
      block.setAttribute("data-page-start", "");
      const current = parseFloat(block.style.marginBlockStart || "0");
      if (Math.abs(current - height) > 0.5) block.style.marginBlockStart = height + "px";
    }
  }

  // Use the plan to create sheets, pages, and blocks
  function buildModel(p) {
    return p.pages.map((page, k) => {
      const first = page.items[0];

      return {
        head: "", // intentionally empty for now; not derived from headings
        folio: `${k + 1} / ${p.pages.length}`,
        recto: k % 2 === 0,
        /* Always false while blocks are atomic. Kept because the plan already carries
           `from`, and a continued page is a fact about the plan, not the renderer. */
        continued: !!first && first.from > 0,
      };
    });
  }

  // Render sheets based off of plan
  function renderSheets(p, model) {
    const need = p.pages.length;
    const cells = [...sheets.children];

    // Removes sheets that don't have page content
    while (cells.length > need) cells.pop().remove();

    while (cells.length < need) {
      const sheet = document.createElement("div");
      sheet.className = "sheet";

      // Adds elements for headers and footers
      for (const slot of ["head", "folio"]) {
        const box = document.createElement("div");
        box.className = "sheet-margin";
        box.dataset.slot = slot;
        sheet.append(box);
      }

      sheets.append(sheet);
      cells.push(sheet);
    }

    cells.forEach((sheet, k) => {
      const pg = p.pages[k];
      const m = model[k];

      sheet.style.top = pg.top + "px";
      sheet.style.height = (pg.avail + 2 * p.pad) + "px"; // Pages height + padding

      sheet.dataset.page = String(k + 1);
      sheet.dataset.side = m.recto ? "recto" : "verso";
      sheet.toggleAttribute("data-first", k === 0);
      sheet.toggleAttribute("data-continued", m.continued);

      sheet.querySelector('[data-slot="head"]').textContent = m.head || "";
      sheet.querySelector('[data-slot="folio"]').textContent = m.folio || "";
    });

    const last = p.pages[need - 1];
    stage.style.minHeight = (last.top + last.avail + 2 * p.pad) + "px";
  }

  // Rendering/reformatting logic:
  let applying = false;
  let timer = null;
  let queued = false;
  let lastRun = 0;

  // Queue up the replanning and page change event
  function schedule() {
    if (queued || applying || signals.composing) return;

    queued = true;
    const idle = performance.now() - lastRun > 350;

    clearTimeout(timer);
    timer = setTimeout(() => {
      requestAnimationFrame(() => {
        queued = false;
        lastRun = performance.now();
        refresh();
      });
    }, idle ? 0 : 120);
  }

  signals.on("mutation", () => schedule());
  signals.on("resize", schedule);
  signals.on("compositionend", schedule);

  (document.fonts ? document.fonts.ready : Promise.resolve()).then(schedule);

  // Refresh setup starting from Plan to rendering sheets
  let lastPlan = null;

  function pageCount() {
    return lastPlan && lastPlan.p ? lastPlan.p.pages.length : 1;
  }

  /* The page under the reader's eye: the sheet covering the centre of the viewport.
     Centre, not top — a tall figure can fill the top of the screen while the reader is
     still on the page above. Layout px, so the zoomed scroll offset is divided out,
     exactly as measureH() does. */
  function pageAt(clientY = viewport.clientHeight / 2) {
    const pages = lastPlan?.p?.pages;
    if (!pages || !pages.length) return 1;
    const y = layout.viewportY(clientY);
    for (let i = 0; i < pages.length; i++) {
      if (y < pages[i].top + pages[i].avail) return i + 1;
    }
    return pages.length;
  }

  /* Every `[data-folio]` in the document, the way zoom.syncUI() owns [data-zoom-label].
     Page numbers are written in one place because two bars show them: the editor's
     minimal chrome and a viewer's bar. A scroll tick, not a signal — pagination does not
     mutate while the reader scrolls. */
  let folioFrame = 0;

  function syncFolio() {
    folioFrame = 0;
    const nodes = document.querySelectorAll("[data-folio]");
    if (!nodes.length) return;
    const text = `p. ${pageAt()} / ${pageCount()}`;
    for (const node of nodes) {
      if (node.textContent !== text) node.textContent = text;
    }
  }

  function refresh() {
    if (applying) return;

    applying = true;
    try {
      signals.mute(() => {
        const p = plan();
        applyGaps(p);
        const model = buildModel(p);
        renderSheets(p, model);
        lastPlan = {p};
      });
    } finally {
      applying = false;
    }
    signals.emit("layout", {pages: pageCount()});
  }

  /* What a pass did, for a test or a report. No checks: this version has no post-conditions
     beyond "the plan and the sheets agree", and a report that invents them would lie. */
  function diagnostics() {
    const p = lastPlan?.p ?? null;
    return {
      pages: pageCount(),
      gaps: p ? p.spacers.length : 0,
      pageTops: p?.pageTops ?? [],
      pageBottoms: p?.pageBottoms ?? [],
      items: p ? p.pages.map((page) => page.items.map((item) => ({block: item.block, from: item.from, to: item.to}))) : [],
    };
  }

  /* The reader moves; the pages do not. One rAF-throttled tick per scroll burst. */
  viewport.addEventListener("scroll", () => {
    if (!folioFrame) folioFrame = requestAnimationFrame(syncFolio);
  }, {passive: true});
  signals.on("layout", syncFolio);

  // Render once immediately, then again after fonts settle.
  refresh();
  syncFolio();
  return {
    schedule, pageCount, pageAt, syncFolio, refresh, diagnostics,
    plan: () => lastPlan?.p ?? null,
  };
}
