#!/usr/bin/env node
/* tools/demo-comments.mjs — a document with comments, to click through by hand.
 *
 *   npm run demo:comments      writes .test-tmp/comments-demo.html and prints the URL
 *   npm run dev                (in another shell) serve it, then open the URL
 *
 * The demo is the real editor with three comments seeded at load, and a small panel that
 * does the two exports a review round-trip uses. Nothing is stubbed: the comments go
 * through `comments.add()` the way a selection does, and the copies come from the same
 * `toolbar.copy()` the dialog calls.
 *
 * When the page is served over http (as `npm run dev` serves it), it re-points its own
 * asset manifest at `dist/cdn` on this origin. That is what makes "Edit a copy…" work
 * locally: the copy pins bytes this working tree has, not the bytes of the last release.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".test-tmp/comments-demo.html");

/* The source document is deliberately tiny; a demo needs prose to comment on, and a
   paragraph long enough to cross a page boundary. This is the only edit to the content. */
const LONG = Array.from({ length: 7 }, (_, i) => `Page ${i + 1}. A paged document has to keep its place while the reader edits, and a comment has to keep its words while the pages move under it. The anchor is a range over the text stream, so a page break inside this paragraph changes nothing about what the comment names — the highlight is recomputed per page, from the text, every time the plan changes.`).join(" ");
const CONTENT = `        <h1>On keeping a document whole</h1>
        <p>A single HTML file can hold its own styles, its figures and its runtime, and still be
          read by someone who has never heard of this project. That is the promise this editor
          keeps: the file is the document, and the document is the file.</p>
        <h2>What travels</h2>
        <p>Text first, and the structure a reader needs to follow it. Then the evidence: the
          figures, the tables, the small typographic decisions that make a page readable. A
          comment is part of that evidence — it is why a sentence changed, kept next to the
          sentence rather than in a mail thread nobody can find again.</p>
        <p class="demo-long">${LONG}</p>
        <h2>What a reader may do</h2>
        <p>A reader opens the file and the file decides. This copy is the editor: the text is
          yours. The copy you make from it can be a review copy, where the text is locked and
          the comments are not, or a viewer, where nothing writes at all.</p>
        <h2>What a reviewer may do</h2>
        <p>Comments are content, so they travel with every copy. What differs is the
          capability: who may add one, who may only read, and whether the copy carries the
          address of an editor it could become.</p>
        <p>Resolving a comment is not deleting it. The highlight goes away, the record stays
          in the list beside the page, and either the author reopens it or the reviewer
          deletes it — with the delete button, which is the only destructive action here.</p>`;

