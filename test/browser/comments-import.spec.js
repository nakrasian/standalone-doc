import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* The file channel for comments. One pure function (`comments.merge`) does the work;
   these specs are about the two transports around it and about the rule that a
   disagreement is *listed*, never applied. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const fileUrl = (name = "index.html") => "file://" + path.join(ROOT, name);

async function load(page) {
  const problems = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  await page.goto(fileUrl());
  await page.waitForFunction(
    () => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state),
    null,
    { timeout: 15_000 },
  );
  return problems;
}

/** Seed one comment over a two-block range, with the file signed. */
async function seed(page, body = "The title claims more than the copy supports.") {
  return page.evaluate((text) => {
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
    const settings = document.getElementById("doc-settings");
    const parsed = JSON.parse(settings.textContent);
    parsed.author = "Nadia";
    settings.textContent = JSON.stringify(parsed);
    const start = point(0, 2);
    const end = point(1, 4);
    globalThis.getSelection().setBaseAndExtent(start.node, start.offset, end.node, end.offset);
    return globalThis.StandaloneDoc.modules.comments.add({body: text, author: {name: "Nadia", kind: "author"}}).id;
  }, body);
}

const storeOf = (page) => page.evaluate(() => {
  const block = document.getElementById("comment-store");
  return block ? JSON.parse(block.textContent) : {schema: 1, comments: []};
});

async function exportComments(page) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.evaluate(() => globalThis.StandaloneDoc.modules.toolbar.exportCommentsOnly()),
  ]);
  const html = fs.readFileSync(await download.path(), "utf8");
  return {html, name: download.suggestedFilename()};
}

