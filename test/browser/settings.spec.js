import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* The document settings sheet: the gear menu that opens it, what it writes into
   `#doc-settings`, and the two doors into it (the gear, and the size readout). */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fileUrl = (name = "index.html") => "file://" + path.join(ROOT, name);

async function load(page) {
  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(fileUrl());
  await page.waitForFunction(
    () => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state),
    null,
    { timeout: 15_000 },
  );
  return problems;
}

const GEAR = '#ui-ribbon [data-menu][aria-label="Document settings"]';
const settingsBlock = (page) =>
  page.evaluate(() => JSON.parse(document.getElementById("doc-settings").textContent));

async function openSheet(page) {
  await page.click(GEAR);
  await page.click("#ui-ribbon [data-settings-open]");
  await page.waitForFunction(() => document.getElementById("doc-settings-dialog")?.open === true);
}

test("the gear is a two-item menu and there is no separate shortcuts button", async ({ page }) => {
  const problems = await load(page);
  expect(problems).toEqual([]);

  const chrome = await page.evaluate(() => {
    const bars = ["ribbon", "minimal"].map((ui) => {
      const host = document.querySelector(`[data-ui-panel="${ui}"]`);
      const gear = host.querySelector('[data-menu][aria-label="Document settings"]');
      return {
        ui,
        gear: host.querySelectorAll('[data-menu][aria-label="Document settings"]').length,
        shortcutsButton: host.querySelectorAll("button[data-shortcuts]:not([data-menu-item])").length,
        /* the gear sits immediately before the Save button, as decided */
        gearBeforeSave: Boolean(gear && gear.closest(".menu-wrap")?.nextElementSibling?.matches("[data-save]")),
      };
    });
    return { bars, gearIcon: document.querySelectorAll('symbol[id="i-settings"]').length };
  });

  /* Both bars reach the sheet, and neither carries the old standalone button. */
  expect(chrome.bars).toEqual([
    {ui: "ribbon", gear: 1, shortcutsButton: 0, gearBeforeSave: true},
    {ui: "minimal", gear: 1, shortcutsButton: 0, gearBeforeSave: true},
  ]);
  expect(chrome.gearIcon).toBe(1);

  await page.click(GEAR);
  const items = await page.evaluate(() =>
    [...document.querySelectorAll("#ui-ribbon [data-menu-panel]:not([hidden]) [data-menu-item]")].map((item) => ({
      /* the label is the first text node; the chord lives in its own <kbd> slot */
      label: item.textContent.replace(item.querySelector("kbd")?.textContent ?? "", "").trim(),
      hint: item.querySelector("kbd")?.textContent ?? "",
      settings: item.hasAttribute("data-settings-open"),
      shortcuts: item.hasAttribute("data-shortcuts"),
    })),
  );
  expect(items.map((item) => item.label)).toEqual(["Document settings…", "Keyboard shortcuts"]);
  /* the exact chord is platform-dependent (⌘ vs Ctrl); presence is the contract */
  expect(items.map((item) => item.hint.length > 0)).toEqual([true, true]);
  expect(items.some((item) => item.settings)).toBe(true);
  expect(items.some((item) => item.shortcuts)).toBe(true);
});

test("the sheet shows behaviour, storage and the pin", async ({ page }) => {
  await load(page);
  await openSheet(page);

  const shown = await page.evaluate(() => ({
    open: document.getElementById("doc-settings-dialog").open,
    mode: document.querySelector("[data-ds='mode']").value,
    rows: [...document.querySelectorAll("[data-ds-rows] tr")].map((tr) => ({
      key: tr.dataset.row,
      stored: tr.querySelector("select")?.value ?? "inline",
    })),
    presets: [...document.querySelectorAll("[data-preset]")]
      .filter((chip) => chip.getAttribute("aria-pressed") === "true")
      .map((chip) => chip.dataset.preset),
    pin: document.querySelector("[data-ds-pin]").textContent,
    threshold: document.querySelector("[data-ds='threshold']").value,
  }));

  expect(shown.open).toBe(true);
  expect(shown.mode).toBe("edit");
  /* An edit-mode document: the base view and the editor, both inline by default. */
  expect(shown.rows).toEqual([{key: "view", stored: "inline"}, {key: "editor", stored: "inline"}]);
  expect(shown.presets).toEqual(["inline"]);
  expect(shown.pin).toBe("@v0.1.0");
  expect(shown.threshold).toBe("2");
});

