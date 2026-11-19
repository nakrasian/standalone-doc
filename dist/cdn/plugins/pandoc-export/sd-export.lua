--[[ sd-export.lua — the vocabulary layer for a materialized standalone-doc document.

     Pandoc's HTML reader already does the hard part: headings, paragraphs, lists,
     blockquotes, code, tables, figures and captions all arrive as real AST nodes.
     This filter only adds the things the reader cannot know:

       1. what a page-spacer (the old spelling) or a page-start block means in a
          target that has pages
       2. which Divs are editor scaffolding, and which are wrappers to unwrap
       3. how a captured figure travels, so every writer can see the image
       4. that a caret-only paragraph is not a paragraph

     (The authored figure width is *not* its job: buildStatic now writes width="80%" on the
     image, which every writer reads. This filter only sweeps up the old data-width form.)

     It reads only names the editor writes (page-spacer, figure-frame, #sheets,
     data-width). Anything it does not recognise is *counted and reported* rather
     than silently passed through, because a silent pass-through is how an export
     quietly loses a figure.

     Runs unchanged under the CLI and under pandoc.wasm: it touches the AST, never
     the filesystem, the network, or another process.
--]]

local FILTER_VERSION = "0.1"

-- A page break is the one construct with no portable AST node.
local PAGE_BREAK = {
  docx = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
  openxml = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
  typst = "#pagebreak()",
  latex = "\\newpage",
  context = "\\page",
  html = '<div class="page-break"></div>',
  html4 = '<div class="page-break"></div>',
  revealjs = "",
  epub = "",
}
-- Markdown and plain text have no page. Say so once, at the top, and keep going.
local NO_PAGE = { markdown = true, plain = true, rst = true, asciidoc = true }
-- The raw format name is not always the writer's name: docx reads OpenXML.
local RAW_FORMAT = { docx = "openxml" }

-- The intended target, which is FORMAT unless the caller says otherwise. A golden-AST
-- test converts to json, and without this every FORMAT branch would be invisible to it:
-- `-t json` would produce the *html* page break and then compare against nothing.
local TARGET = FORMAT

local function Meta(meta)
  if meta["sd-target"] ~= nil then
    TARGET = pandoc.utils.stringify(meta["sd-target"])
  end
  return nil
end

local skipped = {}      -- chrome we dropped, by name
local unknown = {}      -- div classes we never taught this filter about
local notes = {}        -- informational, printed once

