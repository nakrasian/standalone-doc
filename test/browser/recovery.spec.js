import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* 6a — a document whose pin no longer resolves repairs itself.
 *
 * The fixture is the real `dist/slim.html`, re-pointed at a base that serves bytes the
 * document does not pin (one comment added to `editor.js` is enough), plus a catalog that
 * names the healthy tree as a newer release. That is the v0.3.0→v0.3.1 situation,
 * reproduced without an old tag and without jsDelivr.
 *
 * The contract, from lab/009:
 *   - the failure card is the entry point (a failed boot injects no toolbar, so the
 *     settings sheet cannot be reached exactly when it is needed)
 *   - a repair moves only what the document fetches, and nothing until the reader saves
 *   - a release that does not load leaves the document's own pin exactly as it was
 *   - no catalog is not an error: the document keeps its failure card and its Retry
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SLUG = `rec-${process.pid}`;
const FIX = `.test-tmp/${SLUG}`;
const ORIGIN = "http://127.0.0.1:8080";
const HEALTHY = `${ORIGIN}/dist/cdn`;
const STALE_TAG = "v0.3.0";
const STALE = `${ORIGIN}/${FIX}/stale/@${STALE_TAG}/dist/cdn`;
const CATALOG = `${ORIGIN}/${FIX}/catalog/runtime.json`;
const SLIM = fs.readFileSync(path.join(ROOT, "dist/slim.html"), "utf8");
const PUBLISHED = /"cdnBase":"([^"]*)"/.exec(SLIM)[1];

const manifestOf = (html) => JSON.parse(/<script id="asset-manifest" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
const write = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, rel), body);
};

/** The healthy tree, described as a release (the shape `npm run catalog` publishes). */
function releaseEntry(tag = "v0.3.1") {
  return {
    schema: 1,
    tag,
    base: HEALTHY,
    assets: manifestOf(SLIM).assets
      .filter((asset) => asset.role !== "infra")
      .map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        bytes: asset.bytes,
        sha384: asset.integrity,
        url: `${HEALTHY}/${asset.id}.${asset.kind === "css" ? "css" : asset.kind === "html" ? "html" : "js"}`,
        requiredBy: asset.requiredBy || ["*"],
      })),
  };
}

/** A broken document: it pins the healthy hashes, and is served a mutated editor. */
function brokenDocument({ catalog = true } = {}) {
  let html = SLIM.split(PUBLISHED).join(STALE);
  if (catalog) {
    html = html.replace(/(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/,
      (whole, open, json, close) => {
        const doc = JSON.parse(json);
        doc.catalog = CATALOG;
        return open + JSON.stringify(doc) + close;
      });
  }
  return html;
}

test.beforeAll(() => {
  /* The stale release: the real tree, with one asset's bytes moved by one comment. A hash
     mismatch that still leaves a valid module, so the failure is `integrity` and not `import`. */
  const cdn = path.join(ROOT, "dist/cdn");
  for (const name of fs.readdirSync(cdn)) {
    const body = fs.readFileSync(path.join(cdn, name));
    write(`${FIX}/stale/@${STALE_TAG}/dist/cdn/${name}`, body);
  }
  fs.appendFileSync(path.join(ROOT, `${FIX}/stale/@${STALE_TAG}/dist/cdn/editor.js`), "\n/* stale release */\n");

  write(`${FIX}/catalog/runtime/v0.3.1.json`, JSON.stringify(releaseEntry(), null, 2) + "\n");
  write(`${FIX}/catalog/runtime.json`, JSON.stringify({
    schema: 1,
    latest: "v0.3.1",
    releases: [{ tag: "v0.3.1", date: "2026-11-17", base: HEALTHY, assets: releaseEntry().assets.length, manifest: "runtime/v0.3.1.json" }],
  }, null, 2) + "\n");

  /* A release that will not load: same table, one hash wrong. */
  const lying = releaseEntry();
  lying.assets.find((asset) => asset.id === "editor").sha384 = "sha384-" + "A".repeat(64);
  write(`${FIX}/catalog-lying/runtime/v0.3.1.json`, JSON.stringify(lying, null, 2) + "\n");
  write(`${FIX}/catalog-lying/runtime.json`, JSON.stringify({
    schema: 1,
    latest: "v0.3.1",
    releases: [{ tag: "v0.3.1", date: "2026-11-17", base: HEALTHY, assets: lying.assets.length, manifest: "runtime/v0.3.1.json" }],
  }, null, 2) + "\n");

  write(`${FIX}/broken.html`, brokenDocument());
  write(`${FIX}/broken-no-catalog.html`, brokenDocument({ catalog: false }));
  write(`${FIX}/broken-lying.html`, brokenDocument().replace(CATALOG, `${ORIGIN}/${FIX}/catalog-lying/runtime.json`));
});

test.afterAll(() => {
  fs.rmSync(path.join(ROOT, FIX), { recursive: true, force: true });
});

const settle = (page) => page.waitForFunction(
  () => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state),
  null,
  { timeout: 20_000 },
);

