// Lexical syntax highlighting for the Advanced-mode code panel (Graph JSON +
// TypeScript SDK example). Deliberately a ~small hand-rolled lexer, not a
// TextMate/Shiki dependency: both views show MACHINE-GENERATED text whose
// token shapes we control, so a full grammar engine would be megabytes of
// WASM for no visible gain. Pure and DOM-free so it unit-tests under Node.
//
// Invariant: concatenating token texts MUST reproduce the input exactly —
// the JSON tab renders these tokens *behind a transparent textarea*, and any
// dropped/duplicated character would desynchronize the overlay from the
// real text (caret and colors drift apart). Tests assert this round-trip.

export type TokenKind =
  | "plain" // punctuation/whitespace — rendered in the default foreground
  | "key" // JSON object key
  | "string"
  | "number"
  | "keyword" // declaration keywords + literals (const, true, null, ...)
  | "control" // control-flow keywords (import, return, if, await, ...)
  | "comment"
  | "function" // identifier directly before a call paren
  | "type" // Capitalized identifier (class/type by convention)
  | "variable"; // any other identifier

export interface Token {
  text: string;
  kind: TokenKind;
}

/** Token builder that merges adjacent plain runs to keep span count low. */
class Tokens {
  private out: Token[] = [];
  push(text: string, kind: TokenKind): void {
    if (text === "") return;
    const last = this.out[this.out.length - 1];
    if (last && last.kind === kind && (kind === "plain" || kind === "comment")) {
      last.text += text;
    } else {
      this.out.push({ text, kind });
    }
  }
  list(): Token[] {
    return this.out;
  }
}

const JSON_LITERALS = new Set(["true", "false", "null"]);

/**
 * Tokenize JSON text. Purely lexical — never parses — so it cannot throw on
 * the half-typed/invalid JSON the editable Graph JSON buffer often holds.
 * Keys are distinguished from string values by looking ahead for a colon,
 * matching how VS Code's JSON grammar scopes them differently.
 */
export function tokenizeJson(text: string): Token[] {
  const toks = new Tokens();
  let i = 0;
  // charAt (never undefined; "" out of bounds) keeps the lexer clean under
  // noUncheckedIndexedAccess — "" fails every equality/regex test below.
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '"') {
      const start = i;
      i++;
      // JSON strings cannot contain raw newlines; stopping there keeps an
      // unterminated string from swallowing the rest of the document.
      while (i < text.length && text.charAt(i) !== '"' && text.charAt(i) !== "\n") {
        if (text.charAt(i) === "\\") i++; // skip the escaped char (incl. \")
        i++;
      }
      if (text.charAt(i) === '"') i++;
      // Lookahead past whitespace: a colon means this string is a key.
      let j = i;
      while (j < text.length && /\s/.test(text.charAt(j))) j++;
      toks.push(text.slice(start, i), text.charAt(j) === ":" ? "key" : "string");
    } else if (/\d/.test(ch) || (ch === "-" && /\d/.test(text.charAt(i + 1)))) {
      const start = i;
      if (ch === "-") i++;
      while (i < text.length && /[\d.]/.test(text.charAt(i))) i++;
      if (text.charAt(i) === "e" || text.charAt(i) === "E") {
        i++;
        if (text.charAt(i) === "+" || text.charAt(i) === "-") i++;
        while (i < text.length && /\d/.test(text.charAt(i))) i++;
      }
      toks.push(text.slice(start, i), "number");
    } else if (/[a-z]/.test(ch)) {
      const start = i;
      while (i < text.length && /[a-z]/.test(text.charAt(i))) i++;
      const word = text.slice(start, i);
      toks.push(word, JSON_LITERALS.has(word) ? "keyword" : "plain");
    } else {
      toks.push(ch, "plain");
      i++;
    }
  }
  return toks.list();
}

// ---------------------------------------------------------------------------
// Custom-code languages
// ---------------------------------------------------------------------------
// The custom-code block accepts several languages, and each needs its own
// keyword sets and comment/string syntax. Rather than one lexer per language
// (eight near-copies that would drift), there is ONE parameterized lexer plus
// a small per-language dialect table. Only the parts that genuinely differ —
// comment markers, string delimiters, keyword sets — are data.
//
// The same invariant as the JSON/TS lexers applies and is tested: concatenated
// token text must reproduce the input exactly, because these tokens render
// behind a transparent textarea in the code overlay.

export interface Dialect {
  /** Line-comment openers, longest-first so "//" wins over "/". */
  lineComment: string[];
  /** Block comment as [open, close]; omitted when the language has none. */
  blockComment?: [string, string];
  /** Quote characters that start a string literal. */
  quotes: string[];
  /** Quotes that may span multiple lines (template/heredoc style). */
  multilineQuotes?: string[];
  control: Set<string>;
  keyword: Set<string>;
  /** Sigil characters that begin an identifier ($foo, @foo). */
  identifierPrefixes?: string[];
}

