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

/** Rewrite the in-document settings block (mode, locks, threshold) for a fixture. */
function editSettings(html, edit) {
  return html.replace(
    /(<script id="doc-settings" type="application\/json">)([\s\S]*?)(<\/script>)/,
    (match, open, json, close) => {
      const settings = JSON.parse(json);
      edit(settings);
      return open + JSON.stringify(settings) + close;
    },
  );
}

/** A copy that fetches nothing: every asset `inline`, using the blocks the source already
 *  carries. That is what a save with the `inline` policy produces, and the only honest
 *  fixture for a document that must boot offline while the working tree is ahead of the
 *  tag it pins (a view copy of `index.html` now *fetches* the viewer bar). */
function selfContained(html) {
  return editManifest(html, (doc) => {
    for (const asset of doc.assets) asset.mode = "inline";
  });
}

/** Rewrite the in-document manifest (one line of JSON) for a fixture. */
function editManifest(html, edit) {
  return html.replace(
    /(<script id="asset-manifest" type="application\/json">)([\s\S]*?)(<\/script>)/,
    (match, open, json, close) => {
      const doc = JSON.parse(json);
      edit(doc);
      return open + JSON.stringify(doc) + close;
    },
  );
}

/** A document whose plan omits an asset, while its block still registers it. */
function withoutFromPlan(id) {
  return editManifest(SOURCE, (doc) => {
    doc.assets = doc.assets.filter((asset) => asset.id !== id);
  });
}

async function load(page, url) {
  const problems = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state),
    null,
    { timeout: 15_000 },
  );
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
    signals: typeof StandaloneDoc.modules.signals,
    figures: typeof StandaloneDoc.modules.figures,
    toolbar: !!document.getElementById("app-toolbar"),
    stats: document.querySelector("[data-stats]")?.textContent ?? "",
  }));

  expect(problems).toEqual([]);
  expect(state.state).toBe("ready");
  /* Manifest order, even though the blocks were reversed in the file. */
  expect(state.built).toEqual([
    "apply-settings", "session", "signals", "zoom", "progress", "pagination",
    "status", "editor", "figures", "policy", "toolbar", "plugins", "export",
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
  /* One global, by design: the registry. Every other binding a module needs is
     injected by boot() from the manifest's dependency list. */
  expect(added).toEqual(["StandaloneDoc"]);
});

test("a view-mode document boots without the editor", async ({ page }) => {
  /* The document declares its own mode and every asset declares the modes that
     need it, so a viewer never constructs (or, in the slim flavour, fetches) the
     editing modules. figures mounts islands either way — that is the point of a
     viewer. */
  const file = tmp("view");
  fs.writeFileSync(file, editSettings(selfContained(SOURCE), (settings) => {
    settings.mode = "view";
    settings.editable = false;
    settings.toolbar = false;
  }));

  const problems = await load(page, "file://" + file);
  const state = await page.evaluate(() => ({
    state: StandaloneDoc.state,
    built: StandaloneDoc.order(),
    /* The rows are the plan, not the module list: a slim document fetches fragments and
       stylesheets too, and they are half of what a slow boot spends its time on. */
    planned: StandaloneDoc.planned().filter((asset) => asset.role !== "infra").map((asset) => asset.id),
    constructed: Object.keys(StandaloneDoc.modules).sort(),
    rowIds: [...document.querySelectorAll(".boot-row")].map((row) => row.dataset.id),
    stats: document.querySelector("[data-stats]")?.textContent ?? "",
    content: document.querySelector("#content")?.textContent?.trim().slice(0, 20) ?? "",
    mode: document.documentElement.dataset.mode,
    editable: document.getElementById("content")?.getAttribute("contenteditable"),
    toolbar: document.documentElement.dataset.toolbar,
    toolbarHidden: getComputedStyle(document.getElementById("app-toolbar")).display === "none",
  }));

  expect(problems).toEqual([]);
  expect(state.state).toBe("ready");
  expect(state.built).toEqual(["apply-settings", "session", "signals", "zoom", "pagination", "figures", "viewer-bar"]);
  expect(state.constructed).toEqual(["apply-settings", "figures", "pagination", "session", "signals", "viewer-bar", "zoom"]);
  /* The lock is the loader's job, from the settings block — not the markup's. */
  expect(state.mode).toBe("view");
  expect(state.editable).toBe("false");
  expect(state.toolbar).toBe("off");
  expect(state.toolbarHidden).toBe(true);
  /* The boot dialog lists what this document will load and build — every non-infra asset
     in the plan, in manifest order. Infrastructure is already running and is not a wait. */
  expect(state.rowIds).toEqual(state.planned);
  /* No status module, so the status line keeps its placeholder. */
  expect(state.stats).not.toMatch(/\d+ words?/);
  expect(state.content.length).toBeGreaterThan(0);
  fs.rmSync(file, { force: true });
});

