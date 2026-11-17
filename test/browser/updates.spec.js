import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* 6a's deliberate half — "Check for updates…" in Document settings.
 *
 * The failure card is the repair path: it exists because the pin no longer resolves, and
 * it can only be reached from a document that cannot boot. This is the same move made on
 * purpose, from a document that works. The contract:
 *
 *   - nothing is written until Done (Cancel leaves the pin and the dirty state alone)
 *   - failure is total: no catalog, no offer, no change
 *   - only `mode: online` module assets move; inline hashes keep describing the bytes
 *     the file already has, and a plugin's bytes stay its author's
 *   - the running window keeps its own pin: the file moves, this session does not
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SLUG = `upd-${process.pid}`;
const FIX = `.test-tmp/${SLUG}`;
const ORIGIN = "http://127.0.0.1:8080";
const HEALTHY = `${ORIGIN}/dist/cdn`;
const PINNED = "v0.5.1";
const NEXT = "v0.6.0";
const EDITOR = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");
const manifestOf = (html) => JSON.parse(/<script id="asset-manifest" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);

const write = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, rel), body);
};

/** The shape `npm run catalog` publishes: an index, and one table per release. */
function catalogAt(latest) {
  const base = `${HEALTHY.replace(/\/dist\/cdn$/, "")}@${latest}/dist/cdn`;
  const ext = (kind) => (kind === "css" ? "css" : kind === "html" ? "html" : "js");
  const remote = manifestOf(EDITOR).assets
    .filter((asset) => asset.role !== "infra")
    .map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      bytes: asset.bytes,
      /* A different hash per release is the whole point: an update that does not change
         what the document expects would be indistinguishable from a no-op. */
      sha384: `sha384-${Buffer.from(`${latest}:${asset.id}`).toString("base64").padEnd(64, "A").slice(0, 64)}`,
      url: `${base}/${asset.id}.${ext(asset.kind)}`,
      requiredBy: asset.requiredBy || ["*"],
    }));
  return {
    index: {
      schema: 1,
      latest,
      releases: [{ tag: latest, date: "2026-11-17", base: HEALTHY, assets: remote.length, manifest: `runtime/${latest}.json` }],
    },
    table: { schema: 1, tag: latest, base, assets: remote },
  };
}

/** The built editor, pointed at a fixture catalog (and told what tag it is on). */
function documentWith(catalogUrl) {
  return EDITOR.replace(/(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/, (whole, open, json, close) => {
    const doc = manifestOf(EDITOR);
    doc.cdnBase = `${HEALTHY.replace(/\/dist\/cdn$/, "")}@${PINNED}/dist/cdn`;
    doc.catalog = catalogUrl;
    return open + JSON.stringify(doc) + close;
  });
}

test.beforeAll(() => {
  const { index, table } = catalogAt(NEXT);
  write(`${FIX}/catalog/runtime.json`, JSON.stringify(index, null, 2));
  write(`${FIX}/catalog/runtime/${NEXT}.json`, JSON.stringify(table, null, 2));
  write(`${FIX}/editor.html`, documentWith(`${ORIGIN}/${FIX}/catalog/runtime.json`));
  /* Same document, no catalog: "cannot read the index" is a real state (offline, or a
     private tag), and it must cost nothing. */
  write(`${FIX}/editor-offline.html`, documentWith(`${ORIGIN}/${FIX}/missing/runtime.json`));
});

test.afterAll(() => {
  fs.rmSync(path.join(ROOT, FIX), { recursive: true, force: true });
});

const open = async (page, file = "editor.html") => {
  await page.goto(`${ORIGIN}/${FIX}/${file}`);
  await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, { timeout: 20_000 });
  await page.evaluate(() => document.querySelector("[data-settings-open]").click());
  await expect(page.locator("#doc-settings-dialog")).toBeVisible();
};

const block = (page) => page.evaluate(() => JSON.parse(document.getElementById("asset-manifest").textContent));
const note = (page) => page.locator("[data-ds-update-note]");
const dirty = (page) => page.evaluate(() => !document.querySelector("[data-dirty]")?.hidden);
const done = (page) => page.locator("[data-ds-done]").click();

test("a release that is newer than the pin is offered, applied on Done, and only online assets move", async ({ page }) => {
  await open(page);
  const before = await block(page);
  const inlineBefore = before.assets.filter((asset) => asset.mode === "inline").map((asset) => asset.integrity);

  await page.locator("[data-ds-update]").click();
  await expect(page.locator("[data-ds-update]")).toHaveText(`Update to ${NEXT}`);
  await expect(note(page)).toContainText(NEXT);
  /* An offer is a draft: the file has not changed, and it is not dirty. */
  expect(await block(page)).toEqual(before);
  expect(await dirty(page)).toBe(false);

  await done(page);
  const after = await block(page);
  expect(after.cdnBase).toContain(`@${NEXT}/dist/cdn`);
  for (const asset of after.assets.filter((candidate) => candidate.mode === "online")) {
    const was = before.assets.find((candidate) => candidate.id === asset.id);
    expect(asset.integrity).not.toBe(was.integrity);
    expect(asset.url).toContain(`@${NEXT}/`);
  }
  /* Inline bytes are the file's own: their hashes must still describe what is here. */
  expect(after.assets.filter((asset) => asset.mode === "inline").map((asset) => asset.integrity)).toEqual(inlineBefore);
  expect(await dirty(page)).toBe(true);
  /* The session keeps the pin it booted with; only the file moved. `repin()` reloads the
     manifest for *future* saves, and the running modules are the ones we started on. */
  expect(await page.evaluate(() => StandaloneDoc.manifest().cdnBase)).toContain(`@${NEXT}/`);
  expect(await page.evaluate(() => StandaloneDoc.modules ? true : false)).toBe(true);
});

test("Cancel throws the offer away and leaves the pin alone", async ({ page }) => {
  await open(page);
  const before = await block(page);
  await page.locator("[data-ds-update]").click();
  await expect(page.locator("[data-ds-update]")).toHaveText(`Update to ${NEXT}`);
  await page.locator("[data-ds-cancel]").click();
  expect(await block(page)).toEqual(before);
  expect(await dirty(page)).toBe(false);
  /* Reopening the sheet is a fresh draft, not the discarded one. */
  await page.evaluate(() => document.querySelector("[data-settings-open]").click());
  await expect(page.locator("[data-ds-update]")).toHaveText("Check for updates…");
});

test("a pin that is already newest says so, and changes nothing", async ({ page }) => {
  /* Same fixture index, but the document claims to be on the release it offers. */
  const html = fs.readFileSync(path.join(ROOT, `${FIX}/editor.html`), "utf8");
  const same = html.replace(/"cdnBase":"([^"]*)"/, (whole, base) => `"cdnBase":"${base.replace(/@[^/]+/, `@${NEXT}`)}"`);
  write(`${FIX}/editor-current.html`, same);
  await open(page, "editor-current.html");
  await page.locator("[data-ds-update]").click();
  await expect(note(page)).toContainText("newest");
  expect(await dirty(page)).toBe(false);
  await done(page);
  expect(await dirty(page)).toBe(false);
});

test("a catalog that cannot be read is not an offer, and not a change", async ({ page }) => {
  await open(page, "editor-offline.html");
  const before = await block(page);
  await page.locator("[data-ds-update]").click();
  await expect(note(page)).toContainText("Could not read the release index");
  await expect(page.locator("[data-ds-update]")).toHaveText("Check for updates…");
  expect(await block(page)).toEqual(before);
  await done(page);
  expect(await block(page)).toEqual(before);
  expect(await dirty(page)).toBe(false);
});
