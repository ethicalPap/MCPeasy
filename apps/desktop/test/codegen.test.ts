import { describe, expect, it } from "vitest";
import { GRAPH_DOC_VERSION, type GraphDoc } from "@mcpeasy/schema";
import { generateTypescript } from "../src/renderer/src/codegen";

// Advanced mode's TS example generator: assert the contract (SDK imports,
// tool schema fidelity, chain sketch), not exact formatting.

function doc(): GraphDoc {
  return {
    version: GRAPH_DOC_VERSION,
    server: { name: "weather", description: "Weather tools", creator: "Acme", version: "1.2.3", transport: "stdio", auth: { type: "none" }, env: ["API_TOKEN"] },
    nodes: {
      tool_1: {
        kind: "tool",
        name: "get_weather",
        description: "Get weather",
        inputs: [
          { name: "city", type: "string" },
          { name: "units", type: "enum", enumValues: ["c", "f"], required: false },
        ],
        annotations: { readOnly: true },
        entry: "action_1",
      },
      action_1: { kind: "action", http: { method: "GET", url: "https://api.x/{{input.city}}" }, next: "return_1" },
      return_1: { kind: "return", format: "json" },
    },
    edges: [],
    layout: {},
  };
}

describe("generateTypescript", () => {
  it("emits an SDK server skeleton for the doc", () => {
    const ts = generateTypescript(doc());
    expect(ts).toContain('from "@modelcontextprotocol/sdk/server/index.js"');
    expect(ts).toContain('name: "weather", version: "1.2.3"');
    expect(ts).toContain("Creator: Acme");
    expect(ts).toContain("Weather tools");
    expect(ts).toContain('name: "get_weather"');
    // Input schema mirrors the graph: enum inputs carry their values, and
    // only required inputs land in `required`.
    expect(ts).toContain('"city": { type: "string" }');
    expect(ts).toContain('"units": { type: "string", enum: ["c","f"] }');
    expect(ts).toContain('required: ["city"]');
    // Chain sketch + declared env are present as comments.
    expect(ts).toContain("GET https://api.x/{{input.city}}");
    expect(ts).toContain("API_TOKEN");
  });

  it("degrades gracefully on an empty doc", () => {
    const empty: GraphDoc = {
      version: GRAPH_DOC_VERSION,
      server: { name: "s", version: "0.1.0", transport: "stdio", auth: { type: "none" }, env: [] },
      nodes: {},
      edges: [],
      layout: {},
    };
    const ts = generateTypescript(empty);
    expect(ts).toContain("no tool blocks");
    expect(ts).toContain("(none declared)");
  });
});
