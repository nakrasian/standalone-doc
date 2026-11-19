/* citations — inline citations and a bibliography, as a plugin.
 *
 * The whole feature lives here, not in the runtime: the mark, the picker, the parsers, the
 * bibliography. The core gained exactly two generic things for it (lab/017):
 *
 *   data-atomic            a cut may not land inside this inline element (pagination.js)
 *   editor.insertInline()  insert an inline atomic at the caret, one history entry (editor.js)
 *
 * Both are useful to any plugin and neither knows what a citation is. That is the whole
 * reason this can be a plugin at all.
 *
 * **It degrades.** A document with citations is readable with this plugin absent, and that
 * is a design property, not luck:
 *
 *   - the label is *derived but saved* — `[3]`, `(Smith, 2020)` — so the mark is ordinary
 *     text in a link with no plugin running;
 *   - the bibliography is a **saved block** (`<section id="bibliography" data-generated>`),
 *     not something rendered by this code, so a reader who never loads the plugin still
 *     reads the reference list;
 *   - the stylesheet is written into `<head>` as `<style data-plugin-style="citations">` and
 *     travels in the file — a plugin may contribute document-level CSS that must survive a
 *     save, and this is the first one that does. It is *not* `data-runtime="ephemeral"`;
 *   - the store is a JSON block beside `#figure-store`, so a later activation re-derives
 *     everything and repairs whatever a session without the plugin left behind.
 *
 * What does not degrade is renumbering: without the plugin the numbers are a snapshot. That
 * is the honest boundary — a reader sees a correct document; only an editor with the plugin
 * can renumber it.
 *
 * Storage is **cited entries only**. The imported library is a session pool: a document
 * should not carry 400 references to render three. A citation whose key is not in the store
 * renders as a visible `?` rather than a plausible wrong number.
 */

/* The stylesheet. Written into the document, not an asset: a plugin's CSS has to be in the
   file or a reader without the plugin gets unstyled links. Idempotent by id.
   Not named `CSS`: a module-level binding of that name shadows the global `CSS` object for
   every function in this file, and `CSS.escape` then reads as "is not a function". */
const STYLE_ID = "citation-styles";
const STORE_ID = "citation-store";
const STYLE_TEXT = `
a.cite {
  color: #1a4d8f;
  text-decoration: none;
  border-bottom: 1px solid rgba(26, 77, 143, .35);
  padding: 0 1px;
  border-radius: 2px;
}
a.cite:hover, a.cite.is-cite-hot { background: rgba(26, 77, 143, .13); }
a.cite[data-missing] {
  color: #a12b2b;
  border-bottom-color: rgba(161, 43, 43, .45);
  background: rgba(161, 43, 43, .07);
}
#bibliography {
  margin-top: 2.2em;
  padding-top: .9em;
  border-top: 1px solid #d8d5cf;
  font-size: .92em;
  text-align: left;
  hyphens: none;
}
#bibliography > h2 {
  font-size: .78em;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: #6b6b76;
  margin: 0 0 .9em;
  font-weight: 600;
}
#bibliography ol { margin: 0; padding-inline-start: 1.7em; }
#bibliography ol > li { margin: 0 0 .55em; padding-inline-start: .2em; }
#bibliography .bib-entry {
  margin: 0 0 .55em;
  padding-inline-start: 2em;
  text-indent: -2em;
  break-inside: avoid;
  border-radius: 3px;
}
#bibliography .bib-entry.is-cite-hot { background: rgba(26, 77, 143, .1); }
#bibliography .bib-entry[data-missing] { color: #a12b2b; }
#bibliography .bib-key {
  font: .72em/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #8a8a94;
  margin-inline-start: .45em;
}
`;

/* The panel's stylesheet. **Session chrome**, not document state: it styles the References
   dialog, which never reaches a file, so it is tagged `data-plugin-ui` and removed with the
   dialog. (`STYLE_TEXT` above is the opposite case — saved, because a reader without the
   plugin needs it.) The `cp-*` names are the plugin's own: `.ds-*` belongs to the document
   settings dialog and is scoped to it, which is why reusing those classes rendered nothing. */
const PANEL_CSS = `
.cp-lede { color: #6b6b76; margin: 0 0 10px; }
.cp-row { display: flex; align-items: center; gap: 10px; padding: 5px 0; }
.cp-row > .cp-grow { flex: 1 1 auto; }
.cp-label { font-weight: 500; }
.cp-chips { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.cp-chip {
  height: 26px; padding: 0 9px; font: inherit; font-size: 12px; cursor: pointer;
  border: 1px solid #dfe1e6; border-radius: 7px; background: #fff; color: #1b1f24;
}
.cp-chip:hover { border-color: #1a4d8f; color: #1a4d8f; }
.cp-chip[aria-pressed="true"] { background: #1a4d8f; border-color: #1a4d8f; color: #fff; }
.cp-chip.primary { background: #1a4d8f; border-color: #1a4d8f; color: #fff; }
.cp-sep { border-top: 1px solid #ecebe7; margin: 14px 0; }
.cp-hint { color: #6b6b76; font-size: 12px; margin: 6px 0; }
.cp-hint code { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: #f4f3f0; padding: 1px 4px; border-radius: 3px; }
.cp-input, .cp-import {
  width: 100%; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  border: 1px solid #dfe1e6; border-radius: 7px; padding: 6px 8px; background: #fff; color: #1b1f24;
}
.cp-import { min-height: 84px; resize: vertical; margin-top: 6px; }
.cp-out { color: #6b6b76; font-size: 12px; margin: 8px 0 0; min-height: 16px; }
.cp-list { list-style: none; margin: 8px 0 0; padding: 0; max-height: 208px; overflow: auto; border-top: 1px solid #ecebe7; }
.cp-list li { display: grid; grid-template-columns: 1fr auto; gap: 10px; padding: 5px 2px; border-bottom: 1px solid #f2f1ee; align-items: baseline; }
.cp-list .cp-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-list .cp-meta { color: #6b6b76; font-size: 11px; white-space: nowrap; }
.cp-list .cp-cited { color: #1a4d8f; font-weight: 600; }
.cp-conflict { border: 1px solid #f0d9b5; background: #fffaf0; border-radius: 8px; padding: 8px 10px; margin: 10px 0; }
.cp-conflict + .cp-conflict { margin-top: 6px; }
.cp-conflict .cp-what { font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #6b6b76; }
.cp-conflict .cp-what b { color: #1b1f24; font-weight: 600; }
.cp-conflict .cp-chips { margin-top: 6px; }
`;

/* The picker. `data-plugin-ui` is what makes `session.strip()` drop it on save; without it a
   saved document would carry a floating dialog. */
const POP_STYLE = `
position: fixed; z-index: 60; width: 380px; background: #fff; color: #1b1b1f;
border: 1px solid #d8d6d1; border-radius: 10px;
box-shadow: 0 10px 30px rgba(0,0,0,.16), 0 2px 6px rgba(0,0,0,.06);
font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
overflow: hidden;
`.replace(/\s*\n\s*/g, " ");

