import { describe, expect, it } from "vitest";
import { tokenizeCode, tokenizeJson, tokenizeTs, type Token } from "../src/renderer/src/highlight";

// The overlay-editor invariant: concatenated token text must equal the input
// EXACTLY, or the colored layer desynchronizes from the textarea's glyphs.
function joined(tokens: Token[]): string {
  return tokens.map((t) => t.text).join("");
}

describe("tokenizeJson", () => {
  it("round-trips the input exactly", () => {
    const src = '{\n  "name": "my-server",\n  "count": -3.5e+2,\n  "on": true,\n  "x": null\n}\n';
    expect(joined(tokenizeJson(src))).toBe(src);
  });

  it("distinguishes keys from string values by colon lookahead", () => {
    const toks = tokenizeJson('{ "name": "my-server" }');
    expect(toks.find((t) => t.text === '"name"')?.kind).toBe("key");
    expect(toks.find((t) => t.text === '"my-server"')?.kind).toBe("string");
  });

  it("handles keys whose colon sits on the next line", () => {
    const toks = tokenizeJson('{ "key"\n : 1 }');
    expect(toks.find((t) => t.text === '"key"')?.kind).toBe("key");
  });

  it("colors numbers and literals", () => {
    const toks = tokenizeJson('[1, -2.5, 3e10, true, false, null]');
    expect(toks.find((t) => t.text === "-2.5")?.kind).toBe("number");
    expect(toks.find((t) => t.text === "3e10")?.kind).toBe("number");
    expect(toks.find((t) => t.text === "true")?.kind).toBe("keyword");
    expect(toks.find((t) => t.text === "null")?.kind).toBe("keyword");
  });

  it("survives escaped quotes inside strings", () => {
    const src = '{ "a": "say \\"hi\\"" }';
    const toks = tokenizeJson(src);
    expect(joined(toks)).toBe(src);
    expect(toks.find((t) => t.text === '"say \\"hi\\""')?.kind).toBe("string");
  });

  it("never lets an unterminated string swallow following lines", () => {
    const src = '{ "broken: 1,\n  "next": 2 }';
    const toks = tokenizeJson(src);
    expect(joined(toks)).toBe(src);
    // The line after the bad string still tokenizes its key.
    expect(toks.find((t) => t.text === '"next"')?.kind).toBe("key");
  });

  it("handles empty input", () => {
    expect(tokenizeJson("")).toEqual([]);
  });
});

describe("tokenizeTs", () => {
  it("round-trips the input exactly", () => {
    const src = 'import { Server } from "@modelcontextprotocol/sdk/server/index.js";\n// comment\nconst n = 42;\nawait server.connect(t);\n';
    expect(joined(tokenizeTs(src))).toBe(src);
  });

  it("classifies control keywords, declarations, comments and strings", () => {
    const toks = tokenizeTs('import x from "y"; // hi\nconst z = `tpl`;');
    expect(toks.find((t) => t.text === "import")?.kind).toBe("control");
    expect(toks.find((t) => t.text === "const")?.kind).toBe("keyword");
    expect(toks.find((t) => t.text === '"y"')?.kind).toBe("string");
    expect(toks.find((t) => t.text === "// hi")?.kind).toBe("comment");
    expect(toks.find((t) => t.text === "`tpl`")?.kind).toBe("string");
  });

  it("marks call names as functions and Capitalized names as types", () => {
    const toks = tokenizeTs("new Server(opts); connect(x); foo.bar");
    expect(toks.find((t) => t.text === "Server")?.kind).toBe("type");
    expect(toks.find((t) => t.text === "connect")?.kind).toBe("function");
    expect(toks.find((t) => t.text === "foo")?.kind).toBe("variable");
  });

  it("keeps block comments as one token across lines", () => {
    const src = "/* a\n b */ let x";
    const toks = tokenizeTs(src);
    expect(joined(toks)).toBe(src);
    expect(toks[0]?.kind).toBe("comment");
    expect(toks[0]?.text).toBe("/* a\n b */");
  });

  it("does not treat a division slash as a comment", () => {
    const toks = tokenizeTs("a / b");
    expect(toks.some((t) => t.kind === "comment")).toBe(false);
    expect(joined(toks)).toBe("a / b");
  });

  it("survives an unterminated template literal", () => {
    const src = "const s = `abc\ndef";
    const toks = tokenizeTs(src);
    expect(joined(toks)).toBe(src);
  });
});

