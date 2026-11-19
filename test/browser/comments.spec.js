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
        rail: Boolean(doc.querySelector("#comment-rail, #comment-rail-tab")),
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
    expect(saved.rail).toBe(false);
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
    await expect(page.locator("#comment-rail .comment-card[data-pinned]")).toContainText("Open thread.");
  });
});


/* --------------------------------------------------------- the rail and the page */

/* The rail is the list a reader lives in: cards beside the page, unresolved in document
   order, resolved kept below. Hover previews, click pins until a click lands elsewhere,
   and a resolved comment keeps its record but loses its highlight. */
test.describe("comments: the rail", () => {
  test("hover previews, click pins, and a click elsewhere lets go", async ({ page }) => {
    await load(page);
    await selectText(page, [0, 2], [1, 6]);
    await page.evaluate(() => {
      globalThis.StandaloneDoc.modules.comments.add({body: "Rail me.", author: {name: "Nadia", kind: "author"}});
    });
    await expect(page.locator("#comment-rail .comment-card")).toHaveCount(1);

    await page.locator("#comment-layer .comment-mark").first().hover();
    await expect(page.locator("#comment-rail .comment-card[data-hover]")).toHaveCount(1);
    await expect(page.locator("#comment-layer .comment-mark[data-hover]")).not.toHaveCount(0);

    await page.locator("#comment-layer .comment-mark").first().click();
    await expect(page.locator("#comment-rail .comment-card[data-pinned]")).toHaveCount(1);
    /* The flash is what makes a navigation legible; it is removed after the animation. */
    await expect(page.locator("#comment-layer .comment-mark[data-flash]")).not.toHaveCount(0);

    await page.mouse.click(120, 500);
    await expect(page.locator("#comment-rail .comment-card[data-pinned]")).toHaveCount(0);
  });

  test("resolving removes the highlight, keeps the record, and reopening restores it", async ({ page }) => {
    await load(page);
    await selectText(page, [0, 2], [1, 6]);
    const id = await page.evaluate(() => {
      const comment = globalThis.StandaloneDoc.modules.comments.add({body: "Done soon.", author: {name: "Nadia", kind: "author"}});
      globalThis.StandaloneDoc.modules.comments.resolve(comment.id, true);
      return comment.id;
    });
    expect(id).toBeTruthy();

    let state = await page.evaluate((id) => ({
      marks: document.querySelectorAll(`#comment-layer .comment-mark[data-comment-id="${id}"]`).length,
      inList: globalThis.StandaloneDoc.modules.comments.list().some((comment) => comment.id === id && comment.resolved),
      resolvedCard: document.querySelectorAll("#comment-rail .comment-card[data-resolved]").length,
      reopen: [...document.querySelectorAll("#comment-rail .comment-card[data-resolved] .comment-actions button")].map((b) => b.textContent),
    }), id);
    expect(state.marks).toBe(0);
    expect(state.inList).toBe(true);
    expect(state.resolvedCard).toBe(1);
    expect(state.reopen).toEqual(["Reopen", "Delete"]);

    await page.locator("#comment-rail .comment-card[data-resolved]").getByRole("button", {name: "Reopen"}).click();
    state = await page.evaluate((id) => ({
      marks: document.querySelectorAll(`#comment-layer .comment-mark[data-comment-id="${id}"]`).length,
      resolvedCard: document.querySelectorAll("#comment-rail .comment-card[data-resolved]").length,
    }), id);
    expect(state.marks).toBeGreaterThan(0);
    expect(state.resolvedCard).toBe(0);
  });

  test("a comment across a page break anchors once and paints on every page it touches", async ({ page }) => {
    await load(page);
    const prepared = await page.evaluate(() => {
      const content = document.getElementById("content");
      const block = content.children[1];
      block.textContent = Array.from({length: 40}, (_, i) => `Line ${i + 1}: a paragraph long enough to cross a page boundary, written so that the comment below can name a range on two pages of one block.`).join(" ");
      globalThis.StandaloneDoc.modules.pagination.refresh();
      const plan = globalThis.StandaloneDoc.modules.pagination.plan();
      const items = plan.pages.flatMap((page, index) => page.items.map((item) => ({...item, page: index}))).filter((item) => item.block === 1);
      return {blocks: items.length, from: items[0].from + 20, to: items.at(-1).to ?? block.textContent.length};
    });
    expect(prepared.blocks).toBeGreaterThan(1);

    const result = await page.evaluate(({from, to}) => {
      const content = document.getElementById("content");
      const block = content.children[1];
      const point = (offset) => {
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        let remaining = offset;
        let last = null;
        while (node) {
          last = node;
          if (remaining <= node.nodeValue.length) return {node, offset: remaining};
          remaining -= node.nodeValue.length;
          node = walker.nextNode();
        }
        return last ? {node: last, offset: last.nodeValue.length} : null;
      };
      const start = point(from);
      const end = point(to);
      globalThis.getSelection().setBaseAndExtent(start.node, start.offset, end.node, end.offset);
      const comment = globalThis.StandaloneDoc.modules.comments.add({body: "Across the break.", author: {name: "Nadia", kind: "author"}});
      const plan = globalThis.StandaloneDoc.modules.pagination.plan();
      const marks = [...document.querySelectorAll("#comment-layer .comment-mark")].map((mark) => Number.parseFloat(mark.style.top));
      return {
        state: globalThis.StandaloneDoc.modules.comments.list()[0]?.state,
        blocks: comment.anchor.blocks.length,
        marks: marks.length,
        pages: new Set(marks.map((top) => plan.pageTops.findLastIndex((pageTop) => top >= pageTop))).size,
        pageTops: plan.pageTops.length,
      };
    }, {from: prepared.from, to: prepared.to});

    expect(result.state).toBe("exact");
    expect(result.blocks).toBe(1, "one block, cut by pagination — not two anchors");
    expect(result.marks).toBeGreaterThan(1, "one mark per page the range touches");
    expect(result.pages).toBeGreaterThan(1, "and they are on different pages");
  });

  test("the keyboard opens the composer (Mod+Alt+M)", async ({ page }) => {
    await load(page);
    await selectText(page, [0, 2], [1, 6]);
    await page.keyboard.press("Meta+Alt+m");
    await expect(page.locator("#comment-composer")).toBeVisible();
    await expect(page.locator("#comment-composer")).toContainText("Comment as the author");
    await page.keyboard.press("Escape");
    await expect(page.locator("#comment-composer")).toBeHidden();
  });

  test("a settings row closes the dialog, pins the card and flashes the highlight", async ({ page }) => {
    await load(page);
    await selectText(page, [0, 2], [1, 6]);
    await page.evaluate(() => {
      globalThis.StandaloneDoc.modules.comments.add({body: "Find me.", author: {name: "Nadia", kind: "author"}});
    });
    await page.click(GEAR);
    await page.click("#app-toolbar [data-settings-open]");
    await page.click('[data-dd-tab="comments"]');
    await expect(page.locator("#dd-comments .doc-comment")).toHaveCount(1);
    await page.locator("#dd-comments .doc-comment").first().click();
    await expect(page.locator("#doc-settings-dialog")).not.toHaveAttribute("open", "");
    await expect(page.locator("#comment-rail .comment-card[data-pinned]")).toHaveCount(1);
    await expect(page.locator("#comment-layer .comment-mark[data-flash]")).not.toHaveCount(0);
  });

  test("the rail hides from its own header and comes back from the tab", async ({ page }) => {
    await load(page);
    await selectText(page, [0, 2], [1, 6]);
    await page.evaluate(() => {
      globalThis.StandaloneDoc.modules.comments.add({body: "Hide me.", author: {name: "Nadia", kind: "author"}});
    });
    await expect(page.locator("#comment-rail .comment-card")).toHaveCount(1);

    await page.locator("#comment-rail [data-rail-close]").click();
    await expect(page.locator("#comment-rail")).toBeHidden();
    await expect(page.locator("#comment-rail-tab")).toBeVisible();
    /* The page is untouched by the rail coming and going. */
    const padding = await page.evaluate(() => getComputedStyle(document.getElementById("viewport")).paddingRight);
    expect(padding).toBe("0px");

    await page.locator("#comment-rail-tab").click();
    await expect(page.locator("#comment-rail .comment-card")).toHaveCount(1);
    await expect(page.locator("#comment-rail-tab")).toBeHidden();
  });

  test("hover and click work both ways: card to highlight, and highlight to card", async ({ page }) => {
    await load(page);
    /* A document tall enough that "go to the words" has somewhere to go. */
    await page.evaluate(() => {
      const content = document.getElementById("content");
      const target = content.children[1];
      target.textContent = Array.from({length: 30}, (_, i) => `Sentence ${i + 1}: the comment is on this paragraph and the reader will be far away from it.`).join(" ");
      for (let i = 0; i < 24; i += 1) {
        const p = document.createElement("p");
        p.textContent = `Filler ${i + 1}, so the target can be scrolled out of view while the rail keeps it in reach.`;
        content.append(p);
      }
      globalThis.StandaloneDoc.modules.pagination.refresh();
    });
    await page.evaluate(() => {
      const content = document.getElementById("content");
      const block = content.children[1];
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      globalThis.getSelection().setBaseAndExtent(node, 0, node, 40);
      globalThis.StandaloneDoc.modules.comments.add({body: "Both ways.", author: {name: "Nadia", kind: "author"}});
      document.getElementById("viewport").scrollTop = document.getElementById("viewport").scrollHeight;
    });
    await expect(page.locator("#comment-rail .comment-card")).toHaveCount(1);
    const before = await page.evaluate(() => document.getElementById("viewport").scrollTop);
    expect(before).toBeGreaterThan(200);

    /* Card → highlight: hovering the card lights the marks. */
    await page.locator("#comment-rail .comment-card .comment-body").hover();
    await expect(page.locator("#comment-layer .comment-mark[data-hover]")).not.toHaveCount(0);
    expect(await page.evaluate(() => document.getElementById("viewport").scrollTop)).toBe(before);

    /* Card → words: a click anywhere on the card goes there. */
    await page.locator("#comment-rail .comment-card .comment-body").click();
    await expect.poll(() => page.evaluate(() => document.getElementById("viewport").scrollTop)).toBeLessThan(before);
    await expect(page.locator("#comment-rail .comment-card[data-pinned]")).toHaveCount(1);

    /* The controls keep their own meaning: typing a reply must not move the page. Let the
       smooth scroll from the click finish first, then park and compare. */
    await page.waitForTimeout(900);
    const parked = await page.evaluate(() => document.getElementById("viewport").scrollTop);
    await page.locator("#comment-rail .comment-card input[aria-label=Reply]").click();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.getElementById("viewport").scrollTop)).toBe(parked);

    /* Highlight → card: hovering the mark lights the card. */
    await page.locator("#comment-layer .comment-mark").first().hover();
    await expect(page.locator("#comment-rail .comment-card[data-hover]")).toHaveCount(1);
  });

  test("a narrow layout has no room for the rail, and falls back to a popover", async ({ page }) => {
    await page.setViewportSize({width: 900, height: 800});
    await load(page);
    await selectText(page, [0, 2], [1, 6]);
    await page.evaluate(() => {
      globalThis.StandaloneDoc.modules.comments.add({body: "Narrow.", author: {name: "Nadia", kind: "author"}});
    });
    const layout = await page.evaluate(() => ({
      railHidden: document.getElementById("comment-rail").hidden,
      padding: getComputedStyle(document.getElementById("viewport")).paddingRight,
    }));
    expect(layout).toEqual({railHidden: true, padding: "0px"});

    await page.locator("#comment-layer .comment-mark").first().click();
    await expect(page.locator("#comment-popover")).toBeVisible();
    await expect(page.locator("#comment-popover")).toContainText("Narrow.");
  });
});


