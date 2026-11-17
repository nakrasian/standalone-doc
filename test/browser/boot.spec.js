import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* Phase 3 invariants. If these pass, the registry/boot architecture is doing its
   job: construction follows the manifest's order, not the document's. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const tmp = (name) => path.join(os.tmpdir(), `standalone-doc-test-${process.pid}-${name}.html`);

/** Every marked block, keyed by asset id, with its kind from the marker. */
function blocks(html) {
  const found = new Map();
  const re = /^<!-- @asset id="([^"]+)"[^>]*-->$[\s\S]*?^<!-- \/@asset -->$/gm;
  for (const match of html.matchAll(re)) {
    const id = /@asset id="([^"]+)"/.exec(match[0])[1];
    const kind = /kind="([^"]+)"/.exec(match[0])[1];
    found.set(id, { kind, block: match[0] });
  }
  return found;
}

/**
 * Reverse the order of the *module* blocks (registry stays first, bootstrap last),
 * so document order no longer matches dependency order.
 */
function shuffled() {
  const infra = new Set(["registry", "bootstrap"]);
  const modules = [...blocks(SOURCE).entries()].filter(([id, b]) => b.kind === "js" && !infra.has(id));

  let html = SOURCE;
  for (const [, b] of modules) html = html.replace(b.block, () => "@@SLOT@@");
  /* Function replacers: block text contains "$1"/"$&" (minified html-to-image),
     which String.replace would treat as capture-group references. */
  for (const [, b] of [...modules].reverse()) html = html.replace("@@SLOT@@", () => b.block);
  return html;
}

async function load(page, url) {
  const problems = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto(url);
  return problems;
}

test("construction follows the manifest order, not document order", async ({ page }) => {
  const file = tmp("shuffled");
  fs.writeFileSync(file, shuffled());

  const problems = await load(page, "file://" + file);
  await page.waitForSelector("#app-toolbar", { state: "attached" });

  const state = await page.evaluate(() => ({
    state: StandaloneDoc.state,
    built: StandaloneDoc.order(),
    signals: typeof Signals,
    figures: typeof Figures,
    toolbar: !!document.getElementById("app-toolbar"),
    stats: document.querySelector("[data-stats]")?.textContent ?? "",
  }));

  expect(problems).toEqual([]);
  expect(state.state).toBe("ready");
  /* Manifest order, even though the blocks were reversed in the file. */
  expect(state.built).toEqual([
    "signals", "zoom", "progress", "pagination", "status", "editor", "figures", "toolbar", "export",
  ]);
  expect(state.signals).toBe("object");
  expect(state.figures).toBe("object");
  expect(state.toolbar).toBe(true);
  expect(state.stats).toMatch(/\d+ words?/);
  fs.rmSync(file, { force: true });
});

test("the app introduces only the allowlisted globals", async ({ page }) => {
  /* Snapshot a blank file:// page so origin-specific built-ins cancel out. */
  const blank = tmp("blank");
  fs.writeFileSync(blank, "<!doctype html><title>blank</title>");
  await page.goto("file://" + blank);
  const before = await page.evaluate(() => Object.getOwnPropertyNames(globalThis));
  fs.rmSync(blank, { force: true });

  await page.goto("file://" + path.join(ROOT, "index.html"));
  await page.waitForSelector("#app-toolbar", { state: "attached" });
  const after = await page.evaluate(() => Object.getOwnPropertyNames(globalThis));

  const added = after.filter((name) => !before.includes(name)).sort();
  /* Transitional: boot still publishes the legacy bindings so unconverted
     consumers keep working. Commit 5 shrinks this to ["StandaloneDoc"]. */
  expect(added).toEqual([
    "Editor", "Export", "Figures", "Pagination", "ProgressDialog",
    "Signals", "StandaloneDoc", "Status", "Toolbar", "Zoom",
  ]);
});

test("a missing dependency aborts boot with a named error", async ({ page }) => {
  /* Drop the progress block: export declares it, so boot must refuse. */
  const html = SOURCE.replace(blocks(SOURCE).get("progress").block, () => "");
  const file = tmp("missing-dep");
  fs.writeFileSync(file, html);

  const problems = await load(page, "file://" + file);

  const state = await page.evaluate(() => ({
    state: StandaloneDoc.state,
    errors: StandaloneDoc.errors.map((e) => ({ phase: e.phase, id: e.id, message: e.message })),
  }));
  expect(state.state).toBe("failed");
  expect(state.errors).toEqual([
    { phase: "construct", id: "export", message: expect.stringContaining('requires "progress"') },
  ]);
  expect(problems.some((p) => p.includes('requires "progress"'))).toBe(true);
  fs.rmSync(file, { force: true });
});

test("a factory that throws is recorded against its asset", async ({ page }) => {
  const html = SOURCE.replace(
    'function createFigures(deps = {}) {',
    'function createFigures(deps = {}) {\n    throw new Error("deliberate test failure");',
  );
  const file = tmp("factory-throws");
  fs.writeFileSync(file, html);

  await load(page, "file://" + file);
  const state = await page.evaluate(() => ({
    state: StandaloneDoc.state,
    failedId: StandaloneDoc.errors[0]?.id,
    message: StandaloneDoc.errors[0]?.message,
  }));
  expect(state.state).toBe("failed");
  expect(state.failedId).toBe("figures");
  expect(state.message).toContain("deliberate test failure");
  fs.rmSync(file, { force: true });
});

