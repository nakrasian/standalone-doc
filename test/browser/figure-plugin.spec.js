import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/* A figure whose plugin is not there still has to be a figure.
 *
 *   - the element and its store entry survive: the file is byte-stable, and the
 *     plugin can be added later without touching the content
 *   - the frame says why, in place, and clicking retries
 *   - a failing plugin is not refetched on every scroll (a click is deliberate)
 *   - once the plugin builds, the figure mounts and `pluginUsage()` counts it
 *
 * The plugin's bytes are served from .test-tmp/, so this exercises the real
 * fetch → SHA-384 → construct → mount path. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const STAGE = "http://127.0.0.1:8080/.test-tmp";
const EDITOR = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");

const PLUGIN_JS = `globalThis.__evalCount = (globalThis.__evalCount || 0) + 1;

export function createWhiteboard(deps = {}) {
  return { kind: "whiteboard", mode: deps.settings && deps.settings.mode };
}
`;

const sha384 = (text) => "sha384-" + createHash("sha384").update(text, "utf8").digest("base64");
const byteLength = (text) => Buffer.byteLength(text, "utf8");
const MANIFEST_RE = /(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/;
const STORE_RE = /(<script id="figure-store" type="application\/json">)([\s\S]*?)(<\/script>)/;
const FIGURE_ID = "fig-board";

function writePlugin() {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(path.join(TMP, "figure-plugin.js"), PLUGIN_JS);
}

/**
 * An editor document with one plugin-backed figure in it.
 *
 * `pinned: false` is the case that matters most: the store entry names a plugin the
 * document has no copy of, and the figure must not lose its place over it.
 */
function makeDoc({ pinned = true, tampered = false } = {}) {
  writePlugin();
  let html = EDITOR;
  const manifest = JSON.parse(MANIFEST_RE.exec(html)[2]);

  if (pinned) {
    manifest.assets.push({
      id: "whiteboard",
      kind: "js",
      role: "module",
      order: 210,
      mode: "online",
      category: "plugin",
      plugin: "whiteboard",
      requiredBy: ["*"],
      bytes: byteLength(PLUGIN_JS),
      factory: "createWhiteboard",
      url: `${STAGE}/figure-plugin.js`,
      integrity: tampered ? sha384(PLUGIN_JS + "\n// different bytes\n") : sha384(PLUGIN_JS),
    });
    manifest.plugins = {
      whiteboard: {
        label: "Whiteboard",
        version: "1.0.0",
        island: "sealed",
        enabled: true,
        entry: "whiteboard",
        assets: ["whiteboard"],
      },
    };
  }
  html = html.replace(MANIFEST_RE, (_, open, _json, close) => open + JSON.stringify(manifest) + close);

  const store = JSON.parse(STORE_RE.exec(html)[2]);
  store.figures[FIGURE_ID] = {
    id: FIGURE_ID,
    kind: "html",
    name: "Board",
    mime: "text/html",
    bytes: 24,
    hash: "probe",
    src: "data:text/html,<p>board</p>",
    width: 0,
    height: 0,
    plugin: { id: "whiteboard", label: "Whiteboard", url: `${STAGE}/figure-plugin.js`, integrity: sha384(PLUGIN_JS) },
  };
  html = html.replace(STORE_RE, (_, open, _json, close) => open + JSON.stringify(store) + close);

  const figure = `<figure class="figure" data-figure-id="${FIGURE_ID}" data-kind="html">`
    + `<div class="figure-frame" data-runtime="ephemeral"></div><figcaption>Board</figcaption></figure>`;
  html = html.replace('<article id="content" contenteditable="true" spellcheck="true">', `<article id="content" contenteditable="true" spellcheck="true">${figure}`);

  const slug = !pinned ? "bare" : tampered ? "tampered" : "pinned";
  const name = `.test-tmp/figure-plugin-${process.pid}-${slug}.html`;
  fs.writeFileSync(path.join(ROOT, name), html);
  return "/" + name;
}

async function load(page, url) {
  const requests = [];
  page.on("request", (request) => {
    if (request.url().includes("figure-plugin.js")) requests.push(request.url());
  });
  const problems = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, { timeout: 20_000 });
  return { requests, problems };
}

