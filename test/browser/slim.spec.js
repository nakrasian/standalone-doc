import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* The slim flavour: the same document, with every module and stylesheet fetched
   from the CDN. These specs are the loader's contract — happy path plus one test
   per failure mode, each mocking exactly one thing. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const CDN = "http://127.0.0.1:8080/dist/cdn";
/* One fixture per worker: the specs run in parallel and mutate this file (the
   timeout spec lowers timeoutMs), so a shared name races between workers. */
const FILE = `.test-tmp/slim-${process.pid}.html`;
const URL_PATH = "/" + FILE;

const SLIM = fs.readFileSync(path.join(ROOT, "dist/slim.html"), "utf8");

/** Point the document at the locally served CDN copies, optionally lowering the
 *  timeout so the timeout spec does not take eight seconds. */
function makeSlim({ timeoutMs } = {}) {
  /* Every asset url is baked in at build time, so replace the published base
     everywhere rather than only the cdnBase field. */
  const published = /"cdnBase":"([^"]*)"/.exec(SLIM)[1];
  let html = SLIM.split(published).join(CDN);
  if (timeoutMs) html = html.replace(/"timeoutMs":\d+/, `"timeoutMs":${timeoutMs}`);
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(path.join(ROOT, FILE), html);
}

async function load(page) {
  const problems = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto(URL_PATH);
  await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, { timeout: 20_000 });
  return problems;
}

const dialogState = (page) =>
  page.evaluate(() => {
    const el = document.getElementById("boot-dialog");
    return {
      state: globalThis.StandaloneDoc.state,
      open: el.open,
      title: el.querySelector("[data-boot-title]").textContent,
      body: el.querySelector("[data-boot-error-body]").textContent,
      diag: el.querySelector("[data-boot-diag]").textContent,
      kind: globalThis.StandaloneDoc.errors[0]?.kind ?? null,
    };
  });

test.beforeAll(() => makeSlim());

test("boots entirely from the CDN", async ({ page }) => {
  const problems = await load(page);
  const info = await page.evaluate(() => ({
    state: StandaloneDoc.state,
    built: Object.keys(StandaloneDoc.modules),
    signals: typeof StandaloneDoc.modules.signals,
    figures: typeof StandaloneDoc.modules.figures,
    /* nothing carried the module code inline */
    inlineBlocks: document.querySelectorAll('script[id="signals"], script[id="figures"]').length,
    injectedStyles: [...document.querySelectorAll('style[data-asset]')].map((el) => el.dataset.asset),
    stats: document.querySelector("[data-stats]").textContent,
    toolbar: !!document.getElementById("app-toolbar"),
  }));

  expect(problems).toEqual([]);
  expect(info.state).toBe("ready");
  expect(info.built).toHaveLength(12);
  expect(info.signals).toBe("object");
  expect(info.figures).toBe("object");
  expect(info.inlineBlocks).toBe(0);
  expect(info.injectedStyles).toEqual(["page-styles", "toolbar-styles"]);
  expect(info.stats).toMatch(/\d+ words?/);
  expect(info.toolbar).toBe(true);
});

test("source() returns the bytes the manifest pins, cached", async ({ page }) => {
  /* The seam Phase 4's save policies use: an asset that booted from the CDN can be
     embedded in a saved file, and what gets embedded is exactly what was verified. */
  await load(page);
  const result = await page.evaluate(async () => {
    const entry = StandaloneDoc.manifest().assets.find((asset) => asset.id === "figures");
    const text = await StandaloneDoc.source("figures");
    const digest = await crypto.subtle.digest("SHA-384", new TextEncoder().encode(text));
    let binary = "";
    for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
    return {
      actual: "sha384-" + btoa(binary),
      expected: entry.integrity,
      head: text.slice(0, 40),
      cached: (await StandaloneDoc.source("figures")) === text,
    };
  });
  expect(result.actual).toBe(result.expected);
  expect(result.head).toContain("export function createFigures(deps = {})");
  expect(result.cached).toBe(true);
});

test("a view-mode document never asks the CDN for editor assets", async ({ page }) => {
  const published = /"cdnBase":"([^"]*)"/.exec(SLIM)[1];
  const file = `.test-tmp/slim-view-${process.pid}.html`;
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, file),
    SLIM.split(published)
      .join(CDN)
      .replace(
        /(<script id="doc-settings" type="application\/json">)([\s\S]*?)(<\/script>)/,
        (match, open, json, close) => open + JSON.stringify({ ...JSON.parse(json), mode: "view", editable: false }) + close,
      ),
  );

  const requested = [];
  page.on("request", (request) => requested.push(request.url()));
  await page.goto("/" + file);
  await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, { timeout: 20_000 });

  const built = await page.evaluate(() => StandaloneDoc.order());
  const fetched = requested
    .filter((url) => url.includes("/dist/cdn/"))
    .map((url) => url.split("/").pop())
    .sort();

  expect(built).toEqual(["apply-settings", "signals", "zoom", "pagination", "figures"]);
  /* progress is authoring-only, so a viewer never fetches it either. */
  expect(fetched).toEqual(["apply-settings.js", "figures.js", "page-styles.css", "pagination.js", "signals.js", "zoom.js"]);
});

