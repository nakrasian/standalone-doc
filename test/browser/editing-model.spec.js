import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* The editing model, asserted where it can be measured: a real browser.
 *
 * Each test is one invariant from `docs/EDITING-MODEL.md`, and the failure message names
 * the number that disagreed. The model's whole point is that these are *relationships*
 * ("every child is a block", "the tail item is at a page top", "a nested paragraph has the
 * same padding as a top-level one"), so the assertions compare two measured values rather
 * than hard-coding a page count — window size and font metrics differ per platform.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fileUrl = (name = "index.html") => "file://" + path.join(ROOT, name);

async function boot(page) {
  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  await page.goto(fileUrl());
  await page.waitForFunction(
    () => ["ready", "failed"].includes(globalThis.StandaloneDoc?.state),
    null,
    {timeout: 15_000},
  );
  expect(await page.evaluate(() => globalThis.StandaloneDoc.state), problems.join(" | ")).toBe("ready");
  return problems;
}

/** Two frames: the fragmenting pass runs in the observer callback, before the next paint. */
const settle = (page) => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
}));

/** Replace the document without the model, so a test decides when normalization runs. */
async function reset(page, html) {
  await page.evaluate((markup) => {
    const content = document.getElementById("content");
    content.innerHTML = markup;
    globalThis.StandaloneDoc.modules.pagination.refresh();
    globalThis.StandaloneDoc.modules.editor.history.reset();
  }, html);
  await settle(page);
}

/** A clipboard event with a DataTransfer. `ClipboardEvent`'s init dict is not portable;
    every engine lets a plain Event carry the property. */
async function paste(page, {html = "", text = ""}) {
  await page.evaluate(({html, text}) => {
    const content = document.getElementById("content");
    content.focus();
    const data = new DataTransfer();
    if (html) data.setData("text/html", html);
    if (text) data.setData("text/plain", text);
    const event = new Event("paste", {bubbles: true, cancelable: true});
    Object.defineProperty(event, "clipboardData", {value: data});
    content.dispatchEvent(event);
  }, {html, text});
  await settle(page);
}

const state = (page) => page.evaluate(() => {
  const content = document.getElementById("content");
  const pagination = globalThis.StandaloneDoc.modules.pagination;
  const d = pagination.diagnostics();
  return {
    children: [...content.children].map((el) => el.localName),
    html: content.innerHTML,
    text: content.textContent,
    pages: d.pages,
    fragments: d.fragments,
    breaks: d.breaks,
    check: d.check ? {ok: d.check.ok, failures: d.check.failures} : null,
    sheets: [...document.querySelectorAll(".sheet")].map((sheet) => ({
      top: parseFloat(sheet.style.top),
      height: parseFloat(sheet.style.height),
    })),
    pageTops: d.pageTops,
    pageBottoms: d.pageBottoms,
    /* Layout px, like `pageTops`: a client rect would include the stage's scroll offset
       and the comparison below would fail for the scroll position, not the plan. */
    tips: [...content.querySelectorAll("[data-page-break]")].map((li) => ({
      text: li.textContent,
      top: globalThis.StandaloneDoc.modules.layout.rect(li).top,
      margin: parseFloat(li.style.marginBlockStart || "0"),
    })),
  };
});

const normalize = (page) => page.evaluate(() => globalThis.StandaloneDoc.use("editor").normalize());

const PARAGRAPHS = (count, prefix = "Paragraph") => Array.from(
  {length: count},
  (_, i) => `<p>${prefix} ${i} — lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.</p>`,
).join("");

/* ------------------------------------------------------------------ the invariant */

