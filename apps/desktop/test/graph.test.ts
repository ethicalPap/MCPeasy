import { describe, expect, it } from "vitest";
import { GRAPH_DOC_VERSION, validateGraphDoc, type GraphDoc } from "@mcpeasy/schema";
import {
  MCP_ROOT_NODE_ID,
  addConnectedNode,
  addParallelBranch,
  allowedConnectedKinds,
  builderEdgeLabel,
  deriveBuilderEdges,
  deriveEdges,
  fillMissingLayout,
  makeNode,
  nextNodeId,
  nodeSummary,
  removeConnectedNode,
  searchNodes,
  serializableDoc,
  serializeDocText,
} from "../src/renderer/src/graph";

// The canvas is a view of the doc; these helpers ARE that view's semantics,
// so they get real tests (React components are exercised by the app itself).

function doc(nodes: GraphDoc["nodes"], layout?: GraphDoc["layout"]): GraphDoc {
  return {
    version: GRAPH_DOC_VERSION,
    server: { name: "s", version: "0.1.0", transport: "stdio", auth: { type: "none" }, env: [] },
    nodes,
    ...(layout !== undefined ? { layout } : {}),
  };
}

const chainDoc = (): GraphDoc =>
  doc({
    tool_1: {
      kind: "tool",
      name: "get_thing",
      description: "Get a thing. Use when you need a thing.",
      inputs: [],
      annotations: { readOnly: true },
      entry: "action_1",
    },
    action_1: { kind: "action", http: { method: "GET", url: "https://x.test/" }, next: "return_1" },
    return_1: { kind: "return", format: "json" },
  });

describe("deriveEdges", () => {
  it("derives one edge per entry/next ref, keyed by source", () => {
    expect(deriveEdges(chainDoc())).toEqual([
      { id: "e_tool_1__entry", source: "tool_1", target: "action_1" },
      { id: "e_action_1__next", source: "action_1", target: "return_1" },
    ]);
  });

  it("emits nothing for unwired nodes", () => {
    const d = doc({ return_1: { kind: "return", format: "json" } });
    expect(deriveEdges(d)).toEqual([]);
  });
});

describe("connection-driven creation", () => {
  it("connects every tool to the MCP root in the builder view", () => {
    expect(deriveBuilderEdges(chainDoc())).toEqual([
      { id: "root_tool_1", source: MCP_ROOT_NODE_ID, target: "tool_1" },
      { id: "e_tool_1__entry", source: "tool_1", target: "action_1" },
      { id: "e_action_1__next", source: "action_1", target: "return_1" },
    ]);
  });

  it("labels visual connections from their MCP meaning", () => {
    const d = chainDoc();
    expect(builderEdgeLabel(d, MCP_ROOT_NODE_ID, "tool_1")).toBe("Expose tool");
    expect(builderEdgeLabel(d, "tool_1", "action_1")).toBe("Run request");
    expect(builderEdgeLabel(d, "action_1", "return_1")).toBe("Return result");
  });

  it("offers only structurally valid kinds at each connector", () => {
    const d = chainDoc();
    expect(allowedConnectedKinds(d, MCP_ROOT_NODE_ID)).toEqual(["tool"]);
    expect(allowedConnectedKinds(d, "tool_1")).toEqual(["action", "command", "script", "code", "parallel", "transform"]);
    expect(allowedConnectedKinds(d, "return_1")).toEqual([]);
  });

  it("adds a tool from the root without creating a floating execution node", () => {
    const result = addConnectedNode(doc({}), MCP_ROOT_NODE_ID, "tool");
    expect(result?.id).toBe("tool_1");
    expect(result?.doc.nodes.tool_1?.kind).toBe("tool");
    expect(result?.doc.layout?.tool_1).toBeDefined();
  });

  it("inserts an execution node without orphaning the existing tail", () => {
    const result = addConnectedNode(chainDoc(), "tool_1", "transform");
    expect(result?.id).toBe("transform_1");
    expect(result?.doc.nodes.tool_1).toMatchObject({ entry: "transform_1" });
    expect(result?.doc.nodes.transform_1).toMatchObject({ next: "action_1" });
    expect(result?.doc.layout?.action_1?.y).toBeGreaterThan(result?.doc.layout?.transform_1?.y ?? Infinity);
  });

  it("adds named parallel branches as connected paths", () => {
    const parallelResult = addConnectedNode(chainDoc(), "tool_1", "parallel");
    expect(parallelResult).not.toBeNull();
    const result = addParallelBranch(parallelResult!.doc, parallelResult!.id, "command");
    expect(result?.doc.nodes[parallelResult!.id]).toMatchObject({
      kind: "parallel",
      branches: [{ name: "request_1", entry: "command_1" }],
    });
    expect(deriveEdges(result!.doc)).toContainEqual({
      id: `e_${parallelResult!.id}__branches_0_entry`,
      source: parallelResult!.id,
      target: "command_1",
    });
    expect(allowedConnectedKinds(result!.doc, "command_1")).not.toContain("return");
  });

  it("rejects invalid root and terminating-node additions", () => {
    const d = chainDoc();
    expect(addConnectedNode(d, MCP_ROOT_NODE_ID, "action")).toBeNull();
    expect(addConnectedNode(d, "return_1", "action")).toBeNull();
    expect(addConnectedNode(d, "tool_1", "return")).toBeNull();
  });

  it("splices a deleted middle step out of its chain", () => {
    const result = removeConnectedNode(chainDoc(), "action_1");
    expect(result.nodes.action_1).toBeUndefined();
    expect(result.nodes.tool_1).toMatchObject({ entry: "return_1" });
  });

  it("deleting a parallel node removes its private branches and reconnects the joined continuation", () => {
    const d = doc({
      tool_1: {
        kind: "tool",
        name: "aggregate",
        description: "Aggregate two data sources.",
        inputs: [],
        annotations: { readOnly: true },
        entry: "parallel_1",
      },
      parallel_1: {
        kind: "parallel",
        branches: [
          { name: "left", entry: "action_1" },
          { name: "right", entry: "command_1" },
        ],
        next: "return_1",
      },
      action_1: { kind: "action", http: { method: "GET", url: "https://x.test/" }, next: null },
      command_1: { kind: "command", command: { executable: "node", args: [], output: "json" }, next: null },
      return_1: { kind: "return", format: "json" },
    });
    d.server.execution = { allowLocal: true };

    const result = removeConnectedNode(d, "parallel_1");

    expect(result.nodes.tool_1).toMatchObject({ entry: "return_1" });
    expect(result.nodes.parallel_1).toBeUndefined();
    expect(result.nodes.action_1).toBeUndefined();
    expect(result.nodes.command_1).toBeUndefined();
    expect(result.nodes.return_1).toBeDefined();
  });

  it("deleting a tool removes its owned chain but preserves sibling tools", () => {
    const d = chainDoc();
    d.nodes.tool_2 = {
      kind: "tool",
      name: "other_tool",
      description: "Other",
      inputs: [],
      annotations: { readOnly: true },
      entry: null,
    };
    const result = removeConnectedNode(d, "tool_1");
    expect(Object.keys(result.nodes)).toEqual(["tool_2"]);
  });
});

