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

test("saving twice produces byte-identical files", async ({ page }) => {
  await load(page, fileUrl());
  const first = await saveTo(page, "idem1");
  const second = await saveTo(page, "idem2");
  expect(fs.readFileSync(second).equals(fs.readFileSync(first))).toBe(true);
  fs.rmSync(first, { force: true });
  fs.rmSync(second, { force: true });
});