const card = (page) => page.evaluate(() => {
  const dialog = document.getElementById("boot-dialog");
  const text = (selector) => dialog?.querySelector(selector)?.textContent?.trim() ?? "";
  return {
    state: StandaloneDoc.state,
    errors: StandaloneDoc.errors.map((error) => `${error.kind} · ${error.id}`),
    phase: dialog?.dataset.phase ?? null,
    updateHidden: dialog?.querySelector("[data-boot-update]")?.hidden ?? null,
    updateText: text("[data-boot-update-text]"),
    updateLabel: text("[data-boot-update-go]"),
    sub: text("[data-boot-sub]"),
    title: text("[data-boot-title]"),
    cdnBase: JSON.parse(document.getElementById("asset-manifest").textContent).cdnBase,
    content: document.getElementById("content").textContent.replace(/\s+/g, " ").trim().slice(0, 40),
  };
});

test("a document whose pin no longer resolves offers the newest release and repairs itself", async ({ page }) => {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") problems.push(message.text()); });

  await page.goto(`${ORIGIN}/${FIX}/broken.html`);
  await settle(page);
  const broken = await card(page);
  expect(broken.state).toBe("failed");
  expect(broken.errors).toEqual(["integrity · editor"]);
  expect(broken.cdnBase).toContain(`@${STALE_TAG}/`);

  /* The offer is in the failure card, and it is about *this* document's pin. */
  const go = page.locator("[data-boot-update-go]");
  await expect(go).toBeVisible();
  await expect(go).toHaveText("Update to v0.3.1");
  expect(broken.updateText).toContain(`pins ${STALE_TAG}`);
  /* A catalog read is not a document failure. */
  expect(broken.errors).toHaveLength(1);

  await go.click();
  await expect.poll(() => card(page).then((state) => state.state), { timeout: 15_000 }).toBe("ready");

  const repaired = await card(page);
  expect(repaired.cdnBase).toBe(HEALTHY);
  expect(repaired.content).toBe(broken.content);
  expect(repaired.title).toBe("Updated to v0.3.1");
  expect(repaired.sub).toContain("re-pinned");
  expect(repaired.updateText).toContain("Save the file");
  /* The repair is in memory: nothing was written until the reader asks. */
  await expect(page.locator("[data-boot-continue]")).toBeVisible();
  expect(problems).toEqual([]);
});

test("a release that will not load leaves the document's own pin exactly as it was", async ({ page }) => {
  await page.goto(`${ORIGIN}/${FIX}/broken-lying.html`);
  await settle(page);
  await page.locator("[data-boot-update-go]").click();
  /* The pin is restored after the attempt fails, so wait for the card to say so before
     reading it: `failed` is emitted before the restore finishes. */
  await expect.poll(() => card(page).then((state) => state.updateText), { timeout: 15_000 }).toContain("restored");

  const after = await card(page);
  expect(after.state).toBe("failed");
  expect(after.cdnBase).toContain(`@${STALE_TAG}/`);
  expect(after.errors.some((error) => error.startsWith("integrity"))).toBe(true);
  await expect(page.locator("[data-boot-update-go]")).toBeHidden();
  await expect(page.locator("[data-boot-retry]")).toBeVisible();
});

test("without a catalog the card offers retry and nothing else", async ({ page }) => {
  await page.goto(`${ORIGIN}/${FIX}/broken-no-catalog.html`);
  await settle(page);
  const state = await card(page);
  expect(state.state).toBe("failed");
  expect(state.updateHidden).toBe(true);
  await expect(page.locator("[data-boot-retry]")).toBeVisible();
});
