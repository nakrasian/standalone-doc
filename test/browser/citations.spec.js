import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/* The citations plugin, as a document sees it.
 *
 * `lab/017-inline-marks/final.mjs` is where this was worked out and where the narrative is
 * argued; this file is the part that must not regress, because the plugin is published and a
 * document pins its bytes. Five properties:
 *
 *   1. `@@` → pick → one mark, one label, one reference list, one store entry;
 *   2. numbers follow first appearance, so a citation above renumbers the rest;
 *   3. a re-imported library **offers** a changed entry instead of overwriting it;
 *   4. a save carries labels, list, store and stylesheet — and not the picker;
 *   5. with the plugin's pin removed, the saved file still reads correctly.
 *
 * The fixture is generated: the plugin's sha384 is part of the pin, so a hand-written fixture
 * would go stale the first time `citations.js` changed.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const STAGE = "http://127.0.0.1:8080/.test-tmp/citations";
const DIR = path.join(ROOT, ".test-tmp", "citations");
const MANIFEST_RE = /(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/;
const CONTENT_RE = /(<article id="content"[^>]*>)[\s\S]*?(<\/article>)/;

const plugins = fs.readFileSync(path.join(ROOT, "plugins/citations/citations.js"), "utf8");
const sha384 = (text) => "sha384-" + createHash("sha384").update(text).digest("base64");
const byteLength = (text) => Buffer.byteLength(text, "utf8");

const BIB = (year) => [
  `@article{smith${year === 2020 ? "2020a" : "2020a"},`,
  "  author = {Smith, John and Jones, Anne},",
  "  title = {A study of citations in long-form documents},",
  `  journal = {Journal of Documentation}, year = {${year}}, volume = {76}, pages = {411--430}`,
  "}",
  "@book{who2020,",
  "  author = {{World Health Organization}}, title = {Guidance on the use of reference managers},",
  "  publisher = {WHO}, year = {2020}",
  "}",
].join("\n");

const BODY = `<h1>Citations</h1>
<p>Type @@ to cite. Type @@ again in the next paragraph.</p>
<p>Second paragraph.</p>`;

/** The editor, with the plugin pinned by url at a path the dev server serves. */
function makeDoc() {
  fs.mkdirSync(DIR, {recursive: true});
  fs.writeFileSync(path.join(DIR, "citations.js"), plugins);
  let html = fs.readFileSync(path.join(ROOT, "dist", "editor.html"), "utf8");
  html = html.replace(CONTENT_RE, (_, open, close) => `${open}\n${BODY}\n${close}`);
  const manifest = JSON.parse(MANIFEST_RE.exec(html)[2]);
  manifest.assets.push({
    id: "citations", kind: "js", role: "module", order: 600, mode: "online",
    category: "plugin", plugin: "citations", requiredBy: ["*"],
    bytes: byteLength(plugins), factory: "createCitations",
    url: `${STAGE}/citations.js`, integrity: sha384(plugins),
  });
  manifest.plugins = {
    citations: {
      label: "Citations", version: "0.1.1", api: 2, island: "sealed", enabled: true,
      entry: "citations", assets: ["citations"],
      contributes: {
        inline: [{ id: "citation", label: "Citation…" }],
        panel: [{ id: "library", label: "References" }],
      },
    },
  };
  html = html.replace(MANIFEST_RE, (_, open, _json, close) => open + JSON.stringify(manifest) + close);
  return html;
}

async function boot(page) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(`${STAGE}/editor.html`, { waitUntil: "load" });
  await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, { timeout: 20_000 });
  expect(await page.evaluate(() => globalThis.StandaloneDoc.state), problems.join(" | ")).toBe("ready");
  /* The plugin has UI contributions, so boot builds it; require() is idempotent. */
  await page.evaluate(() => globalThis.StandaloneDoc.require("citations"));
}

const caretAt = (page, selector, where = "end") => page.evaluate(([selector, where]) => {
  const block = document.querySelector(selector);
  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(where !== "start");
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.getElementById("content").focus();
}, [selector, where]);

const cite = async (page, selector, query) => {
  await caretAt(page, selector);
  await page.keyboard.type(" @@");
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
};

const state = (page) => page.evaluate(() => {
  const content = document.getElementById("content");
  const store = document.getElementById("citation-store");
  return {
    marks: [...content.querySelectorAll("a.cite")].map((el) => ({
      keys: el.dataset.keys, label: el.textContent,
      atomic: el.hasAttribute("data-atomic"), id: el.id || null,
    })),
    bib: [...content.querySelectorAll("#bibliography [data-key]")].map((el) => el.dataset.key),
    bibText: content.querySelector("#bibliography")?.textContent ?? "",
    store: store ? JSON.parse(store.textContent) : null,
    style: document.getElementById("citation-styles")?.textContent.length ?? 0,
  };
});