test.describe("boot dialog", () => {
  const dialog = (page) =>
    page.evaluate(() => {
      const el = document.getElementById("boot-dialog");
      const q = (s) => el.querySelector(s);
      return {
        open: el.open,
        phase: el.dataset.phase ?? "",
        title: q("[data-boot-title]").textContent,
        sub: q("[data-boot-sub]").textContent,
        errorTitle: q("[data-boot-error-title]").textContent,
        errorBody: q("[data-boot-error-body]").textContent,
        diag: q("[data-boot-diag]").textContent,
        retryHidden: q("[data-boot-retry]").hidden,
        rows: el.querySelectorAll(".boot-row").length,
        states: [...el.querySelectorAll(".boot-row")].map((r) => `${r.dataset.id}:${r.dataset.state}`),
        barNow: q("[data-boot-bar]").getAttribute("aria-valuenow"),
        ariaLive: q("[data-boot-rows]").getAttribute("aria-live"),
        toolbarVisible: !!document.getElementById("app-toolbar"),
      };
    });

  test("stays out of the way when boot is instant", async ({ page }) => {
    await load(page, "file://" + path.join(ROOT, "index.html"));
    await page.waitForTimeout(300);
    const seen = await dialog(page);
    expect(seen.open).toBe(false);
    expect(seen.phase).toBe("ready");
    expect(seen.rows).toBe(9);
    expect(seen.barNow).toBe("100");
  });

  test("a missing dependency opens the dialog naming both assets", async ({ page }) => {
    const file = tmp("dialog-missing-dep");
    fs.writeFileSync(file, SOURCE.replace(blocks(SOURCE).get("progress").block, () => ""));
    await load(page, "file://" + file);
    const seen = await dialog(page);
    expect(seen.open).toBe(true);
    expect(seen.phase).toBe("failed");
    expect(seen.title).toBe("The editor failed to start");
    expect(seen.errorTitle).toBe("Export threw while starting");
    expect(seen.errorBody).toContain('requires "progress"');
    expect(seen.diag).toContain('requires "progress"');
    expect(seen.retryHidden).toBe(false);
    expect(seen.ariaLive).toBe("polite");
    /* The document stays visible: only interaction is blocked, by the modal. */
    expect(seen.toolbarVisible).toBe(true);
    /* The row that failed is marked; assets that never registered are absent
       from the plan entirely (the error names the missing one). */
    expect(seen.states).toContain("export:failed");
    expect(seen.states.some((entry) => entry.startsWith("progress:"))).toBe(false);
    fs.rmSync(file, { force: true });
  });

  test("a factory that throws shows its message and stack", async ({ page }) => {
    const file = tmp("dialog-throws");
    fs.writeFileSync(
      file,
      SOURCE.replace('function createFigures(deps = {}) {', 'function createFigures(deps = {}) {\n    throw new Error("deliberate test failure");'),
    );
    await load(page, "file://" + file);
    const seen = await dialog(page);
    expect(seen.open).toBe(true);
    expect(seen.errorTitle).toBe("Figures threw while starting");
    expect(seen.errorBody).toContain("deliberate test failure");
    expect(seen.diag).toContain("deliberate test failure");
    expect(seen.diag).toContain("createFigures"); /* the stack */
    expect(seen.states).toContain("figures:failed");
    fs.rmSync(file, { force: true });
  });

  test("retry rebuilds from a clean state instead of accumulating errors", async ({ page }) => {
    const file = tmp("dialog-retry");
    fs.writeFileSync(file, SOURCE.replace(blocks(SOURCE).get("progress").block, () => ""));
    await load(page, "file://" + file);
    expect(await page.evaluate(() => window.StandaloneDoc.errors.length)).toBe(1);

    await page.click("[data-boot-retry]");
    await page.waitForTimeout(100);

    const after = await page.evaluate(() => ({
      errors: window.StandaloneDoc.errors.length,
      state: window.StandaloneDoc.state,
      built: Object.keys(window.StandaloneDoc.modules),
      legacyPublished: typeof window.Export,
    }));
    expect(after.errors).toBe(1); /* reset, then failed again once */
    expect(after.state).toBe("failed");
    expect(after.built).toContain("toolbar");
    expect(after.built).not.toContain("export");
    expect(after.legacyPublished).toBe("undefined"); /* the failed asset's global is cleared */
    fs.rmSync(file, { force: true });
  });

  test("diagnostics can be revealed and copied without throwing", async ({ page }) => {
    const file = tmp("dialog-diag");
    fs.writeFileSync(file, SOURCE.replace(blocks(SOURCE).get("progress").block, () => ""));
    const problems = await load(page, "file://" + file);

    await page.click("[data-boot-toggle]");
    await expect(page.locator("[data-boot-diag]")).toBeVisible();
    await expect(page.locator("[data-boot-toggle]")).toHaveText("Hide diagnostics");

    await page.click("[data-boot-copy]");
    await page.waitForTimeout(150);
    const label = await page.locator("[data-boot-copy]").textContent();
    expect(["Copied", "Select and copy"]).toContain(label);
    expect(problems.filter((p) => p.includes("clipboard"))).toEqual([]);
    fs.rmSync(file, { force: true });
  });
});