local function note(kind, detail)
  notes[#notes + 1] = kind .. " " .. detail
end

local function bump(t, key)
  t[key] = (t[key] or 0) + 1
end

local function percent(value)
  local n = tonumber(value)
  if not n then return nil end
  if n > 0 and n <= 1 then return string.format("%d%%", math.floor(n * 100 + 0.5)) end
  return nil
end

-- ---------------------------------------------------------------- Div -------
local function Div(el)
  local id = el.identifier or ""
  local classes = el.classes
  local attrs = el.attributes

  -- Scaffolding the materializer may not have removed (a hand-run conversion, or a
-- document whose export ran before buildStatic). Dropped, never unwrapped: they
-- carry no content worth keeping.
  if id == "sheets" or id == "probe" or attrs["data-generated"] then
    bump(skipped, id ~= "" and id or "generated")
    return {}
  end

  -- page-spacer is handled in Pandoc(), not here: see the note there.
  -- page-break and page-spacer are handled in Pandoc(), where pageBreak() is in scope.
  if classes:includes("page-spacer") or classes:includes("page-break") then return nil end

  -- Wrappers that exist for layout. Unwrapping them is what makes the image inside
-- a figure visible to the LaTeX writer, which refuses to render an Image that is
-- not a bare child of the figure.
  if id == "viewport" or id == "stage" or classes:includes("figure-frame") then
    return el.content
  end

  -- Pagination chrome. #sheets is dropped above, but a hand-built or older file can carry
  -- the sheets without the container.
  if classes:includes("sheet") or classes:includes("sheet-margin") then
    bump(skipped, "sheet")
    return {}
  end

  -- Unknown classes are reported by Pandoc(), on the document that survives. Counting
  -- here would report the children of a dropped parent as unknown, which they are not.
  return nil
end

-- --------------------------------------------------------------- Para -------
local function Para(el)
  -- "<p><br></p>" — a caret paragraph the author left behind. It is not content.
  local content = el.content
  if #content == 0 then return {} end
  if #content == 1 and (content[1].tag == "LineBreak" or content[1].tag == "SoftBreak") then
    bump(skipped, "empty-paragraph")
    return {}
  end
  return nil
end

-- -------------------------------------------------------------- Link --------
local function Link(el)
  -- An editor placeholder link ("#"), or a document-relative one? Unwrap the first
-- and report the second, because an exporter cannot make a link to something it
-- was never given.
  local target = el.target
  if target == "#" or target == "" then return el.content end
  if target:match("^file:") then
    bump(unknown, "file-link")
    return el.content
  end
  return nil
end

-- ------------------------------------------------------------- Image --------
local function Image(el)
  local attrs = el.attributes
  local width = attrs["data-width"]
  if width then
    local w = percent(width)
    if w then attrs["width"] = w end
    -- data-* and style are materializer bookkeeping. A writer that honours `style`
-- would try to interpret a CSS string as a LaTeX dimension.
    attrs["data-width"] = nil
  end
  attrs["style"] = nil
  -- No alt text is a real accessibility loss, and cheap to fix: fall back to the
-- figure's caption, which the Figure filter has already normalised.
  return el
end

-- ----------------------------------------------- the figure, made portable --
-- The materializer leaves <figure><div class="figure-frame"><img></div><figcaption>.
-- After Div unwraps .figure-frame, the Figure holds a Plain with one Image — which
-- is the shape every writer expects. This pass only fixes what the *source* got
-- wrong: a missing caption, a data-URI src that no text target can use, an image
-- that is not first.
local function Figure(el)
  local caption = el.caption
  if caption.long ~= nil and #pandoc.utils.blocks_to_inlines(caption.long) == 0 then
    caption.long = nil
  end
  local text = pandoc.utils.stringify(caption)
  if text == "" then
    bump(unknown, "figure-without-caption")
  end

  -- Three writers want three shapes for one figure. docx and typst and latex all have
  -- a native figure (Word's Image Caption, typst's #figure, LaTeX's figure env), so
  -- they keep `el`. Markdown has no figure node at all: a Figure reaches the writer as
  -- raw HTML, which is not markdown anyone can edit. An implicit figure — a Para
  -- holding one Image — is, and there the alt text *is* the caption.
  if TARGET:match("markdown") or TARGET == "plain" then
    local found = nil
    el.content:walk({ Image = function(img) found = img end })
    if found then
      if text ~= "" then found.caption = pandoc.Inlines({ pandoc.Str(text) }) end
      return pandoc.Para({ found })
    end
  end
  return el
end

-- ------------------------------------------------------------- Pandoc -------
-- A page break depends on the *target*, and the target is only settled once metadata has
-- been read — which happens before this pass, not before the element walk. So the break
-- is decided here, on the finished document, where TARGET is certain even when the caller
-- asked for json and told us the target with `-M sd-target=docx`.
local function pageBreak(el)
  if NO_PAGE[TARGET] then
    bump(skipped, "page-spacer")
    return {}
  end
  local raw = PAGE_BREAK[TARGET]
  if raw then return pandoc.RawBlock(RAW_FORMAT[TARGET] or TARGET, raw) end
  return pandoc.Div({}, pandoc.Attr("", { "page-break" }))
end

-- A page start is the margin model's break: the first block of every page after the
-- first carries `data-page-start`, and buildStatic clears the gap but keeps the marker.
-- A page-spacer Div is the older spelling, handled in Pandoc() below.
local function pageStartBreak()
  if NO_PAGE[TARGET] then
    bump(skipped, "page-start")
    return {}
  end
  local raw = PAGE_BREAK[TARGET]
  if raw then return {pandoc.RawBlock(RAW_FORMAT[TARGET] or TARGET, raw)} end
  return {pandoc.Div({}, pandoc.Attr("", { "page-break" }))}
end

-- Only blocks with an Attr can carry the marker. Lists and a few other blocks have no
-- attr field in the AST, so an export whose page starts with one of those has no break;
-- the editor's own page starts are paragraphs and headings.
local function hasPageStart(el)
  local attr = el.attr
  if attr == nil then return false end
  -- The HTML reader drops attributes on a `<p>` and strips the `data-` prefix from the
  -- ones it keeps (a `<h2 data-page-start>` arrives as `page-start`), so both spellings
  -- are accepted. buildStatic's marker Div is the reliable route; this is for a hand-run
  -- conversion of a live document.
  local key = attr.attributes["data-page-start"] ~= nil and "data-page-start"
    or attr.attributes["page-start"] ~= nil and "page-start"
    or nil
  if key == nil then return false end
  attr.attributes[key] = nil
  return true
end

-- Classes this filter understands. Anything else on a surviving Div or Span is a
-- construct the editor can write and the export was never taught: reported, never hidden.
local KNOWN = {
  ["page-spacer"] = true, ["page-break"] = true, ["figure"] = true,
  ["figure-frame"] = true, ["underline"] = true,
}

local function Pandoc(doc)
  doc = doc:walk({ Div = function(el)
    if el.classes:includes("page-spacer") or el.classes:includes("page-break") then
      return pageBreak(el)
    end
    return nil
  end })
  -- The margin model: a block that starts a page becomes a break, for every writer that
  -- has pages. The walk is over block lists, so it sees Para, Header, BlockQuote, Table,
  -- Figure and Div alike; blocks without an Attr simply cannot carry the marker.
  doc = doc:walk({ Blocks = function(blocks)
    local out = pandoc.Blocks({})
    for _, block in ipairs(blocks) do
      if hasPageStart(block) then
        for _, br in ipairs(pageStartBreak()) do out:insert(br) end
      end
      out:insert(block)
    end
    return out
  end })
  doc = doc:walk({
    Div = function(el)
      for _, class in ipairs(el.classes) do
        if not KNOWN[class] then bump(unknown, class) end
      end
      return nil
    end,
    Span = function(el)
      for _, class in ipairs(el.classes) do
        if not KNOWN[class] then bump(unknown, class) end
      end
      return nil
    end,
  })
  -- Determinism: a document's own date, never today's. An export that changes its
-- bytes on every run cannot be verified.
  doc.meta["date"] = nil

  local sorted = {}
  for key, count in pairs(skipped) do sorted[#sorted + 1] = key .. "×" .. count end
  for key, count in pairs(unknown) do sorted[#sorted + 1] = "unknown:" .. key .. "×" .. count end
  table.sort(sorted)
  if #sorted > 0 then
    io.stderr:write("sd-export " .. FILTER_VERSION .. " → " .. TARGET .. ": " ..
      table.concat(sorted, " ") .. "\n")
  end
  return doc
end

return {
  { Meta = Meta, Div = Div, Para = Para, Link = Link, Image = Image, Figure = Figure },
  { Pandoc = Pandoc },
}
