#!/usr/bin/env node
/* tools/demo-resilience.mjs — three documents that show what survives a missing plugin.
 *
 *   npm run demo:resilience     writes .test-tmp/resilience-demo/ and prints the URL
 *   npm run dev                 (in another shell) serve it, then open the URL
 *
 * They are generated, not committed, for the same reason `tools/demo.mjs` is: each is a
 * *mutated copy* of the real `dist/editor.html`, and a committed copy would go stale the
 * first time the editor changed. Nothing is stubbed — the plugin fetch, the boot decision,
 * the sheet and the figure card are the shipped code paths.
 *
 *   1. soft-module.html   the `plugins` module cannot load. The editor still opens, says
 *                         "Ready — with limitations" with the remedy, and the Plugins sheet is
 *                         simply absent.
 *   2. soft-plugin.html   a pinned plugin's bytes are missing. The document is ready; the
 *                         figure that needs it shows the reason and retry, without touching
 *                         the rest of the page.
 *   3. blocked-plugin.html a catalog offers versions that need host API 3. This runtime
 *                         provides 2, so the row names `v0.13.0` (the first release that
 *                         would satisfy it) instead of offering a dead Install button.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".test-tmp/resilience-demo");
const LOCAL = "http://127.0.0.1:8080/.test-tmp/resilience-demo";
const EDITOR = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");

const sha384 = (text) => "sha384-" + createHash("sha384").update(text, "utf8").digest("base64");
const MANIFEST_RE = /(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/;
const STORE_RE = /(<script id="figure-store" type="application\/json">)([\s\S]*?)(<\/script>)/;

const placeholder = sha384("this url is deliberately not published");
const write = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(OUT, file)), { recursive: true });
  fs.writeFileSync(path.join(OUT, file), text);
};

/** A copy of the editor whose manifest the callback may rewrite. */
function documentWith(mutate, { stripPlugins = false } = {}) {
  const manifest = JSON.parse(MANIFEST_RE.exec(EDITOR)[2]);
  mutate(manifest);
  let html = EDITOR.replace(MANIFEST_RE, (_, open, _json, close) => open + JSON.stringify(manifest) + close);
  if (stripPlugins) {
    /* The module is inline in a published editor. Removing the block is what makes `mode:
       online` and a missing url a real fetch instead of a shadowed registration. */
    html = html.replace(/<script type="module" id="plugins">[\s\S]*?<\/script>\n?/, "");
  }
  return html;
}

function withFigure(html, figure, markup) {
  const store = JSON.parse(STORE_RE.exec(html)[2]);
  store.figures[figure.id] = figure;
  html = html.replace(STORE_RE, (_, open, _json, close) => open + JSON.stringify(store) + close);
  return html.replace(/(<article id="content"[^>]*>)/, `$1\n${markup}`);
}

function copy(text) {
  return `<p>${text}</p>`;
}

/* An empty index so 1 and 2 never reach the network for a catalog they do not demonstrate. */
write("empty-index.json", JSON.stringify({
  schema: 1,
  generated: "demo fixture — intentionally empty",
  revision: placeholder,
  assets: {},
  bundles: {},
}, null, 2) + "\n");

/* ------------------------------------------------------------ 1. soft module */

write("soft-module.html", documentWith((manifest) => {
  manifest.pluginIndex = `${LOCAL}/empty-index.json`;
  const asset = manifest.assets.find((candidate) => candidate.id === "plugins");
  asset.mode = "online";
  asset.url = `${LOCAL}/plugins-not-published.js`;
  asset.critical = false;
}, { stripPlugins: true }));

/* ------------------------------------------------------------ 2. soft plugin */

const broken = `${LOCAL}/broken-plugin-not-published.js`;
write("soft-plugin.html", withFigure(
  documentWith((manifest) => {
    manifest.pluginIndex = `${LOCAL}/empty-index.json`;
    manifest.assets.push({
      id: "demo-broken",
      kind: "js",
      role: "module",
      order: 900,
      mode: "online",
      category: "plugin",
      plugin: "demo-broken",
      requiredBy: ["*"],
      bytes: 120,
      url: broken,
      integrity: placeholder,
    });
    manifest.plugins = {
      "demo-broken": {
        label: "Demo broken plugin",
        version: "1.0.0",
        api: 1,
        island: "sealed",
        enabled: true,
        entry: "demo-broken",
        assets: ["demo-broken"],
        contributes: {},
      },
    };
  }),
  {
    id: "broken-figure",
    kind: "html",
    name: "Broken plugin figure",
    mime: "text/html",
    bytes: 22,
    hash: "x",
    src: "<body>demo</body>",
    width: 0,
    height: 0,
    plugin: { id: "demo-broken", label: "Demo broken plugin", url: broken, integrity: placeholder },
    island: "sealed",
  },
  '<figure class="figure" data-figure-id="broken-figure" data-kind="html">'
    + '<div class="figure-frame" data-runtime="ephemeral"></div>'
    + '<figcaption>Broken plugin figure</figcaption></figure>'
    + "\n" + copy("This paragraph is ordinary document content: it is readable even though the "
      + "figure above needs a plugin whose bytes are not published. The figure card names the "
      + "reason; the rest of the page, editing and saving are untouched."),
));

/* -------------------------------------------------------- 3. blocked plugin */

const blockedRow = (version) => ({
  label: "Modern export",
  version,
  api: 3,
  island: "sealed",
  entry: "modern-export",
  manifest: `${LOCAL}/modern-export.json`,
  bytes: 2,
  sha384: placeholder,
  assets: 1,
  assetBytes: 2,
  about: "A hypothetical next-generation plugin that asks for host API 3.",
  minRuntime: "v0.13.0",
});