export function createCitations() {
  return {
    async activate(host) {
      const doc = document;
      const content = doc.getElementById("content");
      if (!content) return {}; /* a flavour without a document body: nothing to do */

      const registry = globalThis.StandaloneDoc;
      const writable = host.settings().capabilities?.edit !== "off" && host.settings().mode !== "view";
      const editor = host.can("editor") ? host.use("editor") : null;
      const status = host.can("status") ? host.use("status") : null;
      const planner = host.can("pagination") ? host.use("pagination") : null;

      /* `entries` travels with the document; `pool` is this session's imported library. */
      let entries = {};
      let pool = {};
      let style = "numeric";
      /* `off` · `cited` · `all`. In the store because it is a decision about the document,
         not a preference of this session: a reader must see the list the author chose. */
      let bibliography = "cited";

      const lookup = (key) => entries[key] || pool[key] || null;
      const marks = () => [...content.querySelectorAll("a.cite")];
      const keysOf = (mark) => (mark.dataset.keys || "").split(" ").filter(Boolean);
      const citedKeys = () => [...new Set(marks().flatMap(keysOf))];
      const librarySize = () => new Set([...Object.keys(entries), ...Object.keys(pool)]).size;

      /* ---------------------------------------------------------------- the stylesheet */

      function ensureStyle() {
        let el = doc.getElementById(STYLE_ID);
        if (!el) {
          el = doc.createElement("style");
          el.id = STYLE_ID;
          /* Not ephemeral: this is document state, and a reader without the plugin needs it. */
          el.dataset.pluginStyle = "citations";
          doc.head.append(el);
        }
        if (el.textContent !== STYLE_TEXT) el.textContent = STYLE_TEXT;
        return el;
      }

      /* -------------------------------------------------------------------- the store */

      function readStore() {
        const el = doc.getElementById(STORE_ID);
        if (!el) return;
        try {
          const stored = JSON.parse(el.textContent || "{}");
          if (stored.schema !== 1) return;
          entries = stored.entries && typeof stored.entries === "object" ? stored.entries : {};
          if (typeof stored.style === "string") style = stored.style;
          if (["off", "cited", "all"].includes(stored.bibliography)) bibliography = stored.bibliography;
        } catch {
          /* A corrupt block is boot's problem, not this plugin's: an empty store is a
             document whose marks show `?`, which is the visible failure we want. */
        }
      }

      function writeStore() {
        const cited = citedKeys();
        const kept = {};
        for (const key of cited) {
          const entry = entries[key] || pool[key];
          if (entry) kept[key] = entry;
        }
        entries = kept;
        if (!cited.length && !Object.keys(entries).length && bibliography === "cited"
          && !doc.getElementById(STORE_ID)) return;
        let el = doc.getElementById(STORE_ID);
        if (!el) {
          el = doc.createElement("script");
          el.type = "application/json";
          el.id = STORE_ID;
          doc.body.append(el);
        }
        const next = JSON.stringify({schema: 1, style, bibliography, entries});
        if (el.textContent !== next) el.textContent = next;
      }

      /* ------------------------------------------------------------------- the labels */

      /* The label, the reference line and the ordering are **pure functions of
         (keys, style, store)** — exported at the foot of this file, imported by
         `lab/017`'s tests, and therefore tested as the bytes that ship. Nothing in this
         closure computes a label; it only supplies the store and the document's numbers.

         `entries` wins over `pool` in `library()`: the document's copy is what a reader
         sees, which is why an import cannot change a cited reference by itself. */
      const library = () => ({...pool, ...entries});
      const numbers = () => numberKeys(marks().map(keysOf), {store: library()});
      const label = (keys, map) => labelFor(keys, style, library(), map);

      /* -------------------------------------------------------------- the bibliography */

      /**
       * The bibliography is a **block in the flow**, appended, never inserted through the
       * editor: it is derived (`data-generated`), so it is not an author's block and not an
       * undo step. `signals` observes `#content`, so pagination re-plans on its own.
       *
       * A reference list longer than a page has to fragment, which is what `section` does
       * not mean by default (an unknown tag is atomic). `defineBlock` is the planner's own
       * seam, so this asks for it — but only in a document that uses no other `section`,
       * because the strategy table is keyed by tag, not by element.
       */
      function renderBibliography() {
        const section = doc.getElementById("bibliography");
        if (bibliography === "off") {
          /* Off means *not in the document*: the section is content, so leaving an empty one
             behind would be a stray block an author cannot get rid of. */
          section?.remove();
          return;
        }
        const cited = citedKeys();
        const keys = bibliography === "all" ? [...new Set([...Object.keys(entries), ...Object.keys(pool)])] : cited;
        if (!keys.length && !section) return;
        if (planner) {
          const others = content.querySelectorAll("section:not(#bibliography)").length;
          if (!others) planner.defineBlock("section", {kind: "lines", minLines: 2, keepWithNext: false});
        }
        const target = section || doc.createElement("section");
        target.id = "bibliography";
        target.setAttribute("contenteditable", "false");
        target.dataset.generated = "";

        const ordered = bibOrder(keys, style, library());
        const items = ordered.map((key) => {
          const entry = lookup(key);
          const body = entry
            ? `<a href="#cite-${escapeAttr(key)}">${escapeHtml(entryLine(key, style, library()))}</a>`
            + `<span class="bib-key">${escapeHtml(key)}</span>`
            : `<span>${escapeHtml(key)} — not in this document's library</span>`;
          const attrs = `id="bib-${escapeAttr(key)}" data-key="${escapeAttr(key)}"${entry ? "" : " data-missing"}`;
          return style === "author-date"
            ? `<div class="bib-entry" ${attrs}>${body}</div>`
            : `<li ${attrs}>${body}</li>`;
        }).join("");
        target.innerHTML = `<h2>References</h2>${style === "author-date" ? items : `<ol>${items}</ol>`}`;

        if (!section) content.append(target);
        else if (content.lastElementChild !== target) content.append(target);
      }

      /* ---------------------------------------------------------------- relabel, write */

      /**
       * Recompute every derived thing from the store. Idempotent, and safe to call on load,
       * on input, after an insert, and after an undo — which is why nothing else in this
       * plugin is allowed to touch a label or an entry.
       */
      function relabel() {
        const numberMap = numbers();
        for (const mark of marks()) {
          const keys = keysOf(mark);
          const text = label(keys, numberMap);
          if (mark.textContent !== text) mark.textContent = text;
          if (keys.length && mark.getAttribute("href") !== `#bib-${keys[0]}`) mark.setAttribute("href", `#bib-${keys[0]}`);
          /* An unbreakable mark carries no `id`: pagination's older guard moves a block
             whole when a cut lands inside an element with an id, and that guard must not
             catch a citation. `data-atomic` is the rule that keeps it in one piece. */
          if (mark.id) mark.removeAttribute("id");
          mark.setAttribute("data-atomic", "");
          mark.setAttribute("contenteditable", "false");
          mark.toggleAttribute("data-missing", keys.some((key) => !lookup(key)));
        }
        renderBibliography();
        writeStore();
        status?.refresh();
      }

      /* ------------------------------------------------------------------- the picker */

      const pop = doc.createElement("div");
      pop.dataset.pluginUi = "";
      pop.dataset.runtime = "ephemeral";
      /* Its own hook: `data-plugin-ui` is shared with the host's panel dialogs and the
         comment overlay, so a lab cannot select "the picker" by it. */
      pop.dataset.citationPicker = "";
      pop.setAttribute("role", "dialog");
      pop.setAttribute("aria-label", "Insert citation");
      pop.style.cssText = POP_STYLE + " display: none;";
      pop.innerHTML = `
        <input type="text" data-cite-filter placeholder="Filter references…" autocomplete="off"
               spellcheck="false" role="combobox" aria-expanded="true" aria-controls="cite-list"
               style="width:100%;border:0;border-bottom:1px solid #e2e0dc;padding:9px 11px;font:13px/1.3 inherit;outline:none">
        <ul id="cite-list" role="listbox" style="list-style:none;margin:0;padding:4px;max-height:280px;overflow:auto"></ul>
        <div data-cite-foot style="border-top:1px solid #e2e0dc;padding:5px 10px;display:flex;gap:10px;color:#6b6b76;font-size:11px">
          <span>↑↓ choose</span><span>↵ insert</span><span>esc cancel</span>
          <span data-cite-count style="margin-left:auto"></span>
        </div>`;
      doc.body.append(pop);
      const filter = pop.querySelector("[data-cite-filter]");
      const list = pop.querySelector("#cite-list");
      const countOut = pop.querySelector("[data-cite-count]");

      let anchor = null;
      let matches = [];
      let active = 0;

      function caretPoint() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed) return null;
        const range = selection.getRangeAt(0);
        if (!content.contains(range.startContainer)) return null;
        return {node: range.startContainer, offset: range.startOffset};
      }

      /* The caret as a **text node** plus an offset — the only shape an insertion can use.
         Remembered whenever the reader types or clicks in the document, because the menu path
         loses the selection: opening the Insert menu moves focus out of `#content`, and
         `content.focus()` puts the caret back on the *element*, not in the text. That was the
         reason "Insert citation…" from the menu did nothing at all (`lab/017` §6). */
      let lastCaret = null;
      function rememberCaret() {
        const at = caretPoint();
        if (at && at.node.nodeType === Node.TEXT_NODE) lastCaret = {node: at.node, offset: at.offset};
      }

      /** End of the last block that has text: where a menu insertion goes when the document
       *  has never been clicked in. */
      function endOfText() {
        const blocks = [...content.children].reverse()
          .filter((el) => !el.id?.startsWith("bib") && el.id !== "bibliography" && el.textContent.trim());
        for (const block of blocks) {
          const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
          let last = null;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node;
          if (last) return {node: last, offset: last.nodeValue.length};
        }
        return null;
      }

      function caretAnchor() {
        const at = caretPoint();
        if (at && at.node.nodeType === Node.TEXT_NODE) return at;
        /* An element-anchored caret (`#content` itself after a focus): find a text node in it. */
        if (at && at.node.nodeType === Node.ELEMENT_NODE) {
          const walker = doc.createTreeWalker(at.node, NodeFilter.SHOW_TEXT);
          let first = null;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {first = node; break;}
          if (first) return {node: first, offset: 0};
        }
        if (lastCaret?.node?.isConnected) {
          return {node: lastCaret.node, offset: Math.min(lastCaret.offset, lastCaret.node.nodeValue.length)};
        }
        return endOfText();
      }

      function caretRect() {
        const selection = window.getSelection();
        if (selection && selection.rangeCount) {
          const range = selection.getRangeAt(0).cloneRange();
          if (content.contains(range.startContainer)) {
            const rects = range.getClientRects();
            if (rects.length) return rects[rects.length - 1];
            const box = range.startContainer.parentElement?.getBoundingClientRect();
            if (box) return box;
          }
        }
        return content.getBoundingClientRect();
      }

      /**
       * Rank, not merely match: "jones" is in `jones2019` *and* in `smith2020a`'s co-author
       * list, so an unranked filter makes the first Enter a coin flip (lab/017).
       */
      function score(entry, query) {
        const needle = query.toLowerCase().trim();
        if (!needle) return 1;
        const key = String(entry[`citation-key`] || entry.id || "").toLowerCase();
        const first = String(entry.author?.[0]?.family || entry.author?.[0]?.literal || "").toLowerCase();
        const rest = [entry.title, ...(entry.author || []).slice(1).map((n) => n.family || n.literal || ""),
          entry.issued?.["date-parts"]?.[0]?.[0] ?? ""].join(" ").toLowerCase();
        let rank = 0;
        for (const token of needle.split(/\s+/)) {
          if (key.startsWith(token) || first.startsWith(token)) rank = Math.max(rank, 3);
          else if (key.includes(token) || first.includes(token)) rank = Math.max(rank, 2);
          else if (rest.includes(token)) rank = Math.max(rank, 1);
          else return 0;
        }
        return rank;
      }

      function renderMatches(query) {
        const all = [...Object.values(entries), ...Object.values(pool)];
        const byKey = new Map();
        for (const entry of all) byKey.set(entry[`citation-key`] || entry.id, entry);
        matches = [...byKey.values()]
          .map((entry) => ({entry, rank: score(entry, query)}))
          .filter((row) => row.rank > 0)
          .sort((a, b) => b.rank - a.rank
            || (b.entry.issued?.["date-parts"]?.[0]?.[0] ?? 0) - (a.entry.issued?.["date-parts"]?.[0]?.[0] ?? 0))
          .map((row) => row.entry);
        active = Math.min(active, Math.max(0, matches.length - 1));
        list.innerHTML = matches.map((entry, index) => {
          const key = entry[`citation-key`] || entry.id;
          const families = (entry.author || []).map((n) => n.family || n.literal).join(", ");
          return `<li role="option" data-cite-key="${escapeAttr(key)}" aria-selected="${index === active}"
            style="display:grid;grid-template-columns:1fr auto;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;
                   ${index === active ? "background:#1a4d8f;color:#fff" : ""}">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(entry.title || key)}</span>
            <span style="color:${index === active ? "#dfe7f3" : "#6b6b76"};font-size:11px">${escapeHtml(families)} ${escapeHtml(String(entryYear(entry)))}</span>
          </li>`;
        }).join("");
        countOut.textContent = `${matches.length} of ${byKey.size}`;
        if (!byKey.size) {
          list.innerHTML = `<li style="padding:10px 12px;color:#6b6b76">No references yet.
            Open <b>References</b> in the document menu to import a .bib or CSL-JSON file.</li>`;
        }
      }

      function paintActive() {
        [...list.children].forEach((item, index) => {
          const on = index === active;
          item.setAttribute("aria-selected", String(on));
          item.style.background = on ? "#1a4d8f" : "";
          item.style.color = on ? "#fff" : "";
        });
        list.children[active]?.scrollIntoView({block: "nearest"});
      }

      /** Where the caret goes back to when the picker closes without inserting. */
      function restoreCaret(at) {
        if (!at || !at.node || !at.node.isConnected) return content.focus();
        const range = doc.createRange();
        range.setStart(at.node, Math.min(at.offset, at.node.nodeValue?.length ?? 0));
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        content.focus();
      }

      function openPicker(at) {
        anchor = at;
        const rect = caretRect();
        pop.style.display = "block";
        pop.style.left = `${Math.min(Math.max(8, rect.left), window.innerWidth - 388)}px`;
        pop.style.top = `${rect.bottom + 8 + 300 > window.innerHeight
          ? Math.max(8, rect.top - 308) : rect.bottom + 8}px`;
        filter.value = "";
        active = 0;
        renderMatches("");
        filter.focus();
      }

      /**
       * `restore` is "put the caret back where the picker found it". Escape and Backspace want
       * that; a click somewhere else does not — the click decides where focus goes, and
       * stealing it back is how a picker becomes a trap.
       */
      function closePicker({restore = true} = {}) {
        const wasOpen = pop.style.display === "block";
        pop.style.display = "none";
        const at = anchor;
        anchor = null;
        if (wasOpen && restore) restoreCaret(at);
      }

      /* A picker opened from the **Insert menu** has no keystroke to end it: Esc is handled on
         the filter, which has focus only while it is there, and nothing closed on a click
         outside. Both are now handled, at the document, for every way in. */
      function onOutsidePointer(event) {
        if (pop.style.display !== "block" || pop.contains(event.target)) return;
        closePicker({restore: false});
      }
      function onDocumentKey(event) {
        if (pop.style.display !== "block") return;
        if (event.key === "Escape") {
          event.preventDefault();
          closePicker();
        }
      }
      doc.addEventListener("pointerdown", onOutsidePointer, true);
      doc.addEventListener("keydown", onDocumentKey, true);

      /** The menu path: no trigger text to spend, so `removeBefore` is 0. */
      function openPickerAtCaret() {
        content.focus();
        const at = caretAnchor();
        if (!at) return false;
        openPicker(at);
        return true;
      }

      function insert(entry) {
        if (!entry) return closePicker();
        const key = entry[`citation-key`] || entry.id;
        const at = anchor;
        /* Take the entry into the store first: the mark's label is computed from the store,
           and a mark that arrives before its entry would render `?` for one paint. */
        if (!entries[key]) entries[key] = entry;
        const mark = doc.createElement("a");
        mark.className = "cite";
        mark.setAttribute("contenteditable", "false");
        mark.setAttribute("data-atomic", "");
        mark.dataset.keys = key;
        mark.textContent = key; /* replaced by relabel() below */
        pop.style.display = "none";
        anchor = null;
        if (!at || !at.node?.isConnected) return restoredFocus();

        /* The trigger is spent here, by the editor: `removeBefore: 2` deletes the `@@` and
           records one history entry for the whole insertion. */
        restoreCaret(at);
        /* `2` only when the trigger is really there: from the menu there is no `@@` to eat,
           and deleting two characters of the author's sentence would be a small disaster. */
        const spent = at.node.nodeValue.slice(Math.max(0, at.offset - 2), at.offset) === "@@" ? 2 : 0;
        if (editor) editor.insertInline(mark, {removeBefore: spent});
        else mark.after(doc.createTextNode("")); /* a flavour without an editor: no insert */
        if (!mark.isConnected) return;
        relabel();
        status?.markDirty();
      }

      function restoredFocus() {
        content.focus();
      }

      filter.addEventListener("input", () => { active = 0; renderMatches(filter.value); });
      filter.addEventListener("keydown", (event) => {
        if (event.isComposing) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          if (matches.length) { active = (active + 1) % matches.length; paintActive(); }
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          if (matches.length) { active = (active - 1 + matches.length) % matches.length; paintActive(); }
        } else if (event.key === "Enter") {
          event.preventDefault();
          insert(matches[active]);
        } else if (event.key === "Escape") {
          event.preventDefault();
          closePicker();
        } else if (event.key === "Backspace" && filter.value === "") {
          /* Backspace on an empty line closes the picker and returns the caret, rather than
             eating it: the reader's next Backspace should delete the `@@` they typed, in the
             document, where they can see it happen. */
          event.preventDefault();
          closePicker();
        }
      });
      list.addEventListener("mousedown", (event) => {
        const item = event.target.closest("li[data-cite-key]");
        if (!item) return;
        event.preventDefault();
        const entry = entries[item.dataset.citeKey] || pool[item.dataset.citeKey];
        insert(entry);
      });
      /* A click on the frame must not blur the filter before `mousedown` runs. */
      pop.addEventListener("mousedown", (event) => event.preventDefault());

      /* ------------------------------------------------------------- the DOC trigger */

      /**
       * `@@` opens the picker. The trigger text stays in the document until a citation is
       * chosen: cancelling leaves it as literal text the author can see and delete, which is
       * predictable — the alternative (delete on open, restore on cancel) surprises.
       */
      function onInput() {
        relabel();
        if (!editor || pop.style.display === "block") return;
        const at = caretPoint();
        if (!at || at.node.nodeType !== Node.TEXT_NODE) return;
        if (!at.node.nodeValue.slice(0, at.offset).endsWith("@@")) return;
        openPicker(at);
      }

      /**
       * Get the caret out of a mark before the browser acts.
       *
       * `contenteditable="false"` stops an arrow key *entering* a mark, but it does not stop
       * `Home` putting the caret at offset 1 of the mark's own text node — measured in
       * Chromium in lab/017, where typing then did nothing at all. A label is a text node;
       * the guard is part of the element's contract.
       */
      function guardCaret(event) {
        if (!editor || event.isComposing) return;
        const at = caretPoint();
        if (!at || at.node.nodeType !== Node.TEXT_NODE) return;
        const mark = at.node.parentElement?.closest("a.cite");
        if (!mark) return;
        const range = doc.createRange();
        if (["Home", "ArrowLeft", "ArrowUp"].includes(event.key)) range.setStartBefore(mark);
        else range.setStartAfter(mark);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }

      /* ------------------------------------------------------------------- both-way hover */

      function light(key) {
        for (const mark of marks()) mark.classList.toggle("is-cite-hot", !key || keysOf(mark).includes(key));
        for (const entry of content.querySelectorAll("#bibliography [data-key]")) {
          entry.classList.toggle("is-cite-hot", !key || entry.dataset.key === key);
        }
      }
      function onOver(event) {
        const mark = event.target.closest?.("a.cite");
        if (mark) return light(keysOf(mark)[0]);
        const entry = event.target.closest?.("#bibliography [data-key]");
        if (entry) return light(entry.dataset.key);
        light(null);
      }
      function onMarkClick(event) {
        const mark = event.target.closest?.("a.cite");
        if (!mark) return;
        event.preventDefault();
        const target = doc.getElementById(`bib-${keysOf(mark)[0]}`);
        target?.scrollIntoView({block: "center", behavior: "smooth"});
        light(keysOf(mark)[0]);
        setTimeout(() => light(null), 1200);
      }

      /* --------------------------------------------------------------------- the library */

      /**
       * Import a library. New entries go into the session pool; an entry the document
       * already cites is **never** replaced here — it comes back as `changed` and the panel
       * asks. That is the whole difference between "import" and "overwrite".
       */
      function importText(text) {
        const looksBib = /^\s*@\w+\s*[{(]/.test(text);
        const parsed = looksBib ? parseBib(text) : parseCslJson(text);
        const report = reconcile({incoming: parsed.entries, entries, pool});
        /* New and same both land in the pool: a `same` entry is already in the document, so
           the pool's copy only matters if the author removes the citation again. */
        for (const [key, entry] of Object.entries(parsed.entries)) {
          if (!entries[key]) pool[key] = entry;
        }
        return {
          count: Object.keys(parsed.entries).length,
          added: report.added.length,
          same: report.same.length,
          changed: report.changed,
          warnings: parsed.warnings,
        };
      }

      /** Read a file the author picked. The picker is the browser's, not a dialog of ours. */
      async function importFile(file) {
        if (!file) return null;
        const text = await file.text();
        return importText(text);
      }

      function panel(body) {
        body.innerHTML = `
          <p class="cp-lede" data-cp-count></p>

          <div class="cp-row">
            <span class="cp-grow cp-label">Style</span>
            <span class="cp-chips" data-cp-styles>
              <button type="button" class="cp-chip" data-cp-style="numeric">[1]</button>
              <button type="button" class="cp-chip" data-cp-style="author-date">(Author, 2020)</button>
              <button type="button" class="cp-chip" data-cp-style="vancouver">(1)</button>
            </span>
          </div>
          <div class="cp-row">
            <span class="cp-grow cp-label">Reference list</span>
            <span class="cp-chips" data-cp-bibs>
              <button type="button" class="cp-chip" data-cp-bib="off">Off</button>
              <button type="button" class="cp-chip" data-cp-bib="cited">Cited only</button>
              <button type="button" class="cp-chip" data-cp-bib="all">Whole library</button>
            </span>
          </div>

          <div class="cp-sep"></div>

          <div class="cp-row">
            <span class="cp-grow cp-label">Library</span>
            <button type="button" class="cp-chip primary" data-cp-pick>Import file…</button>
            <input type="file" data-cp-file accept=".bib,.json,.ris,application/json,text/plain" hidden>
          </div>
          <p class="cp-hint">A <code>.bib</code> (Better BibTeX keys become citation keys) or a CSL-JSON
            export. Only cited entries are written into the document.</p>
          <details data-cp-manual>
            <summary class="cp-hint" style="cursor:pointer">or paste one</summary>
            <textarea class="cp-import" data-cp-import rows="5" spellcheck="false"
              placeholder="@article{smith2020a, author={Smith, John}, …}  —  or  [{&quot;type&quot;:&quot;book&quot;,…}]"></textarea>
            <div class="cp-row"><button type="button" class="cp-chip" data-cp-do>Import pasted text</button></div>
          </details>
          <p class="cp-out" data-cp-out aria-live="polite"></p>
          <div data-cp-conflicts></div>

          <ul class="cp-list" data-cp-list></ul>

          <div class="cp-sep"></div>

          <p class="cp-hint"><b>Zotero Web API</b> — a public library needs no key. A key is kept in
            this browser (<code>localStorage</code>) and is never written into the document.</p>
          <div class="cp-row">
            <input type="text" class="cp-input" data-cp-zotlib placeholder="groups/459003 or users/1234567" style="flex:1">
            <input type="password" class="cp-input" data-cp-zotkey placeholder="API key (optional)" style="flex:1">
            <button type="button" class="cp-chip" data-cp-zot>Fetch</button>
          </div>
          <p class="cp-out" data-cp-zotout></p>`;

        const out = body.querySelector("[data-cp-count]");
        const say = (selector, text) => { body.querySelector(selector).textContent = text; };

        const line = (entry) => `${(entry.author || []).map((n) => n.family || n.literal).join(", ") || "—"} (${entryYear(entry)})`;
        function paint() {
          const cited = citedKeys();
          const size = new Blob([doc.getElementById(STORE_ID)?.textContent || "{}"]).size;
          say("[data-cp-count]", `${librarySize()} references in this session · ${cited.length} cited · `
            + `${Object.keys(entries).length} in the document · store ${size} B`);
          for (const button of body.querySelectorAll("[data-cp-style]")) {
            button.setAttribute("aria-pressed", String(button.dataset.cpStyle === style));
          }
          for (const button of body.querySelectorAll("[data-cp-bib]")) {
            button.setAttribute("aria-pressed", String(button.dataset.cpBib === bibliography));
          }
          /* One list of everything this session knows, with the cited ones marked: the panel
             is the library, and "cited" is the only thing that travels. */
          const all = new Map();
          for (const [key, entry] of Object.entries({...pool, ...entries})) all.set(key, entry);
          const rows = [...all].sort((a, b) => String(familyOf(a[1])).localeCompare(String(familyOf(b[1])), "en"));
          body.querySelector("[data-cp-list]").innerHTML = rows.length
            ? rows.map(([key, entry]) => `<li>
                <span class="cp-title">${escapeHtml(entry.title || key)}</span>
                <span class="cp-meta">${escapeHtml(line(entry))}${cited.includes(key)
                  ? ' · <span class="cp-cited">cited</span>' : ""}</span>
              </li>`).join("")
            : `<li><span class="cp-title cp-hint">Nothing imported yet.</span></li>`;
        }

        for (const button of body.querySelectorAll("[data-cp-style]")) {
          button.addEventListener("click", () => {
            style = button.dataset.cpStyle;
            relabel();
            paint();
          });
        }
        for (const button of body.querySelectorAll("[data-cp-bib]")) {
          button.addEventListener("click", () => {
            bibliography = button.dataset.cpBib;
            relabel();
            status?.markDirty();
            paint();
          });
        }

        function report(result) {
          const parts = [
            `${result.count} parsed`,
            result.added ? `${result.added} new` : "",
            result.same ? `${result.same} already current` : "",
            result.changed.length ? `${result.changed.length} changed in the library` : "",
            ...result.warnings,
          ].filter(Boolean);
          say("[data-cp-out]", parts.join(" · "));
          showConflicts(result.changed);
          relabel();
          paint();
        }

        const fileInput = body.querySelector("[data-cp-file]");
        body.querySelector("[data-cp-pick]").addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", async () => {
          const file = fileInput.files?.[0];
          if (!file) return;
          try {
            const result = await importFile(file);
            report(result);
          } catch (error) {
            say("[data-cp-out]", `nothing imported from ${file.name}: ${error.message}`);
          } finally {
            fileInput.value = "";
          }
        });
        body.querySelector("[data-cp-do]").addEventListener("click", () => {
          const text = body.querySelector("[data-cp-import]").value.trim();
          if (!text) return;
          try {
            report(importText(text));
          } catch (error) {
            say("[data-cp-out]", `nothing imported: ${error.message}`);
          }
        });

        /**
         * A reference the document already cites, with a different copy in the library.
         *
         * Nothing is resolved for the author: `Update` replaces the document's entry and
         * `Keep mine` leaves it alone. `Keep mine` is not remembered, because a library can be
         * re-read at any time and a suppressed row would be a decision nobody can find again.
         * This is the same shape as `File › Import comments…`, and for the same reason — two
         * copies of one thing is a decision, not a merge rule.
         */
        function showConflicts(changed) {
          const box = body.querySelector("[data-cp-conflicts]");
          if (!changed?.length) {
            box.innerHTML = "";
            return;
          }
          box.innerHTML = `<p class="cp-hint"><b>${changed.length} reference${changed.length > 1 ? "s" : ""}
              changed in the library.</b> This document keeps its own copy of each.</p>`
            + changed.map(({key, mine, theirs}) => `
              <div class="cp-conflict" data-conflict="${escapeAttr(key)}">
                <div class="cp-what"><code>${escapeHtml(key)}</code></div>
                <div class="cp-what">document: <b>${escapeHtml(mine.title || "")}</b> ${escapeHtml(String(entryYear(mine)))}</div>
                <div class="cp-what">library: <b>${escapeHtml(theirs.title || "")}</b> ${escapeHtml(String(entryYear(theirs)))}</div>
                <span class="cp-chips">
                  <button type="button" class="cp-chip primary" data-cp-update="${escapeAttr(key)}">Update</button>
                  <button type="button" class="cp-chip" data-cp-keep="${escapeAttr(key)}">Keep mine</button>
                </span>
              </div>`).join("")
            + `<div class="cp-row"><button type="button" class="cp-chip" data-cp-all>Update all</button></div>`;

          const pending = new Map(changed.map((row) => [row.key, row.theirs]));
          const done = (key) => {
            pending.delete(key);
            box.querySelector(`[data-conflict="${escapeAttr(key)}"]`)?.remove();
            if (!pending.size) showConflicts([]);
          };
          box.querySelectorAll("[data-cp-update]").forEach((button) => {
            button.addEventListener("click", () => {
              const key = button.dataset.cpUpdate;
              if (!pending.has(key)) return;
              entries[key] = pending.get(key);
              done(key);
              relabel();
              status?.markDirty();
              paint();
            });
          });
          box.querySelectorAll("[data-cp-keep]").forEach((button) => {
            button.addEventListener("click", () => done(button.dataset.cpKeep));
          });
          box.querySelector("[data-cp-all]")?.addEventListener("click", () => {
            for (const [key, entry] of pending) entries[key] = entry;
            pending.clear();
            showConflicts([]);
            relabel();
            status?.markDirty();
            paint();
          });
        }

        const KEY = "sd:zotero:key";
        const keyInput = body.querySelector("[data-cp-zotkey]");
        const libraryInput = body.querySelector("[data-cp-zotlib]");
        try { keyInput.value = globalThis.localStorage?.getItem(KEY) || ""; } catch { /* private window */ }
        try { libraryInput.value = globalThis.localStorage?.getItem("sd:zotero:library") || ""; } catch { /* */ }
        body.querySelector("[data-cp-zot]").addEventListener("click", async () => {
          const library = libraryInput.value.trim() || "groups/459003";
          const key = keyInput.value.trim();
          try {
            if (key) globalThis.localStorage?.setItem(KEY, key);
            else globalThis.localStorage?.removeItem(KEY);
            globalThis.localStorage?.setItem("sd:zotero:library", library);
          } catch { /* a private window is still allowed to fetch */ }
          say("[data-cp-zotout]", "fetching…");
          try {
            const joined = await fetchZoteroLibrary({
              library,
              key,
              onPage: ({taken, total}) => say("[data-cp-zotout]", `fetched ${taken}${total ? ` of ${total}` : ""}…`),
            });
            Object.assign(pool, joined.entries);
            const bbt = Object.values(joined.entries)
              .filter((entry) => entry[`citation-key`] !== entry[`zotero-item-key`]).length;
            const dropped = Object.entries(joined.skipped)
              .filter(([, count]) => count)
              .map(([reason, count]) => `${count} ${reason}${count > 1 ? "s" : ""}`);
            say("[data-cp-zotout]", [
              `${joined.references} reference${joined.references === 1 ? "" : "s"} imported`,
              joined.total != null ? `of ${joined.total} item${joined.total === 1 ? "" : "s"}` : "",
              joined.taken < (joined.total ?? 0) ? `(first ${joined.taken})` : "",
              dropped.length ? `skipped ${dropped.join(", ")}` : "",
              `${bbt} with a Better BibTeX key`,
              ...joined.warnings,
            ].filter(Boolean).join(" · "));
            relabel();
            paint();
          } catch (error) {
            say("[data-cp-zotout]", `failed: ${error.message}. Nothing was written.`);
          }
        });

        paint();
        return {refresh: paint};
      }

      /* ----------------------------------------------------------------------- wiring */

      /* The panel's own stylesheet: session chrome, dropped with the dialog. */
      let uiStyle = doc.getElementById("citation-ui");
      if (!uiStyle) {
        uiStyle = doc.createElement("style");
        uiStyle.id = "citation-ui";
        uiStyle.dataset.pluginUi = "";
        doc.head.append(uiStyle);
      }
      uiStyle.textContent = PANEL_CSS;

      readStore();
      ensureStyle();
      if (writable && editor) {
        content.addEventListener("input", onInput);
        content.addEventListener("keydown", guardCaret);
        content.addEventListener("mouseover", onOver);
        content.addEventListener("mouseleave", () => light(null));
        content.addEventListener("click", onMarkClick);
        content.addEventListener("mouseup", rememberCaret);
        content.addEventListener("keyup", rememberCaret);
      }
      /* The editor replaced the DOM under a muted observer, so nothing has heard about it:
         undo leaves a stale store entry and redo shows the raw citation key until the next
         keystroke (`lab/017` §undo). This is the event that closes that gap. */
      host.on("restore", () => relabel());
      relabel();

      host.track(() => {
        pop.remove();
        uiStyle.remove();
        doc.removeEventListener("pointerdown", onOutsidePointer, true);
        doc.removeEventListener("keydown", onDocumentKey, true);
        /* The stylesheet is document state and is recreated by the next activation; removing
           it here keeps a *disabled* plugin from restyling the page it no longer runs on. */
        doc.getElementById(STYLE_ID)?.remove();
        content.removeEventListener("input", onInput);
        content.removeEventListener("keydown", guardCaret);
        content.removeEventListener("mouseover", onOver);
        content.removeEventListener("click", onMarkClick);
        light(null);
      });

      return {
        panel: {library: panel},
        /* The Insert menu, beside the figures: a citation belongs where the author is typing.
           `inline`, not `insert` — this one lands in the paragraph and owns no store. */
        inline: {
          citation: () => {
            if (!editor) return;
            openPickerAtCaret();
          },
        },
        deactivate() {
          closePicker({restore: false});
        },
      };
    },
  };
}