test("behaviour changes are written to the document and clamp against the mode", async ({ page }) => {
  await load(page);
  await openSheet(page);

  await page.selectOption("[data-ds='mode']", "view");
  /* A setting can restrict a mode, never contradict it. */
  const clamped = await page.evaluate(() => ({
    editable: document.querySelector("[data-ds='editable']").checked,
    editableDisabled: document.querySelector("[data-ds='editable']").disabled,
    toolbar: document.querySelector("[data-ds='toolbar']").checked,
    toolbarDisabled: document.querySelector("[data-ds='toolbar']").disabled,
  }));
  expect(clamped).toEqual({editable: false, editableDisabled: true, toolbar: false, toolbarDisabled: true});

  await page.click("[data-ds-done]");
  const settings = await settingsBlock(page);
  expect(settings.mode).toBe("view");
  expect(settings.editable).toBe(false);
  expect(settings.toolbar).toBe(false);
  /* The document is now dirty: the change reaches disk on save, not before. */
  expect(await page.evaluate(() => document.querySelector("[data-dirty]")?.hidden)).toBe(false);
});

test("a preset writes a preset, a row edit writes the map", async ({ page }) => {
  await load(page);
  await openSheet(page);

  await page.click('[data-preset="slim"]');
  await page.click("[data-ds-done]");
  const preset = await settingsBlock(page);
  expect(preset.policy).toBe("slim");
  expect(preset.assets).toBeUndefined();

  await openSheet(page);
  await page.selectOption('[data-ds-rows] tr[data-row="editor"] select', "absent");
  await page.click("[data-ds-done]");
  const map = await settingsBlock(page);
  /* Once anything is overridden, the preset name must go: the map is the truth. */
  expect(map.policy).toBeUndefined();
  expect(map.assets.editor).toBe("absent");
  /* the map is keyed by asset id, not by the row label */
  expect(map.assets["page-styles"]).toBe("online");
});

test("'don't ask again' records the decline, and re-arm clears it", async ({ page }) => {
  await load(page);
  await openSheet(page);

  await page.check("[data-ds='never']");
  await page.click("[data-ds-done]");
  const declined = await settingsBlock(page);
  expect(declined.thresholdDeclined).toBeGreaterThan(100_000);

  await openSheet(page);
  await page.click("[data-ds='arm']");
  await page.click("[data-ds-done]");
  expect((await settingsBlock(page)).thresholdDeclined).toBeUndefined();
});

test("the size readout opens the sheet at Size & loading", async ({ page }) => {
  await load(page);
  /* The second door: the number that asks "why is this file big?" answers it. */
  await page.click("[data-stats]");
  await page.waitForFunction(() => document.getElementById("doc-settings-dialog")?.open === true);

  const visible = await page.evaluate(() => {
    const dialog = document.getElementById("doc-settings-dialog");
    const section = dialog.querySelector('[data-ds-section="size"]');
    const body = dialog.querySelector(".ds-body");
    const inner = body.getBoundingClientRect();
    const outer = section.getBoundingClientRect();
    return { open: dialog.open, mode: document.querySelector("[data-ds='mode']").value, inView: outer.top < inner.bottom && outer.bottom > inner.top };
  });
  expect(visible).toEqual({open: true, mode: "edit", inView: true});
});

test("a preset reaches the saved file", async ({ page }) => {
  await load(page);
  await openSheet(page);
  await page.click('[data-preset="slim"]');
  await page.click("[data-ds-done]");

  const result = await page.evaluate(async () => {
    const {html} = await StandaloneDoc.modules.toolbar.serialize({});
    const doc = new DOMParser().parseFromString(html, "text/html");
    return {
      settings: JSON.parse(doc.getElementById("doc-settings").textContent),
      toolbarBlock: !!doc.getElementById("app-toolbar"),
      validate: StandaloneDoc.modules.toolbar.validate(html),
    };
  });

  expect(result.settings.policy).toBe("slim");
  expect(result.toolbarBlock).toBe(false);
  expect(result.validate).toEqual([]);
});