test("normalization makes every child a block, once", async ({page}) => {
  await boot(page);
  await reset(page, `
    <div><p>wrapped paragraph</p><p>second</p></div>
    <p>a paragraph<ul><li>with a list inside</li></ul></p>
    <li>loose item</li><li>loose item two</li>
    <span>bare inline at the top</span>
    <section>section that holds text</section>
  `);

  const passes = await normalize(page);
  expect(passes).toBeGreaterThan(0);

  const after = await state(page);
  /* Every child is a block the strategy table knows. */
  for (const tag of after.children) {
    expect(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "ul", "ol", "figure", "table", "hr", "div"])
      .toContain(tag);
  }
  /* No text block contains a block; no list item lives outside a list. */
  const shape = await page.evaluate(() => {
    const content = document.getElementById("content");
    const blocks = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "ul", "ol", "figure", "table", "hr", "div"]);
    return {
      nestedBlockInText: [...content.querySelectorAll("p, h1, h2, h3, h4, h5, h6")]
        .filter((el) => [...el.querySelectorAll("*")].some((child) => blocks.has(child.localName)))
        .map((el) => el.outerHTML.slice(0, 80)),
      looseItems: [...content.querySelectorAll(":scope > li")].length,
      nonItemChildren: [...content.querySelectorAll("ul, ol")]
        .flatMap((list) => [...list.children].filter((child) => child.localName !== "li"))
        .map((el) => el.localName),
      wrappers: [...content.querySelectorAll(":scope > span, :scope > b, :scope > section, :scope > div")]
        .map((el) => el.localName),
    };
  });
  expect(shape.nestedBlockInText).toEqual([]);
  expect(shape.looseItems).toBe(0);
  expect(shape.nonItemChildren).toEqual([]);
  expect(shape.wrappers).toEqual([]);

  /* Idempotent: a second pass writes nothing, which is why opening a document cannot
     mark it dirty. */
  expect(await normalize(page)).toBe(0);
  expect((await state(page)).html).toBe(after.html);
});

/* ----------------------------------------------------------------------- ingestion */