/* --------------------------------------------------------------- the parsers
   BibTeX and CSL-JSON, at the bottom because they are the part that is a pure function of
   its input and could live in its own module the day a second plugin wants them.

   Brace-balanced, not regex: `{Xanthobacter {flavus} 301}` is one title, `{\"o}` is a
   letter, `{World Health Organization} and Smith, J.` is two authors, and `@article(key,`
   is a record. `archive/docs/05-citations.md` §6 is the list; lab/017's tests are the
   proof. */

const ACCENTS = {
  '"a': "ä", '"e': "ë", '"o': "ö", '"u': "ü", '"A': "Ä", '"O': "Ö", '"U': "Ü",
  "'a": "á", "'e": "é", "'i": "í", "'o": "ó", "'u": "ú", "'c": "ć", "'n": "ń",
  "'A": "Á", "'E": "É", "'I": "Í", "'O": "Ó", "'U": "Ú", "'C": "Ć", "'N": "Ń",
  "`a": "à", "`e": "è", "`o": "ò", "^a": "â", "^e": "ê", "^o": "ô", "^u": "û",
  "`A": "À", "`E": "È", "`O": "Ò", "^A": "Â", "^E": "Ê", "^O": "Ô", "^U": "Û",
  "~a": "ã", "~n": "ñ", "~o": "õ", "~A": "Ã", "~N": "Ñ", "~O": "Õ",
  "c{c": "ç", "ss": "ß", "o": "ø", "O": "Ø",
  "aa": "å", "ae": "æ", "AE": "Æ", "oe": "œ", "l": "ł",
};
const SYMBOLS = {"&": "&", "%": "%", $: "$", _: "_", "#": "#", "{": "{", "}": "}", "\\": "\\"};

