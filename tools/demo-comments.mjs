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
const CONTENT = `        <h1>On keeping a document whole</h1>
        <p>A single HTML file can hold its own styles, its figures and its runtime, and still be
          read by someone who has never heard of this project. That is the promise this editor
          keeps: the file is the document, and the document is the file.</p>
        <h2>What travels</h2>
        <p>Text first, and the structure a reader needs to follow it. Then the evidence: the
          figures, the tables, the small typographic decisions that make a page readable. A
          comment is part of that evidence — it is why a sentence changed, kept next to the
          sentence rather than in a mail thread nobody can find again.</p>
        <p>A long paragraph is where a paged document earns its keep. It has to cross a page
          boundary without becoming two paragraphs, and the reviewer has to be able to point at
          the sixth line of the second page without the anchor drifting when the first page
          reflows. Fragments, one coordinate and a quotation are how that is managed; none of
          it reaches the saved file.</p>
        <h2>What a reader may do</h2>
        <p>A reader opens the file and the file decides. This copy is the editor: the text is
          yours. The copy you make from it can be a review copy, where the text is locked and
          the comments are not, or a viewer, where nothing writes at all.</p>
        <p>Comments are content, so they travel with every copy. What differs is the
          capability: who may add one, who may only read, and whether the copy carries the
          address of an editor it could become.</p>`;

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

      const point = (block, offset) => {
        const el = content.children[block];
        if (!el) return null;
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
      const comment = (from, to, body) => {
        const start = point(from[0], from[1]);
        const end = point(to[0], to[1]);
        if (!start || !end) return null;
        getSelection().setBaseAndExtent(start.node, start.offset, end.node, end.offset);
        return comments.add({body, author: {name: "Nadia", kind: "author"}});
      };

      comment([0, 0], [0, 21], "The title says “whole”, the first paragraph says “promise”. Pick one word and let the other paragraph carry it.");
      comment([1, 0], [2, 18], "This crosses a heading on purpose: a review comment can name a range over two blocks, and the anchor still lands after an edit.");
      const third = comment([4, 0], [4, 31], "Resolved below: the third paragraph now says what a reader may do.");
      if (third) comments.resolve(third.id, true);
      getSelection().removeAllRanges();

      /* The demo panel is session chrome: it carries the strip list's marker, so a copy
         saved from here does not carry the instructions. */
      const panel = document.createElement("aside");
      panel.dataset.pluginUi = "";
      panel.style.cssText = [
        "position:fixed", "right:16px", "bottom:16px", "z-index:80", "width:320px",
        "padding:12px 14px", "background:#fff", "color:#1b1f24", "border:1px solid #dfe1e6",
        "border-radius:10px", "box-shadow:0 10px 30px rgba(15,23,42,.18)",
        "font:13px/1.45 system-ui", "white-space:normal",
      ].join(";");
      const title = document.createElement("p");
      title.style.cssText = "margin:0 0 6px;font-weight:700";
      title.textContent = "Comments demo";
      const steps = document.createElement("ol");
      steps.style.cssText = "margin:0 0 8px;padding-left:18px";
      for (const line of [
        "Click a highlight to read the thread; Resolve and Reply are live.",
        "File › Save as… › HTML › Save a copy for someone… — pick Review, keep comments, tick “may take an editable copy”.",
        "Open the downloaded file. The text is locked; add a comment, then Save a copy.",
        "File › Import comments… in this document, and pick that file: the list shows what arrived, and a disagreement is yours to settle.",
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
      button("Hide", () => panel.remove());
      panel.append(title, steps, row);
      document.body.append(panel);

      /* The seeder has done its job; it must not travel into a saved copy. */
      document.currentScript?.remove();
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
const injected = withContent.slice(0, at) + `<script>\n${seed}\n<\/script>\n` + withContent.slice(at);
fs.mkdirSync(path.dirname(OUT), {recursive: true});
fs.writeFileSync(OUT, injected);
const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(`demo: wrote ${path.relative(ROOT, OUT)} (${kb(Buffer.byteLength(injected))})`);
console.log("demo: three comments are seeded at load; the panel does the two exports.");
console.log("demo: run  npm run dev  and open");
console.log("        http://127.0.0.1:8080/.test-tmp/comments-demo.html");
console.log("demo: served over http, the page pins dist/cdn on this origin, so “Edit a copy…” works offline-of-CDN.");
