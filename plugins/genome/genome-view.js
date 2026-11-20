/* genome-view — the half of the genome plugin that runs *inside* the island.
 *
 * It is never evaluated in the document: the host pins it as a `bin` copy, and the figure
 * fetches it through `__figureBytes()` and imports it from a `blob:` URL. That is why it has
 * no imports of its own and takes the engine as an argument — a bare or relative specifier
 * cannot resolve from a blob, so `genome-spy.js` arrives the same way this file did.
 *
 * The division of labour is the interesting part:
 *
 *   the plugin (document level)  reads the .spec.json, decides the window and the geometry,
 *                                and writes both into the figure's markup as data
 *   this module (island level)   merges the theme, embeds the engine, and answers
 *                                `imageExport.svg()` for the export hook
 *
 * Nothing here parses the grammar. `bounds` is the plugin's answer to "what is this figure
 * allowed to show", so a spec that already carries a `zoom.extent` keeps it, and a spec that
 * does not gets the contig it declares.
 */

/** Ink, muted ink, and the paper the figure is exported on. Light is the printable one. */
const THEMES = {
  light: {background: "#ffffff", ink: "#1b1f24", muted: "#5b6770", rule: "#dde3e9"},
  dark: {background: "#14181c", ink: "#e8edf2", muted: "#9aa5ad", rule: "#2c343b"},
};

/* GenomeSpy's own defaults are tuned for a full-page app: sized for a screen, with a view
   outline and a legend that wraps. A figure in a printed column wants none of that. */
