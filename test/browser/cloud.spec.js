import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* The library sink: a document that names one writes back to it, and a document that
   does not is a file — the same ⌘S, two destinations, decided by the document.

   Four claims are worth a test, because each one is a way this breaks quietly:

     1. a document in a library PUTs its *serialized* bytes, and its assets stay online —
        from an http(s) origin only: the endpoint is relative, so a copy re-opened from
        disk is a file, and says so before anything is clicked;
        (a save that inlines everything is 5× the storage and stops the runtime sharing);
     2. a document without the field still downloads, and the File menu does not offer to
        publish something it cannot publish;
     3. the viewer is an **export** with its two options attached to the *copy*: chrome on
        or off, inline or by reference — and the file that produced it is untouched, still
        an editor. `mode` is not a setting of a document you are editing, because a
        view-mode save marks the editing assets `absent` with no way back;
     4. publishing is one destination of that export, a **save in view mode**: the editing
        assets are `absent` from the copy, and it carries no `cloud` (a copy is not a source);
     5. a followed redirect is a *failed* save. Access answers an expired session with the
        login page and status 200, so the sink's test is the content type, not the status.

   The server is mocked at the network edge (`page.route`), never in the page: the thing
   under test is what the document sends and what it does with what comes back. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const CDN = "http://127.0.0.1:8080/dist/cdn";
const SLIM = fs.readFileSync(path.join(ROOT, "dist/slim.html"), "utf8");

/**
 * A slim document, re-pointed at the locally served copies, with a library if asked.
 * `slim` is the right fixture: every asset is already `online`, which is exactly the
 * shape a hosted document is supposed to keep.
 */
function makeDoc(name, cloud) {
  const published = /"cdnBase":"([^"]*)"/.exec(SLIM)[1];
  let html = SLIM.split(published).join(CDN);
  if (cloud) {
    html = html.replace(
      /(<script id="doc-settings"[^>]*>)([\s\S]*?)(<\/script>)/,
      (match, open, json, close) => open + JSON.stringify({...JSON.parse(json), cloud}) + close,
    );
  }
  fs.mkdirSync(TMP, { recursive: true });
  const file = `.test-tmp/cloud-${process.pid}-${name}.html`;
  fs.writeFileSync(path.join(ROOT, file), html);
  return { file: "/" + file, html };
}

const settingsOf = (html) => JSON.parse(/(<script id="doc-settings"[^>]*>)([\s\S]*?)(<\/script>)/.exec(html)[2]);

/**
 * A document that can boot from `file://`: `dist/editor.html` carries every asset it needs
 * inline, so the only thing under test is the `cloud` field.
 */
function makeLocalDoc(cloud = { id: "abc123" }) {
  const editor = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");
  const html = editor.replace(
    /(<script id="doc-settings"[^>]*>)([\s\S]*?)(<\/script>)/,
    (match, open, json, close) => open + JSON.stringify({ ...JSON.parse(json), cloud }) + close,
  );
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `local-${process.pid}.html`);
  fs.writeFileSync(file, html);
  return "file://" + file;
}

/**
 * What a copy *is*, read the way a reader's browser would read it.
 *
 * Never a substring search: the runtime's own source ships inside every document, and
 * `session.js` contains the selectors it strips (`clone.querySelector("#app-toolbar")`),
 * so a text match for chrome that must be absent matches the code that removes it.
 */
const shapeOf = (page, html) =>
  page.evaluate((copy) => {
    const doc = new DOMParser().parseFromString(copy, "text/html");
    const manifest = JSON.parse(doc.getElementById("asset-manifest").textContent);
    const mode = (id) => manifest.assets.find((asset) => asset.id === id)?.mode ?? null;
    return {
      settings: JSON.parse(doc.getElementById("doc-settings").textContent),
      ribbon: doc.querySelector("#app-toolbar") !== null,
      bar: doc.querySelector("#viewer-bar") !== null,
      editor: mode("toolbar"),
      viewerBar: mode("viewer-bar"),
      problems: StandaloneDoc.modules.toolbar.validate(copy),
    };
  }, html);

