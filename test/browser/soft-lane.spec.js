import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* The soft lane, at its narrowest: the `plugins` module is the one asset a document may lose
   without losing itself. Everything else still stops a boot — a document that says "ready"
   with a broken editor is a worse lie than a failure card.
 *
 * The fixture rewrites `plugins` to an online asset with a url nobody serves, and removes its
 * inline block, so boot really fetches and really fails. `critical: false` is what turns that
 * into a note; without it, the same bytes must fail. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp", "soft-lane");
const EDITOR = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");
const MANIFEST_RE = /(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/;
const PLUGINS_RE = /<script type="module" id="plugins">[\s\S]*?<\/script>\n?/;

function fixture({ soft }) {
  fs.mkdirSync(TMP, { recursive: true });
  const manifest = JSON.parse(MANIFEST_RE.exec(EDITOR)[2]);
  const asset = manifest.assets.find((candidate) => candidate.id === "plugins");
  asset.mode = "online";
  asset.url = "http://127.0.0.1:8080/.test-tmp/soft-lane/not-published.js";
  if (soft) asset.critical = false;
  else delete asset.critical;
  /* `plugins` is inline in a published editor; remove the block so the fetch is the only
     source. The rest of the document is untouched. */
  const html = EDITOR
    .replace(MANIFEST_RE, (_, open, _json, close) => open + JSON.stringify(manifest) + close)
    .replace(PLUGINS_RE, "");
  const name = soft ? "soft.html" : "critical.html";
  fs.writeFileSync(path.join(TMP, name), html);
  return `/.test-tmp/soft-lane/${name}`;
}

async function booted(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, { timeout: 20_000 });
}

test("a soft asset that fails boots the document and names the limitation", async ({ page }) => {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await booted(page, fixture({ soft: true }));

  const state = await page.evaluate(() => ({
    boot: globalThis.StandaloneDoc.state,
    errors: globalThis.StandaloneDoc.errors.map((error) => ({ id: error.id, kind: error.kind, remedy: error.remedy?.action })),
    title: document.querySelector("[data-boot-title]")?.textContent,
    sub: document.querySelector("[data-boot-sub]")?.textContent,
    body: document.querySelector("[data-boot-error-body]")?.textContent,
    content: Boolean(document.querySelector("#content")?.textContent?.trim()),
    toolbar: Boolean(document.querySelector("#app-toolbar")),
  }));
  expect(state.boot).toBe("ready");
  expect(state.toolbar).toBe(true);
  expect(state.content).toBe(true);
  expect(state.errors).toContainEqual({ id: "plugins", kind: "http", remedy: "update-runtime" });
  expect(state.title).toBe("Ready — with limitations");
  expect(state.sub).toContain("1 feature");
  expect(state.body).toContain("Plugins");
  expect(state.body).toContain("update this file's runtime");
  expect(problems).toEqual([]);

  /* Continue dismisses it; the editor is a working editor, minus the Plugins sheet. */
  await page.evaluate(() => document.querySelector("[data-boot-continue]").click());
  expect(await page.evaluate(() => document.getElementById("boot-dialog").open)).toBe(false);
  expect(await page.evaluate(() => Boolean(globalThis.StandaloneDoc.modules.plugins))).toBe(false);
});

test("the same failure without critical:false still stops the boot", async ({ page }) => {
  await booted(page, fixture({ soft: false }));
  const state = await page.evaluate(() => ({
    boot: globalThis.StandaloneDoc.state,
    title: document.querySelector("[data-boot-title]")?.textContent,
  }));
  expect(state.boot).toBe("failed");
  expect(state.title).toBe("An asset is missing from the CDN");
});
