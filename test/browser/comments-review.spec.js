import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* A review copy is an export, not a mode of the file you are editing (invariant 18):
   these specs build one from the real editor, then open it from disk. What they assert
   is the social contract of the file — the text is locked, comments are not, and the
   reviewer's name belongs to the browser rather than to the document. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = path.join(ROOT, ".test-tmp");
const fileUrl = (name) => "file://" + path.join(ROOT, name);

async function load(page, url) {
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

/** Build a copy from the editor with the capabilities an export would name. */
async function copy(page, {mode, capabilities, seed} = {}) {
  await page.goto(fileUrl("index.html"));
  await page.waitForFunction(() => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state), null, {timeout: 15_000});
  if (seed) await page.evaluate(seed);
  return page.evaluate(async ({mode, capabilities}) => {
    const {html} = await StandaloneDoc.modules.toolbar.serialize({mode, capabilities});
    return html;
  }, {mode, capabilities});
}

const writeCopy = (name, html) => {
  fs.mkdirSync(TMP, {recursive: true});
  const file = path.join(TMP, name);
  fs.writeFileSync(file, html);
  return file;
};

const store = (page) => page.evaluate(() => {
  const block = document.getElementById("comment-store");
  return block ? JSON.parse(block.textContent) : null;
});

async function selectText(page, [ai, ao], [bi, bo]) {
  await page.evaluate(([ai, ao, bi, bo]) => {
    const content = document.getElementById("content");
    const point = (block, offset) => {
      const el = content.children[block];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      let last = null;
      let remaining = offset;
      while (node) {
        last = node;
        if (remaining <= node.nodeValue.length) return {node, offset: remaining};
        remaining -= node.nodeValue.length;
        node = walker.nextNode();
      }
      return last ? {node: last, offset: last.nodeValue.length} : {node: el, offset: 0};
    };
    const start = point(ai, ao);
    const end = point(bi, bo);
    globalThis.getSelection().setBaseAndExtent(start.node, start.offset, end.node, end.offset);
  }, [...[ai, ao], ...[bi, bo]]);
}

/** A review copy of the source document, carrying one comment, opened from disk. */
async function openReviewWithComment(page, name = `review-${process.pid}.html`) {
  const seed = () => {
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
    StandaloneDoc.modules.comments.add({body: "Seeded comment.", author: {name: "Nadia", kind: "author"}});
  };
  const html = await copy(page, {mode: "comment", capabilities: {comments: "write", edit: "off"}, seed});
  const file = writeCopy(name, html);
  await load(page, "file://" + file);
  return {file, html};
}