/** File → Save as… → HTML → Viewer (read-only)… — the submenus open on hover for a mouse. */
async function openViewer(page) {
  /* Scoped to the ribbon: the minimal chrome carries a File menu too, and it is hidden. */
  await page.locator("#ui-ribbon").getByRole("button", { name: "File", exact: true }).click();
  /* `hasText` is a substring match against text content, which carries the button's
     whitespace — an anchored regex would match nothing and hang on visibility. */
  await page.locator("#ui-ribbon [data-submenu-trigger]", { hasText: "Save as" }).hover();
  await page.locator("#ui-ribbon [data-submenu-trigger]", { hasText: "HTML" }).hover();
  await page.locator("#ui-ribbon [data-viewer]").click();
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

test("a document in a library saves by PUT, and keeps its assets online", async ({ page }) => {
  const { file } = makeDoc("save", { id: "abc123", api: "/api/docs" });
  await load(page, file);

  let download = 0;
  page.on("download", () => download++);

  const sent = page.waitForRequest((request) => request.url().endsWith("/api/docs/abc123"));
  await page.route("**/api/docs/abc123", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, bytes: 1 }) }),
  );

  await page.locator("[data-save]:visible").first().click();
  const request = await sent;

  expect(request.method()).toBe("PUT");
  const body = request.postData() || "";
  /* Serialized, not the live DOM: the sink receives the same bytes a download would
     have received, which is what keeps one save path for both destinations. */
  expect(body.startsWith("<!doctype html>")).toBe(true);
  /* The library's policy: the runtime stays where the other documents can share it. */
  expect(body).not.toContain("export function createEditor");
  expect(body).toContain('"mode":"online"');
  /* The pin is still the document's own — a save does not repin anything. */
  expect(settingsOf(body).cloud).toEqual({ id: "abc123", api: "/api/docs" });
  expect(download).toBe(0);
});

test("the viewer is an export in the File menu, and a document without a library still downloads", async ({ page }) => {
  const { file } = makeDoc("file", null);
  await load(page, file);

  expect(await page.evaluate(() => document.documentElement.dataset.cloud)).toBe("off");

  /* It sits with the exports, and it is offered whether or not this document belongs to a
     library — making a copy needs no library. Only the *destination* does. */
  await openViewer(page);
  await expect(page.locator("#viewer-dialog")).toBeVisible();
  await expect(page.locator("[data-viewer-publish]")).toBeHidden();
  await page.locator("#viewer-dialog button[value='cancel']").click();

  const download = page.waitForEvent("download", { timeout: 20_000 });
  await page.locator("[data-save]:visible").first().click();
  await download;
});

test("the viewer copy takes its options with it, and this file is untouched", async ({ page }) => {
  const { file } = makeDoc("viewer", { id: "abc123", api: "/api/docs" });
  await load(page, file);

  const download = page.waitForEvent("download", { timeout: 20_000 });
  await page.evaluate(() => StandaloneDoc.modules.toolbar.viewer({ toolbar: false, policy: "inline" }));
  const saved = await download;
  /* WebKit rewrites the spaces in a suggested filename to `_` (measured: CI's Linux build
     yields `Standalone_HTML_Doc_(read-only).html`, while this repo's macOS build keeps them).
     The claim is the suffix and the extension — the separator is the browser's business. */
  expect(saved.suggestedFilename().replace(/_/g, " ")).toMatch(/ \(read-only\)\.html$/);
  const copy = fs.readFileSync(await saved.path(), "utf8");
  const shape = await shapeOf(page, copy);

  /* Both options belong to the copy, which is what lets one document produce several
     readers — and what keeps the file from being rewritten into one by accident. */
  expect(shape.settings.mode).toBe("view");
  expect(shape.settings.toolbar).toBe(false);
  expect(shape.settings.cloud).toBeUndefined();

  /* `inline`: the viewer's chrome travels inside the file, so it opens from disk. */
  expect(shape.ribbon).toBe(false);
  expect(shape.bar).toBe(true);
  expect(shape.editor).toBe("absent");
  expect(shape.viewerBar).toBe("inline");
  expect(shape.problems).toEqual([]);

  /* The source is still an editor, and still what it was before the export ran. */
  expect(await page.evaluate(() => StandaloneDoc.settings().mode)).toBe("edit");
  expect(await page.evaluate(() => document.querySelector("[data-dirty]")?.hidden)).toBe(true);
  const again = await page.evaluate(async () => (await StandaloneDoc.modules.toolbar.serialize({})).html);
  expect(settingsOf(again).mode).toBe("edit");
});

