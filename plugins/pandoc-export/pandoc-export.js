/* pandoc-export — a document exporter, as a plugin.
 *
 * What it pins (four assets, all verified by the host before this code runs):
 *
 *   "pandoc"          kind: bin   58.6 MB  pandoc.wasm, the same binary the CLI uses
 *   "wasi-shim"       kind: js    41.8 KB  @bjorn3/browser_wasi_shim, bundled (tools/shim.mjs)
 *   "sd-export-lua"   kind: bin   ~8 KB    tools/sd-export.lua, carried as bytes
 *                                          (a `js` asset would be *evaluated*, and Lua is
 *                                          not JavaScript; there is no text kind yet)
 *   "sd-reference"    kind: bin   12 KB    optional: tools/reference.docx (Word look)
 *   "sd-template-typ" kind: bin   ~3 KB    optional: tools/sd-template.typ (Typst look)
 *   "typst-bundle"    kind: bin   211 KB   optional: typst.ts's all-in-one bundle, for PDF
 *   "typst-compiler"  kind: bin   27 MB    optional: typst's wasm compiler, for PDF
 *   "typst-font-*"    kind: bin   ~0.5 MB  optional, one per font file; without them the PDF
 *                                          asks jsDelivr for the default text fonts
 *
 * It never fetches its own runtime (invariant 13): `host.bytes()` is the only source of a
 * byte, and the host is the only thing that verifies. It also never builds its own HTML —
 * `host.use("materialize")` is the editor's own capture path, so a .docx cannot disagree
 * with the .html export about figure 4.
 *
 * Text targets are offered only when the document has no figures: a `.typ` with
 * `image("fig-01.png")` is two files, and a plugin can hand back one. Word embeds, so it
 * always works — and PDF is not a writer here, it is the browser's PDF (Save as… ▸ PDF).
 */
