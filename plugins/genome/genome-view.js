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
    const next = clone(spec);
    const x = next.scales && next.scales.x;
    if (x) {
      if (bounds && Array.isArray(bounds.domain)) x.domain = clone(bounds.domain);
      if (clamped) x.zoom = Object.assign({}, x.zoom, {extent: [bounds.lo, bounds.hi]});
      else if (bounds && bounds.extHi > bounds.extLo) {
        x.zoom = Object.assign({}, x.zoom, {extent: [bounds.extLo, bounds.extHi]});
      } else {
        /* No contig to bound: let the engine decide, which is what a spec without `extent`
           already means. */
        delete x.zoom;
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