test("a slim document can be saved back to a fully inline file", async ({ page }) => {
  /* The reverse direction needs the bytes, so it goes through source(): fetch,
     verify, embed. This is the only policy path that touches the network. */
  await load(page);
  const result = await page.evaluate(async () => {
    const toolbar = StandaloneDoc.modules.toolbar;
    const {html} = await toolbar.serialize({policy: "inline"});
    const ids = ["apply-settings", "signals", "zoom", "pagination", "progress", "status", "editor", "figures", "policy", "toolbar", "plugins", "export"];
    const missing = ids.filter((id) => !html.includes(`id="${id}"`));
    const unregistered = ids.filter((id) => !new RegExp(`StandaloneDoc\\.register\\("${id}"`).test(html));
    const styles = ["page-styles", "toolbar-styles"].filter((id) => !new RegExp(`<style id="${id}"`).test(html));
    /* Parse, never text-search: the policy module's own source contains the
       literal `data-asset="`, so a string count would match the checker code. */
    const parsed = new DOMParser().parseFromString(html, "text/html");
    return {
      missing,
      unregistered,
      missingStyles: styles,
      toolbar: !!html.includes('id="app-toolbar"'),
      symbols: (html.match(/<symbol /g) || []).length,
      fragmentMarkers: (html.match(/@asset id=\"(sprite|toolbar-markup|figure-tools|dialogs)\"/g) || []).length,
      injectedStylesLeft: parsed.querySelectorAll("style[data-asset]").length,
      stillOnline: /"mode":"online"/.test(html),
      /* inline is the default, so materialising it stores no policy key. Parsed, not
         text-matched: "assets" also names the manifest's array. */
      storesPolicy: (() => {
        const settings = JSON.parse(parsed.getElementById("doc-settings").textContent);
        return "policy" in settings || "assets" in settings;
      })(),
      validate: toolbar.validate(html),
    };
  });

  expect(result.missing).toEqual([]);
  expect(result.unregistered).toEqual([]);
  expect(result.missingStyles).toEqual([]);
  /* Injected <style data-asset> is session state; it must not be saved twice. */
  expect(result.injectedStylesLeft).toBe(0);
  expect(result.stillOnline).toBe(false);
  expect(result.storesPolicy).toBe(false);
  /* The chrome came back as markup, from the verified fragment plus its open tag. */
  expect(result.toolbar).toBe(true);
  expect(result.symbols).toBe(24);
  expect(result.fragmentMarkers).toBe(4);
  expect(result.validate).toEqual([]);
});

test("an HTTP error is reported as a missing asset", async ({ page }) => {
  await page.route("**/dist/cdn/signals.js", (route) => route.fulfill({ status: 404, body: "not found" }));
  await load(page);
  const seen = await dialogState(page);
  expect(seen.state).toBe("failed");
  expect(seen.kind).toBe("http");
  expect(seen.title).toBe("An asset is missing from the CDN");
  expect(seen.body).toContain("HTTP 404");
  expect(seen.diag).toContain("signals.js");
});

test("a tampered asset is refused, not run", async ({ page }) => {
  await page.route("**/dist/cdn/signals.js", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "export function createSignals() { throw new Error('pwned'); }" }),
  );
  await load(page);
  const seen = await dialogState(page);
  expect(seen.state).toBe("failed");
  expect(seen.kind).toBe("integrity");
  expect(seen.title).toBe("This document's code has been altered");
  expect(seen.diag).toContain("expected sha384-");
  expect(await page.evaluate(() => typeof Signals)).toBe("undefined");
});

test("a blocked CDN is reported as unreachable, not as offline", async ({ page }) => {
  await page.route("**/dist/cdn/**", (route) => route.abort("failed"));
  await load(page);
  const seen = await dialogState(page);
  expect(seen.kind).toBe("unreachable");
  expect(seen.title).toBe("The CDN is unreachable");
  expect(seen.body).toContain("Your connection is working");
});

test("navigator.onLine === false labels the failure as offline", async ({ page }) => {
  /* Offline is a *label*, never a decision: the same aborted fetch, different copy. */
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "onLine", { get: () => false });
  });
  await page.route("**/dist/cdn/**", (route) => route.abort("failed"));
  await load(page);
  const seen = await dialogState(page);
  expect(seen.kind).toBe("offline");
  expect(seen.title).toBe("You appear to be offline");
});

test("a stalled request times out", async ({ page }) => {
  makeSlim({ timeoutMs: 250 });
  await page.route("**/dist/cdn/signals.js", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await route.abort("timedout").catch(() => {});
  });
  await load(page);
  const seen = await dialogState(page);
  expect(seen.kind).toBe("timeout");
  expect(seen.title).toBe("Loading timed out");
  makeSlim();
});

test("nothing paints behind the dialog until boot finishes", async ({ page }) => {
  await page.route("**/dist/cdn/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  await page.goto(URL_PATH);

  const during = await page.evaluate(async () => ({
    boot: document.documentElement.dataset.bootState,
    /* The chrome is a fetched fragment, so before boot settles it does not exist at
       all — stronger than "present but hidden", and no half-styled toolbar. */
    toolbar: document.getElementById("app-toolbar") ? "present" : "absent",
    stage: getComputedStyle(document.getElementById("viewport")).visibility,
    background: getComputedStyle(document.documentElement).backgroundColor,
  }));
  expect(during.boot).toBe("booting");
  expect(during.toolbar).toBe("absent");
  expect(during.stage).toBe("hidden");
  /* the stage colour, not the app: no sprite flash, no half-styled toolbar */
  expect(during.background).toBe("rgb(224, 224, 224)");

  await page.waitForFunction(() => window.StandaloneDoc?.state === "ready", null, { timeout: 20_000 });
  const after = await page.evaluate(() => ({
    boot: document.documentElement.dataset.bootState,
    toolbar: document.getElementById("app-toolbar") ? getComputedStyle(document.getElementById("app-toolbar")).visibility : "absent",
    symbols: document.querySelectorAll("symbol").length,
    dialogOpen: document.getElementById("boot-dialog").open,
  }));
  expect(after).toEqual({ boot: "ready", toolbar: "visible", symbols: 24, dialogOpen: false });
});