export function createPandocExport() {
  /* The handshake. pandoc.wasm's own glue is an ES module that fetches its own bytes; we
     have the bytes, so we write the ~120 lines. Two details cost real time to find:
     `hs_init_with_rtsopts` takes a pointer to a pointer to argv, and ConsoleStdout must be
     the lineBuffered variant or the filter's report arrives as a byte array. */
  function createPandocEngine(shim, bytes, {env = [], onStderr = () => {}} = {}) {
    const {WASI, File, OpenFile, ConsoleStdout, PreopenDirectory} = shim;
    const args = ["pandoc.wasm", "+RTS", "-H64m", "-RTS"];
    const fileSystem = new Map();
    const fds = [
      new OpenFile(new File(new Uint8Array(), {readonly: true})),
      ConsoleStdout.lineBuffered(() => {}),
      ConsoleStdout.lineBuffered((line) => onStderr(line)),
      new PreopenDirectory("/", fileSystem),
    ];
    const wasi = new WASI(args, env, fds, {debug: false});
    return WebAssembly.instantiate(bytes, {wasi_snapshot_preview1: wasi.wasiImport}).then(({instance}) => {
      wasi.initialize(instance);
      instance.exports.__wasm_call_ctors();
      const view = () => new DataView(instance.exports.memory.buffer);
      const heap = () => new Uint8Array(instance.exports.memory.buffer);
      const alloc = (length) => {
        const pointer = instance.exports.malloc(length);
        if (!pointer) throw new Error("pandoc.wasm is out of memory");
        return pointer;
      };
      const write = (text) => {
        const encoded = new TextEncoder().encode(text);
        const pointer = alloc(encoded.length + 1);
        heap().set(encoded, pointer);
        heap()[pointer + encoded.length] = 0;
        return pointer;
      };
      const argv = alloc(4 * (args.length + 1));
      args.forEach((argument, index) => view().setUint32(argv + 4 * index, write(argument), true));
      view().setUint32(argv + 4 * args.length, 0, true);
      const argc = alloc(4);
      view().setUint32(argc, args.length, true);
      const argvPointer = alloc(4);
      view().setUint32(argvPointer, argv, true);
      instance.exports.hs_init_with_rtsopts(argc, argvPointer);

      const text = (name) => {
        const file = fileSystem.get(name);
        return file ? new TextDecoder().decode(file.data).trim() : "";
      };
      const call = (name, options) => {
        const encoded = new TextEncoder().encode(JSON.stringify(options));
        const pointer = alloc(encoded.length);
        heap().set(encoded, pointer);
        instance.exports[name](pointer, encoded.length);
      };

      return {
        async convert(options, stdin, files) {
          fileSystem.clear();
          for (const [name, value] of Object.entries(files)) {
            const data = typeof value === "string" ? new TextEncoder().encode(value)
              : new Uint8Array(await value.arrayBuffer());
            fileSystem.set(name, new File(data, {readonly: true}));
          }
          fileSystem.set("stdin", new File(new TextEncoder().encode(stdin), {readonly: true}));
          fileSystem.set("stdout", new File(new Uint8Array()));
          fileSystem.set("stderr", new File(new Uint8Array()));
          if (options["output-file"]) fileSystem.set(options["output-file"], new File(new Uint8Array()));
          call("convert", options);
          const result = {stdout: text("stdout"), stderr: text("stderr"), files: {}};
          for (const [name, file] of fileSystem) {
            if (["stdin", "stdout", "stderr"].includes(name)) continue;
            result.files[name] = new Blob([file.data]);
          }
          return result;
        },
      };
    });
  }

  /* The compiler has no filesystem. This is the whole bridge: three methods keyed by a path
     prefix, which is the convention typst.ts uses for an in-memory workspace. */
  function memoryModel() {
    const files = new Map();
    return {
      insert(path, bytes) { files.set(path, bytes); },
      getMTime: (path) => (files.has(path) ? new Date() : undefined),
      isFile: (path) => files.has(path),
      readAll: (path) => files.get(path),
      getRealPath: (path) => path,
    };
  }

  /* A plugin is loaded from a blob:, so it cannot import. The shim arrives as verified text
     and becomes a module here — the bytes are the host's, the evaluation is ours. */
  async function importText(text) {
    const url = URL.createObjectURL(new Blob([text], {type: "text/javascript"}));
    try {
      return await import(url);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  function recipeFor(target, figures) {
    const settings = (() => {
      try { return JSON.parse(document.getElementById("export-settings")?.textContent || "null"); }
      catch { return null; }
    })();
    const recipe = settings?.recipe || {};
    if (!figures) {
      /* Single-file text targets only when there is nothing to reference. */
      return {to: {typ: "typst", md: "markdown-smart"}[target] || target, ext: {typ: "typ", md: "md"}[target]};
    }
    return null;
  }

  return {
    async activate(host) {
      const settings = host.settings();
      let engine = null;
      let shimModule = null;
      let filter = null;

      async function ready() {
        if (engine) return engine;
        filter = filter || new TextDecoder().decode(await host.bytes("sd-export-lua"));
        shimModule = shimModule || await importText(await host.text("wasi-shim"));
        const bytes = await host.bytes("pandoc");
        engine = await createPandocEngine(shimModule, bytes, {
          /* Determinism in the browser, without a zip pass: the writer honours this and we
             own the environment, unlike the npm loader (env = []). */
          env: ["SOURCE_DATE_EPOCH=0"],
          onStderr: (line) => console.info("[pandoc-export]", line),
        });
        return engine;
      }

      async function exportTo(target) {
        const materialized = await host.use("materialize").build({format: "png", media: "files"});
        if (!materialized) throw new Error("materialization was cancelled");
        if (materialized.problems.length) {
          /* A placeholder is a card, not a figure: refuse, like `--on-missing=fail`. */
          throw new Error(`not exported: ${materialized.problems.join("; ")}`);
        }
        const files = {"sd-export.lua": filter || new TextDecoder().decode(await host.bytes("sd-export-lua"))};
        for (const file of materialized.files) files[file.name] = new Blob([dataUrlBytes(file.dataUrl)]);
        const reference = await optionalBytes(host, "sd-reference");
        const template = await optionalBytes(host, "sd-template-typ");
        const wanted = target === "docx"
          ? {to: "docx", ext: "docx"}
          : recipeFor(target, materialized.files.length);
        if (!wanted) {
          throw new Error(`a .${target} with figures is several files and a plugin returns one; `
            + `use the CLI (npm run export) or Save as… ▸ PDF ▸ Captured figures`);
        }
        /* `host.bytes()` hands back an ArrayBuffer; the writer wants something it can call
           `arrayBuffer()` on, which is a Blob. */
        if (reference) files["reference.docx"] = new Blob([reference]);
        if (template) files["sd-template.typ"] = new TextDecoder().decode(template);

        const pandoc = await ready();
        const result = await pandoc.convert({
          from: "html",
          to: wanted.to,
          standalone: true,
          filters: ["sd-export.lua"],
          "output-file": `out.${wanted.ext}`,
          ...(reference ? {"reference-doc": "reference.docx"} : {}),
          ...(template ? {template: "sd-template.typ"} : {}),
        }, materialized.html, files);

        if (/^ERROR/m.test(result.stderr)) throw new Error(result.stderr.trim().split("\n")[0]);
        const blob = result.files[`out.${wanted.ext}`];
        if (!blob) throw new Error("the writer produced no file");
        return {
          name: `document.${wanted.ext}`,
          mime: {
            docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            typ: "text/vnd.typst", md: "text/markdown",
          }[wanted.ext] || "application/octet-stream",
          bytes: blob,
        };
      }

      /* The second stage: `.typ` → PDF, in the tab. typst.ts is pinned as a bundle because a
         blob: module cannot resolve its internal imports; the compiler is a 27 MB wasm; the
         fonts come from the document's own `typst-font-*` assets when it has them, and from
         jsDelivr when it does not (which is why the label says so). */
      let typst = null;
      async function compileTypst(typ, figures) {
        if (!typst) {
          typst = await importText(new TextDecoder().decode(await host.bytes("typst-bundle")));
        }
        const wasm = await host.bytes("typst-compiler");
        const fonts = [];
        for (const asset of (host.manifest().assets || [])) {
          if (!asset.id.startsWith("typst-font-")) continue;
          try { fonts.push(new Uint8Array(await host.bytes(asset.id))); } catch { /* not this document's */ }
        }
        const workspace = memoryModel();
        workspace.insert("/@memory/document.typ", new TextEncoder().encode(typ));
        for (const file of figures) workspace.insert(`/@memory/${file.name}`, dataUrlBytes(file.dataUrl));

        typst.$typst.setCompilerInitOptions({
          getModule: async () => new Uint8Array(wasm),
          beforeBuild: [fonts.length
            ? typst.loadFonts(fonts)
            : typst.preloadRemoteFonts([], {assets: ["text"]})],
        });
        typst.$typst.use(typst.TypstSnippet.withAccessModel(workspace));
        const pdf = await typst.$typst.pdf({mainFilePath: "/@memory/document.typ"});
        if (!pdf) throw new Error("typst produced no PDF");
        return new Blob([pdf], {type: "application/pdf"});
      }

      async function exportPdf() {
        const materialized = await host.use("materialize").build({format: "png", media: "files"});
        if (!materialized) throw new Error("materialization was cancelled");
        if (materialized.problems.length) throw new Error(`not exported: ${materialized.problems.join("; ")}`);
        const files = {"sd-export.lua": filter || new TextDecoder().decode(await host.bytes("sd-export-lua"))};
        const template = await optionalBytes(host, "sd-template-typ");
        if (template) files["sd-template.typ"] = new TextDecoder().decode(template);
        const pandoc = await ready();
        const typ = await pandoc.convert({
          from: "html", to: "typst", standalone: true, filters: ["sd-export.lua"],
          "output-file": "out.typ",
          ...(template ? {template: "sd-template.typ"} : {}),
        }, materialized.html, files);
        const typBlob = typ.files["out.typ"];
        if (!typBlob) throw new Error("pandoc produced no .typ");
        /* Figures are handed to the compiler by name, exactly as the .typ references them. */
        const figures = materialized.files.map((file) => ({name: file.name, dataUrl: file.dataUrl}));
        return {
          name: "document.pdf",
          mime: "application/pdf",
          bytes: await compileTypst(await typBlob.text(), figures),
        };
      }

      return {
        export: {
          docx: () => exportTo("docx"),
          typ: () => exportTo("typ"),
          md: () => exportTo("md"),
          pdf: () => exportPdf(),
        },
        deactivate() {
          engine = null;
          shimModule = null;
        },
      };
    },
  };
}

/* A data URL to bytes, without a fetch: file:// pages cannot fetch, and this function must
   work wherever `materialize()` does. */
function dataUrlBytes(dataUrl) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* An optional asset: a plugin may pin a reference docx, or may not. */
async function optionalBytes(host, id) {
  try { return await host.bytes(id); } catch { return null; }
}