test("a wrapped paste is paginated, not one enormous page", async ({page}) => {
  await boot(page);
  await reset(page, "<p>Start.</p>");
  await page.evaluate(() => {
    const p = document.getElementById("content").firstElementChild;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  /* The shape a rendered web page or a rendered markdown preview produces: one wrapper
     around many paragraphs. Before the model this was a single atomic block. */
  await paste(page, {html: `<div>${PARAGRAPHS(30, "Pasted")}</div>`});

  const after = await state(page);
  expect(after.children.every((tag) => tag === "p")).toBe(true);
  expect(after.pages).toBeGreaterThan(1);
  /* The regression is a page that grows to fit its block: every sheet is one page tall. */
  const first = after.sheets[0].height;
  for (const sheet of after.sheets) {
    expect(Math.abs(sheet.height - first)).toBeLessThan(2);
  }
  expect(after.check?.ok).toBe(true);
});

test("a Google Docs paste loses its wrapper, styles and line height", async ({page}) => {
  await boot(page);
  await reset(page, "<p>Start.</p>");
  await page.evaluate(() => {
    const p = document.getElementById("content").firstElementChild;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  const docsHtml = `<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid-1">${
    Array.from({length: 6}, (_, i) => `<p style="line-height:1.38;margin:0"><span style="font-size:11pt;font-family:Arial">GDoc line ${i}</span></p>`).join("")
  }</b>`;
  await paste(page, {html: docsHtml});

  const after = await state(page);
  expect(after.children).not.toContain("b");
  expect(after.children).not.toContain("span");
  const styled = await page.evaluate(() => document.querySelectorAll("#content [style]").length);
  expect(styled).toBe(0);
  /* The document's own leading, not the source's. */
  const leading = await page.evaluate(() => getComputedStyle(document.getElementById("content").firstElementChild).lineHeight);
  expect(leading).toBe(await page.evaluate(() => getComputedStyle(document.body).lineHeight));
});

test("paste inserts at the caret: inline in a sentence, blocks mid-list", async ({page}) => {
  await boot(page);

  await reset(page, "<p>Hello world</p>");
  await page.evaluate(() => {
    const p = document.getElementById("content").firstElementChild;
    const range = document.createRange();
    range.setStart(p.firstChild, 5);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await paste(page, {html: "<p>BIG</p><p>second</p>"});
  let after = await state(page);
  expect(after.children).toEqual(["p", "p", "p", "p"]);
  expect(after.text).toBe("HelloBIGsecond world");
  /* The tail is a paragraph and typing continues there, not in a heading or a list. */
  expect(await page.evaluate(() => {
    const selection = window.getSelection();
    const node = selection.anchorNode;
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    return el?.closest("#content > *")?.localName;
  })).toBe("p");

  await reset(page, "<ul><li>one</li><li>two</li></ul><p>after</p>");
  await page.evaluate(() => {
    const li = [...document.querySelectorAll("li")][0];
    const range = document.createRange();
    range.setStart(li.firstChild, 2);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await paste(page, {html: "<p>pasted paragraph</p>"});
  after = await state(page);
  /* The list splits around the paste; the payload is a sibling block, not a paragraph
     inside a list item (which is what the engine does unaided). */
  expect(after.children).toEqual(["ul", "p", "ul", "p"]);
  expect(after.text).toContain("pasted paragraph");
  expect(await page.evaluate(() => document.querySelectorAll("li p").length)).toBe(0);
});

test("plain text paste becomes paragraphs, blank lines included", async ({page}) => {
  await boot(page);
  await reset(page, "<p>Start.</p>");
  await page.evaluate(() => {
    const p = document.getElementById("content").firstElementChild;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await paste(page, {text: "line one\nline two\n\nsecond paragraph"});
  const after = await state(page);
  expect(after.children).toEqual(["p", "p", "p"]);
  expect(after.text).toContain("line one");
  expect(await page.evaluate(() => document.querySelectorAll("#content br").length)).toBe(1);
});

/* --------------------------------------------------------------------------- lists */

test("a long list breaks between items and stays one list", async ({page}) => {
  await boot(page);
  await reset(page, `<ol>${Array.from({length: 44}, (_, i) => `<li>Item ${i + 1} — lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do.</li>`).join("")}</ol>`);

  const after = await state(page);
  expect(after.pages).toBeGreaterThan(1);
  expect(after.breaks).toBe(after.pages - 1);
  /* One `<ol>`, no `start`: numbering continues because the element was never split. */
  expect(after.children).toEqual(["ol"]);
  expect(await page.evaluate(() => document.querySelectorAll("#content ol").length)).toBe(1);
  expect(await page.evaluate(() => document.querySelector("#content ol").hasAttribute("start"))).toBe(false);
  /* Every break item is at a page's content top, within the pass's own tolerance. */
  for (const tip of after.tips) {
    expect(after.pageTops.some((top) => Math.abs(top - tip.top) <= 1.5)).toBe(true);
    expect(tip.margin).toBeGreaterThan(0);
  }
  expect(after.check?.ok).toBe(true);
  /* The last sheet is a page, not a stretched block. */
  const first = after.sheets[0].height;
  for (const sheet of after.sheets) expect(Math.abs(sheet.height - first)).toBeLessThan(2);
});

test("a list that shrinks loses its breaks in the same pass", async ({page}) => {
  await boot(page);
  await reset(page, `<ul>${Array.from({length: 44}, (_, i) => `<li>Item ${i + 1} — lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do.</li>`).join("")}</ul>`);
  expect((await state(page)).breaks).toBeGreaterThan(0);

  await page.evaluate(() => {
    const list = document.querySelector("#content ul");
    [...list.children].slice(6).forEach((li) => li.remove());
    globalThis.StandaloneDoc.modules.pagination.refresh();
  });
  await settle(page);
  const after = await state(page);
  expect(after.breaks).toBe(0);
  expect(after.children).toEqual(["ul"]);
});

test("Tab indents an item and Shift-Tab brings it back", async ({page}) => {
  await boot(page);
  await reset(page, "<ul><li>one</li><li>two</li></ul>");
  await page.evaluate(() => {
    const li = [...document.querySelectorAll("li")][1];
    const range = document.createRange();
    range.setStart(li.firstChild, 1);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.getElementById("content").focus();
  });
  await page.keyboard.press("Tab");
  await settle(page);
  expect(await page.evaluate(() => document.querySelectorAll("#content ul ul li").length)).toBe(1);
  /* The caret survived the move (Chromium otherwise resets it to the list element). */
  expect(await page.evaluate(() => {
    const node = window.getSelection().anchorNode;
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    return el?.closest("li")?.textContent;
  })).toBe("two");

  await page.keyboard.press("Shift+Tab");
  await settle(page);
  expect(await page.evaluate(() => document.querySelectorAll("#content ul ul").length)).toBe(0);
  expect(await page.evaluate(() => [...document.querySelectorAll("#content li")].map((li) => li.textContent))).toEqual(["one", "two"]);
});

test("setBlock on a list item makes a block, not a paragraph around a list", async ({page}) => {
  await boot(page);
  await reset(page, "<ul><li>only item</li></ul><p>after</p>");
  await page.evaluate(() => {
    const li = document.querySelector("li");
    const range = document.createRange();
    range.setStart(li.firstChild, 2);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    globalThis.StandaloneDoc.modules.editor.setBlock("p");
  });
  await settle(page);
  const after = await state(page);
  expect(after.children).toEqual(["p", "p"]);
  expect(await page.evaluate(() => document.querySelectorAll("#content p ul, #content p ol").length)).toBe(0);
});

test("a click below the last block starts a paragraph, not a list item", async ({page}) => {
  await boot(page);
  await reset(page, "<ul><li>only item</li></ul>");
  const point = await page.evaluate(() => {
    const content = document.getElementById("content").getBoundingClientRect();
    const list = document.querySelector("ul").getBoundingClientRect();
    return {x: content.left + 60, y: list.bottom + 40};
  });
  await page.mouse.click(point.x, point.y);
  await page.keyboard.type("typed below");
  await settle(page);
  const after = await state(page);
  expect(after.children).toEqual(["ul", "p"]);
  expect(after.text).toContain("typed below");
  expect(await page.evaluate(() => document.querySelector("li").textContent)).toBe("only item");
});

/* ------------------------------------------------------------------------- spacing */

test("a nested paragraph has the same rhythm as a top-level one", async ({page}) => {
  await boot(page);
  await reset(page, `
    <p id="top">Top paragraph.</p>
    <ul><li><p id="nested">Paragraph inside an item.</p></li><li>plain item</li></ul>
    <blockquote><p id="quoted">Quoted paragraph.</p></blockquote>
    <pre id="code">const x = 1;</pre>
    <h2 id="head">Heading</h2>
  `);
  await settle(page);
  const m = await page.evaluate(() => {
    const read = (id) => {
      const cs = getComputedStyle(document.getElementById(id));
      return {
        top: cs.marginTop,
        bottom: cs.marginBottom,
        padBottom: cs.paddingBottom,
        lineHeight: cs.lineHeight,
      };
    };
    return {
      top: read("top"),
      nested: read("nested"),
      quoted: read("quoted"),
      blockquotePad: getComputedStyle(document.querySelector("blockquote")).paddingLeft,
      code: getComputedStyle(document.getElementById("code")).fontFamily,
      itemPad: getComputedStyle(document.querySelectorAll("li")[1]).paddingTop,
    };
  });
  /* The reader sees one rhythm: same margins, same trailing space, at both depths. */
  expect(m.nested.top).toBe(m.top.top);
  expect(m.nested.bottom).toBe(m.top.bottom);
  expect(m.quoted.padBottom).toBe("0px");
  expect(parseFloat(m.blockquotePad)).toBeGreaterThan(0);
  expect(m.code).toMatch(/mono/i);
  expect(parseFloat(m.itemPad)).toBeGreaterThan(0);
});

/* --------------------------------------------------------------------- page setup */

test("page geometry is a document setting and the plan follows it", async ({page}) => {
  await boot(page);
  await reset(page, PARAGRAPHS(30));
  const before = await state(page);

  /* A5 with generous margins: smaller than the default in both directions, so the same
     text needs *more* pages. That is the assertion that geometry reached the plan, not just
     the stylesheet. */
  const applied = await page.evaluate(() => {
    const editor = globalThis.StandaloneDoc.modules.editor;
    /* A type change and a page change share the theme block. Setting one first is what
       proves the other merges instead of replacing. */
    editor.setFontSize("12pt");
    editor.applyPage({
      size: "a5",
      orientation: "portrait",
      margins: {top: 0.8, right: 0.7, bottom: 0.9, left: 0.6},
      leading: 1.7,
    });
    return editor.pageState();
  });
  await settle(page);
  expect(applied.size).toBe("a5");
  expect(applied.orientation).toBe("portrait");
  expect(applied.margins).toEqual({top: 0.8, right: 0.7, bottom: 0.9, left: 0.6});
  expect(applied.leading).toBe(1.7);

  const after = await state(page);
  expect(after.pages).toBeGreaterThan(before.pages);
  expect(after.check?.ok).toBe(true);
  /* The sheet is the new page, and the type is the document's, not the source's. */
  const sheet = await page.evaluate(() => {
    const el = document.querySelector(".sheet");
    return {width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height};
  });
  expect(Math.abs(sheet.width - 5.83 * 96)).toBeLessThan(2);
  expect(Math.abs(sheet.height - 8.27 * 96)).toBeLessThan(2);
  const leading = await page.evaluate(() => parseFloat(getComputedStyle(document.body).lineHeight));
  const size = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
  expect(Math.abs(leading - size * 1.7)).toBeLessThan(0.6);
  /* The font size set a line earlier is still there: geometry and type share the block,
     and one must not erase the other. */
  expect(await page.evaluate(() => document.getElementById("user-theme").textContent)).toContain("--doc-size:12pt");
});

test("saving keeps the whole theme block and no session furniture", async ({page}) => {
  await boot(page);
  await reset(page, `<ol>${Array.from({length: 44}, (_, i) => `<li>Item ${i + 1} — lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do.</li>`).join("")}</ol>`);
  await page.evaluate(() => globalThis.StandaloneDoc.modules.editor.applyPage({
    size: "letter",
    margins: {top: 1, right: 1, bottom: 1, left: 1},
    leading: 1.6,
  }));
  await settle(page);
  expect((await state(page)).breaks).toBeGreaterThan(0);

  const saved = await page.evaluate(async () => {
    const {html} = await globalThis.StandaloneDoc.modules.toolbar.serialize();
    return html;
  });
  const doc = await page.evaluate((html) => {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    return {
      theme: parsed.getElementById("user-theme")?.textContent || "",
      breaks: parsed.querySelectorAll("[data-page-break]").length,
      frags: parsed.querySelectorAll("[data-frag]").length,
      starts: parsed.querySelectorAll("[data-page-start]").length,
    };
  }, saved);
  expect(doc.theme).toContain("--sheet-w");
  expect(doc.theme).toContain("--pad");
  expect(doc.theme).toContain("--doc-leading:1.6");
  /* Pagination is session state: the reopened file plans it again. */
  expect(doc.breaks).toBe(0);
  expect(doc.frags).toBe(0);
  expect(doc.starts).toBe(0);
});

/* --------------------------------------------------------------------- page breaks */

test("a heading does not end a page alone", async ({page}) => {
  await boot(page);
  /* Grow the filler until the document needs a second page *on this platform's font
     metrics*, then assert the heading crossed with its paragraph. Without keepWithNext the
     heading fits, the paragraph does not, and they land on different pages. */
  const result = await page.evaluate(() => {
    const content = document.getElementById("content");
    const pagination = globalThis.StandaloneDoc.modules.pagination;
    content.innerHTML = "<p>Fill.</p><h2>The heading</h2><p>Its paragraph, which must not be separated from it.</p>";
    const filler = document.createElement("p");
    filler.textContent = "Filler line — lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod.";
    content.prepend(filler);
    pagination.refresh();
    let guard = 0;
    while (pagination.diagnostics().pages === 1 && guard++ < 120) {
      filler.after(filler.cloneNode(true));
      pagination.refresh();
    }
    const pageOf = (selector) => {
      const rect = content.querySelector(selector).getBoundingClientRect();
      return [...document.querySelectorAll(".sheet")].findIndex((box) => {
        const boxRect = box.getBoundingClientRect();
        return rect.top >= boxRect.top && rect.top <= boxRect.bottom;
      }) + 1;
    };
    return {
      pages: pagination.diagnostics().pages,
      starts: content.querySelector("h2").hasAttribute("data-page-start"),
      headingPage: pageOf("h2"),
      paragraphPage: pageOf("h2 + p"),
    };
  });
  expect(result.pages).toBeGreaterThan(1);
  expect(result.starts).toBe(true);
  expect(result.headingPage).toBe(result.paragraphPage);
});

/* ------------------------------------------------------------- typing shortcuts */

/** An empty paragraph with the caret in it — where a shortcut can legitimately fire. */
async function emptyParagraph(page) {
  await page.evaluate(() => {
    const content = document.getElementById("content");
    content.innerHTML = "<p><br></p>";
    globalThis.StandaloneDoc.modules.pagination.refresh();
    content.focus();
    const paragraph = content.firstElementChild;
    const range = document.createRange();
    range.setStart(paragraph, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await settle(page);
}

const caretBlock = (page) => page.evaluate(() => {
  const node = window.getSelection().anchorNode;
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  return el?.closest("#content > *")?.localName ?? null;
});

test("typing '- ' or '1. ' starts a list, only at the start of a block", async ({page}) => {
  await boot(page);

  for (const [marker, tag] of [["- ", "ul"], ["* ", "ul"], ["1. ", "ol"], ["1) ", "ol"]]) {
    await emptyParagraph(page);
    await page.keyboard.type(marker);
    await settle(page);
    const after = await state(page);
    expect(after.children, marker).toEqual([tag]);
    expect(after.check?.ok, marker).toBe(true);
    /* The caret is inside the item, so typing continues the list rather than the marker. */
    expect(await caretBlock(page), marker).toBe(tag);
    await page.keyboard.type("item");
    await page.waitForTimeout(120);
    expect(await page.evaluate(() => document.querySelector("li").textContent.trim()), marker).toBe("item");
  }

  /* The number typed is the number the list starts at. */
  await emptyParagraph(page);
  await page.keyboard.type("3. ");
  await settle(page);
  expect(await page.evaluate(() => document.querySelector("#content ol")?.getAttribute("start"))).toBe("3");

  /* A dash at the end of a sentence is a dash, and a marker inside an item is text. */
  await reset(page, "<p>a -</p>");
  await page.evaluate(() => {
    const paragraph = document.getElementById("content").firstElementChild;
    const range = document.createRange();
    range.setStart(paragraph.firstChild, 3);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.getElementById("content").focus();
  });
  await page.keyboard.type(" ");
  await settle(page);
  expect((await state(page)).children).toEqual(["p"]);

  await reset(page, "<ul><li>one</li></ul>");
  await page.evaluate(() => {
    const item = document.querySelector("li");
    const range = document.createRange();
    range.selectNodeContents(item);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.getElementById("content").focus();
  });
  await page.keyboard.type("- ");
  await settle(page);
  const inside = await state(page);
  expect(inside.children).toEqual(["ul"]);
  expect(await page.evaluate(() => document.querySelector("li").textContent)).toContain("-");
});

/* ------------------------------------------------------------ hanging indent */

test("every line of a list item shares one text column", async ({page}) => {
  await boot(page);
  const long = "A list item long enough to wrap several times, so the second and third lines have to line up with the first rather than with the marker. ".repeat(3);
  await reset(page, `<ul><li id="item"><span id="wrap">${long}</span><br><span id="cont">a continuation line</span></li></ul>`);
  const measured = await page.evaluate(() => {
    const wrap = document.getElementById("wrap");
    const rects = [...wrap.getClientRects()].filter((rect) => rect.width > 0);
    const item = document.getElementById("item").getBoundingClientRect();
    const list = document.querySelector("ul");
    return {
      lines: rects.length,
      lefts: rects.map((rect) => Math.round(rect.left * 10) / 10),
      continuation: Math.round(document.getElementById("cont").getBoundingClientRect().left * 10) / 10,
      itemLeft: Math.round(item.left * 10) / 10,
      listLeft: Math.round(list.getBoundingClientRect().left * 10) / 10,
      padding: parseFloat(getComputedStyle(list).paddingInlineStart),
    };
  });
  /* More than one line, and every line starts at the same x — the hanging indent. */
  expect(measured.lines).toBeGreaterThan(1);
  for (const left of measured.lefts) expect(Math.abs(left - measured.lefts[0])).toBeLessThan(1.5);
  /* A line broken inside the item (Shift+Enter's `<br>`) is the same column too. */
  expect(Math.abs(measured.continuation - measured.lefts[0])).toBeLessThan(1.5);
  /* The marker lives in the list's padding, outside the item's text column. */
  expect(measured.itemLeft - measured.listLeft).toBeGreaterThan(measured.padding * 0.9);
});

/* ------------------------------------------------- a single item, taller than a page */

test("an item that cannot be cut grows its page instead of painting the gap", async ({page}) => {
  await boot(page);
  const huge = Array.from({length: 70}, (_, i) => `line ${i}`).join("<br>");
  await reset(page, `<ul><li>one</li><li>two</li><li id="huge">${huge}</li><li>four</li></ul>`);
  const after = await page.evaluate(() => {
    const pagination = globalThis.StandaloneDoc.modules.pagination;
    const plan = pagination.plan();
    return {
      pages: pagination.diagnostics().pages,
      contentH: plan.contentH,
      avails: plan.pages.map((page) => Math.round(page.avail)),
      oversize: plan.oversize.length,
      check: pagination.diagnostics().check,
      lastSheet: Math.round(parseFloat(document.querySelectorAll(".sheet")[plan.pages.length - 1].style.height)),
    };
  });
  expect(after.pages).toBeGreaterThan(1);
  /* The tail item is an atom: one page is taller than the page grid, deliberately. */
  expect(after.avails.some((avail) => avail > after.contentH + 1)).toBe(true);
  expect(after.oversize).toBeGreaterThan(0);
  expect(after.check?.ok).toBe(true);
});

/* --------------------------------------------------- Backspace on an empty item */

const caretInItem = (page, index, at = "end") => page.evaluate(({index, at}) => {
  const item = [...document.querySelectorAll("li")][index];
  const content = document.getElementById("content");
  content.focus();
  const range = document.createRange();
  const text = [...item.childNodes].find((node) => node.nodeType === 3);
  if (text) range.setStart(text, at === "start" ? 0 : text.nodeValue.length);
  else { range.selectNodeContents(item); range.collapse(true); }
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}, {index, at});

test("Backspace in an empty item splits the list instead of merging into the item above", async ({page}) => {
  await boot(page);

  await reset(page, "<ul><li>alpha</li><li><br></li><li>charlie</li></ul>");
  await caretInItem(page, 1);
  await page.keyboard.press("Backspace");
  await settle(page);
  let after = await state(page);
  /* The empty line becomes a paragraph, and the list is split around it. Native
     Backspace would merge it into "alpha" and resurrect that item's text. */
  expect(after.children).toEqual(["ul", "p", "ul"]);
  expect(await page.evaluate(() => [...document.querySelectorAll("#content > ul")].map((ul) => ul.textContent))).toEqual(["alpha", "charlie"]);
  expect(await caretBlock(page)).toBe("p");
  expect(await page.evaluate(() => document.querySelector("#content > p").textContent)).toBe("");
  /* Typing in the paragraph does not continue the list. */
  await page.keyboard.type("between");
  await settle(page);
  expect(await page.evaluate(() => document.querySelector("#content > p").textContent)).toBe("between");

  /* The tail of a split `<ol>` continues numbering. */
  await reset(page, '<ol start="4"><li>alpha</li><li><br></li><li>charlie</li></ol>');
  await caretInItem(page, 1);
  await page.keyboard.press("Backspace");
  await settle(page);
  after = await state(page);
  expect(after.children).toEqual(["ol", "p", "ol"]);
  expect(await page.evaluate(() => [...document.querySelectorAll("#content > ol")].map((list) => list.getAttribute("start")))).toEqual(["4", "6"]);

  /* The only item: the list goes away and a paragraph is left. */
  await reset(page, "<ul><li><br></li></ul>");
  await caretInItem(page, 0);
  await page.keyboard.press("Backspace");
  await settle(page);
  expect((await state(page)).children).toEqual(["p"]);

  /* A non-empty item keeps the engine's behaviour: one character, list intact. */
  await reset(page, "<ul><li>alpha</li><li>bravo</li></ul>");
  await caretInItem(page, 1);
  await page.keyboard.press("Backspace");
  await settle(page);
  after = await state(page);
  expect(after.children).toEqual(["ul"]);
  expect(await page.evaluate(() => document.querySelectorAll("li")[1].textContent)).toBe("brav");
});

/* ---------------------------------------------------- Tab keeps the caret on the item */

test("Tab keeps the caret on the item it nests, including an empty one", async ({page}) => {
  await boot(page);

  /* Empty item: the block offset is ambiguous (an empty item adds no text), which used to
     restore the caret to the end of the previous item. */
  await reset(page, "<ul><li>alpha</li><li>bravo</li><li><br></li></ul>");
  await caretInItem(page, 2);
  await page.keyboard.press("Tab");
  await settle(page);
  expect(await page.evaluate(() => document.querySelectorAll("#content ul ul li").length)).toBe(1);
  expect(await page.evaluate(() => {
    const node = window.getSelection().anchorNode;
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    return el?.closest("li")?.textContent ?? null;
  })).toBe("");
  /* Typing goes into the nested item, not into "bravo". */
  await page.keyboard.type("nested");
  await settle(page);
  expect(await page.evaluate(() => document.querySelector("#content ul ul li").textContent)).toBe("nested");

  /* Item at offset 0: the same ambiguity, now for a non-empty item. */
  await reset(page, "<ul><li>alpha</li><li>bravo</li></ul>");
  await caretInItem(page, 1, "start");
  await page.keyboard.press("Tab");
  await settle(page);
  expect(await page.evaluate(() => {
    const node = window.getSelection().anchorNode;
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    return el?.closest("li")?.textContent ?? null;
  })).toBe("bravo");
  await page.keyboard.type("X");
  await settle(page);
  expect(await page.evaluate(() => document.querySelector("#content ul ul li").textContent)).toBe("Xbravo");
});

/* ------------------------------------------- the shortcut in wrappers and quotes */

test("the list shortcut also works in a div, inside a div, and in a quote", async ({page}) => {
  await boot(page);

  /* A one-character marker + the space is the exact moment the shortcut fires. Placing the
     marker in the DOM is how a legacy document or a wrapper reaches that state. */
  const fire = async (html, selector) => {
    await page.evaluate(({html, selector}) => {
      const content = document.getElementById("content");
      content.innerHTML = html;
      globalThis.StandaloneDoc.modules.pagination.refresh();
      content.focus();
      const host = content.querySelector(selector);
      const text = host.firstChild;
      const range = document.createRange();
      range.setStart(text, text.nodeValue.length);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, {html, selector});
    await settle(page);
    await page.keyboard.press(" ");
    await settle(page);
    return state(page);
  };

  /* A legacy `<div>` block is a text block in the model, so the marker becomes a list. */
  expect((await fire("<div>-</div>", "div")).children).toEqual(["ul"]);
  /* A paragraph inside a wrapper: the list is made in the paragraph and normalization
     lifts it out of the container. */
  expect((await fire("<div><p>-</p></div>", "p")).children).toEqual(["ul"]);
  /* A quote keeps being a quote; the list is inside it. */
  const quote = await fire("<blockquote>-</blockquote>", "blockquote");
  expect(quote.children).toEqual(["blockquote"]);
  expect(await page.evaluate(() => document.querySelector("#content blockquote > ul li") != null)).toBe(true);

  /* A non-breaking space is still the shortcut's space (some layouts and line ends). */
  await page.evaluate(() => {
    const content = document.getElementById("content");
    content.innerHTML = "<p>-</p>";
    globalThis.StandaloneDoc.modules.pagination.refresh();
    content.focus();
    const text = content.querySelector("p").firstChild;
    const range = document.createRange();
    range.setStart(text, 1);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    content.dispatchEvent(new InputEvent("beforeinput", {
      inputType: "insertText", data: "\u00a0", bubbles: true, cancelable: true,
    }));
  });
  await settle(page);
  expect((await state(page)).children).toEqual(["ul"]);
});

/* ---------------------------------------------------------------------- tables */

test("a table inserts with a grid, a caret in a cell, and Tab that walks it", async ({page}) => {
  await boot(page);

  /* Through the menu and the dialog: the path a reader takes. */
  await page.locator('#ui-ribbon .menu-trigger', {hasText: "Insert"}).click();
  await page.click("[data-table-open]");
  await page.waitForFunction(() => document.getElementById("table-dialog")?.open === true);
  await page.fill("[data-table='rows']", "2");
  await page.fill("[data-table='cols']", "3");
  await page.click('#table-dialog button[value="insert"]');
  await settle(page);

  const shape = await page.evaluate(() => {
    const content = document.getElementById("content");
    const table = content.querySelector("table");
    const cell = window.getSelection().anchorNode;
    const el = cell?.nodeType === 1 ? cell : cell?.parentElement;
    const computed = getComputedStyle(table.querySelector("td"));
    return {
      tables: content.querySelectorAll("table").length,
      rows: table.rows.length,
      cols: table.rows[0].cells.length,
      headerCells: table.tHead?.rows[0]?.cells.length ?? 0,
      caretInCell: Boolean(el?.closest("td, th")),
      after: table.nextElementSibling?.localName ?? null,
      border: computed.borderTopStyle,
      kind: globalThis.StandaloneDoc.modules.pagination.strategy(table).kind,
      pages: globalThis.StandaloneDoc.modules.pagination.pageCount(),
      check: globalThis.StandaloneDoc.modules.pagination.diagnostics().check?.ok,
    };
  });
  expect(shape).toMatchObject({
    tables: 1, rows: 2, cols: 3, headerCells: 3, caretInCell: true,
    after: "p", border: "solid", kind: "atomic", check: true,
  });

  /* Tab walks cells; Tab in the last one appends a row. */
  const cellAt = () => page.evaluate(() => {
    const table = document.querySelector("#content table");
    const node = window.getSelection().anchorNode;
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    const cell = el?.closest("td, th");
    if (!cell) return null;
    return `${[...table.rows].indexOf(cell.parentElement)}:${[...cell.parentElement.cells].indexOf(cell)}`;
  });
  await page.keyboard.press("Tab");
  expect(await cellAt()).toBe("0:1");
  await page.keyboard.press("Tab");
  expect(await cellAt()).toBe("0:2");
  await page.keyboard.press("Tab");
  expect(await cellAt()).toBe("1:0");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  expect(await cellAt()).toBe("2:0");
  expect(await page.evaluate(() => document.querySelector("#content table").rows.length)).toBe(3);
  /* A row was added by a document change, so it is one of the model's own edits. */
  expect(await page.evaluate(() => globalThis.StandaloneDoc.modules.pagination.diagnostics().check?.ok)).toBe(true);
});
