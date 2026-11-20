/* genome — a GenomeSpy map as a figure in the document.
 *
 * Three assets, and the split is the whole design:
 *
 *   genome.js       this file, document level. It picks a spec file, decides the window and
 *                   the figure's geometry, and writes a *tiny* island (a loader plus the spec).
 *   genome-view.js  pinned `bin`, never evaluated here. Imported by the island from a blob:
 *                   it merges the theme, embeds the engine and answers the export hook.
 *   genomespy       pinned `bin`, 1.4 MB, never evaluated here either. The island imports it
 *                   from a blob after asking the host for its verified bytes.
 *
 * That is why a four-locus document costs ~100 KB of figures instead of the 5.9 MB a set of
 * self-contained exports costs: the engine is one pinned copy for the whole file, and each
 * figure carries only its data.
 *
 * Two host contracts this leans on, both in docs/PLUGINS.md:
 *
 *   island: "compute"   `sealed` plus `'unsafe-eval'`. GenomeSpy's grammar compiles filters and
 *                       encodings with `new Function`; the island still has no network, no
 *                       storage and no parent, and the code it compiles is the code the file
 *                       pinned. Measured in all three engines.
 *   exports: ["svg"]    the figure draws its own export. `window.__figureExport` returns the
 *                       engine's `imageExport.svg()`, so a print or a PDF gets vector text
 *                       rather than a 2× raster of a canvas. The rasterizer is the fallback.
 *
 * Nothing in this file touches the DOM at module scope: `figureHTML` builds a string, so the
 * demo generator and the tests can import this module in Node and produce the same markup the
 * Insert menu produces in a document.
 */

/** The figure's share of the text column's height. A locus map is wide and short. */
const DEFAULT_HEIGHT = 0.32;

/** Assets the island will ask the host for, in the order it asks. */
const ISLAND_ASSETS = ["genome-view", "genomespy"];

/** The scripts a figure needs, as text. No `${}` and no closing tag literal. */
const STYLE = `
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #fff; }
.gmap { position: relative; height: 100%; font: 11px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.gmap-chart { position: absolute; inset: 0; height: 100%; }
.gmap-toggle { position: absolute; z-index: 3; top: 4px; right: 6px; display: none; align-items: center;
  gap: 5px; padding: 2px 7px; border: 1px solid #dde3e9; border-radius: 6px;
  background: rgba(255, 255, 255, .88); color: #5b6770; font-size: 10.5px; cursor: pointer;
  user-select: none; -webkit-user-select: none; }
.gmap[data-state="ready"] .gmap-toggle[data-can-clamp="1"] { display: flex; }
.gmap-toggle input { margin: 0; width: 11px; height: 11px; }
.gmap-msg { position: absolute; inset: 0; display: none; place-items: center; padding: 12px;
  color: #b3261e; font-size: 11.5px; text-align: center; }
.gmap[data-state="failed"] .gmap-msg { display: grid; }
.gmap[data-state="loading"]::after { content: ""; position: absolute; inset: 0; }
`;

/* One loader for every figure. It asks for the two pinned assets, imports them from blob URLs
   (a sealed island has no network and no resolver), and hands the engine to the view. */
const LOADER = `
(function () {
  var root = document.querySelector(".gmap");
  var chart = root.querySelector(".gmap-chart");
  var control = root.querySelector(".gmap-toggle");
  var box = control && control.querySelector("input");
  var message = root.querySelector(".gmap-msg");
  function fail(error) {
    root.dataset.state = "failed";
    if (message) message.textContent = "This map could not be drawn: " + ((error && error.message) || error);
    console.error("[genome]", error);
  }
  function moduleFrom(bytes) {
    var text = new TextDecoder().decode(new Uint8Array(bytes));
    return import(URL.createObjectURL(new Blob([text], { type: "text/javascript" })));
  }
  (async function () {
    var spec = JSON.parse(document.querySelector(".gmap-spec").textContent);
    var bounds = JSON.parse(root.dataset.bounds);
    var view = await (await moduleFrom(await window.__figureBytes("genome-view"))).createLocusView({
      embed: (await moduleFrom(await window.__figureBytes("genomespy"))).embed,
      root: chart,
      spec: spec,
      bounds: bounds,
      clamp: bounds.clamp === 1,
      theme: root.dataset.theme || "light",
    });
    window.__gmap = view;
    window.__figureExport = function (request) {
      return view.exportSVG().then(function (text) {
        return { format: request.format, text: text };
      });
    };
    root.dataset.state = "ready";
    document.documentElement.dataset.gmap = "ready";
    if (box) {
      box.checked = view.clamped;
      box.addEventListener("change", function () {
        view.setClamp(box.checked).catch(fail);
      });
    }
  })().catch(fail);
})();
`;

