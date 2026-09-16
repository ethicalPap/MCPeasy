import { describe, expect, it } from "vitest";
import { validateGraphDoc } from "../src/validate.js";
import { CODE_LANGUAGES, type GraphDoc } from "../src/types.js";

// Builder for a minimal valid doc; each test then breaks one thing.
function baseDoc(): GraphDoc {
  return {
    version: 1,
    server: {
      name: "test-server",
      version: "0.1.0",
      transport: "stdio",
      auth: { type: "none" },
      env: [],
    },
    nodes: {
      t1: {
        kind: "tool",
        name: "echo_message",
        description: "Echo a message back. Use when you need a round trip.",
        inputs: [{ name: "message", type: "string" }],
        annotations: { readOnly: true },
        entry: "r1",
      },
      r1: { kind: "return", format: "json" },
    },
  };
}

describe("validateGraphDoc", () => {
  it("retains optional root metadata while older server configs remain valid", () => {
    const doc = baseDoc();
    doc.server.description = "Tools for the support team";
    doc.server.creator = "Acme Support";
    const result = validateGraphDoc(doc);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc.server.description).toBe("Tools for the support team");
      expect(result.doc.server.creator).toBe("Acme Support");
    }
  });

  it("accepts a minimal valid doc", () => {
    const result = validateGraphDoc(baseDoc());
    expect(result.ok).toBe(true);
  });

  describe("custom code languages", () => {
    function docWithCode(language: unknown): Record<string, unknown> {
      const doc = baseDoc();
      // A code node is a local-execution node, so the graph must opt in or
      // validation rejects it for that reason instead of the language — which
      // would make these tests pass for the wrong reason.
      doc.server.execution = { allowLocal: true };
      const nodes = doc.nodes as unknown as Record<string, unknown>;
      nodes.t1 = { ...(nodes.t1 as object), entry: "c1" };
      nodes.c1 = { kind: "code", language, source: "return 1;", next: "r1" };
      return doc as unknown as Record<string, unknown>;
    }

    // THE backward-compatibility guarantee. Every doc saved before the field
    // was widened holds exactly this value; if it ever stopped validating,
    // users' existing servers would fail to open. That is why "javascript"
    // stays a member of the union rather than being renamed.
    it("still accepts the historical javascript literal", () => {
      expect(validateGraphDoc(docWithCode("javascript")).ok).toBe(true);
    });

    it("accepts every language the engine can run", () => {
      for (const language of CODE_LANGUAGES) {
        const result = validateGraphDoc(docWithCode(language));
        expect(result.ok, `${language} should validate`).toBe(true);
      }
    });

    it("rejects a language the engine has no runner for", () => {
      // Validation is the gate that keeps a saveable doc runnable: accepting
      // an arbitrary string here would let the editor produce a graph that
      // fails only at tool-call time, inside the user's model client.
      const result = validateGraphDoc(docWithCode("brainfuck"));
      expect(result.ok).toBe(false);
    });

    it("rejects a missing language rather than guessing", () => {
      const doc = baseDoc();
      doc.server.execution = { allowLocal: true };
      const nodes = doc.nodes as unknown as Record<string, unknown>;
      nodes.t1 = { ...(nodes.t1 as object), entry: "c1" };
      nodes.c1 = { kind: "code", source: "return 1;", next: "r1" };
      expect(validateGraphDoc(doc as unknown as Record<string, unknown>).ok).toBe(false);
    });
  });

  it("rejects non-doc input with zod issues", () => {
    const result = validateGraphDoc({ version: "x" });
    expect(result.ok).toBe(false);
  });

  it("rejects dangling entry references", () => {
    const doc = baseDoc();
    (doc.nodes.t1 as { entry: string | null }).entry = "nope";
    const result = validateGraphDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.message).toContain("missing node");
  });

  it("rejects chains that point at tool nodes", () => {
    const doc = baseDoc();
    doc.nodes.t2 = {
      kind: "tool",
      name: "other_tool",
      description: "Another tool for testing. Use when needed.",
      inputs: [],
      annotations: { readOnly: true },
      entry: "t1",
    };
    const result = validateGraphDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.message.includes("tool node"))).toBe(true);
  });

  it("rejects cycles", () => {
    const doc = baseDoc();
    doc.nodes.a = { kind: "transform", op: "pick", pick: ["x"], next: "b" };
    doc.nodes.b = { kind: "transform", op: "pick", pick: ["y"], next: "a" };
    (doc.nodes.t1 as { entry: string | null }).entry = "a";
    const result = validateGraphDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.message.includes("cycle"))).toBe(true);
  });

  it("rejects two chains merging into one node", () => {
    const doc = baseDoc();
    doc.nodes.t2 = {
      kind: "tool",
      name: "second_tool",
      description: "Second tool sharing a return. Use when testing merges.",
      inputs: [],
      annotations: { readOnly: true },
      entry: "r1",
    };
    const result = validateGraphDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.message.includes("merge"))).toBe(true);
  });

  it("accepts parallel fan-out and all local/custom operation kinds", () => {
    const doc = baseDoc();
    doc.server.execution = { allowLocal: true };
    (doc.nodes.t1 as { entry: string | null }).entry = "parallel";
    Object.assign(doc.nodes, {
      parallel: {
        kind: "parallel",
        branches: [
          { name: "command", entry: "command" },
          { name: "script", entry: "script" },
          { name: "code", entry: "code" },
        ],
        next: "r1",
      },
      command: {
        kind: "command",
        command: { executable: "node", args: ["--version"], output: "text" },
        next: null,
      },
      script: {
        kind: "script",
        script: { runtime: "node", path: "scripts/example.mjs", args: [], output: "json" },
        next: null,
      },
      code: {
        kind: "code",
        language: "javascript",
        source: "return { ok: true };",
        next: null,
      },
    } as never);
    expect(validateGraphDoc(doc).ok).toBe(true);
  });

  it("rejects parallel branches that merge or cycle", () => {
    const doc = baseDoc();
    (doc.nodes.t1 as { entry: string | null }).entry = "parallel";
    Object.assign(doc.nodes, {
      parallel: {
        kind: "parallel",
        branches: [
          { name: "one", entry: "shared" },
          { name: "two", entry: "shared" },
        ],
        next: "r1",
      },
      shared: { kind: "transform", op: "pick", pick: ["x"], next: "parallel" },
    } as never);
    const result = validateGraphDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.message.includes("merge"))).toBe(true);
      expect(result.issues.some((issue) => issue.message.includes("cycle"))).toBe(true);
    }
  });

  it("rejects empty parallel nodes", () => {
    const doc = baseDoc();
    (doc.nodes.t1 as { entry: string | null }).entry = "parallel";
    doc.nodes.parallel = { kind: "parallel", branches: [], next: "r1" };
    const result = validateGraphDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.message.includes("at least one branch"))).toBe(true);
  });

  it("rejects return nodes inside parallel branches", () => {
    const doc = baseDoc();
    (doc.nodes.t1 as { entry: string | null }).entry = "parallel";
    doc.nodes.parallel = {
      kind: "parallel",
      branches: [{ name: "early", entry: "branch_return" }],
      next: "r1",
    };
    doc.nodes.branch_return = { kind: "return", format: "json" };
    const result = validateGraphDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.message.includes("return after the join"))).toBe(true);
  });

  it("rejects duplicate parallel branch names and local nodes without graph opt-in", () => {
    const doc = baseDoc();
    (doc.nodes.t1 as { entry: string | null }).entry = "parallel";
    Object.assign(doc.nodes, {
      parallel: {
        kind: "parallel",
        branches: [
          { name: "same", entry: "command" },
          { name: "same", entry: null },
        ],
        next: "r1",
      },
      command: {
        kind: "command",
        command: { executable: "node", args: [], output: "text" },
        next: null,
      },
    } as never);
    const result = validateGraphDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.message.includes("unique"))).toBe(true);
      expect(result.issues.some((issue) => issue.message.includes("allowLocal"))).toBe(true);
    }
  });

  it("rejects enum inputs without values and stray enumValues", () => {
    const doc = baseDoc();
    (doc.nodes.t1 as { inputs: unknown[] }).inputs = [
      { name: "mode", type: "enum" },
      { name: "q", type: "string", enumValues: ["a"] },
    ];
    const result = validateGraphDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes("non-empty enumValues"))).toBe(true);
      expect(result.issues.some((i) => i.message.includes("only allowed on enum"))).toBe(true);
    }
  });

  it("rejects lowercase env var names", () => {
    const doc = baseDoc();
    doc.server.env = ["lower_case"];
    expect(validateGraphDoc(doc).ok).toBe(false);
  });

  it("rejects chains longer than the limit", () => {
    const doc = baseDoc();
    // 60 linked transforms > maxChainLength of 50.
    for (let i = 0; i < 60; i++) {
      doc.nodes[`x${i}`] = { kind: "transform", op: "pick", pick: ["a"], next: i < 59 ? `x${i + 1}` : null };
    }
    (doc.nodes.t1 as { entry: string | null }).entry = "x0";
    const result = validateGraphDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.message.includes("longer than"))).toBe(true);
  });
});

describe("migrate interplay", () => {
  it("keeps editor-only fields intact", () => {
    const doc = { ...baseDoc(), edges: [{ id: "e1", source: "t1", target: "r1" }], layout: { t1: { x: 0, y: 0 } } };
    const result = validateGraphDoc(doc);
    expect(result.ok).toBe(true);
  });
});