function themeConfig(palette) {
  return {
    view: {stroke: "transparent"},
    axis: {
      labelFontSize: 10,
      titleFontSize: 10,
      labelColor: palette.muted,
      titleColor: palette.muted,
      ticks: false,
    },
    legend: {labelFontSize: 10, symbolSize: 10, orient: "bottom", labelColor: palette.muted},
    title: {fontSize: 13, subtitleFontSize: 11, color: palette.ink, subtitleColor: palette.muted},
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Right-biased, one level deeper than spread: `config.axis.ticks` must survive a theme. */
function deepMerge(target, source) {
  const out = Object.assign({}, target);
  for (const [key, value] of Object.entries(source)) {
    const existing = out[key];
    out[key] = existing && value && typeof existing === "object" && typeof value === "object"
      && !Array.isArray(existing) && !Array.isArray(value)
      ? deepMerge(existing, value)
      : value;
  }
  return out;
}

/**
 * Embed a spec, and keep the one decision the reader is allowed to change: the window.
 *
 * `clamp` is a *rewrite of the spec*, not a widget: GenomeSpy's `zoom.extent` is the grammar's
 * own answer to "how far out may this view go", so clamping is `extent: [locus]` and freeing
 * it is `extent: [contig]`. Both are declarative, both survive an SVG export, and neither
 * needs a subscription on the scale.
 */
export async function createLocusView({embed, root, spec, bounds, clamp = true, theme = "light"}) {
  const palette = THEMES[theme] || THEMES.light;
  let api = null;
  let clamped = Boolean(clamp && bounds && bounds.extHi > bounds.extLo);

  /* The authored window, so toggling back re-centres instead of leaving the reader wherever
     the free view ended up. */
  function prepared() {
    let next = clone(spec);
    next = upgradeLabels(next, bounds, {fontSize: LABEL_SIZE, laneStep: LANE_STEP});
    const x = next.scales && next.scales.x;
    if (x) {
      /* Two coordinate shapes for the same window: a numeric `index` scale (what the label
         pipeline needs) and a GenomeSpy `locus` scale (what an authored spec normally uses).
         Both clamp the same way. */
      if (x.type === "index") {
        x.domain = [bounds.lo, bounds.hi];
        if (clamped) x.zoom = Object.assign({}, x.zoom, {extent: [bounds.lo, bounds.hi]});
        else if (bounds.extHi > bounds.extLo) x.zoom = Object.assign({}, x.zoom, {extent: [bounds.extLo, bounds.extHi]});
        else delete x.zoom;
      } else {
        if (Array.isArray(bounds.domain)) x.domain = clone(bounds.domain);
        if (clamped) x.zoom = Object.assign({}, x.zoom, {extent: [bounds.lo, bounds.hi]});
        else if (bounds.extHi > bounds.extLo) x.zoom = Object.assign({}, x.zoom, {extent: [bounds.extLo, bounds.extHi]});
        else delete x.zoom;
      }
    }
    next.config = deepMerge(next.config || {}, themeConfig(palette));
    if (!next.background) next.background = palette.background;
    return next;
  }

  function teardown() {
    if (api && typeof api.finalize === "function") {
      try {
        api.finalize();
      } catch (error) {
        console.warn("[genome] finalize:", error);
      }
    }
    api = null;
  }

  async function render() {
    teardown();
    root.replaceChildren();
    api = await embed(root, prepared());
    if (!api) throw new Error("the map engine returned nothing");
    return api;
  }

  /** The vector the export hook hands back; the host wraps it as `data:image/svg+xml`. */
  async function exportSVG() {
    if (!api || !api.imageExport || typeof api.imageExport.svg !== "function") {
      throw new Error("this engine cannot export SVG");
    }
    const result = await api.imageExport.svg({background: palette.background});
    for (const warning of result.warnings || []) console.warn("[genome] svg export:", warning);
    if (!result.blob) throw new Error("the SVG export returned no blob");
    return result.blob.text();
  }

  await render();

  return {
    async setClamp(next) {
      const value = Boolean(next && bounds && bounds.extHi > bounds.extLo);
      if (value === clamped) return api;
      clamped = value;
      return render();
    },
    get clamped() {
      return clamped;
    },
    get api() {
      return api;
    },
    exportSVG,
    destroy: teardown,
  };
}

/* ---- label layout --------------------------------------------------------
 *
 * GenomeSpy's own gene-map example (the lambda phage figure in the grammar docs) lays labels
 * out at *render* width instead of baking rows: `measureText` → sort by left edge → `pileup`
 * assigns collision-free lanes → `height: {step}` grows the panel to fit. That is the grammar
 * this file adopts, because the alternative — rows precomputed for a 1000 px figure — crowds
 * as soon as the text column is narrower, which is the normal case in a document.
 *
 * The look comes with it: labels centred over the gene's midpoint and clamped to the viewport,
 * a short leader with a white gap where another label crosses it, and an underline that the
 * leader meets. Arrows, colours, tooltips and the focus ring stay exactly as authored — this
 * function replaces *layout*, not data or palette.
 *
 * Applied only to the locus shape it understands (features with `label`/`start`/`end` and the
 * `label-*`/`gene` bands spec.py writes). Anything else is returned untouched, so a spec with
 * regulatory strips, coverage or a different grammar still renders as authored. A spec may opt
 * out with `config.genome.labels = "authored"`.
 */

const LABEL_FONT = "Lato";
const LANE_STEP = 13;
const LABEL_SIZE = 10;

const isLocusSpec = (spec) => {
  const rows = spec && spec.datasets && spec.datasets.features;
  if (!Array.isArray(rows) || !rows.length) return false;
  const row = rows[0];
  return row && "label" in row && "start" in row && "end" in row;
};

/** The bands spec.py writes: `label-0..n` plus `gene`. Anything else is not our shape. */
function authoredBands(spec) {
  const domains = [];
  const walk = (view) => {
    if (!view || typeof view !== "object") return;
    const y = view.encoding && view.encoding.y;
    if (y && y.scale && Array.isArray(y.scale.domain)) domains.push(y.scale.domain);
    for (const child of view.layer || []) walk(child);
    for (const child of view.vconcat || []) walk(child);
    for (const child of view.hconcat || []) walk(child);
  };
  walk(spec);
  const bands = domains.find((domain) => domain.includes("gene") && domain.some((d) => String(d).startsWith("label-")));
  return bands || null;
}

/** A locus-shaped x channel becomes a numeric one: the label formulas need `scale('x', v)`. */
function numericX(encoding) {
  if (!encoding || !encoding.x) return encoding;
  const x = encoding.x;
  const x2 = encoding.x2;
  if (x.type !== "locus") return encoding;
  const out = Object.assign({}, encoding);
  out.x = {field: x.pos, type: "index", band: 0};
  if (x2) out.x2 = {field: x2.pos, band: 0};
  return out;
}

/** Keep what draws genes; drop what draws labels. */
function arrowLayers(spec) {
  const kept = [];
  for (const layer of spec.layer || []) {
    const type = layer && layer.mark && layer.mark.type;
    if (type !== "arrow" && type !== "rect") continue;
    const next = JSON.parse(JSON.stringify(layer));
    next.encoding = numericX(next.encoding);
    /* One track: the two strand rows of the example would leave half the band empty on a
       bacterial locus, where nearly every gene is on the same strand. */
    next.encoding.y = {value: 0.5};
    next.mark = Object.assign({}, next.mark, {clip: true});
    kept.push(next);
  }
  return kept;
}

/**
 * Rewrite a locus spec so labels are measured and piled at the current width.
 * Returns the spec unchanged when it is not that shape.
 */
export function upgradeLabels(spec, bounds, {fontSize = LABEL_SIZE, laneStep = LANE_STEP} = {}) {
  if (!isLocusSpec(spec) || !bounds) return spec;
  if (!authoredBands(spec)) return spec;
  const config = spec.config && spec.config.genome;
  if (config && config.labels === "authored") return spec;

  const next = JSON.parse(JSON.stringify(spec));
  const arrows = arrowLayers(next);
  if (!arrows.length) return spec;

  /* The parts of the authored arrow layer that are the author's, not the grammar's: palette,
     dimming, direction and the tooltip the reader gets on hover. */
  const authoredArrow = arrows.find((layer) => layer.mark && layer.mark.type === "arrow") || {};
  const arrowEncoding = authoredArrow.encoding || {};
  const arrowMark = authoredArrow.mark || {};

  const RULE = "#9aa1ab";
  const HIGHLIGHT = "#b3261e";

  const labelPanel = {
    name: "labelPanel",
    data: {name: "features"},
    params: [{name: "highlight", select: {type: "point", on: "pointerover", clear: "mouseout"}, persist: false}],
    transform: [
      {type: "formula", expr: "(datum.start + datum.end) / 2", as: "mid"},
      {type: "filter", expr: "datum.label != null && datum.label != ''"},
      {type: "measureText", field: "label", font: LABEL_FONT, fontWeight: 600,
        fontSize: {expr: "labelFontSize"}, as: "labelWidth"},
      {type: "collect"},
      {type: "filter", expr: "datum.mid >= invert('x', 0) && datum.mid <= invert('x', 1)"},
      {type: "formula", as: "labelStart",
        expr: "clamp(width * scale('x', datum.mid) - datum.labelWidth / 2, 0, width - datum.labelWidth)"},
      {type: "formula", as: "labelEnd", expr: "datum.labelStart + datum.labelWidth"},
      {type: "formula", as: "labelOffset",
        expr: "datum.labelStart + datum.labelWidth / 2 - width * scale('x', datum.mid)"},
      /* The right edge as an *offset* from the midpoint: `x2Offset` is relative to x2 (`mid`),
         so the absolute `labelEnd` would draw every underline too long by the label's
         distance from the left edge of the plot. */
      {type: "formula", as: "labelRight", expr: "datum.labelOffset + datum.labelWidth / 2"},
      {type: "collect", sort: {field: ["labelStart", "mid", "id"], order: ["ascending", "ascending", "ascending"]}},
      {type: "pileup", start: "labelStart", end: "labelEnd", spacing: 6, as: "lane"},
    ],
    encoding: {
      x: {field: "mid", type: "index", band: 0},
      y: {field: "lane", type: "index", band: 0, axis: null},
    },
    layer: [
      {
        name: "labelLeaders",
        mark: {type: "rule", size: 0.8, clip: "x", tooltip: null, y2Offset: -9, yOffset: 7},
        encoding: {
          color: {condition: {param: "highlight", empty: false, value: HIGHLIGHT}, value: RULE},
          x: {field: "mid", type: "index", band: 0},
          xOffset: {field: "labelOffset", type: "quantitative", scale: null},
          y2: {value: 0},
        },
      },
      {
        name: "labelBackgrounds",
        mark: {type: "rect", fill: "#ffffff", tooltip: null, yOffset: 4, y2Offset: -3},
        encoding: {
          x: {field: "mid", type: "index", band: 0},
          x2: {field: "mid", band: 0},
          xOffset: {field: "labelOffset", type: "quantitative", scale: null},
          x2Offset: {field: "labelRight", type: "quantitative", scale: null},
          y2: {field: "lane", type: "index", band: 0},
        },
      },
      {
        name: "labelUnderlines",
        mark: {type: "rule", size: 0.8, tooltip: null},
        encoding: {
          color: {condition: {param: "highlight", empty: false, value: HIGHLIGHT}, value: RULE},
          x: {field: "mid", type: "index", band: 0},
          x2: {field: "mid", band: 0},
          xOffset: {field: "labelOffset", type: "quantitative", scale: null},
          x2Offset: {field: "labelRight", type: "quantitative", scale: null},
        },
      },
      {
        name: "labelText",
        mark: {
          type: "text",
          font: LABEL_FONT,
          fontWeight: 600,
          size: {expr: "labelFontSize"},
          align: "center",
          baseline: "bottom",
          dy: -5,
          clip: true,
        },
        encoding: {
          color: {condition: {param: "highlight", empty: false, value: HIGHLIGHT}, value: "#1b1f24"},
          x: {field: "mid", type: "index", band: 0},
          xOffset: {field: "labelOffset", type: "quantitative", scale: null},
          text: {field: "label"},
        },
      },
    ],
    height: {step: {expr: "laneStep"}},
    scales: {
      y: {name: "labelLanes", type: "index", zoom: false, domainMin: -1, domainTransition: false, padding: 0},
    },
    /* The panel takes the frame's spare height and hangs the lanes off its bottom edge, so the
       lowest label is always next to the gene track — and a locus that needs more lanes than the
       frame has scrolls inside the panel instead of losing the top ones. The empty space is
       headroom above the labels, which is where a reader expects it. */
    viewportHeight: {grow: 1, anchor: "end"},
  };

  const arrowPanel = {
    name: "arrowPanel",
    data: {name: "genes"},
    params: [{name: "highlight", select: {type: "point", on: "pointerover", clear: "mouseout"}, persist: false}],
    transform: [{type: "formula", expr: "(datum.start + datum.end) / 2", as: "mid"}],
    encoding: {
      x: {field: "start", type: "index", band: 0},
      y: {
        field: "strand",
        type: "nominal",
        scale: {name: "strandRows", type: "band", domain: ["+", "-"], reverse: true, padding: 0},
        axis: null,
      },
    },
    height: {step: 26},
    layer: [
      /* The genome line itself, between the two strand rows. Spanning the whole contig (not
         just this locus) is what makes a clamped view read as a window onto something larger. */
      {
        name: "backbone",
        data: {values: [{}]},
        mark: {type: "rule", color: "#d0d0d0", size: 3, tooltip: null},
        encoding: {
          x: {datum: bounds.extLo || bounds.lo, type: "index", band: 0},
          x2: {datum: bounds.extHi || bounds.hi, band: 0},
          y: {value: 0.5},
        },
      },
      /* The gene midpoints, continued from the label panel's bottom edge down to the arrows:
         one track per strand, so the two halves read like the example. */
      {
        name: "arrowLeaders",
        mark: {type: "rule", size: 0.8, clip: "x", tooltip: null},
        encoding: {
          color: {condition: {param: "highlight", empty: false, value: HIGHLIGHT}, value: RULE},
          x: {field: "mid", type: "index", band: 0},
          x2: {field: "mid", band: 0},
          y2: {value: 1},
        },
      },
      {
        name: "geneArrows",
        zindex: 1,
        mark: Object.assign({
          type: "arrow",
          size: {band: 0.62},
          headWidth: 1,
          headAngle: 56,
          headPlacement: "inside",
          minStemLength: 0,
          strokeWidth: 0,
          clip: true,
        }, {
          /* The authored mark's own choices (size, stroke) win where they exist. */
          ...(arrowMark.size != null ? {size: arrowMark.size} : {}),
          ...(arrowMark.strokeWidth != null ? {strokeWidth: arrowMark.strokeWidth} : {}),
        }),
        encoding: Object.assign({}, arrowEncoding, {
          order: {condition: {param: "highlight", empty: false, value: 1}, value: 0},
          x: {field: "start", type: "index", band: 0},
          x2: {field: "end", band: 0},
        }),
      },
    ],
  };
  /* `y: undefined` would serialize as a key with no value; drop it so the panel's strand rows
     are the only y encoding. */
  delete arrowPanel.layer[1].encoding.y;

  const x = next.scales && next.scales.x;
  next.scales = Object.assign({}, next.scales, {
    x: Object.assign({}, x, {type: "index", domain: [bounds.lo, bounds.hi]}),
  });
  delete next.encoding;
  delete next.height;
  delete next.layer;
  /* A shared axis is described once, at the root: GenomeSpy derives a title from the fields
     of every view that shares it (`mid, start, end` — not a thing a reader should see), so the
     axis is stated here instead of on a view. */
  next.axes = {
    x: {
      title: "Genome position (bp)",
      tickCount: 6,
      labelFontSize: 9.5,
      labelPadding: 4,
      labelColor: "#5b6770",
      titleFontSize: 9.5,
      titleColor: "#8b949e",
      titlePadding: 2,
      domainColor: "#c9d1d9",
      tickColor: "#c9d1d9",
      tickSize: 4,
      grid: false,
    },
  };
  next.params = (next.params || [])
    .filter((param) => !["labelFontSize", "laneStep"].includes(param.name))
    .concat([{name: "labelFontSize", value: fontSize}, {name: "laneStep", value: laneStep}]);
  next.spacing = 0;
  /* The label panel's `grow` means nothing without a height to grow into. */
  next.height = "container";
  next.resolve = {scale: {x: "shared", y: "independent"}, axis: {x: "shared"}};
  next.vconcat = [labelPanel, arrowPanel];
  return next;
}
