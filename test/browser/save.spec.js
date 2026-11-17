import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* Save is the product. This spec clicks the real button, keeps the real file,
   reopens it from disk, and checks two invariants:
     1. the artifact still works (serialize + validate + compiled bodies);
     2. saving twice produces byte-identical output. That second one is the
        anti-drift gate for the whole asset system: anything the save path adds
        and the load path strips would show up here as a diff. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fileUrl = (name = "index.html") => "file://" + path.join(ROOT, name);
const TMP = path.join(ROOT, ".test-tmp");
const CDN = "http://127.0.0.1:8080/dist/cdn";
const PUBLISHED = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).cdnBase;
const SOURCE = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

/** A document whose own threshold is low enough to trigger the dialog. */
function fixtureWithThreshold(bytes) {
  const html = SOURCE.replace(
    /(<script id="doc-settings" type="application\/json">)([\s\S]*?)(<\/script>)/,
    (match, open, json, close) => open + JSON.stringify({...JSON.parse(json), saveThresholdBytes: bytes}) + close,
  );
  const file = path.join(os.tmpdir(), `standalone-doc-test-${process.pid}-threshold.html`);
  fs.writeFileSync(file, html);
  return file;
}

const readSettings = (html) => {
  const found = /<script id="doc-settings"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  return found ? JSON.parse(found[1]) : {};
};

async function saveTo(page, name) {
  const target = path.join(os.tmpdir(), `standalone-doc-test-${process.pid}-${name}.html`);
  const download = page.waitForEvent("download", { timeout: 20_000 });
  await page.locator("[data-save]:visible").first().click();
  await (await download).saveAs(target);
  return target;
}

async function load(page, url) {
  const problems = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  await page.goto(url);
  await page.waitForSelector("#app-toolbar", { state: "attached" });
  /* boot() is async: wait until it has either finished or failed. */
  await page.waitForFunction(
    () => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state),
    null,
    { timeout: 15_000 },
  );
  return problems;
}

test("a saved document reopens as a working editor", async ({ page }) => {
  const problems = await load(page, fileUrl());
  expect(problems).toEqual([]);

  const saved = await saveTo(page, "reopen");
  expect(fs.statSync(saved).size).toBeGreaterThan(50_000);

  const reopened = await page.context().newPage();
  const reopenedProblems = await load(reopened, "file://" + saved);
  const state = await reopened.evaluate(() => ({
    signals: typeof StandaloneDoc.modules.signals,
    zoom: typeof StandaloneDoc.modules.zoom.value,
    toolbar: !!document.getElementById("app-toolbar"),
    stats: document.querySelector("[data-stats]")?.textContent ?? "",
    markers: document.querySelectorAll("script[id]").length,
  }));
  expect(state.signals).toBe("object");
  expect(state.zoom).toBe("number");
  expect(state.toolbar).toBe(true);
  expect(state.stats).toMatch(/\d+ words?/);
  expect(reopenedProblems).toEqual([]);
});

test("the slim policy offloads everything except the loader, and leaves the editor running", async ({ page }) => {
  const problems = await load(page, fileUrl());
  expect(problems).toEqual([]);

  const result = await page.evaluate(async () => {
    const toolbar = StandaloneDoc.modules.toolbar;
    const {html} = await toolbar.serialize({policy: "slim"});
    const doc = new DOMParser().parseFromString(html, "text/html");
    const manifest = JSON.parse(doc.getElementById("asset-manifest").textContent);
    const settings = JSON.parse(doc.getElementById("doc-settings").textContent);
    const byId = Object.fromEntries(manifest.assets.map((asset) => [asset.id, asset]));
    return {
      blocks: {
        signals: !!doc.getElementById("signals"),
        editor: !!doc.getElementById("editor"),
        registry: !!doc.getElementById("registry"),
      },
      signals: {mode: byId.signals.mode, url: Boolean(byId.signals.url), integrity: Boolean(byId.signals.integrity)},
      registry: {mode: byId.registry.mode, url: Boolean(byId.registry.url)},
      policy: settings.policy ?? null,
      assets: settings.assets ?? null,
      validate: toolbar.validate(html),
      live: {
        editorBuilt: Boolean(StandaloneDoc.modules.editor),
        blockStillHere: Boolean(document.getElementById("signals")),
      },
    };
  });

  expect(result.blocks).toEqual({signals: false, editor: false, registry: true});
  expect(result.signals).toEqual({mode: "online", url: true, integrity: true});
  /* The loader has no url on purpose: it cannot be fetched, only carried. */
  expect(result.registry).toEqual({mode: "inline", url: false});
  expect(result.policy).toBe("slim");
  expect(result.assets).toBe(null);
  expect(result.validate).toEqual([]);
  /* Materialising a copy must never unload the document you are working in. */
  expect(result.live).toEqual({editorBuilt: true, blockStillHere: true});
});

