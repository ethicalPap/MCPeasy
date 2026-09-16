import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runChain } from "../src/runChain.js";
import type { GraphDoc } from "@mcpeasy/schema";

function docWithNodes(nodes: GraphDoc["nodes"]): GraphDoc {
  return {
    version: 1,
    server: { name: "s", version: "1", transport: "stdio", auth: { type: "none" }, env: [] },
    nodes,
  };
}

describe("runChain", () => {
  it("runs transform → return json with structuredContent", async () => {
    const doc = docWithNodes({
      a: { kind: "transform", op: "pick", pick: ["name"], next: "r" },
      r: { kind: "return", format: "json" },
    });
    const result = await runChain(doc, "a", { input: {}, env: {}, prev: { name: "Maya", junk: 1 } });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ name: "Maya" });
    expect(JSON.parse(result.content[0]!.text)).toEqual({ name: "Maya" });
  });

  it("return text renders template against scope", async () => {
    const doc = docWithNodes({
      r: { kind: "return", format: "text", template: "Hello {{input.who}}" },
    });
    const result = await runChain(doc, "r", { input: { who: "world" }, env: {}, prev: undefined });
    expect(result.content[0]!.text).toBe("Hello world");
  });

  it("wraps array results so structuredContent stays an object", async () => {
    const doc = docWithNodes({ r: { kind: "return", format: "json" } });
    const result = await runChain(doc, "r", { input: {}, env: {}, prev: [1, 2] });
    expect(result.structuredContent).toEqual({ result: [1, 2] });
  });

  it("unterminated chain becomes a runtime tool error", async () => {
    const doc = docWithNodes({
      a: { kind: "transform", op: "pick", pick: ["x"], next: null },
    });
    const result = await runChain(doc, "a", { input: {}, env: {}, prev: { x: 5 } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]!.text).toBe("chain never reaches a return node");
  });

  it("null entry becomes the same runtime tool error", async () => {
    const result = await runChain(docWithNodes({}), null, { input: {}, env: {}, prev: undefined });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("chain never reaches a return node");
  });

  it("runs named parallel branches concurrently, then resumes with ordered results", async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl: typeof fetch = async (input) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return new Response(JSON.stringify({ url: String(input) }), {
        headers: { "content-type": "application/json" },
      });
    };
    const doc = docWithNodes({
      p: {
        kind: "parallel",
        branches: [
          { name: "first", entry: "a" },
          { name: "second", entry: "b" },
        ],
        next: "r",
      },
      a: { kind: "action", http: { method: "GET", url: "https://x.test/a" }, next: null },
      b: { kind: "action", http: { method: "GET", url: "https://x.test/b" }, next: null },
      r: { kind: "return", format: "json" },
    } as never);
    const result = await runChain(
      doc,
      "p",
      { input: {}, env: {}, prev: undefined },
      { mode: "local", timeoutMs: 1_000, maxResponseBytes: 10_000, fetchImpl },
    );
    expect(peak).toBe(2);
    expect(result.structuredContent).toEqual({
      first: { url: "https://x.test/a" },
      second: { url: "https://x.test/b" },
    });
  });

  it("refuses local execution unless both the graph and host opt in", async () => {
    const doc = docWithNodes({
      c: { kind: "command", command: { executable: process.execPath, args: ["--version"], output: "text" }, next: "r" },
      r: { kind: "return", format: "json" },
    } as never);
    const result = await runChain(doc, "c", { input: {}, env: {}, prev: undefined }, {
      local: { enabled: false, timeoutMs: 1_000, maxOutputBytes: 10_000 },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/local execution is disabled/i);
  });

  it("runs direct commands without a shell and parses their selected output", async () => {
    const doc = docWithNodes({
      c: {
        kind: "command",
        command: {
          executable: process.execPath,
          args: ["--input-type=module", "--eval", "process.stdout.write(JSON.stringify({value: process.argv[1]}))", "{{input.value}}"],
          output: "json",
        },
        next: "r",
      },
      r: { kind: "return", format: "json" },
    } as never);
    const result = await runChain(doc, "c", { input: { value: "a;echo injected" }, env: {}, prev: undefined }, {
      local: { enabled: true, timeoutMs: 2_000, maxOutputBytes: 10_000 },
    });
    expect(result.structuredContent).toEqual({ value: "a;echo injected" });
  });

  it("runs a local Node script file and sends templated stdin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcpeasy-script-"));
    const path = join(directory, "tool.mjs");
    await writeFile(path, "let value = ''; for await (const chunk of process.stdin) value += chunk; process.stdout.write(JSON.stringify({ value }));");
    try {
      const doc = docWithNodes({
        s: {
          kind: "script",
          script: { runtime: "node", path, args: [], stdin: "{{input.value}}", output: "json" },
          next: "r",
        },
        r: { kind: "return", format: "json" },
      } as never);
      const result = await runChain(doc, "s", { input: { value: "hello" }, env: {}, prev: undefined }, {
        local: { enabled: true, timeoutMs: 2_000, maxOutputBytes: 10_000 },
      });
      expect(result.structuredContent).toEqual({ value: "hello" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not expose undeclared host secrets to local processes", async () => {
    const secretName = "MCPEASY_UNDECLARED_SECRET_TEST";
    process.env[secretName] = "must-not-leak";
    try {
      const doc = docWithNodes({
        c: {
          kind: "command",
          command: {
            executable: process.execPath,
            args: ["--input-type=module", "--eval", `process.stdout.write(process.env.${secretName} ?? "missing")`],
            output: "text",
          },
          next: "r",
        },
        r: { kind: "return", format: "text" },
      } as never);
      const result = await runChain(doc, "c", { input: {}, env: {}, prev: undefined }, {
        local: { enabled: true, timeoutMs: 2_000, maxOutputBytes: 10_000 },
      });
      expect(result.content[0]!.text).toBe("missing");
    } finally {
      delete process.env[secretName];
    }
  });

  it("runs inline JavaScript in a separate bounded process", async () => {
    const doc = docWithNodes({
      c: { kind: "code", language: "javascript", source: "return { doubled: input.value * 2 };", next: "r" },
      r: { kind: "return", format: "json" },
    } as never);
    const result = await runChain(doc, "c", { input: { value: 6 }, env: {}, prev: undefined }, {
      local: { enabled: true, timeoutMs: 2_000, maxOutputBytes: 10_000 },
    });
    expect(result.structuredContent).toEqual({ doubled: 12 });
  });

  it("blocks filesystem access from inline JavaScript", async () => {
    const doc = docWithNodes({
      c: { kind: "code", language: "javascript", source: "const { readFile } = await import('node:fs/promises'); return await readFile('package.json', 'utf8');", next: "r" },
      r: { kind: "return", format: "json" },
    } as never);
    const result = await runChain(doc, "c", { input: {}, env: {}, prev: undefined }, {
      local: { enabled: true, timeoutMs: 2_000, maxOutputBytes: 10_000 },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("custom code failed");
  });

  it("runs inline TypeScript by stripping its types", async () => {
    // TypeScript is executed on the BUNDLED Node, so this must pass on every
    // machine — no interpreter to install. The annotation is the point: the
    // same source would be a syntax error if the types were not erased.
    const doc = docWithNodes({
      c: {
        kind: "code",
        language: "typescript",
        source: "const n: number = input.value as number;\nconst out: Record<string, number> = { doubled: n * 2 };\nreturn out;",
        next: "r",
      },
      r: { kind: "return", format: "json" },
    } as never);
    const result = await runChain(doc, "c", { input: { value: 6 }, env: {}, prev: undefined }, {
      local: { enabled: true, timeoutMs: 20_000, maxOutputBytes: 10_000 },
    });
    expect(result.structuredContent).toEqual({ doubled: 12 });
  });

  it("treats a code node with no language as javascript", async () => {
    // Docs written before `language` was widened hold the literal
    // "javascript"; this covers the defensive path where the field is absent
    // entirely, which must keep the original behavior rather than throwing.
    const doc = docWithNodes({
      c: { kind: "code", source: "return { ok: true };", next: "r" },
      r: { kind: "return", format: "json" },
    } as never);
    const result = await runChain(doc, "c", { input: {}, env: {}, prev: undefined }, {
      local: { enabled: true, timeoutMs: 20_000, maxOutputBytes: 10_000 },
    });
    expect(result.structuredContent).toEqual({ ok: true });
  });

  it("names the missing interpreter instead of reporting a generic spawn failure", async () => {
    // The user-visible payoff of the detection work: "local process failed to
    // start" is unactionable, whereas naming the runtime tells them what to
    // install. Uses a language whose executable cannot plausibly exist.
    const doc = docWithNodes({
      c: { kind: "code", language: "ruby", source: "1", next: "r" },
      r: { kind: "return", format: "json" },
    } as never);
    const previousPath = process.env.PATH;
    // Empty PATH guarantees the interpreter is unfindable even on a machine
    // that happens to have Ruby installed, so the test is deterministic.
    process.env.PATH = "";
    try {
      const result = await runChain(doc, "c", { input: {}, env: {}, prev: undefined }, {
        local: { enabled: true, timeoutMs: 10_000, maxOutputBytes: 10_000 },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/needs "ruby" on PATH/);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("terminates custom code that exceeds its runtime limit", async () => {
    const doc = docWithNodes({
      c: { kind: "code", language: "javascript", source: "while (true) {}", next: "r" },
      r: { kind: "return", format: "json" },
    } as never);
    const result = await runChain(doc, "c", { input: {}, env: {}, prev: undefined }, {
      local: { enabled: true, timeoutMs: 100, maxOutputBytes: 10_000 },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/timed out/i);
  });

  it("maps engine errors to isError results with clean text", async () => {
    const doc = docWithNodes({
      a: { kind: "transform", op: "template", next: null }, // missing template
    });
    const result = await runChain(doc, "a", { input: {}, env: {}, prev: undefined });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/requires a template/);
  });

  it("dangling step id becomes a tool error, not a throw", async () => {
    const result = await runChain(docWithNodes({}), "ghost", { input: {}, env: {}, prev: undefined });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/not an execution node/);
  });

  it("runtime cycle guard trips at the step limit", async () => {
    // Two transforms pointing at each other — validation would reject this
    // doc, but runChain must survive drafts that bypassed validation.
    const doc = docWithNodes({
      a: { kind: "transform", op: "pick", pick: ["x"], next: "b" },
      b: { kind: "transform", op: "pick", pick: ["x"], next: "a" },
    });
    const result = await runChain(doc, "a", { input: {}, env: {}, prev: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/exceeded/);
  });

  it("unknown internal failures never leak details", async () => {
    const doc = docWithNodes({
      a: {
        kind: "transform",
        op: "template",
        // getter that throws a non-EngineError when read
        get template(): string {
          throw new Error("secret internal state");
        },
        next: null,
      } as never,
    });
    const result = await runChain(doc, "a", { input: {}, env: {}, prev: undefined });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("internal engine error");
  });
});
