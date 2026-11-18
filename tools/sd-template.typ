// tools/sd-template.typ — the standalone Typst template for this editor's documents.
//
// Pandoc's `-t typst` writes the *body*: `= Heading`, `- list`, `#figure(image(…), caption: …)`,
// `#table(…)`, `#pagebreak()`. A template is the page around it, and this one is written the
// long way (no `conf` module) so it survives a pandoc upgrade without inheriting a new
// template API. It is used with `-s --template=tools/sd-template.typ`, and the CLI does that
// by default for `--to=typ`.
//
// The page geometry matches tools/reference.mjs — Letter, 0.9 in — because a .typ and a .docx
// of the same document should not disagree about the paper.

#set document(title: [$if(title)$$title$$endif$])

#set page(
  paper: "us-letter",
  margin: (x: 0.9in, y: 0.9in),
  numbering: "1",
)
// Typst wants a primary language subtag; pandoc writes the whole tag ("en-US").
#let langtag = "$if(lang)$$lang$$else$en$endif$"
#set text(
  font: ("Georgia", "New Computer Modern", "Linux Libertine"),
  size: 11pt,
  lang: langtag.split("-").first(),
)
#set par(justify: true, leading: 0.72em)
#set smartquote(enabled: false)
#set list(indent: 1.2em, spacing: 0.6em)
#set enum(indent: 1.2em, spacing: 0.6em)
#set table(inset: (x: 6pt, y: 5pt), stroke: none)

// A rule above every level-1 heading, and a page break before the second one — the
// document's own page-spacers arrive as #pagebreak(), so this is only the default rhythm.
#show heading.where(level: 1): it => block(above: 1.6em, below: 0.7em)[
  #line(length: 100%, stroke: 0.5pt + rgb("#dfe1e6"))
  #v(0.4em)
  #set text(size: 18pt, weight: "bold", fill: rgb("#14181d"))
  #it.body
]
#show heading.where(level: 2): it => block(above: 1.4em, below: 0.5em)[
  #set text(size: 13pt, weight: "bold", fill: rgb("#2f3540"))
  #it.body
]
#show heading.where(level: 3): it => block(above: 1.2em, below: 0.4em)[
  #set text(size: 11.5pt, weight: "bold", fill: rgb("#2f3540"))
  #it.body
]

#show quote.where(block: true): it => block(
  inset: (left: 1em, right: 0.5em), above: 0.8em, below: 1em,
  stroke: (left: 2pt + rgb("#c9ced6")),
)[#set text(fill: rgb("#555c66"), style: "italic"); #it.body]

#show raw.where(block: true): it => block(
  inset: 8pt, fill: rgb("#f6f8fa"), radius: 3pt, above: 0.8em, below: 1em, width: 100%,
)[#it]

#show figure.where(kind: image): set figure.caption(position: bottom)
#show figure.caption: set text(size: 9.5pt, fill: rgb("#555c66"))
#show figure: set block(breakable: false)

$if(highlighting-definitions)$
// syntax highlighting functions from skylighting:
$highlighting-definitions$
$endif$

$for(header-includes)$
$header-includes$

$endfor$

$if(title)$
#align(center)[
  #set text(size: 26pt, weight: "bold", fill: rgb("#14181d"))
  #[$title$]
]
#v(1em)
$endif$

$body$
