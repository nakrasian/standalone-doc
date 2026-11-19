export function createFigures(deps = {}) {
  const {signals, pagination, env} = deps;
  /* Editing concerns. A view-mode document mounts figures to render islands but
     has neither module, so these are optional edges rather than dependencies:
     the getters return undefined, and every call site tolerates that. */
  const status = deps.optional("status");
  const editor = deps.optional("editor");
  const content = document.getElementById("content");
  const viewport = document.getElementById("viewport");
  const storeEl = document.getElementById("figure-store");
  const input = document.querySelector("[data-figure-input]");
  const tools = document.getElementById("figure-tools");
  const toolsW = tools && tools.querySelector("[data-figure-w-value]");
  const toolsH = tools && tools.querySelector("[data-figure-h-value]");

  const VERSION = 1;
  const STORE_EMPTY_BYTES = JSON.stringify({version: VERSION, figures: {}})
    .replace(/</g, "\\u003c").length;
  const MAX_EDGE = 1600;
  const WARN_BYTES = 12 * 1024 * 1024;
  const MIN_SCALE = 0.2;
  const MAX_SCALE = 1;
  const DEFAULT_SIZE = {
    image: {w: 0.8, h: "auto"},
    html: {w: 1, h: 0.72},
    media: {w: 1, h: 0.6},
  };
  /* srcdoc + opaque origin: the figure's module scripts and WebAssembly
     still run, its export buttons still download, and it cannot touch
     parent.document. blob: + allow-same-origin was the old recipe; it
     forces every imported figure to be same-origin with the app. */
  const SANDBOX = "allow-scripts allow-downloads";

  /* The island profiles. What is sandboxed is the *content* a figure mounts — never the
     plugin or the editor, which are document-level code by definition.
     
       sealed     no network, no storage, no parent. The default for a plugin's own content.
       sandboxed  today's figure sandbox: it may fetch (a user's own HTML may need to, and
                  the RecT samples call NCBI), still no storage and no parent.
       trusted    + allow-same-origin: the content can reach this document. Measured in
                  lab/005 — that is a real capability, not a label.
     
     `trusted: true` on an older figure means the same thing, so a file saved before the
     profile existed behaves identically. */
  const PROFILES = {
    sealed: {
      sandbox: "allow-scripts",
      csp: [
        "default-src 'none'",
        /* 'wasm-unsafe-eval' is not optional: without it a sealed island cannot compile
           WebAssembly at all (measured, lab/005). */
        "script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'",
        "worker-src blob:",
        "style-src 'unsafe-inline'",
        "img-src data: blob:",
        "media-src data: blob:",
        "font-src data:",
        "connect-src 'none'",
        "frame-src 'none'",
      ].join("; "),
    },
    sandboxed: {sandbox: SANDBOX, csp: null},
    trusted: {sandbox: `${SANDBOX} allow-same-origin`, csp: null},
  };

  /** The profile a figure's content mounts into, with the legacy flag mapped onto it. */
  function profileOf(stored) {
    const name = (stored && stored.island) || (stored && stored.trusted ? "trusted" : "sandboxed");
    return PROFILES[name] || PROFILES.sandboxed;
  }

  /* Export-only snapshot support. The shim only TAGS WebGL canvases; it
     never changes their context attributes. The bridge is a message
     listener; the serializer itself is sent only when an export asks for
     it. */
  const SNAPSHOT_SHIM = `(function(){
  var orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, attrs){
    var ctx = orig.call(this, type, attrs);
    if (ctx && (type === "webgl" || type === "webgl2" || type === "experimental-webgl")) {
      this.setAttribute("data-webgl", "");
    }
    return ctx;
  };
})();`;
  const SNAPSHOT_BRIDGE = `(function(){
  /* Bytes into an island (5k).
     A sealed island has no network, so anything it needs to *run* has to be handed in. The
     island asks by name; the figure it belongs to decides what it may ask for, and the host
     answers with verified bytes over this same channel — never a fetch, never eval here. */
  var byteWaiters = {};
  var byteSeq = 0;
  window.__figureBytes = function(name){
    return new Promise(function(resolve, reject){
      var id = "bytes-" + (++byteSeq) + "-" + Math.random().toString(36).slice(2);
      byteWaiters[id] = {resolve: resolve, reject: reject};
      parent.postMessage({type:"figure-bytes-request", id:id, name:String(name)}, "*");
      setTimeout(function(){
        if (!byteWaiters[id]) return;
        delete byteWaiters[id];
        reject(new Error("no bytes for " + name + " within 10s"));
      }, 10000);
    });
  };
  addEventListener("message", function(e){
    var d = e.data || {};
    if (d.type !== "figure-bytes" || !d.id || !byteWaiters[d.id]) return;
    var waiter = byteWaiters[d.id];
    delete byteWaiters[d.id];
    if (d.error) waiter.reject(new Error(d.error));
    else waiter.resolve(d.bytes);
  });

  function reply(id, msg){
    parent.postMessage(Object.assign({type:"figure-snapshot-result", id:id}, msg), "*");
  }
  addEventListener("message", async function(e){
    var d = e.data || {};
    if (!d.id || !d.type || d.type.indexOf("figure-") !== 0) return;
    if (d.type === "figure-ping") {
      reply(d.id, {ok:true, pong:true, width:innerWidth, height:innerHeight});
      return;
    }
    if (d.type !== "figure-snapshot") return;
    var started = performance.now();
    var note = function(step, ms){
      parent.postMessage({type:"figure-snapshot-progress", id:d.id, step:step,
        ms: ms == null ? performance.now() - started : ms}, "*");
    };
    var realRaf = window.requestAnimationFrame;
    var realToDataURL = HTMLCanvasElement.prototype.toDataURL;
    try {
      note("start");
      if (!window.htmlToImage && d.lib) (0, eval)(d.lib);
      var lib = window.htmlToImage;
      if (!lib) throw new Error("html-to-image did not install");
      note("lib");
      if (document.readyState !== "complete") {
        await Promise.race([
          new Promise(function(res){ addEventListener("load", res, {once:true}); }),
          new Promise(function(res){ setTimeout(res, 3000); }),
        ]);
      }
      note("load");
      if (document.fonts && document.fonts.ready) {
        await Promise.race([document.fonts.ready, new Promise(function(res){ setTimeout(res, 800); })]);
      }
      note("fonts");
      var pending = [];
      for (var img of document.images) {
        if (!img.complete) pending.push(new Promise(function(res){
          img.addEventListener("load", res, {once:true});
          img.addEventListener("error", res, {once:true});
        }));
      }
      if (pending.length) await Promise.race([
        Promise.all(pending), new Promise(function(res){ setTimeout(res, 1500); })
      ]);
      note("images");
      await new Promise(function(res){ setTimeout(res, 50); });

      /* Without preserveDrawingBuffer, toDataURL is blank from a task but
         valid inside requestAnimationFrame after the app's draw. Capture the
         WebGL canvases there, then make html-to-image reuse those URLs. */
      var glCanvases = Array.prototype.slice.call(document.querySelectorAll("canvas[data-webgl]"));
      var glUrls = new Map();
      if (glCanvases.length) {
        note("webgl");
        await new Promise(function(res){
          var done = false;
          var finish = function(){ if (!done) { done = true; res(); } };
          realRaf.call(window, function(){
            for (var i = 0; i < glCanvases.length; i++) {
              try {
                var u = glCanvases[i].toDataURL();
                if (u && u !== "data:,") glUrls.set(glCanvases[i], u);
              } catch (err) { /* leave to html-to-image */ }
            }
            finish();
          });
          setTimeout(finish, 1200);
        });
      }

      var opts = {
        width: Math.max(1, innerWidth),
        height: Math.max(1, innerHeight),
        pixelRatio: d.pixelRatio || 2,
        backgroundColor: d.background || "#ffffff",
        cacheBust: false,
      };
      note("tocanvas");
      /* html-to-image waits one rAF before decoding; a timer works in
         offscreen/throttled islands. */
      window.requestAnimationFrame = function(cb){
        return setTimeout(function(){ cb(performance.now()); }, 16);
      };
      if (glUrls.size) {
        HTMLCanvasElement.prototype.toDataURL = function(){
          if (glUrls.has(this)) return glUrls.get(this);
          return realToDataURL.apply(this, arguments);
        };
      }
      var canvas = await Promise.race([
        lib.toCanvas(document.body, opts),
        new Promise(function(_, rej){ setTimeout(function(){ rej(new Error("toCanvas timeout")); }, 20000); }),
      ]);
      var dataUrl = canvas.toDataURL(d.format === "png" ? "image/png" : "image/webp", d.quality || 0.9);
      note("done");
      reply(d.id, {ok:true, dataUrl:dataUrl, width:opts.width, height:opts.height,
        pixelRatio:opts.pixelRatio, ms:performance.now() - started});
    } catch (err) {
      note("error");
      reply(d.id, {ok:false, error:String(err && err.stack || err), ms:performance.now() - started});
    } finally {
      window.requestAnimationFrame = realRaf;
      HTMLCanvasElement.prototype.toDataURL = realToDataURL;
    }
  });
})();`;
  const SNAPSHOT_TAG = "<script>" + SNAPSHOT_SHIM + "</" + "script><script>" + SNAPSHOT_BRIDGE + "</" + "script>";

  let store = {version: VERSION, figures: {}};
  let observer = null;
  let observing = true;
  let selected = null;
  let pickKind = "any";
  let pickTrusted = false;
  let scanTimer = null;
  const mounted = new Map(); // <figure> -> {url, el}
  const sizeCache = new Map(); // store-id -> serialized entry length
  const snapshotWaiters = new Map(); // request id -> {resolve, timer, onProgress}
  let snapshotSeq = 0;

  function blank() {
    return {version: VERSION, figures: {}};
  }

  function readStore() {
    if (!storeEl) return blank();
    try {
      const parsed = JSON.parse(storeEl.textContent || "{}");
      if (!parsed || typeof parsed !== "object") return blank();
      if (!parsed.figures || typeof parsed.figures !== "object") parsed.figures = {};
      parsed.version = Number(parsed.version) || VERSION;
      return parsed;
    } catch (err) {
      console.warn("figure-store is not valid JSON; starting empty", err);
      return blank();
    }
  }

  /* Escape `<` so an island containing the literal end-of-script tag cannot
     terminate its own JSON container. JSON.parse restores it on load. */
  function syncStore() {
    if (storeEl) storeEl.textContent = JSON.stringify(store).replace(/</g, "\\u003c");
    signals.emit("figures");
  }

  function storeJSON() {
    return JSON.stringify(store).replace(/</g, "\\u003c");
  }

  function storeBytes() {
    return byteLength(storeJSON());
  }

  function entryBytes(entry) {
    if (!entry) return 0;
    let size = sizeCache.get(entry.id);
    if (size == null) {
      size = byteLength(JSON.stringify(entry).replace(/</g, "\\u003c"));
      sizeCache.set(entry.id, size);
    }
    return size;
  }

  /* Size of what a save would actually contain: only figures currently in
     the document, plus the sources they reference. This walks the figures
     and sums cached per-entry sizes; it does not stringify the store. A
     deleted figure therefore drops out of the estimate immediately, while
     its source remains in the live store for undo. */
  function savedStoreBytes() {
    const seen = new Set();
    let total = STORE_EMPTY_BYTES;
    let count = 0;
    const add = (id) => {
      if (!id || seen.has(id)) return;
      const entry = store.figures[id];
      if (!entry) return;
      seen.add(id);
      total += entryBytes(entry) + byteLength(JSON.stringify(entry.id)) + 1 + (count ? 1 : 0);
      count++;
      if (entry.sourceId) add(entry.sourceId);
    };
    content.querySelectorAll("figure[data-figure-id]").forEach((figure) => {
      add(figure.dataset.figureId);
    });
    return total;
  }

  function byteLength(str) {
    try {return new Blob([str]).size;} catch {return str.length;}
  }

  function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  function uid() {
    let id;
    do {
      const rnd = globalThis.crypto && crypto.randomUUID
        ? crypto.randomUUID().replace(/-/g, "").slice(0, 10)
        : Math.random().toString(36).slice(2, 12);
      id = "fig-" + rnd;
    } while (store.figures[id]);
    return id;
  }

  function readDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  function dataUrlText(src) {
    const comma = src.indexOf(",");
    if (comma < 0) return "";
    const meta = src.slice(0, comma);
    const data = src.slice(comma + 1);
    if (/;base64/i.test(meta)) {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(data);
  }

  function dataUrlBytes(src) {
    const comma = src.indexOf(",");
    if (comma < 0) return byteLength(src);
    const meta = src.slice(0, comma);
    const data = src.slice(comma + 1);
    if (/;base64/i.test(meta)) {
      const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
      return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
    }
    return byteLength(decodeURIComponent(data));
  }

  function resolveEntry(entry) {
    if (!entry) return null;
    if (entry.src) return entry;
    return store.figures[entry.sourceId] || entry;
  }

  function findSource(entry) {
    for (const candidate of Object.values(store.figures)) {
      if (candidate.src && candidate.kind === entry.kind && candidate.hash === entry.hash) {
        return candidate;
      }
    }
    return null;
  }

  function guessMime(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    return ({
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", bmp: "image/bmp",
      html: "text/html", htm: "text/html",
      mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
      mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
    })[ext] || "";
  }

  function kindOf(file) {
    const mime = file.type || guessMime(file.name || "");
    const name = (file.name || "").toLowerCase();
    if (mime.startsWith("image/")) return "image";
    if (mime === "text/html" || /\.html?$/.test(name)) return "html";
    if (mime.startsWith("video/") || mime.startsWith("audio/")) return "media";
    return null;
  }

  function svgSize(text) {
    try {
      const doc = new DOMParser().parseFromString(text, "image/svg+xml");
      const svg = doc.documentElement;
      if (!svg || svg.localName.toLowerCase() !== "svg") return null;
      const w = parseFloat(svg.getAttribute("width"));
      const h = parseFloat(svg.getAttribute("height"));
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        return {width: w, height: h};
      }
      const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
      if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
        return {width: vb[2], height: vb[3]};
      }
    } catch { /* malformed SVG */ }
    return null;
  }

  function dataUrlSize(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({
        width: img.naturalWidth || 1200,
        height: img.naturalHeight || 800,
      });
      img.onerror = () => resolve({width: 1200, height: 800});
      img.src = src;
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = src;
    });
  }

  /* Images are downscaled before storage. GIF stays untouched so animation
     survives; SVG stays vector and is never rasterised. Decoding goes
     through <img> rather than createImageBitmap: the latter can reject or
     stall on some file/worker combinations, and it gains us nothing here. */
  async function imagePayload(file) {
    const mime = file.type || guessMime(file.name || "") || "image/png";
    const isSvg = mime === "image/svg+xml" || /\.svg$/i.test(file.name || "");
    if (isSvg) {
      const src = await readDataURL(file);
      const size = svgSize(dataUrlText(src)) || {width: 1200, height: 800};
      return {src, mime: "image/svg+xml", ...size, storedBytes: dataUrlBytes(src), encoded: false};
    }

    const original = await readDataURL(file);
    let img = null;
    try {img = await loadImage(original);} catch { /* size fallback below */ }
    let width = img ? img.naturalWidth : 0;
    let height = img ? img.naturalHeight : 0;
    let bestSrc = original;
    let bestMime = mime;
    let bestBytes = dataUrlBytes(original);
    let encoded = false;

    const tooBig = width > MAX_EDGE || height > MAX_EDGE;
    const worthEncoding = bestBytes > 24 * 1024;
    if (img && mime !== "image/gif" && (tooBig || worthEncoding)) {
      const ratio = tooBig ? Math.min(1, MAX_EDGE / Math.max(width, height)) : 1;
      const cw = Math.max(1, Math.round(width * ratio));
      const ch = Math.max(1, Math.round(height * ratio));
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, cw, ch);

        // PNG may carry alpha, so never flatten it to JPEG. WebP keeps
        // alpha and is usually much smaller. Opaque sources try both.
        const candidates = mime === "image/png"
          ? [["image/webp", 0.9]]
          : [["image/webp", 0.82], ["image/jpeg", 0.82]];
        for (const [format, quality] of candidates) {
          const candidate = canvas.toDataURL(format, quality);
          if (!candidate.startsWith(`data:${format}`)) continue;
          const bytes = dataUrlBytes(candidate);
          if (bytes < bestBytes) {
            bestSrc = candidate;
            bestMime = format;
            bestBytes = bytes;
            encoded = true;
          }
        }
        if (encoded) {
          width = cw;
          height = ch;
        }
      }
    }

    if (!width || !height) {
      const size = await dataUrlSize(bestSrc);
      width = size.width;
      height = size.height;
    }
    return {
      src: bestSrc,
      mime: bestMime,
      width: width || 1200,
      height: height || 800,
      storedBytes: bestBytes,
      encoded,
    };
  }

  async function makeEntry(file, kind, {trusted = false} = {}) {
    const name = file.name || `${kind}-${Date.now()}`;
    const entry = {
      id: uid(),
      kind,
      name,
      mime: file.type || guessMime(name),
      bytes: file.size || 0,
      hash: "",
      src: "",
      width: 0,
      height: 0,
    };
    if (trusted) entry.island = "trusted";

    if (kind === "image") {
      Object.assign(entry, await imagePayload(file));
    } else if (kind === "html") {
      entry.src = dataUrlText(await readDataURL(file));
      entry.mime = "text/html";
      entry.storedBytes = byteLength(entry.src);
    } else if (kind === "media") {
      entry.src = await readDataURL(file);
      entry.media = (file.type || "").startsWith("audio/") ? "audio" : "video";
      entry.storedBytes = dataUrlBytes(entry.src);
    }

    entry.hash = hashString(entry.src);
    entry.bytes = file.size || byteLength(entry.src);
    if (entry.bytes > WARN_BYTES) {
      console.warn(`Figure ${name} is ${(entry.bytes / 1048576).toFixed(1)} MB; saved files will grow by about that much.`);
    }

    // Share the bytes of an identical source. The second figure keeps its
    // own id, caption and size, but points at the first entry's src.
    const shared = findSource(entry);
    if (shared) {
      entry.sourceId = shared.id;
      entry.mime = shared.mime;
      entry.width = shared.width;
      entry.height = shared.height;
      entry.bytes = shared.bytes;
      entry.storedBytes = 0;
      delete entry.src;
    } else {
      if (!entry.storedBytes) entry.storedBytes = byteLength(entry.src);
    }

    store.figures[entry.id] = entry;
    syncStore();
    return entry;
  }

  function defaultCaption(entry) {
    const base = (entry.name || "").replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
    return base || (entry.kind === "image" ? "Image" : "Figure");
  }

  function createFigure(entry) {
    const figure = document.createElement("figure");
    figure.className = "figure";
    figure.dataset.figureId = entry.id;
    figure.dataset.kind = entry.kind;
    if (entry.media) figure.dataset.media = entry.media;
    markTrusted(figure, entry);
    figure.setAttribute("contenteditable", "false");
    /* Not a tab stop: the frame is rendered content, and in Firefox a
       `contenteditable=false` subtree inside an editable region is focusable, which
       makes Tab walk into every figure. The caption (editable) is still reachable, and
       the figure stays programmatically focusable for `select()`. */
    figure.setAttribute("tabindex", "-1");

    const defaults = DEFAULT_SIZE[entry.kind] || {w: 1, h: 0.72};
    const width = defaults.w;
    const height = entry.kind === "media" && entry.media === "audio" ? "auto" : defaults.h;
    figure.dataset.w = String(width);
    figure.dataset.h = String(height);
    figure.dataset.scale = String(width);
    figure.style.setProperty("--figure-w", String(width));
    figure.style.setProperty("--figure-scale", String(width));
    if (height !== "auto") figure.style.setProperty("--figure-h", String(height));
    if (entry.kind === "image") {
      const source = resolveEntry(entry);
      figure.style.setProperty("--figure-aspect", `${source.width || 16} / ${source.height || 9}`);
    }

    const frame = document.createElement("div");
    frame.className = "figure-frame";
    frame.dataset.runtime = "ephemeral";

    const caption = document.createElement("figcaption");
    caption.setAttribute("contenteditable", "true");
    caption.textContent = defaultCaption(entry);

    figure.append(frame, caption);
    return figure;
  }

  /* The reader's only signal that a figure's content runs unsandboxed. Derived from the
     store (the pin), applied at mount, and stripped on save: the file describes the island
     in one place, and the attribute is this session's rendering of it. */
  function markTrusted(figure, entry) {
    if (entry && (entry.island === "trusted" || entry.trusted === true)) figure.dataset.trusted = "1";
    else figure.removeAttribute("data-trusted");
  }

  /* data-w/data-h are the persisted size. data-scale is kept as the old
     width alias so files saved before this change still load. */
  function normaliseScale(figure) {
    const stored = store.figures[figure.dataset.figureId];
    const entry = resolveEntry(stored);
    const kind = (stored && stored.kind) || figure.dataset.kind;
    const defaults = DEFAULT_SIZE[kind] || {w: 1, h: 0.72};
    const legacy = parseFloat(figure.dataset.scale);
    const rawW = parseFloat(figure.dataset.w);
    const width = Math.max(MIN_SCALE, Math.min(MAX_SCALE,
      Number.isFinite(rawW) ? rawW : Number.isFinite(legacy) ? legacy : defaults.w));

    const rawH = figure.dataset.h;
    let height = rawH === "auto" ? "auto" : parseFloat(rawH);
    if (height !== "auto" && !Number.isFinite(height)) height = defaults.h;

    figure.dataset.w = String(width);
    figure.dataset.scale = String(width);
    figure.style.setProperty("--figure-w", String(width));
    figure.style.setProperty("--figure-scale", String(width));

    if (height === "auto") {
      figure.dataset.h = "auto";
      figure.style.removeProperty("--figure-h");
    } else {
      const h = Math.max(MIN_SCALE, Math.min(MAX_SCALE, height));
      figure.dataset.h = String(h);
      figure.style.setProperty("--figure-h", String(h));
    }

    if (entry && entry.kind === "image") {
      figure.style.setProperty("--figure-aspect", `${entry.width || 16} / ${entry.height || 9}`);
    }
  }

  function htmlDocument(src, csp = null) {
    const policy = csp
      ? `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}">`
      : "";
    const html = /<html[\s>]/i.test(src) ? src
      : `<!doctype html><html><head><meta charset="utf-8">${policy}`
        + `<style>html,body{margin:0;padding:0;font-family:system-ui,sans-serif}</style>`
        + `</head><body>${src}</body></html>`;
    /* A source that brings its own <html> gets the policy injected into its head, and the
       policy has to be *first*: a meta CSP is only honoured before the first fetch it
       governs. */
    const withPolicy = csp && !html.includes('http-equiv="Content-Security-Policy"')
      ? (() => {
          const head = html.match(/<head[^>]*>/i);
          if (head) {
            const at = head.index + head[0].length;
            return html.slice(0, at) + policy + html.slice(at);
          }
          const doctype = html.match(/<!doctype[^>]*>/i);
          const at = doctype ? doctype.index + doctype[0].length : 0;
          return html.slice(0, at) + policy + html.slice(at);
        })()
      : html;
    const html2 = withPolicy;
    if (html2.includes("data-figure-bridge")) return html2;
    const tag = SNAPSHOT_TAG.replace("<script>", "<script data-figure-bridge>", 1);
    const head = html2.match(/<head[^>]*>/i);
    if (head) {
      const at = head.index + head[0].length;
      return html2.slice(0, at) + tag + html2.slice(at);
    }
    const doctype = html2.match(/<!doctype[^>]*>/i);
    if (doctype) {
      const at = doctype.index + doctype[0].length;
      return html2.slice(0, at) + tag + html2.slice(at);
    }
    return tag + html2;
  }

  /* ---- plugins ---------------------------------------------------------
     A figure may need a plugin. The plugin is not part of this module: it is built
     on demand, verified, and may be absent — in which case the figure keeps its
     place in the document and says why. A missing plugin is a missing *view*, never
     a missing figure: the element and its store entry are untouched, so the file is
     byte-stable and the plugin can be added later. */
  const pluginOf = (entry) => (entry && entry.plugin && entry.plugin.id ? entry.plugin : null);

  /* How many figures in this document need each plugin. The count is what the
     settings sheet shows and what the save policy floors on; whether the plugin is
     in the file is still the author's choice. */
  function pluginUsage() {
    const usage = {};
    for (const figure of content.querySelectorAll("figure.figure")) {
      const plugin = pluginOf(store.figures[figure.dataset.figureId]);
      if (!plugin) continue;
      usage[plugin.id] = (usage[plugin.id] || 0) + 1;
    }
    return usage;
  }

  /* Short, because it sits in a figure frame: the reason, not the diagnosis. */
  function pluginReason(error) {
    switch (error && error.kind) {
      case "unresolved": return "not in this copy of the file";
      case "disabled": return "switched off in this document";
      case "integrity": return "its bytes do not match the pinned hash";
      case "api": return `it needs a newer runtime (host API ${error.need || "?"})`;
      case "stale": return "it was unloaded while loading";
      default: return (error && error.message) || "it could not be loaded";
    }
  }

  function pluginNotice(figure, state, error) {
    const frame = figure.querySelector(".figure-frame");
    if (!frame) return;
    const plugin = pluginOf(store.figures[figure.dataset.figureId]) || {};
    const label = plugin.label || plugin.id || "A plugin";
    const failed = state === "failed";
    const notice = document.createElement("div");
    notice.className = "figure-plugin";
    notice.dataset.state = state;
    /* A retry cannot satisfy an `api` refusal; saying "click to retry" there would be a
       loop. The remedy is a different runtime, and the Plugins panel names the release. */
    const retryable = !error || !["api", "disabled", "unavailable", "forbidden"].includes(error.kind);
    const next = retryable ? "Click to retry." : "Update this file's runtime in Document settings → Runtime, then reopen.";
    notice.textContent = failed ? `Needs ${label} — ${pluginReason(error)}. ${next}` : `Loading ${label}…`;
    if (failed) {
      notice.onclick = () => {
        /* The only automatic retry is none: a failing plugin must not refetch on
           every scroll. A click is deliberate. */
        delete figure.dataset.pluginState;
        frame.replaceChildren();
        mount(figure);
      };
    }
    frame.replaceChildren(notice);
  }

  async function mountWithPlugin(figure, plugin) {
    const registry = env && env.StandaloneDoc;
    if (!registry || typeof registry.require !== "function") {
      figure.dataset.pluginState = "failed";
      pluginNotice(figure, "failed", { kind: "unresolved" });
      return;
    }
    figure.dataset.pluginState = "loading";
    pluginNotice(figure, "loading");
    try {
      await registry.require(plugin.id);
      /* Scrolled away, or unloaded, while the bytes were in flight. */
      if (!figure.isConnected || figure.dataset.pluginState !== "loading") return;
      figure.dataset.pluginState = "ready";
      const frame = figure.querySelector(".figure-frame");
      if (frame) frame.replaceChildren();
      mount(figure);
    } catch (error) {
      if (!figure.isConnected) return;
      figure.dataset.pluginState = "failed";
      pluginNotice(figure, "failed", error);
    }
  }

  function mount(figure) {
    if (!figure || !figure.isConnected) return;
    const stored = store.figures[figure.dataset.figureId];
    const entry = resolveEntry(stored);
    const frame = figure.querySelector(".figure-frame");
    if (!entry || !frame) {
      figure.dataset.missing = "";
      return;
    }

    /* The plugin comes before the kind: a figure cannot render without it, and the
       loading/failed state is the figure's own, not the document's. */
    const plugin = pluginOf(stored);
    if (plugin && figure.dataset.pluginState !== "ready") {
      if (figure.dataset.pluginState === "loading" || figure.dataset.pluginState === "failed") return;
      return mountWithPlugin(figure, plugin);
    }

    figure.removeAttribute("data-missing");
    markTrusted(figure, stored && stored.island ? stored : entry);
    if (frame.firstElementChild) {
      figure.dataset.mounted = "";
      return;
    }

    if (entry.kind === "image") {
      const img = new Image();
      img.decoding = "async";
      img.alt = (figure.querySelector("figcaption")?.textContent || entry.name || "").trim();
      img.src = entry.src;
      frame.append(img);
    } else if (entry.kind === "html") {
      const iframe = document.createElement("iframe");
      /* Mounting is already gated by IntersectionObserver. Native
         loading=lazy on srcdoc can defer the very island we just decided
         to mount, so it is deliberately not used here. */
      const profile = profileOf(stored);
      iframe.setAttribute("sandbox", profile.sandbox);
      iframe.setAttribute("title", entry.name || "Embedded figure");
      iframe.setAttribute("referrerpolicy", "no-referrer");
      /* A pure affordance is a permissions-policy grant, not a sandbox flag: a plugin may
         ask for fullscreen, and nothing else, without gaining capability. */
      if (Array.isArray(stored && stored.permissions) && stored.permissions.length) {
        iframe.setAttribute("allow", stored.permissions.join("; "));
      }
      iframe.srcdoc = htmlDocument(entry.src, profile.csp);
      frame.append(iframe);
      mounted.set(figure, {el: iframe});
    } else if (entry.kind === "media") {
      const el = document.createElement(entry.media === "audio" ? "audio" : "video");
      el.controls = true;
      el.preload = "metadata";
      el.src = entry.src;
      if (entry.media === "video") el.playsInline = true;
      frame.append(el);
    }
    figure.dataset.mounted = "";
  }

  function unmount(figure) {
    const rec = mounted.get(figure);
    if (rec) {
      if (rec.url) URL.revokeObjectURL(rec.url);
      rec.el.remove();
      mounted.delete(figure);
    }
    const media = figure && figure.querySelector(".figure-frame video, .figure-frame audio");
    if (media) {
      try {media.pause();} catch { }
      media.removeAttribute("src");
      try {media.load();} catch { }
      media.remove();
    }
    /* A notice is runtime state too: scrolled away is not the same as failed. */
    if (figure) {
      figure.querySelectorAll(".figure-frame .figure-plugin").forEach((node) => node.remove());
      delete figure.dataset.pluginState;
    }
    if (figure) delete figure.dataset.mounted;
  }

  function unmountAll() {
    for (const figure of [...mounted.keys()]) unmount(figure);
    if (observer) observer.disconnect();
  }

  /* ---- bytes into an island ------------------------------------------
     The mirror of __figureBytes() in the bridge. Authorization is the *figure*, not the
     request: an island may only ask for the asset ids its store entry declares, so a
     hostile island gets nothing the document did not already intend to hand it. */
  async function onIslandMessage(event) {
    const data = event.data;
    if (!data || data.type !== "figure-bytes-request" || !data.id) return;
    const source = event.source;
    const figure = [...content.querySelectorAll("figure.figure")].find(
      (candidate) => candidate.querySelector("iframe")?.contentWindow === source,
    );
    const reply = (payload, transfer) =>
      source.postMessage(Object.assign({ type: "figure-bytes", id: data.id }, payload), "*", transfer || []);

    const stored = figure && store.figures[figure.dataset.figureId];
    if (!stored) return reply({ error: "this island is not a mounted figure" });
    const declared = Array.isArray(stored.assets) ? stored.assets : [];
    if (!declared.includes(data.name)) {
      return reply({ error: `"${data.name}" is not declared by this figure` });
    }
    const standalone = env && env.StandaloneDoc;
    if (!standalone || typeof standalone.bytes !== "function") return reply({ error: "this document cannot supply bytes" });
    try {
      const bytes = await standalone.bytes(data.name);
      /* One copy, and transfer that same reference: handing over the cached ArrayBuffer would
         neuter the parent's copy for the next island that asks for the same runtime. */
      const copy = bytes.slice(0);
      reply({ bytes: copy }, [copy]);
    } catch (error) {
      reply({ error: (error && error.message) || String(error) });
    }
  }
  window.addEventListener("message", onIslandMessage);

  /* ---- export-only snapshots ----------------------------------------
     The bridge is injected into every HTML island's srcdoc. It answers
     ping/snapshot messages. The serializer source is supplied by the
     Export module only when a static export starts. */
  function onSnapshotMessage(event) {
    const data = event.data;
    if (!data || !data.id) return;
    const waiter = snapshotWaiters.get(data.id);
    if (!waiter) return;
    if (data.type === "figure-snapshot-progress") {
      if (waiter.onProgress) waiter.onProgress(data);
      return;
    }
    if (data.type !== "figure-snapshot-result") return;
    snapshotWaiters.delete(data.id);
    clearTimeout(waiter.timer);
    waiter.resolve(data);
  }
  window.addEventListener("message", onSnapshotMessage);

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function requestSnapshot(win, message, timeout = 30000, onProgress = null) {
    return new Promise((resolve) => {
      const id = "snap-" + (++snapshotSeq) + "-" + Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        snapshotWaiters.delete(id);
        resolve({ok: false, timeout: true, error: "snapshot timed out"});
      }, timeout);
      snapshotWaiters.set(id, {resolve, timer, onProgress});
      try {
        win.postMessage(Object.assign({id}, message), "*");
      } catch (err) {
        snapshotWaiters.delete(id);
        clearTimeout(timer);
        resolve({ok: false, error: String(err)});
      }
    });
  }

  async function waitForBridge(win, tries = 60) {
    for (let i = 0; i < tries; i++) {
      const res = await requestSnapshot(win, {type: "figure-ping"}, 400);
      if (res.ok) return res;
      await sleep(100);
    }
    return {ok: false, error: "snapshot bridge did not answer"};
  }

  function videoSnapshot(figure) {
    const video = figure.querySelector(".figure-frame video");
    if (!video || !video.videoWidth) return null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/webp", 0.9);
    } catch (err) {
      return null;
    }
  }

  async function snapshot(figure, options = {}) {
    const stored = store.figures[figure.dataset.figureId];
    const entry = resolveEntry(stored);
    const kind = (stored && stored.kind) || figure.dataset.kind;
    if (!entry) return {ok: false, error: "figure source is missing"};

    if (kind === "image") {
      return {ok: true, dataUrl: entry.src, width: entry.width, height: entry.height,
        engine: "image-src"};
    }

    if (kind === "media") {
      if (entry.media === "audio") {
        return {ok: false, error: "audio has no visual snapshot"};
      }
      const dataUrl = videoSnapshot(figure);
      return dataUrl
        ? {ok: true, dataUrl, engine: "video-frame"}
        : {ok: false, error: "video frame is not ready"};
    }

    const iframe = figure.querySelector(".figure-frame iframe");
    if (!iframe) return {ok: false, error: "island is not mounted"};
    const ping = await waitForBridge(iframe.contentWindow);
    if (!ping.ok) return {ok: false, error: ping.error || "island did not answer"};
    return requestSnapshot(iframe.contentWindow, {
      type: "figure-snapshot",
      lib: options.lib || "",
      pixelRatio: options.pixelRatio || 2,
      format: options.format || "webp",
      quality: options.quality == null ? 0.9 : options.quality,
      background: options.background || "#ffffff",
    }, options.timeout || 30000, options.onProgress);
  }

  function suspendObserver() {
    observing = false;
    if (observer) observer.disconnect();
  }

  function resumeObserver() {
    observing = true;
    scan();
  }

  function scrollIntoViewForCapture(figure) {
    const rect = figure.getBoundingClientRect();
    if (rect.top >= 0 && rect.bottom <= window.innerHeight) return null;
    const previous = viewport.scrollTop;
    viewport.scrollTop += rect.top - 80;
    return previous;
  }

  async function captureAll(options = {}) {
    const figures = [...content.querySelectorAll("figure.figure")];
    const out = [];
    const mountedForExport = new Set();
    suspendObserver();
    try {
      for (let i = 0; i < figures.length; i++) {
        if (options.signal && options.signal.aborted) break;
        const figure = figures[i];
        const kind = figure.dataset.kind;
        const progress = options.onProgress;
        if (progress) progress({phase: "mount", index: i + 1, total: figures.length, figure});

        const wasMounted = !!figure.querySelector(".figure-frame iframe, .figure-frame video");
        if ((kind === "html" || kind === "media") && !wasMounted) {
          /* Awaited: a plugin-backed figure may have to be built before it can be
             captured, and this loop must not race ahead. */
          await mount(figure);
          mountedForExport.add(figure);
        }

        let previousScroll = null;
        if (kind === "html") {
          previousScroll = scrollIntoViewForCapture(figure);
          if (previousScroll != null) await sleep(120);
        }

        let capture;
        try {
          capture = await snapshot(figure, {
            lib: options.lib,
            pixelRatio: options.pixelRatio,
            format: options.format,
            quality: options.quality,
            onProgress: progress ? (p) => progress({
              phase: "capture", index: i + 1, total: figures.length,
              step: p.step, ms: p.ms, figure,
            }) : null,
          });
        } catch (err) {
          capture = {ok: false, error: String(err && err.message || err)};
        }

        if (previousScroll != null) viewport.scrollTop = previousScroll;
        out.push(Object.assign({figure, id: figure.dataset.figureId, kind}, capture));

        if (mountedForExport.has(figure)) {
          unmount(figure);
          mountedForExport.delete(figure);
        }
      }
    } finally {
      for (const figure of [...mountedForExport]) unmount(figure);
      resumeObserver();
      if (options.onProgress) options.onProgress({phase: "done", total: figures.length});
    }
    return out;
  }

  /* Developer/test switches. Normal operation never calls these; they make
     a single figure's mount/unmount observable without scroll timing. */
  function pause() {
    observing = false;
    if (observer) observer.disconnect();
    scan();
  }

  function resume() {
    observing = true;
    scan();
  }

  function scan() {
    const figures = [...content.querySelectorAll("figure.figure")];
    for (const figure of figures) {
      const entry = store.figures[figure.dataset.figureId];
      if (!entry) {
        figure.dataset.missing = "";
        continue;
      }
      figure.removeAttribute("data-missing");
      /* Files saved before this attribute existed get it on the next save. */
      figure.setAttribute("tabindex", "-1");
      normaliseScale(figure);

      if (entry.kind === "image") {
        mount(figure);
        continue;
      }
      if (!observer || !observing) {
        mount(figure);
      } else {
        observer.observe(figure);
      }
    }

    for (const figure of [...mounted.keys()]) {
      if (!figure.isConnected || !content.contains(figure)) unmount(figure);
    }
    if (selected && !selected.isConnected) select(null);
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 80);
  }

  function positionTools(figure) {
    if (!tools || !figure) return;
    const rect = figure.getBoundingClientRect();
    const toolbar = document.getElementById("app-toolbar");
    const toolbarBottom = toolbar ? toolbar.getBoundingClientRect().bottom : 0;
    const minTop = Math.max(8, toolbarBottom + 8);

    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.bottom <= minTop) {
      tools.hidden = true;
      return;
    }

    const pad = 8;
    const width = tools.offsetWidth || 260;
    const maxTop = Math.max(minTop, window.innerHeight - tools.offsetHeight - pad);
    tools.hidden = false;
    tools.style.left = `${Math.max(pad, Math.min(window.innerWidth - width - pad, rect.right - width))}px`;
    tools.style.top = `${Math.min(maxTop, Math.max(minTop, rect.top + 6))}px`;

    if (toolsW) {
      const w = parseFloat(figure.dataset.w || figure.dataset.scale) || 1;
      toolsW.textContent = `${Math.round(w * 100)}%`;
    }
    if (toolsH) {
      const h = figure.dataset.h;
      toolsH.textContent = h === "auto" ? "auto" : `${Math.round((parseFloat(h) || 0.72) * 100)}%`;
    }
  }

  function select(figure) {
    if (selected && selected !== figure) selected.removeAttribute("data-selected");
    selected = figure || null;
    if (!selected) {
      if (tools) tools.hidden = true;
      return;
    }
    selected.setAttribute("data-selected", "");
    positionTools(selected);
  }

  function setDimension(figure, dimension, value) {
    if (!figure) return;
    const dim = dimension === "h" ? "h" : "w";

    if (dim === "h" && value === "auto") {
      figure.dataset.h = "auto";
      figure.style.removeProperty("--figure-h");
    } else {
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.round(Number(value) * 100) / 100));
      figure.dataset[dim] = String(next);
      figure.style.setProperty(`--figure-${dim}`, String(next));
      if (dim === "w") {
        figure.dataset.scale = String(next);
        figure.style.setProperty("--figure-scale", String(next));
      }
    }

    if (selected === figure) positionTools(figure);
    status()?.markDirty();
    pagination.schedule();
  }

  function setScale(figure, scale) {
    setDimension(figure, "w", scale);
  }

  function resetSize(figure) {
    if (!figure) return;
    const stored = store.figures[figure.dataset.figureId];
    const entry = resolveEntry(stored);
    const kind = (stored && stored.kind) || figure.dataset.kind;
    const defaults = DEFAULT_SIZE[kind] || {w: 1, h: 0.72};
    const height = kind === "media" && entry && entry.media === "audio" ? "auto" : defaults.h;
    setDimension(figure, "w", defaults.w);
    setDimension(figure, "h", height);
  }

  function remove(figure) {
    if (!figure) return;
    unmount(figure);
    figure.remove();
    select(null);
    editor()?.history.record();
    status()?.markDirty();
    pagination.schedule();
    scan();
  }

  function referencedIds(root) {
    const ids = new Set();
    root.querySelectorAll("figure[data-figure-id]").forEach((figure) => {
      if (figure.dataset.figureId) ids.add(figure.dataset.figureId);
    });
    return ids;
  }

  /**
   * Insert a figure from markup the host supplies (a plugin's insert contribution, or a
   * preset). The store entry records the plugin it came from and the island profile its
   * content mounts into, so the figure can be reopened without the plugin and can say
   * so — and a later plugin version cannot widen the island.
   */
  function insertHTML(html, {caption = "", pin = null, island = null, assets = null} = {}) {
    if (!html) return null;
    const entry = {
      id: uid(),
      kind: "html",
      name: caption || "Figure",
      mime: "text/html",
      bytes: byteLength(html),
      hash: hashString(html),
      src: html,
      width: 0,
      height: 0,
    };
    if (pin && pin.id) entry.plugin = pin;
    if (island) entry.island = island;
    /* The asset ids this content may ask the host for (__figureBytes). Stored on the figure,
       so a later plugin version cannot widen it. */
    if (Array.isArray(assets) && assets.length) entry.assets = assets;
    /* Same bytes, same entry: two insertions of one contribution cost one copy. */
    const shared = findSource(entry);
    if (shared) {
      entry.sourceId = shared.id;
      entry.storedBytes = 0;
      delete entry.src;
    }
    store.figures[entry.id] = entry;
    syncStore();
    const figure = createFigure(entry);
    editor()?.insertBlock(figure);
    scan();
    pagination.schedule();
    status()?.markDirty();
    return figure;
  }

  /* Called on the save clone only. The live store keeps entries for an
     undo/redo stack that can still put a deleted figure back. */
  function prepareClone(clone) {
    clone.querySelectorAll("[data-runtime='ephemeral']").forEach((el) => el.replaceChildren());
    clone.querySelectorAll("figure.figure").forEach((figure) => {
      figure.removeAttribute("data-selected");
      figure.removeAttribute("data-mounted");
      figure.removeAttribute("data-missing");
      /* Loading/ready/failed is this session's observation of a plugin, not part of
         the figure. The store entry keeps the pin; the state does not travel. */
      figure.removeAttribute("data-plugin-state");
      /* Derived from the store entry, so the file never carries it. */
      figure.removeAttribute("data-trusted");
    });
    const out = {version: VERSION, figures: {}};
    const add = (id) => {
      const entry = store.figures[id];
      if (!entry || out.figures[id]) return;
      out.figures[id] = entry;
      if (entry.sourceId) add(entry.sourceId);
    };
    for (const id of referencedIds(clone)) add(id);
    const target = clone.querySelector("#figure-store");
    if (target) target.textContent = JSON.stringify(out).replace(/</g, "\\u003c");
  }

  function blockAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || !content.contains(el)) return null;
    return el.closest("#content > *");
  }

  function pick(kind = "any") {
    if (!input) return;
    pickTrusted = kind === "html-trusted";
    pickKind = pickTrusted ? "html" : kind;
    input.accept = pickKind === "image" ? "image/*,.svg"
      : pickKind === "html" ? "text/html,.html,.htm"
      : pickKind === "media" ? "video/*,audio/*"
      : "image/*,.svg,text/html,.html,.htm,video/*,audio/*";
    input.value = "";
    input.click();
  }

  async function insertFiles(fileList, {after = null, kindHint = "any", trusted = false} = {}) {
    const files = [...(fileList || [])].filter(Boolean);
    if (!files.length) return [];
    const created = [];
    let anchor = after;

    for (const file of files) {
      try {
        const kind = kindOf(file);
        if (!kind) {
          console.warn(`Unsupported figure type: ${file.name || file.type}`);
          continue;
        }
        if (kindHint !== "any" && kind !== kindHint) {
          console.warn(`Skipping ${file.name}: expected ${kindHint}, got ${kind}`);
          continue;
        }
        const entry = await makeEntry(file, kind, {trusted});
        const figure = createFigure(entry);
        editor()?.insertBlock(figure, {after: anchor});
        anchor = figure;
        created.push(figure);
      } catch (err) {
        console.error("Figure import failed", file.name, err);
      }
    }

    if (created.length) {
      syncStore();
      scan();
      pagination.schedule();
      status()?.markDirty();
    }
    return created;
  }

  function onPaste(event) {
    const dt = event.clipboardData;
    if (!dt) return;
    const files = [];
    for (const item of dt.items || []) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (!files.length) return; // leave ordinary text/HTML paste native
    event.preventDefault();
    insertFiles(files);
  }

  function onDragOver(event) {
    if (!event.dataTransfer || ![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    content.classList.add("is-drop-target");
  }

  function onDragLeave(event) {
    if (!content.contains(event.relatedTarget)) content.classList.remove("is-drop-target");
  }

  function onDrop(event) {
    if (!event.dataTransfer || !event.dataTransfer.files.length) return;
    event.preventDefault();
    content.classList.remove("is-drop-target");
    const after = blockAtPoint(event.clientX, event.clientY);
    insertFiles(event.dataTransfer.files, {after});
  }

  function init() {
    if (!storeEl) {
      console.warn("No #figure-store found; figure import disabled");
      return;
    }
    store = readStore();
    /* Give status the exact store size from now on. Before this point it counts
       the raw store text; status cannot depend on figures (it is built first and
       refreshes during construction), so the estimator travels this way. */
    status()?.setStoreEstimator(savedStoreBytes);
    syncStore();

    if ("IntersectionObserver" in window) {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const figure = entry.target;
          if (!figure.isConnected) {
            unmount(figure);
            continue;
          }
          if (entry.isIntersecting) mount(figure);
          else unmount(figure);
        }
      }, {root: viewport, rootMargin: "100% 0px 100% 0px", threshold: 0.01});
    }

    if (input) {
      input.addEventListener("change", async () => {
        const files = [...(input.files || [])];
        const hint = pickKind;
        const useTrusted = pickTrusted;
        pickKind = "any";
        pickTrusted = false;
        input.value = "";
        await insertFiles(files, {kindHint: hint, trusted: useTrusted});
      });
    }

    content.addEventListener("paste", onPaste);
    content.addEventListener("dragover", onDragOver);
    content.addEventListener("dragleave", onDragLeave);
    content.addEventListener("drop", onDrop);

    document.addEventListener("click", (event) => {
      /* Selection is an editing affordance: #figure-tools is an edit-only fragment, so an
         outline in a viewer promises actions that cannot exist (lab/010, measured). */
      const mode = env?.StandaloneDoc?.settings?.().mode ?? document.documentElement.dataset.mode;
      /* Selection is an editing affordance. A review copy's text is locked, and a
         viewer's has no tools to offer: only the editor selects a figure. */
      if (mode !== "edit") return;
      const figure = event.target.closest && event.target.closest("figure.figure");
      if (figure && content.contains(figure)) {
        select(figure);
        return;
      }
      if (event.target.closest && event.target.closest("#figure-tools")) return;
      select(null);
    });

    if (tools) {
      tools.addEventListener("mousedown", (event) => event.preventDefault());
      tools.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button || !selected) return;
        if (button.hasAttribute("data-figure-remove")) {
          remove(selected);
          return;
        }
        if (button.hasAttribute("data-figure-reset")) {
          resetSize(selected);
          return;
        }
        const dimButton = button.closest("[data-figure-dim]");
        if (dimButton) {
          const dim = dimButton.dataset.figureDim;
          const direction = button.dataset.figureStep;
          const step = direction === "+" ? 0.1 : -0.1;
          const entry = store.figures[selected.dataset.figureId];
          const kind = (entry && entry.kind) || selected.dataset.kind;
          const defaults = DEFAULT_SIZE[kind] || {w: 1, h: 0.72};
          let current = parseFloat(dim === "h" ? selected.dataset.h : selected.dataset.w);
          if (!Number.isFinite(current)) {
            current = dim === "h" && defaults.h === "auto" ? 0.7 : defaults[dim];
          }
          setDimension(selected, dim, current + step);
        }
      });
    }

    viewport.addEventListener("scroll", () => {
      if (selected) positionTools(selected);
    }, {passive: true});
    window.addEventListener("resize", () => {
      if (selected) positionTools(selected);
    });

    signals.on("layout", scan);
    signals.on("mutation", scheduleScan);
    signals.on("compositionend", scheduleScan);
    scan();
    status()?.save();
  }

  const api = {
    init, pick, insertFiles, scan, mount, unmount, unmountAll, pause, resume,
    suspendObserver, resumeObserver, snapshot, captureAll, pluginUsage, insertHTML,
    setScale, setDimension, resetSize, remove, select, prepareClone, storeJSON, storeBytes, savedStoreBytes,
    get store() {return store;},
    get selected() {return selected;},
  };

  /* The capability a plugin may resolve with host.use("figures"). Deliberately narrow:
     inserting is a host operation, and reading usage is what a panel wants. */
  const registry = env && env.StandaloneDoc;
  if (registry && typeof registry.provide === "function") {
    registry.provide("figures", {insertHTML, scan, usage: pluginUsage});
  }
  /* retry() tears the graph down and builds it again, so anything mounted before it is
     stale. A rescan also picks up a plugin that finished loading during boot. */
  if (registry && typeof registry.on === "function") {
    registry.on("ready", () => scan());
  }

  /* Construction-time, exactly where the IIFE's trailing Figures.init() ran. */
  init();
  return api;
}