describe("nextNodeId", () => {
  it("skips ids already in use", () => {
    const d = chainDoc();
    expect(nextNodeId(d, "action")).toBe("action_2");
    expect(nextNodeId(d, "transform")).toBe("transform_1");
  });
});

describe("makeNode", () => {
  it("new nodes are shape-valid inside a fresh doc", () => {
    for (const kind of ["tool", "action", "command", "script", "code", "parallel", "transform", "return"] as const) {
      const d = doc({ [`${kind}_1`]: makeNode(kind) });
      if (kind === "command" || kind === "script" || kind === "code") {
        d.server.execution = { allowLocal: true };
      }
      // Shape must pass; graph-level lint problems (e.g. empty url) are
      // expected and belong to the badge workflow, not to validity here.
      const result = validateGraphDoc(d);
      if (kind === "action" || kind === "parallel") {
        // Empty URL and empty fan-out are deliberate editor draft states. They
        // become actionable in their properties panels before serving.
        expect(result.ok).toBe(false);
      } else {
        expect(result.ok, `makeNode(${kind})`).toBe(true);
      }
    }
  });
});

describe("fillMissingLayout", () => {
  it("keeps existing positions and places missing ones per chain column", () => {
    const d = chainDoc();
    d.layout = { tool_1: { x: 500, y: 500 } };
    const layout = fillMissingLayout(d);
    expect(layout.tool_1).toEqual({ x: 500, y: 500 });
    expect(layout.action_1).toBeDefined();
    expect(layout.return_1).toBeDefined();
    // Chain members share the tool's column x.
    expect(layout.action_1!.x).toBe(layout.return_1!.x);
  });

  it("survives cyclic chains (shape-valid but structurally broken docs)", () => {
    const d = doc({
      tool_1: {
        kind: "tool",
        name: "t",
        description: "d",
        inputs: [],
        annotations: { readOnly: true },
        entry: "action_1",
      },
      action_1: { kind: "action", http: { method: "GET", url: "https://x.test/" }, next: "action_2" },
      action_2: { kind: "action", http: { method: "GET", url: "https://x.test/" }, next: "action_1" },
    });
    const layout = fillMissingLayout(d);
    expect(Object.keys(layout).sort()).toEqual([MCP_ROOT_NODE_ID, "action_1", "action_2", "tool_1"].sort());
  });

  it("gives orphan exec nodes positions too", () => {
    const d = doc({
      return_9: { kind: "return", format: "text" },
    });
    expect(fillMissingLayout(d).return_9).toBeDefined();
  });
});