test("a slim save reopens and boots from the CDN with nothing inline", async ({ page }) => {
  /* End to end: materialise with a non-default policy, write the file, open it from
     a server, and let boot fetch what the policy removed. The urls are repointed at
     the local CDN copies, which serve the same bytes the hashes were taken from. */
  await load(page, fileUrl());
  const html = await page.evaluate(async () => (await StandaloneDoc.modules.toolbar.serialize({policy: "slim"})).html);

  fs.mkdirSync(TMP, { recursive: true });
  const file = `.test-tmp/slim-saved-${process.pid}.html`;
  fs.writeFileSync(path.join(ROOT, file), html.split(PUBLISHED).join(CDN));

  const reopened = await page.context().newPage();
  const problems = [];
  reopened.on("pageerror", (error) => problems.push(error.message));
  reopened.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  await reopened.goto("http://127.0.0.1:8080/" + file);
  await reopened.waitForFunction(
    () => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state),
    null,
    { timeout: 20_000 },
  );

  const state = await reopened.evaluate(() => ({
    state: StandaloneDoc.state,
    built: Object.keys(StandaloneDoc.modules).sort(),
    inlineBlocks: document.querySelectorAll('script[id="signals"], script[id="editor"], style[id="page-styles"]').length,
    mode: document.documentElement.dataset.mode,
    stats: document.querySelector("[data-stats]")?.textContent ?? "",
  }));

  expect(problems).toEqual([]);
  expect(state.state).toBe("ready");
  expect(state.inlineBlocks).toBe(0);
  expect(state.built).toContain("editor");
  expect(state.mode).toBe("edit");
  expect(state.stats).toMatch(/\d+ words?/);
});

test("over the threshold, the dialog asks per capability and the choice reaches the file", async ({ page }) => {
  const problems = await load(page, "file://" + fixtureWithThreshold(1000));
  expect(problems).toEqual([]);

  const download = page.waitForEvent("download", { timeout: 20_000 });
  await page.locator("[data-save]:visible").first().click();

  const dialog = page.locator("#save-policy-dialog");
  await expect(dialog).toBeVisible();

  /* Rows are capabilities: a base view and an editor for an edit-mode document. */
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("#save-policy-dialog .sp-row")].map((row) => ({
      key: row.dataset.row,
      choices: [...row.querySelectorAll("option")].map((option) => option.value),
    })),
  );
  expect(rows.map((row) => row.key)).toEqual(["view", "editor"]);
  expect(rows[0].choices).toEqual(["inline", "online"]);
  expect(rows[1].choices).toEqual(["inline", "online", "absent"]);

  /* Absent, not offloaded: this copy is for reading. */
  await page.selectOption('#save-policy-dialog .sp-row[data-row="editor"] select', "absent");
  const totalChanged = await page.textContent("#save-policy-dialog [data-save-confirm]");
  expect(totalChanged).toMatch(/^Save · \d+ KB$/);

  await page.click("#save-policy-dialog [data-save-confirm]");
  const saved = await download;
  const target = path.join(os.tmpdir(), `standalone-doc-test-${process.pid}-policy.html`);
  await saved.saveAs(target);

  const html = fs.readFileSync(target, "utf8");
  /* The dialog's total is an estimate that must be honest: within a few percent of
     what actually lands on disk, or it is just a number. */
  const predictedKb = Number(/(\d+) KB/.exec(totalChanged)[1]);
  expect(Math.abs(predictedKb - html.length / 1024) / (html.length / 1024)).toBeLessThan(0.03);
  const settings = readSettings(html);
  const manifest = JSON.parse(/<script id="asset-manifest"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]);
  const byId = Object.fromEntries(manifest.assets.map((asset) => [asset.id, asset]));

  /* The editor left the file entirely; the base view stayed. */
  expect(html).not.toContain('<script type="module" id="editor">');
  expect(html).toContain('<script type="module" id="signals">');
  expect(byId.editor.mode).toBe("absent");
  expect(byId.signals.mode).toBe("inline");
  /* Deviating from every preset is stored as a map, with no preset name. */
  expect(settings.assets.editor).toBe("absent");
  expect(settings.assets.signals).toBe("inline");
  expect("policy" in settings).toBe(false);
  /* A document is still a document: it passes its own save validator. */
  expect(await page.evaluate((saved) => StandaloneDoc.modules.toolbar.validate(saved), html)).toEqual([]);
  fs.rmSync(target, { force: true });
});

test("keep inline is sticky and does not ask again until the file doubles", async ({ page }) => {
  await load(page, "file://" + fixtureWithThreshold(1000));

  const download = page.waitForEvent("download", { timeout: 20_000 });
  await page.locator("[data-save]:visible").first().click();
  await expect(page.locator("#save-policy-dialog")).toBeVisible();
  /* Everything stays inline: that is the "continue without offloading" answer. */
  await page.click("#save-policy-dialog [data-save-confirm]");
  const first = await download;
  const target = path.join(os.tmpdir(), `standalone-doc-test-${process.pid}-sticky.html`);
  await first.saveAs(target);

  const settings = readSettings(fs.readFileSync(target, "utf8"));
  expect(settings.policy).toBe("inline");
  expect(settings.thresholdDeclined).toBeGreaterThan(1000);

  /* Same session, same size: no second prompt. */
  const second = page.waitForEvent("download", { timeout: 20_000 });
  await page.locator("[data-save]:visible").first().click();
  await second;
  await expect(page.locator("#save-policy-dialog")).toBeHidden();
  fs.rmSync(target, { force: true });
});

test("saving twice produces byte-identical files", async ({ page }) => {
  await load(page, fileUrl());
  const first = await saveTo(page, "idem1");
  const second = await saveTo(page, "idem2");
  expect(fs.readFileSync(second).equals(fs.readFileSync(first))).toBe(true);
  fs.rmSync(first, { force: true });
  fs.rmSync(second, { force: true });
});