/** Accent *commands* that take a braced letter: `\c{c}`, `\v{s}`, `\u{g}`. */
const COMPOUND = {
  c: {c: "ç", C: "Ç"}, v: {c: "č", s: "š", z: "ž", C: "Č", S: "Š", Z: "Ž"}, u: {g: "ğ", G: "Ğ"},
};

function decodeLatex(value) {
  let out = String(value ?? "");
  /* First, the compound forms: the command is one letter and the letter is braced. */
  out = out.replace(/\\([cvu])\s*\{?([a-zA-Z])\}?/g, (match, command, letter) =>
    COMPOUND[command]?.[letter] ?? letter);
  out = out.replace(/\\([a-zA-Z]+)\s*/g, (match, name) => {
    if (SYMBOLS[name] !== undefined) return SYMBOLS[name];
    return ACCENTS[name] ?? name;
  });
  out = out.replace(/\\(["'`^~])\s*\{?([a-zA-Z])\}?/g, (match, accent, letter) => ACCENTS[accent + letter] ?? letter);
  out = out.replace(/\\([&%$#_{}])/g, "$1");
  out = out.replace(/[{}]/g, "");
  return out.replace(/---/g, "—").replace(/--/g, "–").replace(/~/g, "\u00a0").replace(/\s+/g, " ").trim();
}

/** Index of the delimiter closing the one at `open`, counting braces even in `(`-records. */
function matchClose(text, open, openChar = "{") {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (openChar === "{" && depth === 0) return i;
    } else if (openChar === "(" && ch === ")" && depth === 0) return i;
  }
  return -1;
}

/** Split on a separator at brace depth 0 only. */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i));
      i += separator.length - 1;
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function parseName(raw) {
  const name = String(raw || "").trim();
  if (!name) return null;
  if (name.startsWith("{") && matchClose(name, 0) === name.length - 1) return {literal: decodeLatex(name.slice(1, -1))};
  const parts = splitTopLevel(name, ",").map((part) => part.trim());
  if (parts.length >= 2) {
    const family = decodeLatex(parts[0]);
    const given = decodeLatex(parts[parts.length - 1]);
    const suffix = parts.length > 2 ? decodeLatex(parts.slice(1, -1).join(", ")) : "";
    return suffix ? {family, given, suffix} : {family, given};
  }
  const words = name.split(/\s+/);
  if (words.length === 1) return {literal: decodeLatex(name)};
  return {family: decodeLatex(words.at(-1)), given: decodeLatex(words.slice(0, -1).join(" "))};
}

const CSL_TYPES = {
  article: "article-journal", inproceedings: "paper-conference", conference: "paper-conference",
  book: "book", inbook: "chapter", incollection: "chapter", phdthesis: "thesis",
  mastersthesis: "thesis", techreport: "report", report: "report", misc: "document",
  unpublished: "manuscript", online: "webpage", electronic: "webpage", www: "webpage",
};
const FIELD_MAP = {
  journal: "container-title", journaltitle: "container-title", booktitle: "container-title",
  series: "collection-title", number: "issue", address: "publisher-place", location: "publisher-place",
  school: "publisher", institution: "publisher", volume: "volume", pages: "page",
  doi: "DOI", url: "URL", isbn: "ISBN", issn: "ISSN", abstract: "abstract",
  keywords: "keyword", language: "language", edition: "edition", publisher: "publisher",
};

function bibEntryToCsl(key, type, fields) {
  const csl = {id: key, type: CSL_TYPES[String(type).toLowerCase()] || "document"};
  const leftovers = [];
  for (const [rawName, rawValue] of Object.entries(fields)) {
    const name = rawName.toLowerCase();
    if (rawValue == null || rawValue === "") continue;
    if (["author", "editor", "translator"].includes(name)) {
      const names = splitTopLevel(String(rawValue), " and ").map(parseName).filter(Boolean);
      if (names.length) csl[name] = names;
    } else if (name === "title") csl.title = decodeLatex(rawValue);
    else if (name === "year" || name === "date") {
      const year = /(\d{4})/.exec(String(rawValue));
      if (year) csl.issued = {"date-parts": [[Number(year[1])]]};
    } else if (name === "month") {
      const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      const found = months.indexOf(String(rawValue).toLowerCase().slice(0, 3));
      if (found >= 0) {
        csl.issued = csl.issued || {"date-parts": [[0]]};
        csl.issued["date-parts"][0][1] = found + 1;
      }
    } else if (name === "type" || name === "key") {
      /* `key` is the citation key, already the record's name. */
    } else if (FIELD_MAP[name]) csl[FIELD_MAP[name]] = decodeLatex(rawValue);
    else leftovers.push(`${name}: ${decodeLatex(rawValue)}`);
  }
  if (leftovers.length) csl.note = leftovers.join("\n");
  csl[`citation-key`] = key;
  return csl;
}

function parseBib(text) {
  const entries = {};
  const warnings = [];
  const source = String(text || "");
  const start = /@(\w+)\s*([{(])\s*([^,\s]+)\s*,/g;
  let match;
  while ((match = start.exec(source))) {
    const [, type, openChar, key] = match;
    const open = source.indexOf(openChar, match.index + 1);
    const close = matchClose(source, open, openChar);
    if (close < 0) {
      warnings.push(`${key}: unclosed record`);
      continue;
    }
    const body = source.slice(open + 1, close);
    const fields = {};
    const field = /\s*([\w:-]+)\s*=\s*/g;
    field.lastIndex = body.indexOf(",") + 1;
    let fieldMatch;
    while ((fieldMatch = field.exec(body))) {
      const name = fieldMatch[1].toLowerCase();
      let i = field.lastIndex;
      let value;
      if (body[i] === "{") {
        const end = matchClose(body, i);
        if (end < 0) { warnings.push(`${key}: unclosed field ${name}`); break; }
        value = body.slice(i + 1, end);
        i = end + 1;
      } else if (body[i] === '"') {
        let end = i + 1;
        while (end < body.length && !(body[end] === '"' && body[end - 1] !== "\\")) end += 1;
        value = body.slice(i + 1, end);
        i = end + 1;
      } else {
        const end = body.indexOf(",", i);
        value = body.slice(i, end < 0 ? body.length : end).trim();
        i = end < 0 ? body.length : end;
      }
      fields[name] = value;
      const comma = body.indexOf(",", i);
      if (comma < 0) break;
      field.lastIndex = comma + 1;
    }
    entries[key] = bibEntryToCsl(key, type, fields);
    start.lastIndex = close + 1;
  }
  if (!Object.keys(entries).length && /@\w+\s*[{(]/.test(source)) warnings.push("no records parsed");
  return {entries, warnings};
}

function parseCslJson(text) {
  const parsed = typeof text === "string" ? JSON.parse(text) : text;
  const list = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed?.items) ? parsed.items
    : parsed && typeof parsed === "object" ? [parsed] : [];
  const entries = {};
  const warnings = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || !raw.type) {
      warnings.push(`skipped an entry with no type: ${JSON.stringify(raw).slice(0, 60)}`);
      continue;
    }
    const key = keyOf(raw);
    if (!key) { warnings.push(`skipped an entry with no key: ${raw.title || raw.id || "?"}`); continue; }
    entries[key] = {...raw, [`citation-key`]: key};
  }
  return {entries, warnings};
}

const KEY_RE = /^[A-Za-z0-9_:.+-]{1,64}$/;

/** The key a document's `data-keys` holds, and it must not change between imports. */
function keyOf(entry) {
  for (const candidate of [entry?.[`citation-key`], entry?.citationKey]) {
    if (candidate && KEY_RE.test(String(candidate))) return String(candidate);
  }
  const id = String(entry?.id ?? "");
  if (id && KEY_RE.test(id)) return id;
  const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : "";
  if (tail && KEY_RE.test(tail)) return tail;
  const family = entry?.author?.[0]?.family || entry?.publisher || entry?.title || "ref";
  const year = entry?.issued?.["date-parts"]?.[0]?.[0] ?? "";
  const slug = String(family).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  return `${slug || "ref"}${year}`;
}

/**
 * A Zotero `/items` page. One URL builder for both representations, so the two halves of a
 * page are always the same items in the same order.
 *
 * **`itemType=-attachment` is the only server-side filter that works**: the API rejects a list
 * (`itemType=-attachment||note` → `400 Invalid itemType`), measured against a live library.
 * Attachments are the bulk of a library's items, so excluding them there is worth the request;
 * everything else is decided by `isReferenceItem()` on the item JSON, which this client
 * fetches anyway for Better BibTeX keys.
 */
export function zoteroUrl({library, format = "json", start = 0, limit = 100}) {
  const query = new URLSearchParams({
    format,
    limit: String(limit),
    start: String(start),
    itemType: "-attachment",
  });
  /* `include=data` is what puts `extra` (and therefore the Better BibTeX key) in the payload. */
  if (format === "json") query.set("include", "data");
  return `https://api.zotero.org/${library}/items?${query}`;
}

/**
 * Read a library, page by page, and return the references in it.
 *
 * Extracted from the panel so the network path is *this* code and not a copy of it: a lab can
 * call it with a stub `fetchImpl`, and a live check can call it with the real one. It reports
 * what it took and what it left, because "334 of 848" is the difference between a library and a
 * bibliography and the author should see it.
 *
 * `total-results` is the library's own count; a short page is the end. `maxPages` is the bound
 * (20 × 100 = 2,000 items), because an import is a deliberate action and not a background sync.
 */
export async function fetchZoteroLibrary({
  library,
  key = "",
  fetchImpl = globalThis.fetch,
  pageSize = 100,
  maxPages = 20,
  onPage = null,
} = {}) {
  if (!library) throw new Error("no library given");
  const headers = key ? {"Zotero-API-Key": key} : {};
  const joined = {entries: {}, warnings: [], skipped: {}, references: 0, total: null, pages: 0, taken: 0};
  let start = 0;
  for (let page = 0; page < maxPages; page++) {
    const [cslResponse, jsonResponse] = await Promise.all([
      fetchImpl(zoteroUrl({library, format: "csljson", start, limit: pageSize}), {headers}),
      fetchImpl(zoteroUrl({library, format: "json", start, limit: pageSize}), {headers}),
    ]);
    for (const [name, response] of [["CSL-JSON", cslResponse], ["items", jsonResponse]]) {
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    }
    joined.total = Number(jsonResponse.headers.get("total-results")) || joined.total;
    const [csl, items] = await Promise.all([cslResponse.json(), jsonResponse.json()]);
    const read = normaliseZotero({csl, json: items});
    Object.assign(joined.entries, read.entries);
    joined.references += read.references;
    joined.pages += 1;
    joined.taken += Array.isArray(items) ? items.length : 0;
    /* One warning per import, not per page: "no Better BibTeX keys" is a fact about the
       library, and five copies of it reads as five problems. */
    for (const warning of read.warnings) {
      if (!joined.warnings.includes(warning)) joined.warnings.push(warning);
    }
    for (const [reason, count] of Object.entries(read.skipped)) {
      joined.skipped[reason] = (joined.skipped[reason] || 0) + count;
    }
    onPage?.({page: joined.pages, start, taken: joined.taken, total: joined.total, references: joined.references});
    start += pageSize;
    if (!Array.isArray(items) || items.length < pageSize) break;
    if (joined.total != null && start >= joined.total) break;
  }
  return joined;
}

/**
 * Is this item a *reference* — something a bibliography can print?
 *
 * Zotero's library is not a bibliography: it holds the PDFs (`attachment`), the notes taken
 * while reading (`note`), and Zotero 7's `annotation` items — every highlight and comment in
 * every PDF, each with `annotationText` and a `parentItem` pointing at the attachment it sits
 * in. Importing a library unfiltered therefore adds highlights as if they were books, which is
 * exactly what happened the first time this was tried by hand.
 *
 * The rule is structural, not a list of "good" types: a reference is **top level, not deleted,
 * and not one of the three kinds that hang off a reference**.
 */
export const NON_REFERENCE_TYPES = new Set(["attachment", "note", "annotation"]);

export function isReferenceItem(data) {
  if (!data || typeof data !== "object") return false;
  if (data.deleted) return false;
  /* A child item — an attachment, a note, an annotation, or a book section filed under its
     book — is not a citation of its own. Top-level items have no `parentItem`. */
  if (data.parentItem) return false;
  return !NON_REFERENCE_TYPES.has(String(data.itemType || ""));
}

/** Better BibTeX keeps the key in `extra`; Zotero's CSL-JSON drops it, so this needs both. */
function betterBibtexKey(extra) {
  const found = /^\s*Citation Key\s*:\s*(\S+)\s*$/im.exec(String(extra || ""));
  return found ? found[1] : "";
}

/**
 * Join one page of Zotero's two representations into references.
 *
 * The **item JSON decides what is a reference** and the CSL-JSON supplies the fields, matched
 * on the item key (Zotero's CSL `id` is `"<libraryID>/<itemKey>"`). Doing it in that order is
 * the whole fix: iterating the CSL list instead means a library imports its PDFs, its notes and
 * every highlight in them, because Zotero serialises an attachment as a CSL `document` — a type
 * a real `document` item also uses, so the CSL side cannot tell them apart.
 *
 * Returns what it kept and what it dropped, by reason, so the panel can say so.
 */
export function normaliseZotero({csl, json}) {
  const cslItems = Array.isArray(csl) ? csl : csl?.items || [];
  const jsonItems = Array.isArray(json) ? json : json?.items || [];
  const cslByKey = new Map();
  for (const raw of cslItems) {
    const id = String(raw?.id ?? "");
    const itemKey = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
    if (itemKey) cslByKey.set(itemKey, raw);
  }

  const entries = {};
  const warnings = [];
  const skipped = {attachment: 0, note: 0, annotation: 0, child: 0, deleted: 0};
  let betterBibtex = 0;
  let references = 0;
  for (const item of jsonItems) {
    const data = item?.data || item;
    const itemKey = item?.key || item?.data?.key;
    if (!itemKey) continue;
    if (!isReferenceItem(data)) {
      if (data?.deleted) skipped.deleted += 1;
      else if (NON_REFERENCE_TYPES.has(String(data?.itemType))) skipped[data.itemType] += 1;
      else skipped.child += 1;
      continue;
    }
    const raw = cslByKey.get(itemKey);
    if (!raw) { warnings.push(`skipped ${itemKey}: no CSL-JSON for it`); continue; }
    const bbt = betterBibtexKey(data.extra);
    const key = bbt || itemKey;
    if (!KEY_RE.test(key)) { warnings.push(`skipped ${itemKey}: unusable key`); continue; }
    if (bbt) betterBibtex += 1;
    references += 1;
    entries[key] = {...raw, id: key, [`citation-key`]: key, [`zotero-item-key`]: itemKey};
  }
  /* One warning for the page, and only about references: an attachment without a Better BibTeX
     key must not make the library look keyless. */
  if (references && betterBibtex === 0) {
    warnings.push("no Citation Key in extra — keys fall back to Zotero item keys; enable Better BibTeX's 'export citation keys to Extra'");
  }
  return {entries, warnings, skipped, references};
}

/* ------------------------------------------------------- the labels, as pure functions
   Exported because they are the part that can be wrong without a browser: `lab/017`'s tests
   import *this file* and assert on these, so the tested bytes are the shipped bytes. A second
   copy in the lab is how `\'E` became `E` once already. */

export const CSL_STYLES = ["numeric", "author-date", "vancouver"];

export function familyOf(entry) {
  return entry?.author?.[0]?.family || entry?.author?.[0]?.literal
    || entry?.editor?.[0]?.family || entry?.publisher || entry?.title || "Anon.";
}

export function entryYear(entry) {
  return entry?.issued?.["date-parts"]?.[0]?.[0] ?? "n.d.";
}

export function shortAuthors(entry) {
  const authors = entry?.author || [];
  if (authors.length > 2) return `${familyOf(entry)} et al.`;
  if (authors.length === 2) {
    return `${authors[0].family || authors[0].literal} & ${authors[1].family || authors[1].literal}`;
  }
  return familyOf(entry);
}

/**
 * Numbers by order of first appearance **over the whole document**, which is what makes a
 * label a function of the page rather than of itself. A key with no entry is never numbered:
 * printing a plausible `[4]` for a reference the document cannot render is the one thing that
 * must not happen.
 */
export function numberKeys(keyGroups, {store = null} = {}) {
  const numbers = new Map();
  for (const group of keyGroups) {
    for (const key of group) {
      if (numbers.has(key)) continue;
      if (store && !store[key]) continue;
      numbers.set(key, numbers.size + 1);
    }
  }
  return numbers;
}

/** The visible label for a mark: derived, never stored. */
export function labelFor(keys, style, store, numbers = null) {
  const map = numbers || numberKeys([keys], {store});
  if (style === "author-date") {
    const parts = keys.map((key) => store[key]).filter(Boolean)
      .map((entry) => `${shortAuthors(entry)}, ${entryYear(entry)}`);
    if (parts.length !== keys.length) parts.push("?");
    return `(${parts.join("; ")})`;
  }
  const shown = keys.map((key) => map.get(key) ?? "?");
  return style === "vancouver" ? `(${shown.join(",")})` : `[${shown.join(",")}]`;
}

/** Appearance order for the numeric styles; family-then-year for author-date. */
export function bibOrder(keys, style, store) {
  if (style !== "author-date") return [...keys];
  return [...keys].sort((a, b) => familyOf(store[a]).localeCompare(familyOf(store[b]), "en")
    || String(entryYear(store[a])).localeCompare(String(entryYear(store[b]))));
}

/** One reference line. Enough to judge the page; a CSL processor replaces this body only. */
export function entryLine(key, style, store) {
  const entry = store[key];
  if (!entry) return `${key} — not in this document's library`;
  const year = entryYear(entry);
  const container = entry["container-title"] || "";
  const vol = entry.volume ? `, ${entry.volume}` : "";
  const issue = entry.issue ? `(${entry.issue})` : "";
  const page = entry.page ? `, ${entry.page}` : "";
  const doi = entry.DOI ? ` https://doi.org/${entry.DOI}` : entry.URL ? ` ${entry.URL}` : "";
  if (style === "vancouver") {
    const initials = (entry.author || []).map((n) => n.literal
      || `${n.family} ${(n.given || "").split(/\s+/).map((w) => w[0] || "").join("")}`);
    return `${initials.join(", ")}. ${entry.title || ""}. ${container}. ${year}${vol}${issue}${page}.${doi}`
      .replace(/\s+/g, " ").trim();
  }
  const names = (entry.author || []).map((name) => name.literal
    || `${name.family}${name.given ? `, ${name.given.replace(/(^|\s)(\S)\S*/g, "$1$2.")}` : ""}`);
  const shown = names.length > 7 ? [...names.slice(0, 6), "…", names.at(-1)] : names;
  const joined = shown.length > 2
    ? `${shown.slice(0, -1).join(", ")}, & ${shown.at(-1)}`
    : shown.join(" & ");
  const rest = container ? `${container}${vol}${issue}${page}.` : "";
  return `${joined} (${year}). ${entry.title || ""}. ${rest}${doi}`.replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ import, re-import */

/** Key order canonicalised, so JSON equality means "the same citation" and not "the same map". */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const name of Object.keys(value).sort()) out[name] = canonical(value[name]);
    return out;
  }
  return value;
}

const fingerprint = (entry) => JSON.stringify(canonical(entry));

/**
 * What an import should do to the copies the document already holds.
 *
 * Three answers, and the third is the point: a reference that is already cited is **not**
 * silently replaced. A `.bib` file is regenerated by a tool that may have corrected a year,
 * and a Zotero item may have been edited since the citation was made — so the author decides,
 * per key, exactly as `File › Import comments…` decides for a resolved thread. Nothing is
 * merged, nothing is guessed, and `Keep mine` is a real answer.
 */
export function reconcile({incoming, entries, pool}) {
  const added = [];
  const same = [];
  const changed = [];
  for (const [key, theirs] of Object.entries(incoming || {})) {
    const mine = entries?.[key];
    if (!mine) {
      /* Not cited here: whether the pool had it is not the document's business. */
      added.push(key);
      continue;
    }
    if (fingerprint(mine) === fingerprint(theirs)) same.push(key);
    else changed.push({key, mine, theirs});
  }
  return {added, same, changed};
}

/** Entries the document must keep: the cited ones, plus whatever the author pinned. */
export function pruneToCited(store, citedKeys, {keep = []} = {}) {
  const wanted = new Set([...citedKeys, ...keep]);
  const entries = {};
  for (const key of wanted) if (store[key]) entries[key] = store[key];
  return entries;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[ch]));
}
const escapeAttr = escapeHtml;

/* The parsers are exported for the same reason the labels are: one copy, tested as shipped. */
export {
  decodeLatex,
  parseBib,
  parseCslJson,
  keyOf,
  betterBibtexKey,
  splitTopLevel,
  parseName,
  escapeHtml,
};