test("publish posts a view-mode copy that carries no write target", async ({ page }) => {
  const { file } = makeDoc("publish", { id: "abc123", api: "/api/docs" });
  const errors = await load(page, file);

  let published = "";
  await page.route("**/api/docs/abc123/share", async (route) => {
    published = route.request().postData() || "";
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ token: "9f8e", url: "/s/9f8e" }),
    });
  });

  await openViewer(page);
  await expect(page.locator("[data-viewer-publish]")).toBeVisible();
  await page.locator("[data-viewer-publish]").click();

  await expect(page.locator("#publish-dialog")).toBeVisible();
  expect(await page.inputValue("[data-publish-url]")).toBe("http://127.0.0.1:8080/s/9f8e");
  expect(errors).toEqual([]);

  /* A save in view mode, not a flag and not a mode flip on the source bytes. */
  const settings = settingsOf(published);
  expect(settings.mode).toBe("view");
  /* A copy is not a source: no id, no endpoint, so saving it cannot overwrite this file. */
  expect(settings.cloud).toBeUndefined();

  /* The editing capability is *absent* — gone from the copy, not offloaded — and the
     viewer's chrome travels by reference, which is what keeps the copy 79 kB. Absent, not
     deleted: the manifest keeps the id, its pin and the mode, which is what lets a later
     re-pin move the same file. */
  const shape = await shapeOf(page, published);
  expect(shape.ribbon).toBe(false);
  expect(shape.editor).toBe("absent");
  expect(shape.viewerBar).toBe("online");
  expect(shape.problems).toEqual([]);

  /* And it opens as a viewer: the same assertion the reader would make. */
  fs.writeFileSync(path.join(TMP, "published.html"), published);
  await page.goto("/.test-tmp/published.html");
  await page.waitForFunction(() => globalThis.StandaloneDoc?.state === "ready", null, { timeout: 20_000 });
  const opened = await page.evaluate(() => ({
    mode: StandaloneDoc.settings().mode,
    ribbon: Boolean(document.querySelector("#app-toolbar")),
    bar: Boolean(document.querySelector("#viewer-bar")),
    errors: StandaloneDoc.errors || [],
  }));
  expect(opened.mode).toBe("view");
  expect(opened.ribbon).toBe(false);
  expect(opened.bar).toBe(true);
  expect(opened.errors).toEqual([]);
});

test("a copy re-opened from disk is a file, whatever its block says", async ({ page }) => {
  await load(page, makeLocalDoc({ id: "abc123" }));

  /* The field is still in the file — it is how a copied document knows where it came
     from — but a relative endpoint is not addressable from `file://`, so the document
     behaves as a file everywhere: no sink, no publish button, and ⌘S downloads. The
     alternative is what this used to do: PUT to `file:///api/docs/<id>`, fail, and leave
     a downloaded copy that cannot be saved at all. */
  const state = await page.evaluate(() => ({
    protocol: location.protocol,
    cloud: StandaloneDoc.settings().cloud,
    announced: document.documentElement.dataset.cloud,
  }));
  expect(state).toEqual({ protocol: "file:", cloud: null, announced: "off" });

  await openViewer(page);
  await expect(page.locator("#viewer-dialog")).toBeVisible();
  await expect(page.locator("[data-viewer-publish]")).toBeHidden();
  await page.locator("#viewer-dialog button[value='cancel']").click();

  const download = page.waitForEvent("download", { timeout: 20_000 });
  await page.locator("[data-save]:visible").first().click();
  await download;
});

test("Save as… → Interactive is a file even when the document is in a library", async ({ page }) => {
  const { file } = makeDoc("interactive", { id: "abc123", api: "/api/docs" });
  await load(page, file);

  let wrote = 0;
  await page.route("**/api/docs/**", (route) => {
    wrote++;
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  const download = page.waitForEvent("download", { timeout: 20_000 });
  await page.locator("#ui-ribbon").getByRole("button", { name: "File", exact: true }).click();
  await page.locator("#ui-ribbon [data-submenu-trigger]", { hasText: "Save as" }).hover();
  await page.locator("#ui-ribbon [data-submenu-trigger]", { hasText: "HTML" }).hover();
  await page.locator('#ui-ribbon [data-export="html-interactive"]').click();
  const saved = await download;
  expect(wrote).toBe(0);

  /* And it is a copy you can send: the author's policy, not the library's `slim`. */
  const shape = await shapeOf(page, fs.readFileSync(await saved.path(), "utf8"));
  expect(shape.editor).toBe("inline");
  expect(shape.problems).toEqual([]);
});

test("a login page with status 200 is a failed save, not a successful one", async ({ page }) => {
  const { file } = makeDoc("signedout", { id: "abc123", api: "/api/docs" });
  const errors = await load(page, file);

  /* Exactly what Access does when the session has expired: a redirect into a login
     page, which `fetch` follows, arriving as HTML with a 200. */
  await page.route("**/api/docs/abc123", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><p>sign in</p>" }),
  );

  await page.locator("[data-save]:visible").first().click();
  await expect.poll(() => errors.join("\n")).toContain("signed out");
  /* Unsaved stays unsaved: the dot is the document's only claim about the disk, and it
     exists twice (ribbon and minimal chrome), so :visible is the one under test. */
  await expect(page.locator("[data-dirty]:visible")).toBeVisible();
});