test("settings decide the lock, and edit mode stays editable", async ({ page }) => {
  await load(page, "file://" + path.join(ROOT, "index.html"));
  const state = await page.evaluate(() => ({
    mode: document.documentElement.dataset.mode,
    editable: document.getElementById("content")?.getAttribute("contenteditable"),
    toolbar: document.documentElement.dataset.toolbar,
    threshold: StandaloneDoc.settings().saveThresholdBytes,
  }));
  expect(state.mode).toBe("edit");
  expect(state.editable).toBe("true");
  expect(state.toolbar).toBe("on");
  expect(state.threshold).toBe(2 * 1024 * 1024);
});

test("a document without a settings block still boots (old files)", async ({ page }) => {
  /* One release of compatibility: mode falls back to the manifest, then to edit. */
  const file = tmp("no-settings");
  fs.writeFileSync(file, SOURCE.replace(/<script id="doc-settings" type="application\/json">[\s\S]*?<\/script>\n?/, ""));
  const problems = await load(page, "file://" + file);
  const mode = await page.evaluate(() => StandaloneDoc.settings().mode);
  expect(problems).toEqual([]);
  expect(mode).toBe("edit");
  fs.rmSync(file, { force: true });
});

test("a missing dependency aborts boot with a named error", async ({ page }) => {
  /* Registered but absent from the plan: this is the dependency failure. */
  const html = withoutFromPlan("progress");
  const file = tmp("missing-dep");
  fs.writeFileSync(file, html);

  const problems = await load(page, "file://" + file);

  const state = await page.evaluate(() => ({
    state: StandaloneDoc.state,
    errors: StandaloneDoc.errors.map((e) => ({ kind: e.kind, id: e.id, message: e.message })),
  }));
  expect(state.state).toBe("failed");
  expect(state.errors).toEqual([
    { kind: "construct", id: "export", message: expect.stringContaining('requires "progress"') },
  ]);
  /* boot() records and reports; it does not throw into the page. */
  expect(problems).toEqual([]);
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
    expect(seen.rows).toBe(19);
    expect(seen.barNow).toBe("100");
  });

  test("a missing dependency opens the dialog naming both assets", async ({ page }) => {
    const file = tmp("dialog-missing-dep");
    fs.writeFileSync(file, withoutFromPlan("progress"));
    await load(page, "file://" + file);
    const seen = await dialog(page);
    expect(seen.open).toBe(true);
    expect(seen.phase).toBe("failed");
    expect(seen.title).toBe("The editor failed to start");
    expect(seen.errorTitle).toBe("Export");
    expect(seen.errorBody).toContain('requires "progress"');
    expect(seen.diag).toContain('requires "progress"');
    expect(seen.retryHidden).toBe(false);
    expect(seen.ariaLive).toBe("polite");
    /* The document stays visible: only interaction is blocked, by the modal. */
    expect(seen.toolbarVisible).toBe(true);
    /* The row that failed is marked; assets that never registered are absent
       from the plan entirely (the error names the missing one). */
    expect(seen.states).toContain("export:failed");
    fs.rmSync(file, { force: true });
  });

  test("a deleted asset block is reported as not loaded", async ({ page }) => {
    const file = tmp("dialog-deleted");
    fs.writeFileSync(file, SOURCE.replace(blocks(SOURCE).get("progress").block, () => ""));
    await load(page, "file://" + file);
    const seen = await dialog(page);
    expect(seen.open).toBe(true);
    expect(seen.errorTitle).toBe("Progress dialog");
    expect(seen.errorBody).toContain("not loaded");
    expect(seen.diag).toContain("[missing] progress");
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
    expect(seen.errorTitle).toBe("Figures");
    expect(seen.errorBody).toContain("deliberate test failure");
    expect(seen.diag).toContain("deliberate test failure");
    expect(seen.diag).toContain("createFigures"); /* the stack */
    expect(seen.states).toContain("figures:failed");
    fs.rmSync(file, { force: true });
  });

  test("retry rebuilds from a clean state instead of accumulating errors", async ({ page }) => {
    const file = tmp("dialog-retry");
    fs.writeFileSync(file, withoutFromPlan("progress"));
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
    fs.writeFileSync(file, withoutFromPlan("progress"));
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
