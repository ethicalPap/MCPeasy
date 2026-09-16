import { describe, expect, it } from "vitest";
import { lintErrorCount, lintGraphDoc } from "../src/lint.js";
import type { GraphDoc, ToolNode } from "../src/types.js";

function docWith(tool: Partial<ToolNode>, extraNodes: GraphDoc["nodes"] = {}): GraphDoc {
  return {
    version: 1,
    server: {
      name: "s",
      version: "1",
      transport: "stdio",
      auth: { type: "none" },
      env: ["BASE_URL"],
    },
    nodes: {
      t1: {
        kind: "tool",
        name: "search_contacts",
        description: "Search contacts by name. Use when looking people up.",
        inputs: [{ name: "query", type: "string" }],
        annotations: { readOnly: true },
        entry: "r1",
        ...tool,
      },
      r1: { kind: "return", format: "json" },
      ...extraNodes,
    },
  };
}

function rulesFor(doc: GraphDoc, nodeId: string): string[] {
  return (lintGraphDoc(doc)[nodeId] ?? []).map((p) => p.rule);
}

describe("lintGraphDoc", () => {
  it("clean doc has no problems", () => {
    expect(lintGraphDoc(docWith({}))).toEqual({});
  });

  it("rule 1: follows the MCP tool-name character set", () => {
    expect(rulesFor(docWith({ name: "SearchContacts.v2" }), "t1")).not.toContain("tool-name-pattern");
    expect(rulesFor(docWith({ name: "search contacts" }), "t1")).toContain("tool-name-pattern");
  });

  it("rule 2: duplicate tool names flagged on every holder", () => {
    const doc = docWith({}, {
      t2: {
        kind: "tool",
        name: "search_contacts",
        description: "Duplicate name. Use when testing duplicates only.",
        inputs: [],
        annotations: { readOnly: true },
        entry: "r2",
      },
      r2: { kind: "return", format: "json" },
    });
    expect(rulesFor(doc, "t1")).toContain("duplicate-tool-name");
    expect(rulesFor(doc, "t2")).toContain("duplicate-tool-name");
  });

  it("defers an unterminated chain to runtime", () => {
    const doc = docWith({ entry: "a" }, { a: { kind: "transform", op: "pick", pick: ["x"], next: null } });
    expect(rulesFor(doc, "t1")).not.toContain("chain-no-return");
  });

  it("does not block a newly-created tool whose entry is not wired yet", () => {
    expect(rulesFor(docWith({ entry: null }), "t1")).not.toContain("chain-no-return");
  });

  it("does not enforce a minimum description length", () => {
    expect(rulesFor(docWith({ description: "Too short" }), "t1")).not.toContain("description-too-short");
  });

  it("suggests a usage hint only when a detailed description omits one", () => {
    const doc = docWith({ description: "Searches the contact database by arbitrary text query." });
    const rules = rulesFor(doc, "t1");
    expect(rules).toContain("description-no-usage-hint");
    expect(rules).not.toContain("description-too-short");
  });

  it("rule 7: read-ish name without readOnly", () => {
    expect(rulesFor(docWith({ annotations: { readOnly: false } }), "t1")).toContain("read-name-not-readonly");
  });

  it("rule 8: write-ish name with destructive unset — and set is fine", () => {
    const unset = docWith({ name: "delete_contact", annotations: { readOnly: false } });
    expect(rulesFor(unset, "t1")).toContain("write-name-destructive-unset");
    const set = docWith({ name: "delete_contact", annotations: { readOnly: false, destructive: true } });
    expect(rulesFor(set, "t1")).not.toContain("write-name-destructive-unset");
  });

  it("rule 9: more than 8 required inputs", () => {
    const inputs = Array.from({ length: 9 }, (_, i) => ({ name: `f${i}`, type: "string" as const }));
    expect(rulesFor(docWith({ inputs }), "t1")).toContain("too-many-required-inputs");
    const optional = inputs.map((f) => ({ ...f, required: false }));
    expect(rulesFor(docWith({ inputs: optional }), "t1")).not.toContain("too-many-required-inputs");
  });

  it("rule 10: undeclared env var flagged on the holding node", () => {
    const doc = docWith({ entry: "a" }, {
      a: {
        kind: "action",
        http: { method: "GET", url: "{{env.MISSING}}/x" },
        next: "r1",
      },
    });
    // Note: pointing entry at "a" makes r1 shared? No — t1.entry is the only
    // ref to a, and a.next is the only ref to r1. Chain: a → r1.
    expect(rulesFor(doc, "a")).toContain("undeclared-env-var");
  });

  it("rule 10: scans local command arguments and stdin", () => {
    const doc = docWith({ entry: "c" }, {
      c: {
        kind: "command",
        command: { executable: "node", args: ["{{env.MISSING}}"], stdin: "{{env.OTHER}}", output: "text" },
        next: "r1",
      },
    });
    expect(rulesFor(doc, "c").filter((rule) => rule === "undeclared-env-var")).toHaveLength(2);
  });

  it("rule 10: declared env vars pass", () => {
    const doc = docWith({ entry: "a" }, {
      a: { kind: "action", http: { method: "GET", url: "{{env.BASE_URL}}/x" }, next: "r1" },
    });
    expect(rulesFor(doc, "a")).not.toContain("undeclared-env-var");
  });

  it("lintErrorCount counts only errors", () => {
    const report = lintGraphDoc(docWith({ name: "bad name", description: "short" }));
    expect(lintErrorCount(report)).toBe(1);
  });
});