test.describe("the review copy", () => {
  test("is locked, selectable, and says what it is", async ({ page }) => {
    const html = await copy(page, {mode: "comment", capabilities: {comments: "write", edit: "off"}});
    const file = writeCopy(`review-shape-${process.pid}.html`, html);
    const problems = await load(page, "file://" + file);

    const state = await page.evaluate(() => {
      const bar = document.getElementById("doc-bar");
      const add = bar.querySelector("[data-comment-add]");
      return {
        mode: StandaloneDoc.settings().mode,
        editable: document.getElementById("content").getAttribute("contenteditable"),
        kind: bar.dataset.kind,
        comments: bar.dataset.comments,
        chip: !bar.querySelector("[data-doc-kind]").hidden,
        chipText: bar.querySelector("[data-doc-kind]").textContent.trim(),
        note: !bar.querySelector("[data-doc-kind-note]").hidden,
        noteText: bar.querySelector("[data-doc-kind-note]").textContent.trim(),
        addHidden: add.hidden,
        addDisabled: add.disabled,
        addTitle: add.title,
        ribbon: Boolean(document.getElementById("app-toolbar")),
        /* The editor is not in the file at all, not merely hidden. */
        editor: Boolean(document.querySelector('script[id="editor"], script[id="toolbar"]')),
      };
    });

    expect(problems).toEqual([]);
    expect(state.mode).toBe("comment");
    expect(state.editable).toBe("false");
    expect(state.kind).toBe("comment");
    expect(state.comments).toBe("write");
    expect(state.chip).toBe(true);
    expect(state.chipText).toBe("Review copy");
    expect(state.note).toBe(true);
    expect(state.noteText).toBe("Review copy — you can add comments; the text is locked.");
    /* Nothing selected yet, so the button refuses with a reason rather than doing
       nothing. */
    expect(state.addHidden).toBe(false);
    expect(state.addDisabled).toBe(true);
    expect(state.addTitle).toContain("Select");
    expect(state.ribbon).toBe(false);
    expect(state.editor).toBe(false);
  });

  test("annotates a selection, and the record is a reviewer's, not the author's", async ({ page }) => {
    const html = await copy(page, {mode: "comment", capabilities: {comments: "write", edit: "off"}});
    const file = writeCopy(`review-annotate-${process.pid}.html`, html);
    await load(page, "file://" + file);

    const settingsBefore = await page.evaluate(() => JSON.parse(document.getElementById("doc-settings").textContent).author ?? null);

    await selectText(page, [0, 2], [1, 6]);
    const add = page.locator("[data-comment-add]");
    await expect(add).toBeEnabled();
    await add.click();

    const composer = page.locator("#comment-composer");
    await expect(composer).toBeVisible();
    await composer.locator("textarea").fill("The title claims more than the copy supports.");
    await composer.locator('input[type="text"]').fill("Reader One");
    await composer.locator('button[type="submit"]').click();
    await expect(composer).toBeHidden();

    const record = (await store(page)).comments[0];
    expect(record.body).toBe("The title claims more than the copy supports.");
    expect(record.author).toEqual({name: "Reader One", kind: "reviewer"});
    expect(record.anchor.blocks.length).toBe(2);
    expect(record.resolved).toBe(false);

    /* The reviewer is remembered for this document, and the document is not signed. */
    const remembered = await page.evaluate(() => {
      const keys = Object.keys(localStorage).filter((key) => key.startsWith("sd:reviewer:"));
      return {keys, values: keys.map((key) => localStorage.getItem(key)), author: JSON.parse(document.getElementById("doc-settings").textContent).author ?? null};
    });
    expect(remembered.keys.length).toBe(1);
    expect(remembered.values).toEqual(["Reader One"]);
    expect(remembered.author).toBe(settingsBefore);

    /* The marker is the comment, and the thread opens on it. */
    await expect(page.locator("#comment-layer .comment-mark")).not.toHaveCount(0);
    await page.locator("#comment-layer .comment-mark").first().click();
    await expect(page.locator("#comment-rail .comment-card[data-pinned]")).toBeVisible();
    await expect(page.locator("#comment-rail .comment-card[data-pinned]")).toContainText("Reader One");
    await expect(page.locator("#comment-rail .comment-card[data-pinned]")).toContainText("The title claims more");
  });

  test("remembers the reviewer's name when the copy is reopened", async ({ page }) => {
    const html = await copy(page, {mode: "comment", capabilities: {comments: "write", edit: "off"}});
    const file = writeCopy(`review-name-${process.pid}.html`, html);
    await load(page, "file://" + file);

    await selectText(page, [0, 1], [0, 6]);
    await page.locator("[data-comment-add]").click();
    await page.locator("#comment-composer textarea").fill("First note.");
    await page.locator('#comment-composer input[type="text"]').fill("Reader One");
    await page.locator('#comment-composer button[type="submit"]').click();
    await expect(page.locator("#comment-composer")).toBeHidden();

    /* Same file, same browser. The name survives the reload, so the composer does not ask
       again — and the document did not grow a field for it. */
    await load(page, "file://" + file);
    await selectText(page, [1, 0], [1, 5]);
    await page.locator("[data-comment-add]").click();
    const composer = page.locator("#comment-composer");
    await expect(composer).toBeVisible();
    await expect(composer.locator('input[type="text"]')).toHaveCount(0);
    await composer.locator("textarea").fill("Second note.");
    await composer.locator('button[type="submit"]').click();
    await expect(composer).toBeHidden();

    /* The reopened file is the one on disk, which never gained the first comment: a copy
       does not write back to the file it came from (invariant 21). What it did gain is a
       remembered name, so the second note is attributed without asking. */
    const records = (await store(page)).comments;
    expect(records.map((record) => record.author)).toEqual([{name: "Reader One", kind: "reviewer"}]);
    const authored = await page.evaluate(() => JSON.parse(document.getElementById("doc-settings").textContent).author ?? null);
    expect(authored).toBe(null);
  });

  test("Save a copy keeps the comments and drops the session's overlay", async ({ page }) => {
    const {file} = await openReviewWithComment(page, `review-save-${process.pid}.html`);
    await expect(page.locator("#comment-layer .comment-mark")).not.toHaveCount(0);

    const download = await Promise.all([
      page.waitForEvent("download"),
      page.locator("[data-save]").click(),
    ]).then(([event]) => event);
    const saved = fs.readFileSync(await download.path(), "utf8");

    expect(saved).toContain('id="comment-store"');
    expect(saved).toContain("Seeded comment.");
    expect(saved).toContain('"comments":"write"');
    expect(saved).not.toContain('id="comment-layer"');
    expect(saved).not.toContain('id="comment-composer"');
    expect(saved).not.toContain('id="comment-popover"');
    /* Never a text search for the attribute: the module's own source contains the
       literal. The layer's id is markup, and it is the thing that could leak. */
    expect(saved).not.toMatch(/<div[^>]+id="comment-layer"/);
    /* The copy is still a review copy, not a source that can become an editor. */
    expect(saved).toContain('"edit":"off"');
    expect(fs.existsSync(file)).toBe(true);
  });

  test("a review copy of a review copy does not license an editor", async ({ page }) => {
    const {html} = await openReviewWithComment(page, `review-twice-${process.pid}.html`);
    const settings = JSON.parse(/<script id="doc-settings" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
    expect(settings.mode).toBe("comment");
    expect(settings.capabilities).toEqual({comments: "write", edit: "off"});
    expect(settings.editable).toBe(false);
  });

  test("a view copy shows the comment and offers no annotation", async ({ page }) => {
    /* One comment, exported as a viewer copy that may read comments (decision 4). */
    const seed = () => {
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
      StandaloneDoc.modules.comments.add({body: "For the reader.", author: {name: "Nadia", kind: "author"}});
    };
    const html = await copy(page, {mode: "view", capabilities: {comments: "read", edit: "off"}, seed});
    const file = writeCopy(`view-read-${process.pid}.html`, html);
    const problems = await load(page, "file://" + file);

    const state = await page.evaluate(() => ({
      mode: StandaloneDoc.settings().mode,
      editable: document.getElementById("content").getAttribute("contenteditable"),
      kind: document.getElementById("doc-bar").dataset.kind,
      comments: document.getElementById("doc-bar").dataset.comments,
      add: document.querySelector("[data-comment-add]").hidden,
      chip: document.querySelector("[data-doc-kind]").hidden,
      marks: document.querySelectorAll("#comment-layer .comment-mark").length > 0,
      store: document.querySelectorAll("#comment-store").length,
      /* The annotator is not carried when nobody may annotate. */
      editor: Boolean(document.querySelector('script[id="editor"], script[id="toolbar"]')),
    }));

    expect(problems).toEqual([]);
    expect(state).toEqual({
      mode: "view",
      editable: "false",
      kind: "view",
      comments: "read",
      add: true,
      chip: true,
      marks: true,
      store: 1,
      editor: false,
    });
    /* A comment crossing two blocks paints a mark per segment; what matters here is that
       a reader sees one. */
    expect(state.marks).toBe(true);
    /* The marker opens what it says, read-only, in the rail beside the page. */
    await page.locator("#comment-layer .comment-mark").first().click();
    await expect(page.locator("#comment-rail .comment-card[data-pinned]")).toContainText("For the reader.");
    /* The head is a button (it is how a card is focused); a read-only card has no verbs. */
    await expect(page.locator("#comment-rail .comment-card[data-pinned] .comment-actions")).toHaveCount(0);
    await expect(page.locator("#comment-rail .comment-card[data-pinned] .comment-reply")).toHaveCount(0);
  });
});


test.describe("the review copy's rail", () => {
  test("the bar's Comments button toggles the rail, and the tab brings it back", async ({ page }) => {
    const {file} = await openReviewWithComment(page, `review-rail-${process.pid}.html`);
    await expect(page.locator("#comment-rail .comment-card")).toHaveCount(1);

    await page.locator("[data-comments-toggle]").click();
    await expect(page.locator("#comment-rail")).toBeHidden();
    await expect(page.locator("#comment-rail-tab")).toBeVisible();

    await page.locator("#comment-rail-tab").click();
    await expect(page.locator("#comment-rail .comment-card")).toHaveCount(1);
    /* The page did not move aside for the rail: it is still centred, and the rail sits in
       the margin to its right. */
    const geometry = await page.evaluate(() => {
      const viewport = document.getElementById("viewport").getBoundingClientRect();
      const sheet = document.getElementById("stage").getBoundingClientRect();
      const rail = document.getElementById("comment-rail").getBoundingClientRect();
      const style = getComputedStyle(document.getElementById("comment-rail"));
      const card = document.querySelector("#comment-rail .comment-card");
      const cardStyle = getComputedStyle(card);
      return {
        padding: getComputedStyle(document.getElementById("viewport")).paddingRight,
        centred: Math.abs((sheet.left + sheet.right) / 2 - (viewport.left + viewport.right) / 2),
        edge: viewport.right - rail.right,
        railRightOfPage: rail.left - sheet.right,
        railWidth: Math.round(rail.width),
        overlay: document.getElementById("comment-rail").dataset.overlay !== undefined,
        paneBlur: style.backdropFilter || style.webkitBackdropFilter,
        paneAlpha: Number((/rgba?\([^)]*?,\s*([\d.]+)\)/.exec(style.backgroundColor) || [])[1] ?? 1),
        paneBorder: style.borderTopWidth,
        paneRadius: style.borderTopLeftRadius,
        cardBackground: cardStyle.backgroundColor,
        cardImage: cardStyle.backgroundImage,
      };
    });
    expect(geometry.padding).toBe("0px");
    expect(geometry.centred).toBeLessThan(2);
    /* Pinned to the right edge, inside the margin, never over the page. */
    expect(geometry.edge).toBeGreaterThanOrEqual(0);
    expect(geometry.edge).toBeLessThanOrEqual(10);
    expect(geometry.railRightOfPage).toBeGreaterThanOrEqual(0);
    expect(geometry.railWidth).toBeGreaterThan(200);
    /* In the margin the column is invisible as a pane: no frost, no border, no radius.
       The cards are plain white; the blur belongs to the overlay case. */
    expect(geometry.overlay).toBe(false);
    expect(geometry.paneBlur).toBe("none");
    expect(geometry.paneAlpha).toBe(0);
    expect(geometry.paneBorder).toBe("0px");
    expect(geometry.paneRadius).toBe("0px");
    expect(geometry.cardBackground).toBe("rgb(255, 255, 255)");
    expect(geometry.cardImage).toBe("none");
  });

  test("the keyboard starts a comment in a copy that has no toolbar", async ({ page }) => {
    const {file} = await openReviewWithComment(page, `review-key-${process.pid}.html`);
    await selectText(page, [0, 1], [0, 6]);
    await page.keyboard.press("Meta+Alt+m");
    const composer = page.locator("#comment-composer");
    await expect(composer).toBeVisible();
    await expect(composer).toContainText("Comment as a reviewer");
    await composer.locator("textarea").fill("From the keyboard.");
    await composer.locator('input[type="text"]').fill("Reader Keys");
    await composer.locator('button[type="submit"]').click();
    await expect.poll(async () => (await store(page)).comments.length).toBe(2);
  });
});