const PYTHON_DIALECT: Dialect = {
  lineComment: ["#"],
  quotes: ['"', "'"],
  control: new Set(["if", "elif", "else", "for", "while", "return", "yield", "break", "continue", "try", "except", "finally", "raise", "with", "await", "async", "import", "from", "pass", "assert", "match", "case"]),
  keyword: new Set(["def", "class", "lambda", "global", "nonlocal", "del", "in", "is", "not", "and", "or", "True", "False", "None", "self", "as"]),
};

const SHELL_DIALECT: Dialect = {
  lineComment: ["#"],
  quotes: ['"', "'"],
  control: new Set(["if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "return", "break", "continue", "exit"]),
  keyword: new Set(["function", "local", "export", "declare", "readonly", "source", "echo", "printf", "true", "false", "in"]),
  identifierPrefixes: ["$"],
};

const POWERSHELL_DIALECT: Dialect = {
  lineComment: ["#"],
  blockComment: ["<#", "#>"],
  quotes: ['"', "'"],
  control: new Set(["if", "elseif", "else", "foreach", "for", "while", "do", "switch", "return", "break", "continue", "try", "catch", "finally", "throw"]),
  keyword: new Set(["function", "param", "begin", "process", "end", "filter", "in", "class"]),
  identifierPrefixes: ["$"],
};

const RUBY_DIALECT: Dialect = {
  lineComment: ["#"],
  quotes: ['"', "'"],
  control: new Set(["if", "elsif", "else", "unless", "case", "when", "while", "until", "for", "return", "yield", "break", "next", "begin", "rescue", "ensure", "raise", "then", "do", "end"]),
  keyword: new Set(["def", "class", "module", "self", "nil", "true", "false", "require", "attr_accessor", "lambda", "proc", "in", "and", "or", "not"]),
  identifierPrefixes: ["@", "$", ":"],
};

const PHP_DIALECT: Dialect = {
  lineComment: ["//", "#"],
  blockComment: ["/*", "*/"],
  quotes: ['"', "'"],
  control: new Set(["if", "elseif", "else", "foreach", "for", "while", "do", "switch", "case", "default", "return", "break", "continue", "try", "catch", "finally", "throw", "yield"]),
  keyword: new Set(["function", "class", "interface", "trait", "extends", "implements", "public", "private", "protected", "static", "const", "new", "true", "false", "null", "array", "echo", "print", "use", "namespace", "as", "fn"]),
  identifierPrefixes: ["$"],
};

const GO_DIALECT: Dialect = {
  lineComment: ["//"],
  blockComment: ["/*", "*/"],
  quotes: ['"', "'"],
  multilineQuotes: ["`"],
  control: new Set(["if", "else", "for", "range", "return", "break", "continue", "switch", "case", "default", "fallthrough", "go", "defer", "select", "goto"]),
  keyword: new Set(["func", "var", "const", "type", "struct", "interface", "map", "chan", "package", "import", "nil", "true", "false", "make", "new", "string", "int", "int64", "float64", "bool", "any", "error"]),
};

/** Generic lexer driven by a Dialect. Mirrors tokenizeTs's classification
 *  rules (Capitalized → type, before "(" → function) so every language in the
 *  overlay is colored by the same visual logic. */
function tokenizeDialect(text: string, dialect: Dialect): Token[] {
  const toks = new Tokens();
  // Longest-first so a two-character opener is never split by a one-character
  // one that happens to be its prefix (PHP has both "//" and "#").
  const lineComments = [...dialect.lineComment].sort((a, b) => b.length - a.length);
  const prefixes = dialect.identifierPrefixes ?? [];
  const multiline = new Set(dialect.multilineQuotes ?? []);
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    const lineOpener = lineComments.find((opener) => text.startsWith(opener, i));
    if (dialect.blockComment && text.startsWith(dialect.blockComment[0], i)) {
      const close = dialect.blockComment[1];
      const end = text.indexOf(close, i + dialect.blockComment[0].length);
      const stop = end === -1 ? text.length : end + close.length;
      toks.push(text.slice(i, stop), "comment");
      i = stop;
    } else if (lineOpener !== undefined) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      toks.push(text.slice(i, stop), "comment");
      i = stop;
    } else if (dialect.quotes.includes(ch) || multiline.has(ch)) {
      const quote = ch;
      const start = i;
      const spans = multiline.has(quote);
      i++;
      while (i < text.length && text.charAt(i) !== quote && (spans || text.charAt(i) !== "\n")) {
        if (text.charAt(i) === "\\") i++;
        i++;
      }
      if (text.charAt(i) === quote) i++;
      toks.push(text.slice(start, i), "string");
    } else if (/\d/.test(ch)) {
      const start = i;
      while (i < text.length && /[\w.]/.test(text.charAt(i))) i++;
      toks.push(text.slice(start, i), "number");
    } else if (prefixes.includes(ch) && /[A-Za-z_]/.test(text.charAt(i + 1))) {
      // $foo / @foo / :foo read as one variable token including the sigil,
      // which is how VS Code scopes them in shell, PHP and Ruby.
      const start = i;
      i++;
      while (i < text.length && /[\w]/.test(text.charAt(i))) i++;
      toks.push(text.slice(start, i), "variable");
    } else if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < text.length && /[\w]/.test(text.charAt(i))) i++;
      const word = text.slice(start, i);
      if (dialect.control.has(word)) {
        toks.push(word, "control");
      } else if (dialect.keyword.has(word)) {
        toks.push(word, "keyword");
      } else {
        let j = i;
        while (j < text.length && (text.charAt(j) === " " || text.charAt(j) === "\t")) j++;
        if (/[A-Z]/.test(word.charAt(0))) {
          toks.push(word, "type");
        } else if (text.charAt(j) === "(") {
          toks.push(word, "function");
        } else {
          toks.push(word, "variable");
        }
      }
    } else {
      toks.push(ch, "plain");
      i++;
    }
  }
  return toks.list();
}

