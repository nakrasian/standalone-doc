import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* `#doc-settings.updates.inline` — the one setting whose only writer is a person.
 *
 * The library reads exactly this path and treats anything it does not recognise as `ask`,
 * so there are three claims worth a test, and each is a way this breaks quietly:
 *
 *   1. the control exists only where the answer can matter — a document with no `cloud`
 *      has nothing that could replace its loader, and a copy taken away from its library
 *      must not carry a consent that reads as a promise;
 *   2. Done writes it, and *only* Done: opening the sheet re-paints the control from the
 *      file, and Cancel leaves the block alone;
 *   3. returning to the default leaves no key at all. `{inline: "ask"}` in every document
 *      would be a change for nothing, and the library assumes `ask` anyway.
 *
 * The document is served over http:// because that is the only origin where `cloudOf()`
 * accepts a library at all — a `file://` copy is a file whatever its block says.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const EDITOR = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");

const settingsBlock = /(<script id="doc-settings"[^>]*>)([\s\S]*?)(<\/script>)/;

/** `dist/editor.html` with a library declared, served from the dev server's root. */
function writeDoc(name, cloud, extra = {}) {
  const html = EDITOR.replace(settingsBlock, (match, open, json, close) =>
    open + JSON.stringify({...JSON.parse(json), ...(cloud ? {cloud} : {}), ...extra}) + close);
  fs.mkdirSync(TMP, { recursive: true });
  const file = `.test-tmp/consent-${process.pid}-${name}.html`;
  fs.writeFileSync(path.join(ROOT, file), html);
  return "/" + file;
}

async function load(page, url) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, {
    timeout: 20_000,
  });
  expect(await page.evaluate(() => globalThis.StandaloneDoc.state)).toBe("ready");
  return errors;
}

/** The gear → Document settings → Runtime, the way an author gets there. */
async function openRuntime(page) {
  await page.click('#ui-ribbon [data-menu][aria-label="Document settings"]');
  await page.click("#ui-ribbon [data-settings-open]");
  await page.waitForFunction(() => document.getElementById("doc-settings-dialog")?.open === true);
  await page.click('[data-dd-tab="runtime"]');
}

const stored = (page) => page.evaluate(() => JSON.parse(document.getElementById("doc-settings").textContent));
const control = (page) =>
  page.evaluate(() => {
    const row = document.querySelector("[data-ds-updates-row]");
    const select = document.querySelector("[data-ds='updates']");
    return {
      rowHidden: row.hidden,
      /* `hidden` is an attribute; what a person sees is computed display. The sheet's own
         `.ds-row { display: flex }` out-specifies `[hidden]`, so both are asserted. */
      rowVisible: getComputedStyle(row).display !== "none",
      value: select.value,
    };
  });

test("a document with no library has no consent to give", async ({ page }) => {
  const url = writeDoc("no-cloud", null);
  const errors = await load(page, url);
  expect(errors).toEqual([]);

  await openRuntime(page);
  expect(await control(page)).toEqual({rowHidden: true, rowVisible: false, value: "ask"});
  expect(await stored(page)).not.toHaveProperty("updates");
});

test("Done writes consent, and the next save carries it", async ({ page }) => {
  const url = writeDoc("allow", {id: "abc123", api: "/api/docs"});
  const errors = await load(page, url);
  expect(errors).toEqual([]);

  await openRuntime(page);
  /* The default is `ask`, and it is shown rather than guessed: absent and `ask` are the
     same permission, but a control that reads blank is a control nobody trusts. */
  expect(await control(page)).toMatchObject({rowVisible: true, value: "ask"});

  await page.selectOption("[data-ds='updates']", "allow");
  /* Nothing is written before Done — the sheet's rule, and the reason a consent cannot be
     granted by clicking around. */
  expect(await stored(page)).not.toHaveProperty("updates");

  await page.click("[data-ds-done]");
  expect(await stored(page)).toEqual(expect.objectContaining({updates: {inline: "allow"}}));

  /* The saved bytes, not the live block: `serialize()` is the same function ⌘S uses, so a
     field that reached the DOM but not the file would still fail here. */
  const copy = await page.evaluate(async () => (await globalThis.StandaloneDoc.modules.toolbar.serialize()).html);
  expect(JSON.parse(settingsBlock.exec(copy)[2]).updates).toEqual({inline: "allow"});

  /* Reopening the saved bytes agrees with the control it produced. */
  fs.writeFileSync(path.join(ROOT, `.test-tmp/consent-${process.pid}-reopen.html`), copy);
  await page.goto(`/.test-tmp/consent-${process.pid}-reopen.html`);
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, {timeout: 20_000});
  await openRuntime(page);
  expect(await control(page)).toMatchObject({rowVisible: true, value: "allow"});
});

test("Cancel leaves consent exactly where it was", async ({ page }) => {
  const url = writeDoc("cancel", {id: "abc123", api: "/api/docs"}, {updates: {inline: "never"}});
  await load(page, url);

  await openRuntime(page);
  expect(await control(page)).toMatchObject({value: "never"});
  await page.selectOption("[data-ds='updates']", "allow");
  await page.click("[data-ds-cancel]");
  expect(await stored(page)).toEqual(expect.objectContaining({updates: {inline: "never"}}));
});

test("choosing the default removes the key instead of writing it", async ({ page }) => {
  const url = writeDoc("reset", {id: "abc123", api: "/api/docs"}, {updates: {inline: "allow"}});
  await load(page, url);

  await openRuntime(page);
  await page.selectOption("[data-ds='updates']", "ask");
  await page.click("[data-ds-done]");

  const block = await stored(page);
  /* No key at all: `{inline: "ask"}` is a change for nothing, and the library reads both
     the same way. */
  expect(block).not.toHaveProperty("updates");
});

test("a save path may not grant consent", async ({ page }) => {
  /* The whole point of the field: a document must not be able to consent on its own
     behalf. A save rewrites both JSON blocks, so this asks whether anything in that path
     invents `updates` — with the file carrying none, and with the file carrying one. */
  for (const [name, extra] of [["none", {}], ["keep", {updates: {inline: "never"}}]]) {
    const url = writeDoc(`save-${name}`, {id: "abc123", api: "/api/docs"}, extra);
    await load(page, url);
    const copy = await page.evaluate(async () => (await globalThis.StandaloneDoc.modules.toolbar.serialize()).html);
    const block = JSON.parse(settingsBlock.exec(copy)[2]);
    if (name === "none") expect(block).not.toHaveProperty("updates");
    else expect(block.updates).toEqual({inline: "never"});
  }
});