describe("tokenizeCode", () => {
  // One realistic snippet per language, each exercising that dialect's own
  // comment marker, string form and sigils — the parts that actually differ.
  const samples: Record<string, string> = {
    python: "# comment\ndef go(x):\n    return {'k': x * 2}\n",
    bash: '# comment\nif [ -n "$MCPEASY_INPUT" ]; then\n  echo "$MCPEASY_INPUT"\nfi\n',
    powershell: "<# block #>\n$mcp_input.value * 2\nforeach ($i in 1..3) { Write-Output $i }\n",
    ruby: "# comment\ndef go(x)\n  { 'k' => @value }\nend\n",
    php: "// comment\n# hash comment\nfunction go($input) { return ['k' => $input]; }\n",
    go: '// comment\nfunc run() (any, error) {\n\treturn map[string]any{"k": 1}, nil\n}\n',
    javascript: "// comment\nconst x = `tpl`;\nreturn { ok: true };\n",
    typescript: "const n: number = 1;\nreturn n;\n",
  };

  // THE load-bearing invariant: the overlay paints these tokens behind a
  // transparent textarea, so a single dropped or duplicated character makes
  // every color downstream of it land on the wrong glyph.
  for (const [language, src] of Object.entries(samples)) {
    it(`round-trips ${language} exactly`, () => {
      expect(joined(tokenizeCode(src, language))).toBe(src);
    });
  }

  it("round-trips every language against text containing no syntax at all", () => {
    // Guards the fallback branches: a half-typed buffer must never throw or
    // lose characters, which is the state the editor is in while typing.
    const messy = "\"unterminated\n'also\n/* unclosed\n$\n\t  \n#\n";
    for (const language of Object.keys(samples)) {
      expect(joined(tokenizeCode(messy, language))).toBe(messy);
    }
  });

  it("colors python comments and keywords, not bash's", () => {
    const toks = tokenizeCode("# note\ndef go():\n    return 1\n", "python");
    expect(toks.find((t) => t.text.startsWith("#"))?.kind).toBe("comment");
    expect(toks.find((t) => t.text === "def")?.kind).toBe("keyword");
    expect(toks.find((t) => t.text === "return")?.kind).toBe("control");
  });

  it("treats $-prefixed names as one variable token in shell dialects", () => {
    const toks = tokenizeCode('echo "$MCPEASY_INPUT"', "bash");
    // The sigil must be part of the token: splitting it would color the $
    // with the surrounding punctuation and the name separately.
    expect(joined(toks)).toBe('echo "$MCPEASY_INPUT"');
    const inString = toks.find((t) => t.text.includes("MCPEASY_INPUT"));
    expect(inString?.kind).toBe("string");
  });

  it("recognizes PowerShell block comments, which no other dialect here has", () => {
    const toks = tokenizeCode("<# hidden #>$x", "powershell");
    expect(toks[0]?.kind).toBe("comment");
    expect(toks[0]?.text).toBe("<# hidden #>");
  });

  it("treats PHP's # as a comment but Go's // only", () => {
    expect(tokenizeCode("# c", "php")[0]?.kind).toBe("comment");
    // Go has no # comment; it must NOT be swallowed, or the rest of the line
    // would lose its coloring.
    expect(tokenizeCode("# c", "go")[0]?.kind).not.toBe("comment");
  });

  it("lets Go backtick strings span lines while quoted ones stop at the newline", () => {
    const spanning = "`line1\nline2`";
    const toks = tokenizeCode(spanning, "go");
    expect(toks[0]?.text).toBe(spanning);
    // An unterminated double-quoted string must not repaint the whole file.
    const unterminated = tokenizeCode('"oops\nnext', "go");
    expect(unterminated[0]?.text).toBe('"oops');
  });

  it("falls back to the TypeScript lexer for javascript and unknown languages", () => {
    const src = "const x = 1;";
    expect(tokenizeCode(src, "javascript")).toEqual(tokenizeTs(src));
    // A language id this build does not know must still be colored, not
    // rendered as undifferentiated plain text.
    expect(tokenizeCode(src, "brand-new-language")).toEqual(tokenizeTs(src));
  });

  it("returns nothing for empty input in every language", () => {
    for (const language of Object.keys(samples)) {
      expect(tokenizeCode("", language)).toEqual([]);
    }
  });
});