const seed = `(() => {
  const EXT = {js: "js", css: "css", html: "html"};
  const origin = location.origin + "/dist/cdn";

  /* Local pins, so a copy made here can adopt the editor from this tree. */
  try {
    const block = document.getElementById("asset-manifest");
    const manifest = JSON.parse(block.textContent);
    if (/^https?:$/.test(location.protocol)) {
      manifest.cdnBase = origin;
      for (const asset of manifest.assets) {
        if (asset.url) asset.url = origin + "/" + asset.id + "." + (EXT[asset.kind] || "js");
      }
      block.textContent = JSON.stringify(manifest);
    }
  } catch (error) {
    console.warn("demo: could not repoint the manifest", error);
  }

  const until = (test, run) => {
    if (test()) return run();
    setTimeout(() => until(test, run), 100);
  };

  until(
    () => globalThis.StandaloneDoc && globalThis.StandaloneDoc.state === "ready",
    () => {
      const comments = StandaloneDoc.modules.comments;
      if (!comments) {
        console.error("demo: this document has no comments capability");
        return;
      }
      const content = document.getElementById("content");
      if (!content || content.children.length < 2) {
        console.error("demo: the document has no blocks to comment on");
        return;
      }
      const settings = document.getElementById("doc-settings");
      const parsed = JSON.parse(settings.textContent);
      parsed.author = "Nadia";
      settings.textContent = JSON.stringify(parsed);

      /* The same clamp the app uses: an offset past the block's text lands at the end of
         its last text node, not at the start of the element. */
      const point = (block, offset) => {
        const el = content.children[block];
        if (!el) return null;
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
        return last ? {node: last, offset: last.nodeValue.length} : null;
      };
      const comment = (from, to, body) => {
        const start = point(from[0], from[1]);
        const end = point(to[0], to[1]);
        if (!start || !end) return null;
        getSelection().setBaseAndExtent(start.node, start.offset, end.node, end.offset);
        return comments.add({body, author: {name: "Nadia", kind: "author"}});
      };

      /* One range inside a heading, one across a block boundary, one across the page
         break inside the long paragraph, and one already resolved. */
      comment([0, 0], [0, 21], "The title says “whole”, the first paragraph says “promise”. Pick one word and let the other paragraph carry it.");
      comment([1, 0], [2, 12], "This crosses a heading on purpose: a review comment can name a range over two blocks, and the anchor still lands after an edit.");
      comment([4, 120], [4, 640], "This one crosses the page break inside the long paragraph. The highlight is per page and the anchor is one range, so it survives a re-plan — resize the window and watch it re-measure.");
      comment([6, 0], [6, 42], "A second comment on the reader's paragraph, so the rail has two cards in document order.");
      const done = comment([9, 0], [9, 35], "Resolved below: the numbers now match the table.");
      if (done) comments.resolve(done.id, true);
      getSelection().removeAllRanges();

      /* The demo panel is session chrome: it carries the strip list's marker, so a copy
         saved from here does not carry the instructions. */
      const panel = document.createElement("aside");
      panel.dataset.pluginUi = "";
      /* Collapsed by default: the demo is for the document, and a wall of instructions
         over the page is the opposite of a demo. The pill is the way in. */
      panel.style.cssText = [
        "position:fixed", "left:16px", "bottom:16px", "z-index:80", "width:300px",
        "padding:12px 14px", "background:#fff", "color:#1b1f24", "border:1px solid #dfe1e6",
        "border-radius:10px", "box-shadow:0 10px 30px rgba(15,23,42,.18)",
        "font:13px/1.45 system-ui", "white-space:normal", "display:none",
      ].join(";");
      const pill = document.createElement("button");
      pill.type = "button";
      pill.dataset.pluginUi = "";
      pill.textContent = "Demo steps";
      pill.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:80;padding:6px 12px;border:1px solid #dfe1e6;border-radius:999px;background:#fff;box-shadow:0 4px 14px rgba(15,23,42,.12);font:600 12px system-ui;color:#1b1f24;cursor:pointer";
      pill.addEventListener("click", () => {
        panel.style.display = "";
        pill.style.display = "none";
      });
      const title = document.createElement("p");
      title.style.cssText = "margin:0 0 6px;font-weight:700";
      title.textContent = "Comments demo";
      const steps = document.createElement("ol");
      steps.style.cssText = "margin:0 0 8px;padding-left:18px";
      for (const line of [
        "Hover a highlight to preview its card; click to pin it until you click away. Cards are beside the page, one per comment, unresolved first.",
        "Select text and press ⌘⌥M (Ctrl+Alt+M) to comment without the menu.",
        "Resolved comments keep no highlight: reopen or delete them from the rail.",
        "File › Save as… › HTML › Save a copy for someone… — pick Review, keep comments, tick “may take an editable copy”; open the download and add a comment.",
        "File › Import comments… in this document and pick that copy: the list shows what arrived.",
      ]) {
        const item = document.createElement("li");
        item.textContent = line;
        steps.append(item);
      }
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
      const button = (label, run) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.style.cssText = "font:12px system-ui;padding:4px 9px;border:1px solid #dfe1e6;border-radius:6px;background:#fff;cursor:pointer";
        b.addEventListener("click", run);
        row.append(b);
      };
      button("Review copy", () => StandaloneDoc.modules.toolbar.copy({kind: "review", comments: true, editCopy: true, policy: "inline"}));
      button("Comments only", () => StandaloneDoc.modules.toolbar.exportCommentsOnly());
      button("Hide", () => {
        panel.style.display = "none";
        pill.style.display = "";
      });
      panel.append(title, steps, row);
      document.body.append(panel, pill);
      /* Seeding focuses each new comment, which scrolls the rail; leave it at the top. */
      const rail = document.getElementById("comment-rail");
      if (rail) rail.scrollTop = 0;

      /* The seeder has done its job. It is marked data-plugin-ui, so session.strip()
         removes it from a saved copy; removing it here keeps the live DOM honest too. */
      document.getElementById("comments-demo")?.remove();
    },
  );
})();`;

/* The *last* closing body tag: the document's own runtime source contains that string
   inside modules that build HTML (the static exporter, for one), and injecting at the
   first match lands in the middle of a script. */
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const withContent = html.replace(/(<article id="content"[^>]*>)([\s\S]*?)(<\/article>)/, (match, open, body, close) => open + "\n" + CONTENT + "\n      " + close);
const at = withContent.lastIndexOf("</body>");
if (at < 0) throw new Error("demo: no </body> to inject before");
const injected = withContent.slice(0, at)
  + `<script id="comments-demo" data-plugin-ui>\n${seed}\n<\/script>\n`
  + withContent.slice(at);
fs.mkdirSync(path.dirname(OUT), {recursive: true});
fs.writeFileSync(OUT, injected);
const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(`demo: wrote ${path.relative(ROOT, OUT)} (${kb(Buffer.byteLength(injected))})`);
console.log("demo: three comments are seeded at load; the panel does the two exports.");
console.log("demo: run  npm run dev  and open");
console.log("        http://127.0.0.1:8080/.test-tmp/comments-demo.html");
console.log("demo: served over http, the page pins dist/cdn on this origin, so “Edit a copy…” works offline-of-CDN.");