test.describe("comments: navigation is deliberate", () => {
  test("adding and resolving do not move the page; opening does", async ({ page }) => {
    await load(page);
    /* A document tall enough to scroll, then park the reader below the fold. */
    const before = await page.evaluate(() => {
      const content = document.getElementById("content");
      for (let i = 0; i < 30; i += 1) {
        const p = document.createElement("p");
        p.textContent = `Filler paragraph ${i + 1}, long enough to make the document scroll and to put the first block well above the fold when the reader is at the bottom.`;
        content.append(p);
      }
      globalThis.StandaloneDoc.modules.pagination.refresh();
      const viewport = document.getElementById("viewport");
      viewport.scrollTop = viewport.scrollHeight;
      return viewport.scrollTop;
    });
    expect(before).toBeGreaterThan(200);

    await selectText(page, [0, 2], [1, 6]);
    const afterAdd = await page.evaluate(() => {
      const comments = globalThis.StandaloneDoc.modules.comments;
      const comment = comments.add({body: "No jump, please.", author: {name: "Nadia", kind: "author"}});
      comments.resolve(comment.id, true);
      return {scrollTop: document.getElementById("viewport").scrollTop, id: comment.id};
    });
    await page.waitForTimeout(300);
    expect(afterAdd.scrollTop).toBe(before);
    expect(await page.evaluate(() => document.getElementById("viewport").scrollTop)).toBe(before);

    /* Opening it is the act that moves the page, and only because it is out of sight. */
    await page.evaluate((id) => {
      const comment = globalThis.StandaloneDoc.modules.comments.list().find((candidate) => candidate.id === id);
      globalThis.StandaloneDoc.modules.comments.focus(comment);
    }, afterAdd.id);
    await expect.poll(() => page.evaluate(() => document.getElementById("viewport").scrollTop)).toBeLessThan(before);
  });
});
