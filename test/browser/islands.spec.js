import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* The island profiles, asserted by behaviour rather than by attribute:
 *
 *   sealed     no network, no parent, and WebAssembly still compiles
 *   sandboxed  may fetch (a user's own HTML may need to), still no parent
 *   trusted    + allow-same-origin: the content can reach this document
 *
 * This is lab/005's measurement turned into a contract. The `'wasm-unsafe-eval'` row
 * matters: without it `default-src 'none'` blocks WebAssembly.compile and every
 * wasm-backed plugin fails in a sealed island.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const EDITOR = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");
const STORE_RE = /(<script id="figure-store" type="application\/json">)([\s\S]*?)(<\/script>)/;
const CONTENT_OPEN = '<article id="content" contenteditable="true" spellcheck="true">';
const CDN_FILE = "https://cdn.jsdelivr.net/gh/nakrasian/standalone-doc@v0.2.0/dist/cdn/signals.js";

const ISLAND = (id) => `<body style="margin:0;font:12px system-ui">
<script>
(async () => {
  const out = { fetch: "?", parent: "?", wasm: "?" };
  try {
    const response = await fetch(${JSON.stringify(CDN_FILE)}, { mode: "cors" });
    out.fetch = response.ok ? "ok" : "http " + response.status;
  } catch (error) { out.fetch = "blocked"; }
  try { out.parent = parent.document.title ? "reachable" : "empty"; }
  catch (error) { out.parent = "blocked"; }
  try {
    await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    out.wasm = "ok";
  } catch (error) { out.wasm = "blocked"; }
  parent.postMessage({ island: ${JSON.stringify(id)}, result: out }, "*");
})();
</scr` + `ipt>
</body>`;

/** One document, three figures, one profile each. */
function makeDoc() {
  const cases = [
    { id: "fig-sealed", island: "sealed" },
    { id: "fig-sandboxed", island: "sandboxed" },
    { id: "fig-trusted", island: "trusted" },
  ];
  let html = EDITOR;
  const store = JSON.parse(STORE_RE.exec(html)[2]);
  for (const entry of cases) {
    store.figures[entry.id] = {
      id: entry.id,
      kind: "html",
      name: entry.island,
      mime: "text/html",
      bytes: 10,
      hash: entry.id,
      src: ISLAND(entry.id),
      width: 0,
      height: 0,
      island: entry.island,
    };
  }
  /* `<` must not appear raw in a JSON script block: an island's own </script> would end
     the block early. figures.js escapes it the same way when it writes the store. */
  html = html.replace(STORE_RE, (_, open, _json, close) => open + JSON.stringify(store).replace(/</g, "\\u003c") + close);
  html = html.replace(
    CONTENT_OPEN,
    CONTENT_OPEN + cases.map((entry) =>
      `<figure class="figure" data-figure-id="${entry.id}" data-kind="html">`
      + `<div class="figure-frame" data-runtime="ephemeral"></div><figcaption>${entry.island}</figcaption></figure>`).join(""),
  );

  fs.mkdirSync(TMP, { recursive: true });
  const name = `.test-tmp/islands-${process.pid}.html`;
  fs.writeFileSync(path.join(ROOT, name), html);
  return "/" + name;
}

async function mounted(page) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(makeDoc());
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, { timeout: 20_000 });
  /* Mount explicitly: the profiles are what is under test, not IntersectionObserver. */
  await page.evaluate(() => {
    const figures = StandaloneDoc.modules.figures;
    for (const figure of document.querySelectorAll("figure.figure")) figures.mount(figure);
  });
  await page.waitForFunction(() => document.querySelectorAll("iframe").length === 3);
  await page.waitForFunction(() => globalThis.__results && Object.keys(globalThis.__results).length === 3, null, { timeout: 20_000 });
  const state = await page.evaluate(() => ({
    results: globalThis.__results,
    frames: [...document.querySelectorAll("figure.figure")].map((figure) => {
      const iframe = figure.querySelector("iframe");
      return {
        id: figure.dataset.figureId,
        sandbox: iframe.getAttribute("sandbox"),
        csp: /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(iframe.srcdoc)?.[1] ?? null,
        allow: iframe.getAttribute("allow"),
      };
    }),
  }));
  return { state, problems };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    globalThis.__results = {};
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (data && data.island) globalThis.__results[data.island] = data.result;
    });
  });
});

