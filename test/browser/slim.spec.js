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
const URL_PATH = "/.test-tmp/slim.html";

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
  fs.writeFileSync(path.join(TMP, "slim.html"), html);
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
    signals: typeof Signals,
    figures: typeof Figures,
    /* nothing carried the module code inline */
    inlineBlocks: document.querySelectorAll('script[id="signals"], script[id="figures"]').length,
    injectedStyles: [...document.querySelectorAll('style[data-asset]')].map((el) => el.dataset.asset),
    stats: document.querySelector("[data-stats]").textContent,
    toolbar: !!document.getElementById("app-toolbar"),
  }));

  expect(problems).toEqual([]);
  expect(info.state).toBe("ready");
  expect(info.built).toHaveLength(9);
  expect(info.signals).toBe("object");
  expect(info.figures).toBe("object");
  expect(info.inlineBlocks).toBe(0);
  expect(info.injectedStyles).toEqual(["page-styles", "toolbar-styles"]);
  expect(info.stats).toMatch(/\d+ words?/);
  expect(info.toolbar).toBe(true);
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
