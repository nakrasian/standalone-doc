import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* Autosave: the one thing in this runtime that writes without being asked.
 *
 * Every test here is about a rule that exists to *stop* it, because that is the whole risk:
 *
 *   - nothing happens for a document that never asked (`off` is the default, and the default
 *     for every file written before the field);
 *   - a document with no `cloud` has no sink, whatever the field says;
 *   - a keystroke is not a milestone: autosaves send `?checkpoint=0`, and ⌘S does not;
 *   - a `409` stops the timer and becomes a bar with two decisions — a retry loop against a
 *     conflict loses the other tab's work one keystroke at a time;
 *   - a failure speaks **once**, then a bar says how long until the next attempt.
 *
 * The library is mocked at the network edge, never in the page: what is under test is what
 * the document *sends*, and what it does with what comes back.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const EDITOR = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");
const SETTINGS = /(<script id="doc-settings"[^>]*>)([\s\S]*?)(<\/script>)/;
const ID = "abc123";
const START = "2026-11-25T10:00:00.000Z";

/** `dist/editor.html` as a library document, with whatever autosave settings asked for. */
function writeDoc(name, {autosave = null} = {}) {
  const html = EDITOR.replace(SETTINGS, (match, open, json, close) =>
    open +
    JSON.stringify({
      ...JSON.parse(json),
      cloud: {id: ID, api: "/api/docs"},
      ...(autosave ? {autosave} : {}),
    }) +
    close);
  fs.mkdirSync(TMP, { recursive: true });
  const file = `.test-tmp/autosave-${process.pid}-${name}.html`;
  fs.writeFileSync(path.join(ROOT, file), html);
  return "/" + file;
}

/**
 * The library, as far as one document can tell: a version, a snapshot flag and a way to be
 * another tab (bump the version behind the document's back).
 */
async function serve(page) {
  const puts = [];
  const state = {version: START, failWith: null};
  /* A regex, not a path glob: a glob ends at the path and does not match the query string,
     and `?checkpoint=0` is half of what this suite asserts. */
  await page.route(new RegExp(`/api/docs/${ID}(\\?.*)?$`), async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {etag: `"${state.version}"`},
        body: JSON.stringify({id: ID, updatedAt: state.version, savedAt: state.version}),
      });
    }
    const url = request.url();
    const ifMatch = request.headers()["if-match"] || null;
    const checkpoint = !url.includes("checkpoint=0");
    if (state.failWith) {
      return route.fulfill({status: state.failWith, contentType: "application/json", body: JSON.stringify({error: "the library said no"})});
    }
    if (ifMatch && ifMatch !== state.version) {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "this document changed elsewhere since you opened it",
          code: "conflict",
          current: {updatedAt: state.version, savedAt: state.version},
        }),
      });
    }
    puts.push({checkpoint, ifMatch, bytes: (request.postData() || "").length});
    state.version = new Date(Date.parse(state.version) + 60_000).toISOString();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {etag: `"${state.version}"`},
      body: JSON.stringify({id: ID, savedAt: state.version, checkpoint}),
    });
  });
  return {puts, state};
}

async function load(page, url) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, {timeout: 20_000});
  expect(await page.evaluate(() => globalThis.StandaloneDoc.state)).toBe("ready");
  return errors;
}

/** Type into the document the way a person does: caret at the end, then keys. */
async function type(page, text = "x") {
  await page.click("#content");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}

const notice = (page) =>
  page.evaluate(() => {
    const el = document.querySelector("[data-notice]");
    return {
      visible: !el.hidden,
      tone: el.dataset.tone ?? null,
      text: el.querySelector("[data-notice-text]").textContent,
      primary: el.querySelector("[data-notice-primary]").hidden ? null : el.querySelector("[data-notice-primary]").textContent,
      secondary: el.querySelector("[data-notice-secondary]").hidden ? null : el.querySelector("[data-notice-secondary]").textContent,
    };
  });

test("a document that never asked is never written to", async ({ page }) => {
  const library = await serve(page);
  const errors = await load(page, writeDoc("off"));
  expect(errors).toEqual([]);

  await type(page);
  await page.waitForTimeout(600);
  expect(library.puts).toEqual([]);
  /* Not even a version read: nothing about this document needs to know. */
  expect(await page.evaluate(() => globalThis.StandaloneDoc.settings().autosave)).toEqual({
    mode: "off",
    idleMs: 2000,
    intervalMs: 60000,
  });
});