const escapeAttribute = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/</g, "&lt;");

/**
 * The window a spec is allowed to show, derived from the spec and nothing else.
 *
 * `lo`/`hi` are the authored view. `extLo`/`extHi` are how far a *free* view may go: the
 * spec's own `zoom.extent` when it has one, otherwise the first contig it declares. A spec
 * with neither (no `genomes`, no `extent`) is still drawable — it simply cannot be clamped,
 * and the toggle stays hidden.
 */
export function boundsOf(spec) {
  const x = spec && spec.scales && spec.scales.x;
  if (!x) return null;
  const assembly = spec.assembly && spec.genomes && spec.genomes[spec.assembly];
  const contig = assembly && Array.isArray(assembly.contigs) ? assembly.contigs[0] : null;
  const size = contig ? Number(contig.size) : 0;
  const fallbackChrom = contig ? String(contig.name) : null;

  const point = (value) => {
    if (value && typeof value === "object") {
      return {chrom: value.chrom == null ? fallbackChrom : String(value.chrom), pos: Number(value.pos)};
    }
    return {chrom: fallbackChrom, pos: Number(value)};
  };
  const extentPoint = (value, fallback) => {
    const p = point(value);
    return Number.isFinite(p.pos) ? p.pos : fallback;
  };

  const domain = x.domain;
  if (!Array.isArray(domain) || domain.length !== 2) return null;
  const a = point(domain[0]);
  const b = point(domain[1]);
  if (!Number.isFinite(a.pos) || !Number.isFinite(b.pos)) return null;

  const zoom = x.zoom && Array.isArray(x.zoom.extent) && x.zoom.extent.length === 2
    ? x.zoom.extent
    : null;
  const extLo = zoom ? extentPoint(zoom[0], 0) : 0;
  const extHi = zoom ? extentPoint(zoom[1], 0) : (size > 0 ? size : 0);

  return {
    chrom: a.chrom || b.chrom || fallbackChrom,
    lo: Math.min(a.pos, b.pos),
    hi: Math.max(a.pos, b.pos),
    extLo: Math.min(extLo, extHi),
    extHi: Math.max(extLo, extHi),
    /* 1 only when there is somewhere to zoom out *to*. */
    clamp: extHi > 0 && extHi > Math.max(a.pos, b.pos) ? 1 : 0,
    domain: [domain[0], domain[1]],
  };
}

/** "Xanthobacter versatilis Py2 — chromosome:4,244,868–4,253,874", from the spec's own title. */
export function captionOf(spec) {
  const title = spec && spec.title;
  const text = typeof title === "string" ? title : (title && title.text) || "";
  const subtitle = (title && title.subtitle) || "";
  if (text && subtitle) return `${text} — ${subtitle}`;
  return text || subtitle || "Genome map";
}

/**
 * Parse and check a GenomeSpy spec, and say what is wrong in the document's words.
 *
 * The check is deliberately shallow: this plugin does not own the grammar, so it asks for the
 * two things it needs (a locus x scale with a window) and leaves the rest to the engine, which
 * reports its own errors in its own vocabulary.
 */
