import { describe, expect, it } from "vitest";
import { GRAPH_DOC_VERSION, type GraphDoc } from "@mcpeasy/schema";
import {
  hasUpstreamStep,
  insertToken,
  toolsReaching,
  varSuggestionsFor,
} from "../src/renderer/src/templateVars";

// The {{var}} helper's suggestion logic: what may legally be inserted where.

function doc(): GraphDoc {
  return {
    version: GRAPH_DOC_VERSION,
    server: { name: "s", version: "0.1.0", transport: "stdio", auth: { type: "none" }, env: ["API_TOKEN"] },
    nodes: {
      tool_1: {
        kind: "tool",
        name: "get_weather",
        description: "d",
        inputs: [
          { name: "city", type: "string", description: "City name" },
          { name: "units", type: "enum", enumValues: ["c", "f"], required: false },
        ],
        annotations: { readOnly: true },
        entry: "action_1",
      },
      action_1: { kind: "action", http: { method: "GET", url: "https://x" }, next: "return_1" },
      return_1: { kind: "return", format: "json" },
      // A second, unwired tool: its inputs must NOT leak into tool_1's chain.
      tool_2: {
        kind: "tool",
        name: "other",
        description: "d",
        inputs: [{ name: "unrelated", type: "string" }],
        annotations: { readOnly: true },
        entry: null,
      },
    },
    edges: [],
    layout: {},
  };
}

describe("toolsReaching", () => {
  it("finds the tool whose chain flows through the node", () => {
    expect(toolsReaching(doc(), "action_1").map((t) => t.name)).toEqual(["get_weather"]);
    expect(toolsReaching(doc(), "return_1").map((t) => t.name)).toEqual(["get_weather"]);
  });

  it("returns nothing for unreachable nodes", () => {
    expect(toolsReaching(doc(), "tool_2")).toEqual([]);
  });

  it("finds nodes reached through parallel branches", () => {
    const d = doc();
    (d.nodes.tool_1 as { entry: string | null }).entry = "parallel_1";
    d.nodes.parallel_1 = {
      kind: "parallel",
      branches: [{ name: "lookup", entry: "action_1" }],
      next: "return_1",
    };
    expect(toolsReaching(d, "action_1").map((tool) => tool.name)).toEqual(["get_weather"]);
    expect(toolsReaching(d, "return_1").map((tool) => tool.name)).toEqual(["get_weather"]);
  });

  it("survives cycles instead of hanging", () => {
    const d = doc();
    // action_1 -> action_1 (shape-valid, structurally broken — editor must cope)
    (d.nodes.action_1 as { next: string | null }).next = "action_1";
    expect(toolsReaching(d, "return_1")).toEqual([]);
    expect(toolsReaching(d, "action_1").map((t) => t.name)).toEqual(["get_weather"]);
  });
});

describe("hasUpstreamStep", () => {
  it("is false on the first chain step, true after it", () => {
    expect(hasUpstreamStep(doc(), "action_1")).toBe(false);
    expect(hasUpstreamStep(doc(), "return_1")).toBe(true);
  });
});

describe("varSuggestionsFor", () => {
  it("offers reaching-tool inputs, env names, and prev when applicable", () => {
    const tokens = varSuggestionsFor(doc(), "return_1").map((s) => s.token);
    expect(tokens).toContain("{{input.city}}");
    expect(tokens).toContain("{{input.units}}");
    expect(tokens).toContain("{{env.API_TOKEN}}");
    expect(tokens).toContain("{{prev}}");
    // The unwired tool's inputs must not appear.
    expect(tokens).not.toContain("{{input.unrelated}}");
  });

  it("omits prev on the first step", () => {
    const tokens = varSuggestionsFor(doc(), "action_1").map((s) => s.token);
    expect(tokens).toContain("{{input.city}}");
    expect(tokens.filter((t) => t.startsWith("{{prev"))).toEqual([]);
  });
});

describe("insertToken", () => {
  it("inserts at the cursor and places the caret after the token", () => {
    const r = insertToken("https://api/x/", 14, 14, "{{input.city}}");
    expect(r.text).toBe("https://api/x/{{input.city}}");
    expect(r.caretStart).toBe(28);
    expect(r.caretEnd).toBe(28);
  });

  it("replaces a selection", () => {
    const r = insertToken("hello WORLD end", 6, 11, "{{prev}}");
    expect(r.text).toBe("hello {{prev}} end");
  });

  it("selects the editable `field` part of the teaching token", () => {
    const r = insertToken("", 0, 0, "{{prev.field}}");
    expect(r.text).toBe("{{prev.field}}");
    expect(r.text.slice(r.caretStart, r.caretEnd)).toBe("field");
  });
});