test("idle: one save after typing stops, without a checkpoint", async ({ page }) => {
  const library = await serve(page);
  await load(page, writeDoc("idle", {autosave: {mode: "idle", idleMs: 150}}));

  await type(page, "hello");
  await expect.poll(() => library.puts.length, {timeout: 5000}).toBe(1);
  /* A keystroke is not a milestone, and the version it quotes is the one it read. */
  expect(library.puts[0]).toMatchObject({checkpoint: false, ifMatch: START});

  /* `Saved 12:04` in place, and no toast: the person did not ask, so they are not told. */
  const quiet = await page.evaluate(() => ({
    saved: document.querySelector("[data-saved]")?.textContent || "",
    toastHidden: document.querySelector("[data-toast]").hidden,
    dirty: !document.querySelector("[data-dirty]").hidden,
  }));
  expect(quiet.saved).toMatch(/^Saved \d/);
  expect(quiet.toastHidden).toBe(true);
  expect(quiet.dirty).toBe(false);
});

test("interval: a clock, and nothing written when nothing changed", async ({ page }) => {
  const library = await serve(page);
  await load(page, writeDoc("interval", {autosave: {mode: "interval", intervalMs: 200}}));

  /* Several ticks with no edit: the comparison with what the library confirmed is what
     keeps an idle document from rewriting itself every interval. */
  await page.waitForTimeout(800);
  expect(library.puts).toEqual([]);

  await type(page);
  await expect.poll(() => library.puts.length, {timeout: 5000}).toBe(1);
  expect(library.puts[0].checkpoint).toBe(false);
});

test("⌘S is a milestone: it checkpoints, and it shares the version", async ({ page }) => {
  const library = await serve(page);
  await load(page, writeDoc("manual", {autosave: {mode: "idle", idleMs: 150}}));

  await type(page);
  await expect.poll(() => library.puts.length, {timeout: 5000}).toBe(1);
  const afterAutosave = library.state.version;

  await type(page, " more");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => library.puts.length, {timeout: 5000}).toBe(2);
  /* The manual save quotes *the autosave's* version — one writer, one idea of "current". */
  expect(library.puts[1]).toMatchObject({checkpoint: true, ifMatch: afterAutosave});
  /* The person asked, so they get an answer. */
  expect(await page.evaluate(() => document.querySelector("[data-toast]").hidden)).toBe(false);
});

test("a conflict is a bar, and it stops the clock", async ({ page }) => {
  const library = await serve(page);
  await load(page, writeDoc("conflict", {autosave: {mode: "idle", idleMs: 150}}));

  await type(page);
  await expect.poll(() => library.puts.length, {timeout: 5000}).toBe(1);

  /* Another tab saves: the version moves under this document. */
  library.state.version = "2026-11-25T12:00:00.000Z";
  await type(page, " mine");
  await expect.poll(async () => (await notice(page)).visible, {timeout: 5000}).toBe(true);

  expect(await notice(page)).toMatchObject({
    tone: "conflict",
    primary: "Keep mine",
    secondary: "Reload theirs",
  });
  expect((await notice(page)).text).toContain("saved elsewhere");

  /* Nothing is retried: one conflicting write is information, a loop of them is a way to
     lose the other tab's work a keystroke at a time. */
  await page.waitForTimeout(500);
  expect(library.puts.length).toBe(1);

  /* "Keep mine" writes *without* `If-Match` — the library snapshots their version first, so
     the decision is recoverable from History rather than merely decisive. It still
     checkpoints, because a person decided. */
  await page.click("[data-notice-primary]");
  await expect.poll(() => library.puts.length, {timeout: 5000}).toBe(2);
  expect(library.puts[1]).toMatchObject({checkpoint: true, ifMatch: null});
  expect(await notice(page)).toMatchObject({visible: false});
});

test("keep mine re-checks the version, and re-offers when it moved again", async ({ page }) => {
  const library = await serve(page);
  await load(page, writeDoc("recheck", {autosave: {mode: "idle", idleMs: 150}}));

  await type(page);
  await expect.poll(() => library.puts.length, {timeout: 5000}).toBe(1);
  library.state.version = "2026-11-25T12:00:00.000Z";
  await type(page, " mine");
  await expect.poll(async () => (await notice(page)).visible, {timeout: 5000}).toBe(true);

  /* A third save lands while the bar is up. Overwriting something three saves newer is not
     the decision the person made, so the bar stays and says the newer version. */
  library.state.version = "2026-11-25T13:00:00.000Z";
  await page.click("[data-notice-primary]");
  await page.waitForTimeout(300);
  expect(library.puts.length).toBe(1);
  expect(await notice(page)).toMatchObject({visible: true, tone: "conflict"});
});

