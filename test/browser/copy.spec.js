import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* A copy is an export with three shapes, and the difference between them is one field:
   what the copy may do. These specs build each shape with the same function the dialog
   calls and read the file, because the promise is in the file — not in the dialog. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");

async function load(page, url = fileUrl("index.html")) {
  const problems = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  await page.goto(url);
  await page.waitForFunction(
    () => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state),
    null,
    { timeout: 15_000 },
  );
  return problems;
}

const fileUrl = (name) => "file://" + path.join(ROOT, name);

/** Seed one comment, so a copy has something to carry. */
async function seed(page) {
  await page.evaluate(() => {
    const content = document.getElementById("content");
    const point = (block, offset) => {
      const el = content.children[block];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      let remaining = offset;
      while (node) {
        if (remaining <= node.nodeValue.length) return {node, offset: remaining};
        remaining -= node.nodeValue.length;
        node = walker.nextNode();
      }
      return {node: el, offset: 0};
    };
    const start = point(0, 2);
    const end = point(1, 4);
    globalThis.getSelection().setBaseAndExtent(start.node, start.offset, end.node, end.offset);
    globalThis.StandaloneDoc.modules.comments.add({body: "Carried by the copy.", author: {name: "Nadia", kind: "author"}});
  });
}

/** Run the export the dialog would, take the download, and read what it wrote. */
async function downloadCopy(page, options) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.evaluate((opts) => globalThis.StandaloneDoc.modules.toolbar.copy(opts), options),
  ]);
  const html = fs.readFileSync(await download.path(), "utf8");
  const settings = JSON.parse(/<script id="doc-settings" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const manifest = JSON.parse(/<script id="asset-manifest" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const byId = Object.fromEntries(manifest.assets.map((asset) => [asset.id, asset]));
  const blocks = new Set([...html.matchAll(/<!-- @asset id="([^"]+)"/g)].map((match) => match[1]));
  return {html, name: download.suggestedFilename(), settings, byId, blocks};
}

test.describe("the copy dialog", () => {
  test("offers three kinds and states what each one may do", async ({ page }) => {
    await load(page);
    /* The menu path is exercised elsewhere; this clicks the real item so the dialog is
       opened by its own handler rather than by a test reaching into the module. */
    await page.evaluate(() => document.querySelector("[data-copy]").click());

    const dialog = page.locator("#copy-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('input[name="copy-kind"]')).toHaveCount(3);
    /* The viewer is the default, because that is what this menu item used to make. */
    await expect(dialog.locator('input[name="copy-kind"][value="view"]')).toBeChecked();
    await expect(dialog.locator("[data-copy-kind-note]")).toHaveText("Read only. Comments show; nobody may add one.");
    await expect(dialog.locator("[data-copy-edit-row]")).toBeVisible();
    await expect(dialog.locator("[data-copy-size]")).toContainText("Assets in the copy");

    await dialog.locator('input[name="copy-kind"][value="review"]').check();
    await expect(dialog.locator("[data-copy-kind-note]")).toHaveText("The text is locked; they can add comments and save a copy.");
    await expect(dialog.locator("[data-copy-comments]")).toBeDisabled();
    await expect(dialog.locator("[data-copy-policy]")).toHaveValue("inline");

    /* Decision 3: a copy that may fetch an editor says what that costs, and inline says
       it once more rather than refusing the combination. */
    await dialog.locator("[data-copy-edit]").check();
    await expect(dialog.locator("[data-copy-edit-why]")).toContainText("download the editor (~");
    await expect(dialog.locator("[data-copy-size]")).toContainText("Inline: the editor still downloads ~");
    await expect(dialog.locator("[data-copy-publish]")).toBeHidden();

    await dialog.locator('input[name="copy-kind"][value="view"]').check();
    await expect(dialog.locator("[data-copy-publish]")).toBeHidden();
    await dialog.locator("button[value='cancel']").click();
    await expect(dialog).toBeHidden();
  });
});

test.describe("the three copies", () => {
  test("a viewer copy is sealed: read-only comments, and no address for the editor", async ({ page }) => {
    await load(page);
    await seed(page);
    const copy = await downloadCopy(page, {kind: "view", comments: true, editCopy: false, policy: "inline"});

    expect(copy.name).toContain("(read-only)");
    expect(copy.settings.mode).toBe("view");
    expect(copy.settings.editable).toBe(false);
    expect(copy.settings.capabilities).toEqual({comments: "read", edit: "off"});
    expect(copy.settings.cloud).toBeUndefined();
    /* The comment travels; the overlay does not. */
    expect(copy.html).toContain("Carried by the copy.");
    expect(copy.html).toContain('id="comment-store"');
    expect(copy.html).not.toContain('id="comment-layer"');
    /* Sealed: the editor is `absent` and has no address, so nothing can fetch it. */
    expect(copy.byId.editor.mode).toBe("absent");
    expect(copy.byId.editor.url).toBeUndefined();
    expect(copy.byId.editor.integrity).toBeUndefined();
    expect(copy.blocks.has("editor")).toBe(false);
    /* What the copy runs is inline, so it opens from disk. */
    expect(copy.byId["doc-bar"].mode).toBe("inline");
    expect(copy.blocks.has("doc-bar")).toBe(true);
  });

  test("a review copy carries the annotator and the editor's address", async ({ page }) => {
    await load(page);
    await seed(page);
    const copy = await downloadCopy(page, {kind: "review", comments: true, editCopy: true, policy: "inline"});

    expect(copy.name).toContain("(review)");
    expect(copy.settings.mode).toBe("comment");
    expect(copy.settings.capabilities).toEqual({comments: "write", edit: "copy"});
    expect(copy.settings.editable).toBe(false);
    /* Pins, not code: online with an address, and no block. */
    expect(copy.byId.editor.mode).toBe("online");
    expect(copy.byId.editor.url).toContain("editor.js");
    expect(copy.byId.editor.integrity).toMatch(/^sha384-/);
    expect(copy.blocks.has("editor")).toBe(false);
    /* The bar and the annotator are in the file: a review copy has to open offline. */
    expect(copy.byId["doc-bar"].mode).toBe("inline");
    expect(copy.blocks.has("comments")).toBe(true);
    expect(copy.byId.comments.mode).toBe("inline");
  });

  test("an editor copy keeps its own modules and carries no way to make another", async ({ page }) => {
    await load(page);
    const copy = await downloadCopy(page, {kind: "editor", comments: false, editCopy: false, policy: "inline"});

    expect(copy.name).toContain("(editable)");
    expect(copy.settings.mode).toBe("edit");
    expect(copy.settings.editable).toBe(true);
    expect(copy.settings.capabilities).toEqual({comments: "off", edit: "off"});
    /* No comments at all: the store and the annotator left together. */
    expect(copy.html).not.toContain('id="comment-store"');
    expect(copy.blocks.has("comments")).toBe(false);
    /* No bar: a document that cannot be a viewer copy has no viewer chrome. */
    expect(copy.byId["doc-bar"].mode).toBe("absent");
    expect(copy.byId["doc-bar"].url).toBeUndefined();
    expect(copy.blocks.has("editor")).toBe(true);
  });

  test("a copy that does not carry comments cannot carry the annotator", async ({ page }) => {
    await load(page);
    await seed(page);
    const copy = await downloadCopy(page, {kind: "view", comments: false, editCopy: false, policy: "inline"});
    expect(copy.settings.capabilities.comments).toBe("off");
    expect(copy.html).not.toContain('id="comment-store"');
    expect(copy.html).not.toContain("Carried by the copy.");
    expect(copy.byId.comments.mode).toBe("absent");
    expect(copy.blocks.has("comments")).toBe(false);
  });
});

test.describe("adopting the editor", () => {
  test("a review copy builds the editor on request, and seals itself against recursion", async ({ page }) => {
    await load(page);
    await seed(page);
    const copy = await downloadCopy(page, {kind: "review", comments: true, editCopy: true, policy: "inline"});
    /* The copy's pins name whichever release is current; point them at the repo's own
       bytes, which are what `dist/cdn` holds and what the manifest hashes. The tag is read
       from the file rather than written here, so a release does not break the fixture. */
    const pinned = /https:\/\/cdn\.jsdelivr\.net\/gh\/nakrasian\/standalone-doc@v[^/]+\/dist\/cdn/.exec(copy.html);
    expect(pinned).not.toBeNull();
    const served = copy.html.replaceAll(pinned[0], "http://127.0.0.1:8080/dist/cdn");
    fs.mkdirSync(TMP, {recursive: true});
    const name = path.join(TMP, `adopt-${process.pid}.html`);
    fs.writeFileSync(name, served);

    const problems = [];
    page.on("pageerror", (err) => problems.push(err.message));
    await page.goto("/" + path.relative(ROOT, name));
    await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, {timeout: 15_000});
    expect(await page.evaluate(() => globalThis.StandaloneDoc.state)).toBe("ready");

    const start = await page.evaluate(() => ({
      mode: globalThis.StandaloneDoc.settings().mode,
      editable: document.getElementById("content").getAttribute("contenteditable"),
      editor: Boolean(globalThis.StandaloneDoc.modules.editor),
      adopt: !document.querySelector("[data-doc-adopt]").hidden,
      /* The ribbon is not in the file at all until the editor is adopted — not hidden. */
      ribbon: !document.getElementById("app-toolbar"),
    }));
    expect(start).toEqual({mode: "comment", editable: "false", editor: false, adopt: true, ribbon: true});

    await page.locator("[data-doc-adopt]").click();
    await page.waitForFunction(
      () => globalThis.StandaloneDoc.state === "ready" && Boolean(globalThis.StandaloneDoc.modules.editor),
      null,
      {timeout: 20_000},
    );

    const adopted = await page.evaluate(() => {
      const settings = globalThis.StandaloneDoc.settings();
      return {
        state: globalThis.StandaloneDoc.state,
        mode: settings.mode,
        editable: document.getElementById("content").getAttribute("contenteditable"),
        capabilities: settings.capabilities,
        ribbonHidden: document.getElementById("app-toolbar").hidden,
        barHidden: document.getElementById("doc-bar").hidden,
        editor: Boolean(globalThis.StandaloneDoc.modules.editor),
        toolbar: Boolean(globalThis.StandaloneDoc.modules.toolbar),
        dirty: !document.querySelector("[data-dirty]").hidden,
        /* The comments survived the upgrade. */
        comments: document.querySelectorAll("#comment-store").length,
        marks: document.querySelectorAll("#comment-layer .comment-mark").length > 0,
      };
    });

    expect(problems).toEqual([]);
    expect(adopted.state).toBe("ready");
    expect(adopted.mode).toBe("edit");
    expect(adopted.editable).toBe("true");
    expect(adopted.capabilities).toEqual({comments: "write", edit: "off"});
    expect(adopted.ribbonHidden).toBe(false);
    expect(adopted.barHidden).toBe(true);
    expect(adopted.editor).toBe(true);
    expect(adopted.toolbar).toBe(true);
    expect(adopted.dirty).toBe(true);
    expect(adopted.comments).toBe(1);
    expect(adopted.marks).toBe(true);

    /* The adopted file, saved, carries the new mode and gives up the address: a copy of
       this copy cannot be adopted again. */
    const saved = await page.evaluate(async () => {
      const {html} = await globalThis.StandaloneDoc.modules.toolbar.serialize();
      const settings = JSON.parse(/<script id="doc-settings" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
      return {mode: settings.mode, capabilities: settings.capabilities, editable: settings.editable};
    });
    expect(saved).toEqual({mode: "edit", capabilities: {comments: "write", edit: "off"}, editable: true});
  });

  test("a sealed copy offers no upgrade at all", async ({ page }) => {
    await load(page);
    const copy = await downloadCopy(page, {kind: "view", comments: true, editCopy: false, policy: "inline"});
    fs.mkdirSync(TMP, {recursive: true});
    const name = path.join(TMP, `sealed-${process.pid}.html`);
    fs.writeFileSync(name, copy.html);
    await page.goto("file://" + name);
    await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, {timeout: 15_000});
    const state = await page.evaluate(() => ({
      adopt: document.querySelector("[data-doc-adopt]").hidden,
      capabilities: globalThis.StandaloneDoc.settings().capabilities,
    }));
    expect(state).toEqual({adopt: true, capabilities: {comments: "read", edit: "off"}});
  });
});