/** Write an import fixture and hand it to the hidden input, as the menu item does. */
async function importFile(page, name, contents) {
  fs.mkdirSync(TMP, {recursive: true});
  const file = path.join(TMP, name);
  fs.writeFileSync(file, contents);
  await page.setInputFiles("[data-comment-import]", file);
  const dialog = page.locator("#import-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("comments on the file channel", () => {
  test("a comments-only export is the store, and importing it again is a no-op", async ({ page }) => {
    const problems = await load(page);
    const id = await seed(page);
    const exported = await exportComments(page);

    expect(exported.name).toContain("(comments)");
    expect(exported.html).toContain('id="comment-store"');
    expect(exported.html).toContain("The title claims more than the copy supports.");
    /* It is not the document: no content, no manifest. */
    expect(exported.html).not.toContain('id="content"');
    expect(exported.html).not.toContain('id="asset-manifest"');
    const carried = JSON.parse(/<script id="comment-store" type="application\/json">([\s\S]*?)<\/script>/.exec(exported.html)[1]);
    expect(carried.comments.map((comment) => comment.id)).toEqual([id]);

    const dialog = await importFile(page, `comments-same-${process.pid}.html`, exported.html);
    await expect(dialog.locator("[data-import-summary]")).toHaveText("Nothing new.");
    await expect(dialog.locator("[data-import-nothing]")).toBeVisible();
    await expect(dialog.locator("[data-import-apply]")).toBeDisabled();
    await dialog.locator("button[value='cancel']").click();
    expect((await storeOf(page)).comments.length).toBe(1);
    expect(problems).toEqual([]);
  });

  test("a disagreement is listed, and taking the imported value is a choice", async ({ page }) => {
    await load(page);
    const id = await seed(page);
    const exported = await exportComments(page);
    const carried = JSON.parse(/<script id="comment-store" type="application\/json">([\s\S]*?)<\/script>/.exec(exported.html)[1]);
    /* The reviewer marked it resolved; this file still says open. */
    carried.comments[0].resolved = true;
    carried.comments[0].updatedAt = new Date(Date.now() + 60_000).toISOString();
    const fixture = `<!doctype html><meta charset="utf-8"><script id="comment-store" type="application/json">${JSON.stringify(carried)}</script>`;

    const dialog = await importFile(page, `comments-conflict-${process.pid}.html`, fixture);
    await expect(dialog.locator("[data-import-summary]")).toHaveText("1 conflict");
    const card = dialog.locator("[data-import-conflict]").first();
    await expect(card).toContainText("this file: resolved = false · imported: resolved = true");
    /* Nothing is resolved until the human says so; `mine` is the default. */
    await expect(card.locator('[data-import-choice="mine"]')).toHaveAttribute("aria-pressed", "true");

    await card.locator('[data-import-choice="theirs"]').click();
    await expect(card.locator('[data-import-choice="theirs"]')).toHaveAttribute("aria-pressed", "true");
    await dialog.locator("[data-import-apply]").click();
    await expect(dialog).toBeHidden();
    /* The store is written on the dialog's `close`, which is a task after the click:
       poll, rather than reading a frame too early. */
    await expect.poll(async () => (await storeOf(page)).comments[0]?.resolved).toBe(true);

    const after = (await storeOf(page)).comments;
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(id);
  });

  test("keep both duplicates rather than losing either version", async ({ page }) => {
    await load(page);
    await seed(page);
    const exported = await exportComments(page);
    const carried = JSON.parse(/<script id="comment-store" type="application\/json">([\s\S]*?)<\/script>/.exec(exported.html)[1]);
    carried.comments[0].resolved = true;
    carried.comments[0].updatedAt = new Date(Date.now() + 60_000).toISOString();
    const fixture = `<!doctype html><script id="comment-store" type="application/json">${JSON.stringify(carried)}</script>`;

    const dialog = await importFile(page, `comments-both-${process.pid}.html`, fixture);
    await dialog.locator('[data-import-choice="both"]').first().click();
    await dialog.locator("[data-import-apply]").click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await storeOf(page)).comments.length).toBe(2);

    const after = (await storeOf(page)).comments;
    expect(after[0].id).not.toBe(after[1].id);
    expect(after[0].resolved).toBe(false);
    expect(after[1].resolved).toBe(true);
    expect(after[1].body).toBe(after[0].body);
  });

  test("an appended reply merges rather than conflicting", async ({ page }) => {
    await load(page);
    await seed(page);
    const exported = await exportComments(page);
    const carried = JSON.parse(/<script id="comment-store" type="application\/json">([\s\S]*?)<\/script>/.exec(exported.html)[1]);
    carried.comments[0].replies = [{id: "r_00000001", author: {name: "Reader"}, at: new Date().toISOString(), body: "Agreed, fixing."}];
    const fixture = `<!doctype html><script id="comment-store" type="application/json">${JSON.stringify(carried)}</script>`;

    const dialog = await importFile(page, `comments-reply-${process.pid}.html`, fixture);
    await expect(dialog.locator("[data-import-summary]")).toHaveText("1 reply merged");
    await expect(dialog.locator("[data-import-conflicts]")).toBeEmpty();
    await dialog.locator("[data-import-apply]").click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await storeOf(page)).comments[0]?.replies.length).toBe(1);

    const after = (await storeOf(page)).comments;
    expect(after.length).toBe(1);
    expect(after[0].replies.map((reply) => reply.body)).toEqual(["Agreed, fixing."]);
  });

  test("the round trip: a reviewer's reply lands in the author's file", async ({ page }) => {
    await load(page);
    await seed(page);
    /* The copy carries the block ids, because it is made from this document's saved
       state — the case the whole file channel exists for. */
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.evaluate(() => globalThis.StandaloneDoc.modules.toolbar.copy({
        kind: "review",
        comments: true,
        editCopy: false,
        policy: "inline",
      })),
    ]);
    const copy = fs.readFileSync(await download.path(), "utf8");
    const carried = JSON.parse(/<script id="comment-store" type="application\/json">([\s\S]*?)<\/script>/.exec(copy)[1]);
    carried.comments[0].replies = [{id: "r_00000abc", author: {name: "Reader"}, at: new Date().toISOString(), body: "Fixed in the next draft."}];
    const reviewer = copy.replace(
      /<script id="comment-store" type="application\/json">[\s\S]*?<\/script>/,
      () => `<script id="comment-store" type="application/json">${JSON.stringify(carried)}<\/script>`,
    );

    const dialog = await importFile(page, `review-roundtrip-${process.pid}.html`, reviewer);
    await expect(dialog.locator("[data-import-summary]")).toHaveText("1 reply merged");
    await expect(dialog.locator("[data-import-conflicts]")).toBeEmpty();
    await dialog.locator("[data-import-apply]").click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await storeOf(page)).comments[0]?.replies.length).toBe(1);

    const after = (await storeOf(page)).comments;
    expect(after.length).toBe(1);
    expect(after[0].author).toEqual({name: "Nadia", kind: "author"});
    expect(after[0].replies[0].body).toBe("Fixed in the next draft.");
    /* And the comment is still attached: the ids travelled with the copy. */
    expect(await page.evaluate(() => globalThis.StandaloneDoc.modules.comments.list()[0].state)).toBe("exact");
  });

  test("a review copy's store imports like a comments-only file", async ({ page }) => {
    await load(page);
    await seed(page);
    /* Build the copy the way a review round-trip does, and read its store. */
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.evaluate(() => globalThis.StandaloneDoc.modules.toolbar.copy({
        kind: "review",
        comments: true,
        editCopy: false,
        policy: "inline",
      })),
    ]);
    const copy = fs.readFileSync(await download.path(), "utf8");
    expect(copy).toContain('id="comment-store"');

    /* A fresh document from the same source, with no comments of its own. */
    await page.goto(fileUrl());
    await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, {timeout: 15_000});
    expect(await page.evaluate(() => document.querySelectorAll("#comment-store").length)).toBe(0);
    /* Block ids live in the saved copy, not in this fresh document, so the imported
       comment is unattached here — kept, counted, and never dropped. */
    const dialog = await importFile(page, `review-store-${process.pid}.html`, copy);
    await expect(dialog.locator("[data-import-summary]")).toHaveText("1 unattached");
    await dialog.locator("[data-import-apply]").click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await storeOf(page)).comments.length).toBe(1);
    const after = await storeOf(page);
    expect(await page.evaluate(() => globalThis.StandaloneDoc.modules.comments.list()[0].state)).toBe("orphan");
  });
});