export function readSpec(text, {name = "spec.json"} = {}) {
  let spec;
  try {
    spec = JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} is not JSON: ${error.message}`);
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(`${name} is not a GenomeSpy spec (expected a JSON object)`);
  }
  if (!spec.scales || typeof spec.scales !== "object") {
    throw new Error(`${name} has no "scales": a GenomeSpy spec needs one`);
  }
  const bounds = boundsOf(spec);
  if (!bounds) {
    throw new Error(`${name} has no genomic x scale (expected "scales.x.domain" with two positions)`);
  }
  return {spec, bounds, caption: captionOf(spec)};
}

/**
 * The figure's content: a loader, the theme it paints, and the spec as data.
 *
 * `theme` and `clamp` are written into the block's data attributes, not into the script, so a
 * hand-edited figure stays legible and the same markup works for both settings.
 */
export function figureHTML(spec, {clamp = null, theme = "light"} = {}) {
  if (!spec || typeof spec !== "object") throw new Error("figureHTML needs a spec object");
  const bounds = boundsOf(spec);
  const clamped = bounds && bounds.clamp === 1 ? (clamp === null ? 1 : (clamp ? 1 : 0)) : 0;
  const record = Object.assign({}, bounds, {clamp: clamped});
  const json = JSON.stringify(spec).replace(/</g, "\\u003c");
  const close = "</" + "script>";
  return [
    `<style>${STYLE}</style>`,
    `<div class="gmap" data-state="loading" data-theme="${escapeAttribute(theme)}" `
      + `data-bounds='${escapeAttribute(JSON.stringify(record))}'>`,
    `<div class="gmap-chart"></div>`,
    `<label class="gmap-toggle" data-can-clamp="${bounds && bounds.clamp === 1 ? 1 : 0}">`
      + `<input type="checkbox"${clamped ? " checked" : ""}> clamp to locus</label>`,
    `<div class="gmap-msg" role="status"></div>`,
    `</div>`,
    `<script type="application/json" class="gmap-spec">${json}${close}`,
    `<script>${LOADER}${close}`,
  ].join("");
}

/* ---- the document-level half ------------------------------------------------ */

/**
 * The file picker.
 *
 * One input for the session, `hidden`, exactly as the editor's own Import comments… works:
 * a plugin that creates a throwaway input per click cannot be driven by anything but a human
 * clicking a native dialog, and a persistent element is both simpler and testable.
 */
function pickSpecFile(input) {
  /* A re-used input keeps its previous selection; clearing it is what makes `change` fire for
     the same file twice. */
  input.value = "";
  /* One listener at a time, and a dismissal is simply nothing: a `cancel` does not mean "no
     file", it means "not this time" — Firefox fires `cancel` *and then* `change` for one
     interaction (measured), so rejecting on it would refuse a file the reader did choose.
     A dismissed pick leaves a promise pending, which the next pick supersedes. */
  if (input.__genomePicker) input.removeEventListener("change", input.__genomePicker);
  return new Promise((resolve) => {
    const onChange = () => {
      delete input.__genomePicker;
      input.removeEventListener("change", onChange);
      resolve((input.files && input.files[0]) || null);
    };
    input.__genomePicker = onChange;
    input.addEventListener("change", onChange);
    input.click();
  });
}

/** Refuse before the figure exists if this document does not carry the pinned assets. */
function missingAssets(host) {
  const manifest = typeof host.manifest === "function" ? host.manifest() : null;
  const pins = manifest && manifest.plugins && manifest.plugins[host.plugin.id];
  const owned = new Set((pins && pins.assets) || []);
  return ISLAND_ASSETS.filter((id) => !owned.has(id));
}

export function createGenome(deps = {}) {
  return {
    async activate(host) {
      const absent = missingAssets(host);
      let input = null;
      const picker = () => {
        if (input) return input;
        input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.dataset.genomeInput = "";
        input.hidden = true;
        document.body.append(input);
        /* The host removes what it handed over; this is ours, so we say so. */
        host.track(() => input.remove());
        return input;
      };

      const insertLocus = async () => {
        if (absent.length) {
          throw new Error(`this document does not carry ${absent.join(", ")} — reinstall the plugin`);
        }
        const file = await pickSpecFile(picker());
        if (!file) throw new Error("no spec file was chosen");
        const {spec, bounds, caption} = readSpec(await file.text(), {name: file.name || "spec.json"});
        return {
          html: figureHTML(spec, {clamp: bounds.clamp === 1}),
          caption,
          /* The island profile and the export contract travel with the figure, not with the
             plugin: a later version cannot widen what this figure asked for. */
          island: "compute",
          assets: ISLAND_ASSETS.slice(),
          exports: ["svg"],
          width: 1,
          height: DEFAULT_HEIGHT,
        };
      };

      return {
        insert: {locus: insertLocus},
      };
    },
  };
}