test("a failed autosave says so once, then shows when it will try again", async ({ page }) => {
  const library = await serve(page);
  await load(page, writeDoc("failed", {autosave: {mode: "idle", idleMs: 150}}));

  library.state.failWith = 500;
  await type(page);
  await expect.poll(async () => (await notice(page)).visible, {timeout: 5000}).toBe(true);

  const bar = await notice(page);
  expect(bar.tone).toBe("warn");
  /* The countdown is the point: a bar that says "retrying" without saying when is a spinner
     with extra words. */
  expect(bar.text).toMatch(/^Could not save · retrying in \d+ s$/);
  expect(bar.primary).toBe("Retry now");
  /* And an error toast — once. It is `role="alert"`, so the count of visible ones is 1. */
  expect(await page.evaluate(() => document.querySelectorAll("[data-toast][role='alert']").length)).toBe(1);

  library.state.failWith = null;
  await page.click("[data-notice-primary]");
  await expect.poll(() => library.puts.length, {timeout: 5000}).toBe(1);
  expect(await notice(page)).toMatchObject({visible: false});
});

test("the mode is chosen in the sheet, and takes effect without reopening", async ({ page }) => {
  const library = await serve(page);
  await load(page, writeDoc("sheet"));

  await page.click('#ui-ribbon [data-menu][aria-label="Document settings"]');
  await page.click("#ui-ribbon [data-settings-open]");
  await page.waitForFunction(() => document.getElementById("doc-settings-dialog")?.open === true);
  await page.click('[data-dd-tab="storage"]');

  /* Offered only where there is a sink: a file saves when it is told to. */
  const row = await page.evaluate(() => {
    const node = document.querySelector("[data-ds-autosave-row]");
    return {hidden: node.hidden, visible: getComputedStyle(node).display !== "none", value: document.querySelector("[data-ds='autosave']").value};
  });
  expect(row).toEqual({hidden: false, visible: true, value: "off"});

  await page.selectOption("[data-ds='autosave']", "idle");
  await page.click("[data-ds-done]");
  /* Written the way it is read: a mode, not the default's absence. */
  expect(await page.evaluate(() => JSON.parse(document.getElementById("doc-settings").textContent).autosave)).toEqual({mode: "idle"});

  /* A mode chosen on a running document arms itself — the sheet has no forward call into
     autosave, and none is needed. */
  await type(page);
  await expect.poll(() => library.puts.length, {timeout: 5000}).toBe(1);
  expect(library.puts[0].checkpoint).toBe(false);
});

test("a review copy in a library writes back, and says so", async ({ page }) => {
  /* The mode `interval` exists for: somebody reading and annotating, whose comments ride in
     the same saved block. The bar's Save used to be a download in every case; `cloud`
     decides, which is the rule the manifest already stated.
     `slim` is the right fixture: every asset is already `online` and re-pointed at the local
     CDN, which is the shape a hosted document keeps. */
  const library = await serve(page);
  const SLIM = fs.readFileSync(path.join(ROOT, "dist/slim.html"), "utf8");
  const published = /"cdnBase":"([^"]*)"/.exec(SLIM)[1];
  let html = SLIM.split(published).join("http://127.0.0.1:8080/dist/cdn");
  html = html.replace(SETTINGS, (match, open, json, close) =>
    open +
    JSON.stringify({
      ...JSON.parse(json),
      mode: "comment",
      editable: false,
      cloud: {id: ID, api: "/api/docs"},
      capabilities: {comments: "write"},
      autosave: {mode: "interval", intervalMs: 200},
    }) +
    close);
  fs.writeFileSync(path.join(ROOT, `.test-tmp/autosave-${process.pid}-review.html`), html);

  const errors = await load(page, `/.test-tmp/autosave-${process.pid}-review.html`);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => globalThis.StandaloneDoc.can("sink"))).toBe(true);

  /* The button is the bar's, not the editor's: there is no toolbar in this mode. */
  await page.click("#doc-bar [data-save]");
  await expect.poll(() => library.puts.length, {timeout: 5000}).toBe(1);
  expect(library.puts[0].checkpoint).toBe(true);
  /* The answer follows the write, so poll for it rather than reading the toast a tick early. */
  await expect
    .poll(() => page.evaluate(() => document.querySelector("[data-toast-text]").textContent), {timeout: 5000})
    .toBe("Saved to the library");
});