/** Open the References panel, run `fn(dialog)`, and close it again. */
async function withPanel(page, fn) {
  await page.evaluate(() => document.querySelector('[data-plugin-panel="citations:library"]').click());
  await page.waitForFunction(() => Boolean(document.querySelector("dialog.plugin-panel[open] [data-cp-import]")));
  const result = await page.evaluate(fn);
  await page.evaluate(() => document.querySelector("dialog.plugin-panel .pp-head button")?.click());
  return result;
}

const importBib = (page, bib) => withPanel(page, `((bib) => {
  const dialog = document.querySelector("dialog.plugin-panel[open]");
  const box = dialog.querySelector("[data-cp-import]");
  box.value = bib;
  box.dispatchEvent(new Event("input", {bubbles: true}));
  dialog.querySelector("[data-cp-do]").click();
  return { out: dialog.querySelector("[data-cp-out]").textContent };
})(${JSON.stringify(bib)})`);

test.beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "editor.html"), makeDoc());
});

test("a citation is one unbreakable mark, one derived label and one store entry", async ({ page }) => {
  await boot(page);
  await importBib(page, BIB(2020));
  await cite(page, "#content p:nth-of-type(1)", "smith");
  const now = await state(page);
  expect(now.marks).toHaveLength(1);
  expect(now.marks[0]).toMatchObject({ keys: "smith2020a", label: "[1]", atomic: true, id: null });
  expect(now.bib).toEqual(["smith2020a"]);
  expect(now.bibText).toContain("Smith");
  expect(Object.keys(now.store.entries)).toEqual(["smith2020a"]);
  /* The picker is session chrome: it must never be part of the saved document. */
  expect(await page.evaluate(() => document.querySelector("[data-citation-picker]").hasAttribute("data-plugin-ui"))).toBe(true);
});

test("numbers follow first appearance, and a citation above renumbers", async ({ page }) => {
  await boot(page);
  await importBib(page, BIB(2020));
  await cite(page, "#content p:nth-of-type(2)", "who");
  await cite(page, "#content p:nth-of-type(1)", "smith");
  const now = await state(page);
  expect(now.marks.map((mark) => mark.label)).toEqual(["[1]", "[2]"]);
  expect(now.bib).toEqual(["smith2020a", "who2020"]);
});

test("a re-imported library offers a changed entry, and updating it relabels", async ({ page }) => {
  await boot(page);
  await importBib(page, BIB(2020));
  await cite(page, "#content p:nth-of-type(1)", "smith");
  /* Same key, corrected year — the case that looks like a refresh and is a decision. */
  const report = await withPanel(page, `((bib) => {
    const dialog = document.querySelector("dialog.plugin-panel[open]");
    const box = dialog.querySelector("[data-cp-import]");
    box.value = bib;
    box.dispatchEvent(new Event("input", {bubbles: true}));
    dialog.querySelector("[data-cp-do]").click();
    const row = dialog.querySelector('[data-conflict="smith2020a"]');
    return { out: dialog.querySelector("[data-cp-out]").textContent, row: Boolean(row),
             hints: [...(row?.querySelectorAll(".cp-what") ?? [])].map((el) => el.textContent) };
  })(${JSON.stringify(BIB(2022))})`);
  expect(report.row).toBe(true);
  expect(report.out).toContain("1 changed in the library");
  expect(report.hints.join(" ")).toContain("2020");
  expect(report.hints.join(" ")).toContain("2022");

  /* Nothing changed yet: an offer is not an edit. */
  expect((await state(page)).store.entries.smith2020a.issued["date-parts"][0][0]).toBe(2020);

  await withPanel(page, `((bib) => {
    const dialog = document.querySelector("dialog.plugin-panel[open]");
    const box = dialog.querySelector("[data-cp-import]");
    box.value = bib;
    box.dispatchEvent(new Event("input", {bubbles: true}));
    dialog.querySelector("[data-cp-do]").click();
    dialog.querySelector('[data-cp-update="smith2020a"]').click();
  })(${JSON.stringify(BIB(2022))})`);
  const now = await state(page);
  expect(now.store.entries.smith2020a.issued["date-parts"][0][0]).toBe(2022);
  expect(now.bibText).toContain("2022");
});

