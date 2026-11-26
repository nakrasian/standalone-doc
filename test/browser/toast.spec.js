import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* The shared toast, and `‹ Library` where the mark was.
 *
 * Both are chrome, so both are asserted where a person looks rather than where the code is:
 *
 *   - the toast is one element in the *body*, not in a bar: it has to exist in the ribbon,
 *     in the minimal bar, in a viewer's bar and under a failed boot, and the ribbon's markup
 *     is `requiredBy: ["edit"]` — a viewer never loads it;
 *   - a manual save says it finished, and the *saved file* carries the element with no
 *     message: a message about this session is not content;
 *   - a failure speaks with `role="alert"` and stays until dismissed, because a message about
 *     lost work that removes itself is one nobody read;
 *   - the corner is identity *or* the way back. A document with no `cloud` has nowhere to
 *     go, so it keeps its mark.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const EDITOR = fs.readFileSync(path.join(ROOT, "dist/editor.html"), "utf8");
const SETTINGS = /(<script id="doc-settings"[^>]*>)([\s\S]*?)(<\/script>)/;

/** `dist/editor.html` with a library declared, served from the dev server's root. */
function writeDoc(name, cloud) {
  const html = EDITOR.replace(SETTINGS, (match, open, json, close) =>
    open + JSON.stringify({...JSON.parse(json), ...(cloud ? {cloud} : {})}) + close);
  fs.mkdirSync(TMP, { recursive: true });
  const file = `.test-tmp/toast-${process.pid}-${name}.html`;
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

const toastState = (page) =>
  page.evaluate(() => {
    const el = document.querySelector("[data-toast]");
    return {
      text: el.querySelector("[data-toast-text]").textContent.replace(/\s+/g, " ").trim(),
      tone: el.dataset.tone ?? null,
      role: el.getAttribute("role"),
      visible: !el.hidden && getComputedStyle(el).display !== "none",
      dismissable: !el.querySelector("[data-toast-close]").hidden,
      /* One element, in the body — the whole reason it is not in the ribbon's markup. */
      parents: el.parentElement.tagName,
      bars: [el.closest("#app-toolbar"), el.closest("#doc-bar")].filter(Boolean).length,
    };
  });

test("a manual save answers, and the saved file carries no message", async ({ page }) => {
  const errors = await load(page, "file://" + path.join(ROOT, "index.html"));
  expect(errors).toEqual([]);

  const download = page.waitForEvent("download", { timeout: 20_000 });
  await page.click("[data-save]:visible");
  const saved = path.join(`${process.env.TMPDIR || "/tmp"}`, `standalone-doc-toast-${process.pid}.html`);
  await (await download).saveAs(saved);

  expect(await toastState(page)).toEqual({
    text: "Saved",
    tone: "ok",
    role: "status",
    visible: true,
    dismissable: false,
    parents: "BODY",
    bars: 0,
  });

  /* The element travels; the message does not. Read as a document, never as a string — the
     runtime's own source ships inside the file. */
  const copy = fs.readFileSync(saved, "utf8");
  const shape = await page.evaluate((html) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const el = doc.querySelector("[data-toast]");
    return {
      present: Boolean(el),
      hidden: el?.hasAttribute("hidden"),
      text: el?.querySelector("[data-toast-text]")?.textContent.trim(),
      close: el?.querySelector("[data-toast-close]")?.hasAttribute("hidden"),
      problems: globalThis.StandaloneDoc.modules.toolbar.validate(html),
    };
  }, copy);
  expect(shape).toEqual({present: true, hidden: true, text: "", close: true, problems: []});
  fs.rmSync(saved, { force: true });
});

test("a failed save speaks once, assertively, and stays until dismissed", async ({ page }) => {
  const url = writeDoc("failed", {id: "abc123", api: "/api/docs"});
  await load(page, url);
  /* Access answers an expired session with a login page and status 200, so the sink's own
     test is the content type. That sentence is the one written for a person. */
  await page.route("**/api/docs/**", (route) =>
    route.fulfill({status: 200, contentType: "text/html; charset=utf-8", body: "<!doctype html><p>sign in</p>"}));

  await page.click("[data-save]:visible");
  await page.waitForFunction(() => !document.querySelector("[data-toast]").hidden);

  const state = await toastState(page);
  expect(state.tone).toBe("error");
  expect(state.role).toBe("alert");
  expect(state.dismissable).toBe(true);
  expect(state.text).toContain("signed out");
  /* Still unsaved: a failed write must not look saved. */
  expect(await page.evaluate(() => !document.querySelector("[data-dirty]").hidden)).toBe(true);

  await page.click("[data-toast-close]");
  expect(await toastState(page)).toMatchObject({visible: false, text: ""});
});

test("the corner is the way back only when there is somewhere to go", async ({ page }) => {
  await load(page, "file://" + path.join(ROOT, "index.html"));
  const local = await page.evaluate(() => {
    const link = document.querySelector("#ui-ribbon [data-library-link]");
    const mark = document.querySelector("#ui-ribbon [data-favicon]");
    return {
      markVisible: !mark.hidden,
      linkVisible: !link.hidden && getComputedStyle(link).display !== "none",
    };
  });
  expect(local).toEqual({markVisible: true, linkVisible: false});

  const url = writeDoc("library", {id: "abc123", api: "/api/docs"});
  await load(page, url);
  const hosted = await page.evaluate(() => {
    const read = (panel) => {
      const host = document.querySelector(`[data-ui-panel="${panel}"]`);
      const link = host.querySelector("[data-library-link]");
      const mark = host.querySelector("[data-favicon]");
      return {
        link: link.textContent.trim(),
        href: link.getAttribute("href"),
        linkVisible: !link.hidden,
        /* Identity steps aside rather than sitting beside it: the ribbon gains no width. */
        markHidden: mark ? mark.hidden : null,
        /* A link inside contenteditable chrome must not be a thing the caret can enter. */
        editable: link.getAttribute("draggable"),
      };
    };
    return {ribbon: read("ribbon"), minimal: read("minimal")};
  });
  expect(hosted.ribbon).toEqual({link: "‹ Library", href: "/", linkVisible: true, markHidden: true, editable: "false"});
  /* Same link in the thin bar: `ui: "minimal"` is a presentation choice, not a different
     place in the library. */
  expect(hosted.minimal).toEqual({link: "‹ Library", href: "/", linkVisible: true, markHidden: null, editable: "false"});

  /* And the first ⌘S still saves rather than following the link: the chord is bound on the
     document, not on the anchor. A hosted document writes back to its library, which is
     also the one save that says *where* it went. */
  let written = null;
  await page.route("**/api/docs/**", async (route) => {
    written = route.request().method();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {etag: `"${new Date().toISOString()}"`},
      body: JSON.stringify({id: "abc123", size: 1}),
    });
  });
  await page.keyboard.press("ControlOrMeta+s");
  await page.waitForFunction(() => !document.querySelector("[data-toast]").hidden);
  expect(written).toBe("PUT");
  expect(await toastState(page)).toMatchObject({text: "Saved to the library", tone: "ok", visible: true});
});
