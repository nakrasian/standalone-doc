import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* Comments are content, and the overlay is session state: the two facts this spec
   exists to keep apart. Every assertion here is a relationship between two numbers
   (a marker and the text it marks, a file and the session that rendered it), not an
   appearance — lab/016's rule, and the reason half its findings were invisible to the
   eye until the numbers disagreed. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fileUrl = (name = "index.html") => "file://" + path.join(ROOT, name);
const GEAR = '#ui-ribbon [data-menu][aria-label="Document settings"]';

async function load(page, url = fileUrl()) {
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

/** Select from `blockIndexA@offsetA` to `blockIndexB@offsetB` with a real Selection. */
async function selectText(page, [ai, ao], [bi, bo]) {
  await page.evaluate(([ai, ao, bi, bo]) => {
    const content = document.getElementById("content");
    /* The same clamp `selection.pointAt()` uses: an offset past the block's text lands at
       the end of its last text node, not at the start of the element. */
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
    window.getSelection().setBaseAndExtent(start.node, start.offset, end.node, end.offset);
  }, [...[ai, ao], ...[bi, bo]]);
}

test.describe("comments: the store and the anchor", () => {
  test("the source document declares the capability and builds the module", async ({ page }) => {
    const problems = await load(page);
    const state = await page.evaluate(() => ({
      can: globalThis.StandaloneDoc.can("comments"),
      dataset: document.documentElement.dataset.comments,
      layer: Boolean(document.getElementById("comment-layer")),
      /* The layer is the session's, and says so. */
      ephemeral: document.getElementById("comment-layer")?.dataset.runtime,
      /* A document with no comments has no block, so a v0.9.3 file and this one differ
         by nothing on disk. */
      block: Boolean(document.getElementById("comment-store")),
    }));
    expect(state).toEqual({can: true, dataset: "write", layer: true, ephemeral: "ephemeral", block: false});
    expect(problems).toEqual([]);
  });

  test("a selection across two paragraphs becomes one stream anchor and ids only where needed", async ({ page }) => {
    await load(page);
    /* A third block nobody comments on: the test is that only the two the range touches
       grow an id. */
    const blocks = await page.evaluate(() => {
      const content = document.getElementById("content");
      const extra = document.createElement("p");
      extra.textContent = "Third block, untouched by the comment.";
      content.append(extra);
      globalThis.StandaloneDoc.modules.pagination.refresh();
      return content.querySelectorAll(":scope > *").length;
    });
    expect(blocks).toBe(3);

    await selectText(page, [0, 2], [1, 20]);
    const created = await page.evaluate(() => {
      const comment = globalThis.StandaloneDoc.modules.comments.add({
        body: "This paragraph contradicts §2.",
        author: {name: "Nadia", kind: "author"},
      });
      return comment && {id: comment.id, quote: comment.anchor.quote, blocks: comment.anchor.blocks};
    });
    expect(created).not.toBeNull();
    expect(created.id).toMatch(/^c_[0-9a-z]{8}$/);
    expect(created.blocks.length).toBe(2);
    expect(created.quote.length).toBeGreaterThan(0);
    expect(created.quote.length).toBeLessThanOrEqual(40);

    const stamped = await page.evaluate(() => {
      const content = document.getElementById("content");
      const ids = [...content.children].map((el) => el.dataset.bid || null).filter(Boolean);
      const record = JSON.parse(document.getElementById("comment-store").textContent).comments[0];
      return {ids, named: record.anchor.blocks, total: content.children.length};
    });
    /* Only the blocks the comment names grow an attribute: a document with one comment
       does not grow 900. */
    expect(stamped.ids).toEqual(stamped.named);
    expect(stamped.ids.length).toBe(2);
    expect(stamped.total).toBeGreaterThan(2);
  });

  test("the marker names the same characters the anchor does, after a pagination pass", async ({ page }) => {
    await load(page);
    await selectText(page, [0, 2], [1, 20]);
    await page.evaluate(() => {
      globalThis.StandaloneDoc.modules.comments.add({body: "Anchor me.", author: {name: "Nadia", kind: "author"}});
    });
    /* Let the pass settle, then measure the marker against the resolved anchor. */
    await page.evaluate(() => globalThis.StandaloneDoc.modules.pagination.refresh());
    await page.waitForTimeout(150);

    const relation = await page.evaluate(() => {
      const comments = globalThis.StandaloneDoc.modules.comments;
      const layer = document.getElementById("comment-layer");
      const marks = [...layer.querySelectorAll(".comment-mark")];
      const comment = comments.list()[0];
      return {
        marks: marks.length,
        state: comment.state,
        /* A marker's client box must sit on a line of text: its height is a line box,
           not a page. The 948 px phantom rect would be the whole page. */
        heights: marks.map((mark) => Math.round(mark.getBoundingClientRect().height)),
        pageHeight: Math.round(document.querySelector(".sheet")?.getBoundingClientRect().height || 0),
      };
    });
    expect(relation.state).toBe("exact");
    expect(relation.marks).toBeGreaterThan(0);
    expect(relation.pageHeight).toBeGreaterThan(500);
    expect(Math.max(...relation.heights)).toBeLessThan(relation.pageHeight / 2);
  });

  test("the overlay never enters a saved file, and #comments does", async ({ page }) => {
    await load(page);
    await selectText(page, [0, 2], [1, 20]);
    await page.evaluate(() => {
      globalThis.StandaloneDoc.modules.comments.add({body: "Save me.", author: {name: "Nadia", kind: "author"}});
    });

    const saved = await page.evaluate(async () => {
      const {html} = await globalThis.StandaloneDoc.modules.toolbar.serialize();
      const doc = new DOMParser().parseFromString(html, "text/html");
      return {
        layer: Boolean(doc.querySelector("#comment-layer")),
        popover: Boolean(doc.querySelector("#comment-popover")),
        ephemeral: Boolean(doc.querySelector("[data-runtime='ephemeral']")),
        comments: doc.querySelectorAll("#comment-store").length,
        records: JSON.parse(doc.querySelector("#comment-store")?.textContent || "{}").comments?.length || 0,
        bids: doc.querySelectorAll("#content [data-bid]").length,
        /* The layer is a sibling of #content, so it cannot reach the .docx either; the
           assertion that matters here is the file. */
        contentLayer: Boolean(doc.querySelector("#content #comment-layer")),
      };
    });
    expect(saved.layer).toBe(false);
    expect(saved.popover).toBe(false);
    expect(saved.ephemeral).toBe(false);
    expect(saved.contentLayer).toBe(false);
    expect(saved.comments).toBe(1);
    expect(saved.records).toBe(1);
    expect(saved.bids).toBe(2);
  });

  test("deleting the last comment removes the block, so an empty store is not a change", async ({ page }) => {
    await load(page);
    await selectText(page, [0, 2], [1, 8]);
    const id = await page.evaluate(() => {
      const comments = globalThis.StandaloneDoc.modules.comments;
      const comment = comments.add({body: "Temporary.", author: {name: "Nadia", kind: "author"}});
      comments.remove(comment.id);
      return comment.id;
    });
    expect(id).toBeTruthy();
    const after = await page.evaluate(() => ({
      block: Boolean(document.getElementById("comment-store")),
      marks: document.querySelectorAll("#comment-layer .comment-mark").length,
    }));
    expect(after).toEqual({block: false, marks: 0});
  });
});

/* ------------------------------------------------------------------- the author */

/* Edit mode has no bar: the author's entry point is the Insert menu (where a selection
   still exists) and their list is the Comments panel. Both are wired to the same store
   the review copies use. */
test.describe("comments: the author in edit mode", () => {
  test("Insert › Comment on selection authors a comment and signs the file", async ({ page }) => {
    await load(page);
    await selectText(page, [0, 2], [1, 6]);
    /* The menu click must not take the selection with it — the toolbar cancels mousedown
       for exactly this reason. */
    await page.getByRole("button", {name: "Insert", exact: true}).click();
    await page.locator("[data-comment-add-edit]").click();

    const composer = page.locator("#comment-composer");
    await expect(composer).toBeVisible();
    await expect(composer).toContainText("Comment as the author");
    /* index.html has no author yet, so the composer asks once and writes it to the file. */
    await composer.locator("textarea").fill("This claim needs a citation.");
    await composer.locator('input[type="text"]').fill("Nadia");
    await composer.locator('button[type="submit"]').click();
    await expect(composer).toBeHidden();

    const state = await page.evaluate(() => ({
      record: JSON.parse(document.getElementById("comment-store").textContent).comments[0],
      author: JSON.parse(document.getElementById("doc-settings").textContent).author ?? null,
      marks: document.querySelectorAll("#comment-layer .comment-mark").length,
    }));
    expect(state.record.body).toBe("This claim needs a citation.");
    expect(state.record.author).toEqual({name: "Nadia", kind: "author"});
    expect(state.author).toBe("Nadia");
    expect(state.marks).toBeGreaterThan(0);
  });

  test("the Comments panel counts, orders and focuses threads", async ({ page }) => {
    await load(page);
    /* Two threads: the second is resolved, so the first row must be the open one. */
    await selectText(page, [0, 1], [0, 6]);
    await page.evaluate(() => {
      const comments = globalThis.StandaloneDoc.modules.comments;
      comments.add({body: "Open thread.", author: {name: "Nadia", kind: "author"}});
      comments.add({body: "Done thread.", author: {name: "Nadia", kind: "author"}});
      const done = comments.list().find((comment) => comment.body === "Done thread.");
      comments.resolve(done.id, true);
    });

    await page.click(GEAR);
    await page.click("#app-toolbar [data-settings-open]");
    await page.click('[data-dd-tab="comments"]');
    const panel = page.locator("#dd-comments");
    await expect(panel.locator("[data-dd-comment-count]")).toHaveText("1 unresolved · 2 total");
    const rows = panel.locator(".doc-comment");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Open thread.");
    await expect(rows.last()).toContainText("Done thread.");

    await rows.first().click();
    await expect(page.locator("#doc-settings-dialog")).not.toHaveAttribute("open", "");
    await expect(page.locator("#comment-popover")).toContainText("Open thread.");
  });
});