const figureState = (page) =>
  page.evaluate((id) => {
    const figure = document.querySelector(`figure[data-figure-id="${id}"]`);
    const notice = figure && figure.querySelector(".figure-plugin");
    return {
      exists: Boolean(figure),
      pluginState: figure?.dataset.pluginState ?? null,
      notice: notice ? notice.textContent : null,
      noticeState: notice?.dataset.state ?? null,
      iframe: Boolean(figure && figure.querySelector(".figure-frame iframe")),
      stored: Boolean(globalThis.StandaloneDoc.modules.figures.store.figures[id]),
      usage: globalThis.StandaloneDoc.modules.figures.pluginUsage(),
      docState: globalThis.StandaloneDoc.state,
    };
  }, FIGURE_ID);

test.beforeAll(() => writePlugin());

test("a figure with no pinned copy keeps its place and says why", async ({ page }) => {
  const { problems } = await load(page, makeDoc({ pinned: false }));
  await page.waitForFunction((id) => {
    const figure = document.querySelector(`figure[data-figure-id="${id}"]`);
    return figure?.dataset.pluginState === "failed";
  }, FIGURE_ID);
  const state = await figureState(page);
  expect(state.exists).toBe(true);
  expect(state.pluginState).toBe("failed");
  expect(state.noticeState).toBe("failed");
  expect(state.notice).toContain("Needs Whiteboard");
  expect(state.notice).toContain("not in this copy of the file");
  expect(state.notice).toContain("Click to retry");
  expect(state.iframe).toBe(false);
  /* The specification is intact: the entry is still in the store, and the policy can
     still price it. */
  expect(state.stored).toBe(true);
  expect(state.usage).toEqual({ whiteboard: 1 });
  expect(state.docState).toBe("ready");
  expect(problems).toEqual([]);
});

test("a figure mounts once its plugin is verified and built", async ({ page }) => {
  const { requests, problems } = await load(page, makeDoc());
  await page.waitForFunction((id) => {
    const figure = document.querySelector(`figure[data-figure-id="${id}"]`);
    return figure?.dataset.pluginState === "ready";
  }, FIGURE_ID);
  const state = await figureState(page);
  expect(state.pluginState).toBe("ready");
  expect(state.notice).toBe(null);
  expect(state.iframe).toBe(true);
  expect(state.usage).toEqual({ whiteboard: 1 });
  expect(state.docState).toBe("ready");
  expect(requests.length).toBe(1);
  expect(problems).toEqual([]);
});

test("a failing plugin is not refetched by scrolling, only by a click", async ({ page }) => {
  const { requests } = await load(page, makeDoc({ tampered: true }));
  await page.waitForFunction((id) => {
    const figure = document.querySelector(`figure[data-figure-id="${id}"]`);
    return figure?.dataset.pluginState === "failed";
  }, FIGURE_ID);

  const failure = await figureState(page);
  expect(failure.notice).toContain("do not match the pinned hash");
  const afterFirst = requests.length;

  /* Three rescans, as the observer would do while the reader scrolls. */
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) globalThis.StandaloneDoc.modules.figures.scan();
  });
  await page.waitForTimeout(250);
  expect(requests.length).toBe(afterFirst);

  /* A click is deliberate, so it tries again. */
  await page.click(`figure[data-figure-id="${FIGURE_ID}"] .figure-plugin`);
  await page.waitForTimeout(400);
  expect(requests.length).toBe(afterFirst + 1);
  const afterRetry = await figureState(page);
  expect(afterRetry.pluginState).toBe("failed");
});

test("the plugin state is session state: it does not travel in a save", async ({ page }) => {
  await load(page, makeDoc());
  await page.waitForFunction((id) => {
    const figure = document.querySelector(`figure[data-figure-id="${id}"]`);
    return figure?.dataset.pluginState === "ready";
  }, FIGURE_ID);
  const stripped = await page.evaluate((id) => {
    const clone = document.documentElement.cloneNode(true);
    globalThis.StandaloneDoc.modules.figures.prepareClone(clone);
    const figure = clone.querySelector(`figure[data-figure-id="${id}"]`);
    return {
      attribute: figure?.hasAttribute("data-plugin-state"),
      frameChildren: figure?.querySelector(".figure-frame")?.childNodes.length,
    };
  }, FIGURE_ID);
  expect(stripped.attribute).toBe(false);
  /* The mounted iframe is ephemeral: the clone's frame is empty. */
  expect(stripped.frameChildren).toBe(0);
});