test("sealed has no network, no parent, and still compiles wasm", async ({ page }) => {
  const { state, problems } = await mounted(page);
  expect(state.results["fig-sealed"]).toEqual({ fetch: "blocked", parent: "blocked", wasm: "ok" });

  const frame = state.frames.find((entry) => entry.id === "fig-sealed");
  expect(frame.sandbox).toBe("allow-scripts");
  expect(frame.csp).toContain("connect-src 'none'");
  expect(frame.csp).toContain("'wasm-unsafe-eval'");
  expect(frame.csp).toContain("frame-src 'none'");
  expect(problems).toEqual([]);
});

test("sandboxed may fetch, but still cannot reach the document", async ({ page }) => {
  const { state, problems } = await mounted(page);
  expect(state.results["fig-sandboxed"]).toEqual({ fetch: "ok", parent: "blocked", wasm: "ok" });

  const frame = state.frames.find((entry) => entry.id === "fig-sandboxed");
  /* The default for user content: keeps the legacy sandbox, and no policy is injected. */
  expect(frame.sandbox).toBe("allow-scripts allow-downloads");
  expect(frame.csp).toBe(null);
  expect(problems).toEqual([]);
});

test("trusted content can reach the document", async ({ page }) => {
  const { state, problems } = await mounted(page);
  expect(state.results["fig-trusted"]).toEqual({ fetch: "ok", parent: "reachable", wasm: "ok" });
  expect(state.frames.find((entry) => entry.id === "fig-trusted").sandbox).toContain("allow-same-origin");
  expect(problems).toEqual([]);
});

test("an older figure with `trusted: true` and no profile still behaves as trusted", async ({ page }) => {
  const name = `.test-tmp/islands-legacy-${process.pid}.html`;
  let html = EDITOR;
  const store = JSON.parse(STORE_RE.exec(html)[2]);
  store.figures.legacy = {
    id: "legacy", kind: "html", name: "legacy", mime: "text/html",
    bytes: 10, hash: "legacy", src: ISLAND("legacy"), width: 0, height: 0,
    trusted: true,
  };
  /* `<` must not appear raw in a JSON script block: an island's own </script> would end
     the block early. figures.js escapes it the same way when it writes the store. */
  html = html.replace(STORE_RE, (_, open, _json, close) => open + JSON.stringify(store).replace(/</g, "\\u003c") + close);
  html = html.replace(CONTENT_OPEN, CONTENT_OPEN
    + '<figure class="figure" data-figure-id="legacy" data-kind="html">'
    + '<div class="figure-frame" data-runtime="ephemeral"></div><figcaption>legacy</figcaption></figure>');
  fs.writeFileSync(path.join(ROOT, name), html);

  await page.goto("/" + name);
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, { timeout: 20_000 });
  await page.evaluate(() => StandaloneDoc.modules.figures.mount(document.querySelector("figure.figure")));
  await page.waitForFunction(() => globalThis.__results?.legacy);
  const result = await page.evaluate(() => globalThis.__results.legacy);
  expect(result.parent).toBe("reachable");
});

test("a figure may ask for a permission without gaining capability", async ({ page }) => {
  const name = `.test-tmp/islands-allow-${process.pid}.html`;
  let html = EDITOR;
  const store = JSON.parse(STORE_RE.exec(html)[2]);
  store.figures.fs = {
    id: "fs", kind: "html", name: "fullscreen", mime: "text/html",
    bytes: 10, hash: "fs", src: "<body>fs</body>", width: 0, height: 0,
    island: "sealed", permissions: ["fullscreen"],
  };
  /* `<` must not appear raw in a JSON script block: an island's own </script> would end
     the block early. figures.js escapes it the same way when it writes the store. */
  html = html.replace(STORE_RE, (_, open, _json, close) => open + JSON.stringify(store).replace(/</g, "\\u003c") + close);
  html = html.replace(CONTENT_OPEN, CONTENT_OPEN
    + '<figure class="figure" data-figure-id="fs" data-kind="html">'
    + '<div class="figure-frame" data-runtime="ephemeral"></div><figcaption>fs</figcaption></figure>');
  fs.writeFileSync(path.join(ROOT, name), html);

  await page.goto("/" + name);
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, { timeout: 20_000 });
  await page.evaluate(() => StandaloneDoc.modules.figures.mount(document.querySelector("figure.figure")));
  await page.waitForSelector("figure.figure iframe");
  const frame = await page.evaluate(() => {
    const iframe = document.querySelector("figure.figure iframe");
    return { allow: iframe.getAttribute("allow"), sandbox: iframe.getAttribute("sandbox") };
  });
  /* A permissions-policy grant, not a sandbox flag: the island is still sealed. */
  expect(frame.allow).toBe("fullscreen");
  expect(frame.sandbox).toBe("allow-scripts");
});