/**
 * Tokenize a custom-code block for the given language. JavaScript and
 * TypeScript reuse tokenizeTs so the overlay and the existing Advanced-mode
 * TypeScript tab cannot disagree about the same syntax.
 */
export function tokenizeCode(text: string, language: string): Token[] {
  switch (language) {
    case "python":
      return tokenizeDialect(text, PYTHON_DIALECT);
    case "bash":
      return tokenizeDialect(text, SHELL_DIALECT);
    case "powershell":
      return tokenizeDialect(text, POWERSHELL_DIALECT);
    case "ruby":
      return tokenizeDialect(text, RUBY_DIALECT);
    case "php":
      return tokenizeDialect(text, PHP_DIALECT);
    case "go":
      return tokenizeDialect(text, GO_DIALECT);
    default:
      // javascript, typescript, and any future language default to the TS
      // lexer rather than falling back to unstyled plain text.
      return tokenizeTs(text);
  }
}

// Split matching VS Code's scopes: keyword.control renders in the accent
// purple/magenta while declaration keywords render blue.
const TS_CONTROL = new Set([
  "import", "export", "from", "return", "if", "else", "for", "of", "while",
  "do", "switch", "case", "break", "continue", "throw", "try", "catch",
  "finally", "await", "yield", "default",
]);
const TS_KEYWORD = new Set([
  "const", "let", "var", "function", "class", "extends", "implements",
  "interface", "type", "enum", "this", "super", "new", "true", "false",
  "null", "undefined", "typeof", "instanceof", "in", "void", "async",
  "static", "get", "set", "as", "satisfies", "keyof", "readonly", "declare",
  "namespace", "abstract", "public", "private", "protected",
]);

/**
 * Tokenize TypeScript/JavaScript source. Approximations vs a real grammar:
 * template literals are one string token (no ${} interpolation splitting)
 * and identifier classification is convention-based (Capitalized → type,
 * before "(" → function call). Fine for the generated SDK example.
 */
export function tokenizeTs(text: string): Token[] {
  const toks = new Tokens();
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      toks.push(text.slice(i, stop), "comment");
      i = stop;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      toks.push(text.slice(i, stop), "comment");
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      const start = i;
      i++;
      // Backtick strings may span lines; quote strings stop at a newline so
      // an unterminated literal can't repaint the whole rest of the file.
      while (i < text.length && text.charAt(i) !== quote && (quote === "`" || text.charAt(i) !== "\n")) {
        if (text.charAt(i) === "\\") i++;
        i++;
      }
      if (text.charAt(i) === quote) i++;
      toks.push(text.slice(start, i), "string");
    } else if (/\d/.test(ch)) {
      const start = i;
      // Covers ints, decimals, hex/binary/octal and exponent digits; the
      // sign of an exponent is consumed via the e/E branch below.
      while (i < text.length && /[\w.]/.test(text.charAt(i))) {
        if ((text.charAt(i) === "e" || text.charAt(i) === "E") && (text.charAt(i + 1) === "+" || text.charAt(i + 1) === "-")) i++;
        i++;
      }
      toks.push(text.slice(start, i), "number");
    } else if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      while (i < text.length && /[\w$]/.test(text.charAt(i))) i++;
      const word = text.slice(start, i);
      if (TS_CONTROL.has(word)) {
        toks.push(word, "control");
      } else if (TS_KEYWORD.has(word)) {
        toks.push(word, "keyword");
      } else {
        // Capitalization outranks call-lookahead: VS Code paints `new
        // Server(...)` teal (type), not function yellow. Lookahead skips
        // spaces only (not newlines: a name at end-of-line is not a call
        // even if the next line opens with a paren).
        let j = i;
        while (j < text.length && (text.charAt(j) === " " || text.charAt(j) === "\t")) j++;
        if (/[A-Z]/.test(word.charAt(0))) {
          toks.push(word, "type");
        } else if (text.charAt(j) === "(") {
          toks.push(word, "function");
        } else {
          toks.push(word, "variable");
        }
      }
    } else {
      toks.push(ch, "plain");
      i++;
    }
  }
  return toks.list();
}