const index = {
  schema: 1,
  generated: "demo fixture — a plugin index that offers versions newer than this runtime",
  revision: placeholder,
  assets: {},
  bundles: {
    "modern-export": {
      ...blockedRow("3.0.0"),
      versions: [blockedRow("3.0.0"), { ...blockedRow("2.0.0"), api: 2, minRuntime: "v0.11.0" }],
    },
    "future-plugin": {
      label: "Future plugin",
      version: "1.0.0",
      api: 3,
      island: "sealed",
      entry: "future-plugin",
      manifest: `${LOCAL}/future-plugin.json`,
      bytes: 2,
      sha384: placeholder,
      assets: 1,
      assetBytes: 2,
      about: "Not installed anywhere: the Available row shows the same runtime requirement.",
      minRuntime: "v0.13.0",
      versions: [{
        label: "Future plugin", version: "1.0.0", api: 3, island: "sealed", entry: "future-plugin",
        manifest: `${LOCAL}/future-plugin.json`, bytes: 2, sha384: placeholder,
        assets: 1, assetBytes: 2, about: "Not installed anywhere.",
        minRuntime: "v0.13.0",
      }],
    },
  },
};
write("index.json", JSON.stringify(index, null, 2) + "\n");

write("blocked-plugin.html", documentWith((manifest) => {
  manifest.pluginIndex = `${LOCAL}/index.json`;
  /* An installed plugin whose pinned contract is newer than this file's. It has no figure,
     so nothing tries to run it; the sheet is enough to show the row and its remedy. */
  manifest.assets.push({
    id: "modern-export",
    kind: "js",
    role: "module",
    order: 910,
    mode: "online",
    category: "plugin",
    plugin: "modern-export",
    requiredBy: ["*"],
    bytes: 2,
    url: `${LOCAL}/modern-export-2.js`,
    integrity: placeholder,
  });
  manifest.plugins = {
    "modern-export": {
      label: "Modern export",
      version: "2.0.0",
      api: 3,
      island: "sealed",
      enabled: true,
      entry: "modern-export",
      assets: ["modern-export"],
      contributes: {},
    },
  };
}));

/* --------------------------------------------------------------- the landing page */

const page = (title, body) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { margin: 0; padding: 48px 24px; font: 16px/1.55 Charter, Georgia, serif; color: #23201c; background: #faf8f4; }
    main { max-width: 760px; margin: 0 auto; }
    h1 { font-size: 30px; margin: 0 0 6px; letter-spacing: -0.01em; }
    p.lead { color: #6b645c; margin-top: 0; }
    section { border-top: 1px solid #e6e1d8; padding: 22px 0; }
    h2 { font-size: 19px; margin: 0 0 6px; }
    h2 a { color: #2f6f4f; text-decoration: none; }
    h2 a:hover { text-decoration: underline; }
    code { font-family: ui-monospace, monospace; font-size: 0.9em; background: #f0ece4; padding: 1px 4px; border-radius: 3px; }
    ul { margin: 8px 0 0; padding-left: 20px; }
    li { margin: 3px 0; }
    .note { background: #f3efe6; border-left: 3px solid #c9b98f; padding: 10px 14px; margin-top: 14px; font-size: 14px; }
  </style>
</head>
<body><main>${body}</main></body>
</html>
`;

write("index.html", page("Resilience demos", `
  <h1>Resilience demos</h1>
  <p class="lead">Three generated documents that show what a failure is allowed to cost.</p>

  <section>
    <h2><a href="soft-module.html">1 · A soft module</a></h2>
    <p>The <code>plugins</code> module points at a URL nobody serves and carries
    <code>critical: false</code>. The editor opens, the content and save path work, and the
    boot card says <strong>Ready — with limitations</strong> with the reason and the remedy.
    The Plugins sheet is absent; nothing else is.</p>
    <div class="note">Look for: the boot card's list and <code>Continue</code>; About →
    diagnostics says <code>next: update this file's runtime…</code>; the toolbar still works.</div>
  </section>

  <section>
    <h2><a href="soft-plugin.html">2 · A soft plugin</a></h2>
    <p>A pinned plugin's bytes are missing. The document is already ready when the figure
    mounts, so the failure belongs to the figure: it shows the reason and a retry, and the
    paragraph below it is still editable.</p>
    <div class="note">Look for: the figure's card, the paragraph and editing around it, and the
    plugin's row in Document settings → Plugins (error kind <code>http</code>).</div>
  </section>

  <section>
    <h2><a href="blocked-plugin.html">3 · A plugin newer than the runtime</a></h2>
    <p>The document's <code>pluginIndex</code> offers versions that ask for host API 3 while
    this file provides 2. Instead of an Install button that cannot work, the rows say
    <strong>Update runtime to v0.13.0</strong> — the oldest release that would satisfy them.
    The installed row's button opens Document settings → Runtime.</p>
    <div class="note">Look for: the installed <em>Modern export</em> row and the Available
    <em>Future plugin</em> row; the sentence names the API it needs and the release that
    provides it.</div>
  </section>

  <section>
    <p>Generated by <code>npm run demo:resilience</code>. Serve the repository root with
    <code>npm run dev</code> — the fixtures are fetched, so <code>file://</code> is not enough
    for 1 and 3.</p>
  </section>
`));

console.log("demo-resilience: wrote .test-tmp/resilience-demo/{index,soft-module,soft-plugin,blocked-plugin}.html");
console.log(`demo-resilience: open ${LOCAL}/index.html (serve: npm run dev)`);