describe("nodeSummary", () => {
  it("titles each kind the way its canvas card does", () => {
    const d = chainDoc();
    expect(nodeSummary(d.nodes.tool_1!)).toEqual({ title: "get_thing", sub: "Tool" });
    expect(nodeSummary(d.nodes.action_1!)).toEqual({ title: "GET request", sub: "x.test/" });
    expect(nodeSummary(d.nodes.return_1!)).toEqual({ title: "Return json", sub: "Reply to the model" });
  });

  it("falls back to placeholder text for empty fields", () => {
    expect(nodeSummary(makeNode("tool")).title).toBe("new_tool");
    expect(nodeSummary(makeNode("action")).sub).toBe("(no url yet)");
    expect(nodeSummary(makeNode("command")).sub).toBe("node");
    expect(nodeSummary(makeNode("script")).title).toBe("node script");
    // A new code block still defaults to JavaScript, so this title is the
    // default's title — not a hardcoded one (see the per-language test below).
    expect(nodeSummary(makeNode("code")).title).toBe("Custom JavaScript");
    expect(nodeSummary(makeNode("parallel")).sub).toBe("0 branches");
    expect(nodeSummary(makeNode("transform")).sub).toBe("(no fields yet)");
  });

  it("titles a code card by its own language, not a fixed JavaScript label", () => {
    // The canvas card previously said "Custom JavaScript" for every block.
    // Once a block can be Go or Python, that is an outright false statement
    // about what the card represents.
    const base = makeNode("code") as { kind: "code"; language: string; source: string; next: string | null };
    expect(nodeSummary({ ...base, language: "python" } as never).title).toBe("Custom Python");
    expect(nodeSummary({ ...base, language: "go" } as never).title).toBe("Custom Go");
    expect(nodeSummary({ ...base, language: "powershell" } as never).title).toBe("Custom PowerShell");
    // An id this build does not know must still title the card with something
    // truthful rather than falling back to the wrong language name.
    expect(nodeSummary({ ...base, language: "elixir" } as never).title).toBe("Custom elixir");
  });
});

describe("searchNodes", () => {
  it("matches title, sub, id and kind label case-insensitively", () => {
    const d = chainDoc();
    expect(searchNodes(d, "GET_TH").map((h) => h.id)).toEqual(["tool_1"]);
    expect(searchNodes(d, "x.test").map((h) => h.id)).toEqual(["action_1"]);
    expect(searchNodes(d, "return_1").map((h) => h.id)).toEqual(["return_1"]);
    // Kind label "HTTP request" — also a title substring for the action card.
    expect(searchNodes(d, "http").map((h) => h.id)).toEqual(["action_1"]);
  });

  it("ranks title prefix over title substring over sub/id matches", () => {
    const d = doc({
      tool_1: {
        kind: "tool",
        name: "get_weather",
        description: "x",
        inputs: [],
        annotations: { readOnly: true },
        entry: null,
      },
      tool_2: {
        kind: "tool",
        name: "forget_thing",
        description: "x",
        inputs: [],
        annotations: { readOnly: true },
        entry: null,
      },
      action_1: {
        kind: "action",
        // "get" appears only in the sub-line (url), not the title.
        http: { method: "POST", url: "https://api.get.example/" },
        next: null,
      },
    });
    expect(searchNodes(d, "get").map((h) => h.id)).toEqual(["tool_1", "tool_2", "action_1"]);
  });

  it("returns nothing for blank queries and respects the limit", () => {
    const d = chainDoc();
    expect(searchNodes(d, "   ")).toEqual([]);
    expect(searchNodes(d, "e", 2)).toHaveLength(2);
  });
});

describe("serializableDoc / serializeDocText", () => {
  it("writes derived edges and layout back into the saved doc", () => {
    const d = chainDoc();
    d.layout = fillMissingLayout(d);
    const saved = serializableDoc(d);
    expect(saved.edges).toEqual(deriveEdges(d));
    expect(saved.layout).toBe(d.layout);
    expect(saved.version).toBe(GRAPH_DOC_VERSION);
  });

  it("round-trips through JSON to a doc that still validates", () => {
    const d = chainDoc();
    d.layout = fillMissingLayout(d);
    const reparsed = JSON.parse(serializeDocText(d));
    expect(validateGraphDoc(reparsed).ok).toBe(true);
  });

  it("ends with a newline like the repo's example docs", () => {
    expect(serializeDocText(chainDoc()).endsWith("\n")).toBe(true);
  });
});
