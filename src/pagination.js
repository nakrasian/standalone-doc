const content = document.getElementById("content");
const sheets = document.getElementById("sheets");
const stage = document.getElementById("stage");

/* Calculate the height, pitch, and padding of the probe element */
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

/* Page geometry is measured in layout pixels. The probe elements live
   OUTSIDE #stage, so geometry() is never zoomed; blocks live inside it, so
   getBoundingClientRect() returns zoomed pixels and must be divided by the
   zoom factor. Skipping this makes the plan shrink with the zoom (a 200%
   view would re-paginate to twice the pages). */
function measureH(el) {
  return el.getBoundingClientRect().height / (Zoom.value || 1);
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
    const h = measureH(el);
    const tall = h > g.contentH; // Check if larger than page height
    let page = pages[pages.length - 1];

    // Check if block overflows and adds page + spacer
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

  return {blocks, pages, spacers, oversize, ...g};
}

// Adds empty space from last text block to the end of the page to the DOM
function applySpacers(p) {
  const wanted = new Map(
    p.spacers.map((s) => [s.before, Math.round(s.height)])
  );

  //
  for (const sp of [...content.querySelectorAll(".page-spacer")]) {
    const next = sp.nextElementSibling;

    // Remove spacer element if not wanted.
    if (!next || !wanted.has(next)) {
      sp.remove();
      continue;
    }

    const want = wanted.get(next);
    wanted.delete(next);
    // If two spacers are next to each other and difference > 0.5, merge and use next element's height
    if (Math.abs(parseFloat(sp.style.height || "0") - want) > 0.5) {
      sp.style.height = want + "px";
    }
  }

  // Insert ones that are missing
  for (const [block, height] of wanted) {
    const sp = document.createElement("div");
    sp.className = "page-spacer";
    sp.dataset.generated = "";
    sp.setAttribute("contenteditable", "false");
    sp.style.height = height + "px";
    block.before(sp);
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
  if (queued || applying || Signals.composing) return;

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

Signals.on("mutation", () => schedule());
Signals.on("resize", schedule);
Signals.on("compositionend", schedule);

(document.fonts ? document.fonts.ready : Promise.resolve()).then(schedule);

// Refresh setup starting from Plan to rendering sheets
let lastPlan = null;

function pageCount() {
  return lastPlan && lastPlan.p ? lastPlan.p.pages.length : 1;
}

function refresh() {
  if (applying) return;

  applying = true;
  try {
    Signals.mute(() => {
      const p = plan();
      applySpacers(p);
      const model = buildModel(p);
      renderSheets(p, model);
      lastPlan = {p};
    });
  } finally {
    applying = false;
  }
  Signals.emit("layout", {pages: pageCount()});
}

// Render once immediately, then again after fonts settle.
refresh();


