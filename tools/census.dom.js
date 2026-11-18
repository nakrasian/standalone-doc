/* audit.dom.js — what the document *says* it contains, read from the DOM.
 *
 * Classic script, not a module: it must run unchanged inside
 *   - the browser probe (a <script src> tag)
 *   - Playwright, as the CLI's DOM (page.addScriptTag({path}))
 *
 * The census is deliberately dumb. It counts constructs, not meaning, because the
 * thing it is compared against (the AST) also only counts constructs. If both sides
 * count honestly, a difference means something was lost in the conversion — which is
 * the whole point of an audit.
 *
 * Keys must match the CENSUS table in audit.mjs. A key that exists on one side and
 * not the other shows up in the report as "—", so drift is visible, not silent.
 */
(function () {
  function wordCount(root) {
    /* Text that a writer would actually emit: not the chrome, not the settings
       blocks, and with whitespace normalised so indentation is not "content". */
    const clone = (root.nodeType === 9 ? root.documentElement : root).cloneNode(true);
    clone.querySelectorAll && clone.querySelectorAll(
      "script, style, #sheets, #probe, #app-toolbar, #viewer-bar, [data-runtime]"
    ).forEach((n) => n.remove());
    const text = (clone.textContent || "").replace(/\s+/g, " ").trim();
    return text ? text.split(" ").length : 0;
  }

  globalThis.sdCensusDom = function (root) {
    root = root || document;
    const q = (sel) => root.querySelectorAll(sel);
    return {
      headings: q("h1, h2, h3, h4").length,
      paragraphs: q("p").length,
      listItems: q("li").length,
      tables: q("table").length,
      tableRows: q("table tr").length,
      figures: q("figure.figure, figure").length,
      images: q("img").length,
      pageBreaks: q(".page-spacer").length,
      links: q("a[href]").length,
      placeholderLinks: q('a[href="#"], a[href=""]').length,
      underline: q("u").length,
      codeBlocks: q("pre").length,
      quotes: q("blockquote").length,
      emptyParagraphs: [...q("p")].filter((p) => !p.textContent.trim() && !p.querySelector("img")).length,
      words: wordCount(root),
    };
  };
})();