test("the Insert menu opens the picker, and undo/redo relabel", async ({ page }) => {
  await boot(page);
  await importBib(page, BIB(2020));
  await cite(page, "#content p:nth-of-type(1)", "smith");

  /* The menu path loses the selection: before the `caretAnchor()` fix this click did nothing. */
  await page.evaluate(() => document.querySelector('[data-plugin-inline="citations:citation"]').click());
  await page.waitForFunction(() => document.querySelector("[data-citation-picker]").style.display === "block");
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("INPUT");
  await page.mouse.click(20, 20);
  await page.waitForFunction(() => document.querySelector("[data-citation-picker]").style.display === "none");

  /* Undo/redo: the editor replaces the DOM under a muted observer, so the plugin hears about
     it through `host.on("restore")`. Without that event, redo shows the raw citation key and
     an empty list — the snapshot is taken before the relabel runs. */
  const before = await state(page);
  await page.evaluate(() => document.getElementById("content").focus());
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForTimeout(120);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await page.waitForTimeout(120);
  const after = await state(page);
  expect(after.marks.map((mark) => mark.label)).toEqual(before.marks.map((mark) => mark.label));
  expect(after.bib).toEqual(before.bib);
  expect(Object.keys(after.store.entries)).toEqual(Object.keys(before.store.entries));
  /* And the label is a label, never the key it was derived from. */
  expect(after.marks[0].label).toBe("[1]");
});

test("the reference list toggles off / cited / whole library, and the choice travels", async ({ page }) => {
  await boot(page);
  await importBib(page, BIB(2020));
  await cite(page, "#content p:nth-of-type(1)", "smith");

  const setList = (state) => withPanel(page, `((state) => {
    const dialog = document.querySelector("dialog.plugin-panel[open]");
    dialog.querySelector('[data-cp-bib="' + state + '"]').click();
    return [...dialog.querySelectorAll("[data-cp-bib]")].map((b) => b.dataset.cpBib + "=" + b.getAttribute("aria-pressed"));
  })(${JSON.stringify(state)})`);

  expect(await setList("off")).toEqual(["off=true", "cited=false", "all=false"]);
  expect(await page.evaluate(() => Boolean(document.getElementById("bibliography")))).toBe(false);
  expect((await state(page)).marks).toHaveLength(1);

  await setList("all");
  expect(await page.evaluate(() => document.querySelectorAll("#bibliography [data-key]").length)).toBe(2);
  expect((await state(page)).store.bibliography).toBe("all");

  await setList("cited");
  expect(await page.evaluate(() => document.querySelectorAll("#bibliography [data-key]").length)).toBe(1);
});

test("a save carries the store, labels and stylesheet, and the file reads without the plugin", async ({ page }) => {
  await boot(page);
  await importBib(page, BIB(2020));
  await cite(page, "#content p:nth-of-type(1)", "smith");
  const saved = await page.evaluate(async () => (await globalThis.StandaloneDoc.modules.toolbar.serialize()).html);

  /* The picker is session chrome and must not be in the file; everything a reader needs must. */
  expect(saved).not.toContain("data-citation-picker");
  expect(saved).toContain("citation-store");
  expect(saved).toContain("citation-styles");
  expect(saved).toContain("id=\"bibliography\"");

  /* Now take the plugin away — code, pin and record — exactly as a reader who never loads it. */
  const manifest = JSON.parse(MANIFEST_RE.exec(saved)[2]);
  expect(manifest.assets.some((asset) => asset.plugin === "citations")).toBe(true);
  manifest.assets = manifest.assets.filter((asset) => asset.plugin !== "citations");
  delete manifest.plugins.citations;
  const stripped = saved
    .replace(MANIFEST_RE, (_, open, _json, close) => open + JSON.stringify(manifest) + close)
    .replace(/<script type="module" id="citations">[\s\S]*?<\/script>/g, "");
  const file = path.join(DIR, "absent.html");
  fs.writeFileSync(file, stripped);

  await page.goto(`file://${file}`, { waitUntil: "load" });
  await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state));
  expect(await page.evaluate(() => globalThis.StandaloneDoc.state)).toBe("ready");
  expect(await page.evaluate(() => Boolean(globalThis.StandaloneDoc.modules.citations))).toBe(false);

  const now = await state(page);
  expect(now.marks.map((mark) => mark.keys)).toEqual(["smith2020a"]);
  expect(now.marks[0].label).toBe("[1]");
  expect(now.bib).toEqual(["smith2020a"]);
  expect(now.style).toBeGreaterThan(200);
  /* The colour comes from the document's own `<style>`, not from the plugin. */
  expect(await page.evaluate(() => getComputedStyle(document.querySelector("a.cite")).color)).toBe("rgb(26, 77, 143)");
});
