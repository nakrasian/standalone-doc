/**
 * lib/indent.mjs — template-aware dedent/indent.
 *
 * The line-based version (strip the minimum indent, re-add it) corrupts any
 * multi-line template literal whose lines sit at column 0: re-indenting the
 * code would silently insert whitespace *inside the string*. figures.js embeds
 * two such literals (the island snapshot shim and bridge), so the build needs
 * to know which lines are code and which are string content.
 *
 * scanTemplateLines() answers exactly one question per line: "does this line
 * begin inside a template literal?" It is a scanner, not a parser: it tracks
 * line/block comments, single/double quoted strings, template literals with
 * `${}` nesting, and regex literals (using the standard previous-token
 * heuristic, which is what makes a `/` inside a regex not look like a comment).
 *
 * Beyond that it deliberately knows nothing about JavaScript. It cannot decide
 * whether a program is valid, only where strings start and end.
 */

const REGEX_PRECEDERS = new Set([
  "",
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
]);
const REGEX_PRECEDER_WORDS = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
  "instanceof",
  "throw",
]);

/**
 * For every line, true when the line starts inside a template literal (that is,
 * its leading whitespace is string content and must not be touched).
 */
export function scanTemplateLines(text) {
  const mask = [];
  let i = 0;
  let mode = "code"; // code | line | block | sq | dq | tpl
  let braceDepth = 0;
  const templateStack = [];
  let lastTok = "";

  const remember = (token) => {
    lastTok = token;
  };

  const skipRegex = () => {
    i++; // opening /
    let inClass = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "\n") return; // unterminated; let the caller resync
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) {
        i++;
        while (i < text.length && /[a-z]/i.test(text[i])) i++;
        remember("/");
        return;
      }
      i++;
    }
  };

  mask.push(false); // line 0 always starts in code

  while (i < text.length) {
    const ch = text[i];

    if (mode === "code") {
      if (ch === "\n") {
        mask.push(false);
        i++;
        continue;
      }
      if (ch === "/" && text[i + 1] === "/") {
        mode = "line";
        i += 2;
        continue;
      }
      if (ch === "/" && text[i + 1] === "*") {
        mode = "block";
        i += 2;
        continue;
      }
      if (ch === "/") {
        if (REGEX_PRECEDERS.has(lastTok) || REGEX_PRECEDER_WORDS.has(lastTok)) {
          skipRegex();
          continue;
        }
        remember("/");
        i++;
        continue;
      }
      if (ch === "'") {
        mode = "sq";
        i++;
        continue;
      }
      if (ch === '"') {
        mode = "dq";
        i++;
        continue;
      }
      if (ch === "`") {
        mode = "tpl";
        i++;
        continue;
      }
      if (ch === "{") {
        braceDepth++;
        remember("{");
        i++;
        continue;
      }
      if (ch === "}") {
        if (templateStack.length && braceDepth === templateStack[templateStack.length - 1]) {
          templateStack.pop();
          braceDepth--;
          mode = "tpl";
        } else {
          braceDepth--;
        }
        remember("}");
        i++;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let word = "";
        while (i < text.length && /[A-Za-z0-9_$]/.test(text[i])) word += text[i++];
        remember(word);
        continue;
      }
      if (/[0-9]/.test(ch)) {
        while (i < text.length && /[0-9a-fx._]/i.test(text[i])) i++;
        remember("0");
        continue;
      }
      if (!/\s/.test(ch)) remember(ch);
      i++;
      continue;
    }

    if (mode === "line") {
      if (ch === "\n") {
        mode = "code";
        mask.push(false);
      }
      i++;
      continue;
    }

    if (mode === "block") {
      if (ch === "\n") mask.push(mask[mask.length - 1]); // still inside
      if (ch === "*" && text[i + 1] === "/") {
        mode = "code";
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (mode === "sq" || mode === "dq") {
      const quote = mode === "sq" ? "'" : '"';
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "\n") {
        /* Unterminated string: be forgiving and resync at the newline. */
        mode = "code";
        mask.push(false);
        i++;
        continue;
      }
      if (ch === quote) mode = "code";
      i++;
      continue;
    }

    if (mode === "tpl") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        mode = "code";
        remember("`");
        i++;
        continue;
      }
      if (ch === "$" && text[i + 1] === "{") {
        braceDepth++;
        templateStack.push(braceDepth);
        mode = "code";
        i += 2;
        continue;
      }
      if (ch === "\n") {
        mask.push(true);
        i++;
        continue;
      }
      i++;
      continue;
    }
  }

  return mask;
}

const indentOf = (line) => /^[ \t]*/.exec(line)[0];

/**
 * Strip the minimum indent from code lines only. Template-literal lines keep
 * their exact bytes, and `indent` records what to re-add.
 */
export function dedentCode(text) {
  const lines = text.split("\n");
  const mask = scanTemplateLines(text);
  let min = Infinity;
  for (const [i, line] of lines.entries()) {
    if (mask[i] || line.trim() === "") continue;
    min = Math.min(min, indentOf(line).length);
  }
  if (!Number.isFinite(min) || min === 0) return { text, indent: "" };
  return {
    text: lines
      .map((line, i) => (mask[i] || line.trim() === "" ? line : line.slice(min)))
      .join("\n"),
    indent: " ".repeat(min),
  };
}

/** The exact inverse of dedentCode. */
export function indentCode(text, indent) {
  if (!indent) return text;
  const lines = text.split("\n");
  const mask = scanTemplateLines(text);
  return lines
    /* Whitespace-only lines are skipped by dedentCode when it measures and when it
       strips, so they have to be skipped here too: indenting them makes the pair
       irreversible, and `parseSource` then refuses to trust the block. */
    .map((line, i) => (mask[i] || line.trim() === "" ? line : indent + line))
    .join("\n");
}
