// Pure helpers between the graph doc and the canvas. Execution references are
// always the source of truth; edges/layout are derived presentation.

import {
  GRAPH_DOC_VERSION,
  executionReferences,
  reachableExecutionNodeIds,
  type GraphDoc,
  type GraphEdge,
  type GraphNode,
} from "@mcpeasy/schema";

export type NodeKind = GraphNode["kind"];

/** The MCP server is a derived canvas root, not an execution node. */
export const MCP_ROOT_NODE_ID = "$mcpeasy:server";
export const MCP_ROOT_NODE_TYPE = "mcpRoot" as const;

export type ConnectedNodeKind = NodeKind;

/** Root creates tools; every non-terminating path can insert another operation.
 * A parallel node's + edits its join continuation; branch starts are added in
 * the parallel properties panel because each must also receive a unique name. */
function isInsideParallelBranch(doc: GraphDoc, nodeId: string): boolean {
  return Object.values(doc.nodes).some((node) =>
    node.kind === "parallel" &&
    node.branches.some((branch) => reachableExecutionNodeIds(doc, branch.entry).includes(nodeId)),
  );
}

export function allowedConnectedKinds(doc: GraphDoc, sourceId: string): ConnectedNodeKind[] {
  if (sourceId === MCP_ROOT_NODE_ID) return ["tool"];
  const source = doc.nodes[sourceId];
  if (!source || source.kind === "return") return [];
  const currentTarget = source.kind === "tool" ? source.entry : source.next;
  const operations: ConnectedNodeKind[] = ["action", "command", "script", "code", "parallel", "transform"];
  // Branch paths join by ending naturally; a Return belongs only on the joined
  // continuation, where it produces the one MCP response for the tool call.
  return currentTarget === null && !isInsideParallelBranch(doc, sourceId) ? [...operations, "return"] : operations;
}

/** Text is shared by cards, picker, search, and tests. */
export const KIND_TEXT: Record<NodeKind, { label: string; blurb: string }> = {
  tool: { label: "Tool", blurb: "What the model can call" },
  action: { label: "HTTP request", blurb: "Call an API" },
  command: { label: "Local command", blurb: "Run an executable directly" },
  script: { label: "Script file", blurb: "Run a local script" },
  code: { label: "Custom code", blurb: "Write code in your language" },
  parallel: { label: "Concurrent requests", blurb: "Run named branches together" },
  transform: { label: "Transform", blurb: "Reshape the result" },
  return: { label: "Return", blurb: "Reply to the model" },
};

/** Canvas-card titles per language. Deliberately NOT reusing the panel's
 *  LANGUAGE_LABEL: that lives in a React component, and graph.ts is a pure
 *  module imported by tests and the search index, which must not pull in the
 *  renderer's component tree. */
const CODE_LANGUAGE_TITLE: Record<string, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  bash: "Bash",
  powershell: "PowerShell",
  ruby: "Ruby",
  php: "PHP",
  go: "Go",
};

export function nodeSummary(node: GraphNode): { title: string; sub: string } {
  switch (node.kind) {
    case "tool":
      return { title: node.name || "(unnamed)", sub: KIND_TEXT.tool.label };
    case "action":
      return { title: `${node.http.method} request`, sub: node.http.url.replace(/^https?:\/\//, "") || "(no url yet)" };
    case "command":
      return { title: "Local command", sub: node.command.executable || "(no executable yet)" };
    case "script":
      return { title: `${node.script.runtime} script`, sub: node.script.path || "(no script path yet)" };
    case "code":
      // Named after the block's actual language, the same way a script node
      // is titled by its runtime. A fixed "Custom JavaScript" would be a lie
      // on the canvas for any of the other seven languages.
      return { title: `Custom ${CODE_LANGUAGE_TITLE[node.language] ?? node.language}`, sub: node.source.split(/\r?\n/, 1)[0] || "(no code yet)" };
    case "parallel":
      return { title: "Concurrent requests", sub: `${node.branches.length} branch${node.branches.length === 1 ? "" : "es"}` };
    case "transform":
      return node.op === "pick"
        ? { title: "Pick fields", sub: (node.pick ?? []).join(", ") || "(no fields yet)" }
        : { title: "Template", sub: node.template ?? "(no template yet)" };
    case "return":
      return { title: `Return ${node.format}`, sub: node.template ?? KIND_TEXT.return.blurb };
  }
}

export interface NodeHit {
  id: string;
  kind: NodeKind;
  title: string;
  sub: string;
}

export function searchNodes(doc: GraphDoc, query: string, limit = 8): NodeHit[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const scored: (NodeHit & { score: number })[] = [];
  for (const [id, node] of Object.entries(doc.nodes)) {
    const { title, sub } = nodeSummary(node);
    const label = KIND_TEXT[node.kind].label;
    const titleLc = title.toLowerCase();
    let score: number;
    if (titleLc.startsWith(q)) score = 0;
    else if (titleLc.includes(q)) score = 1;
    else if (sub.toLowerCase().includes(q) || id.toLowerCase().includes(q) || label.toLowerCase().includes(q)) score = 2;
    else continue;
    scored.push({ id, kind: node.kind, title, sub, score });
  }
  scored.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title));
  return scored.slice(0, limit).map(({ score: _score, ...hit }) => hit);
}

/** Edge ids encode the exact owning field so a parallel branch and its join
 * continuation can coexist without colliding. */
export function deriveEdges(doc: GraphDoc): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const [id, node] of Object.entries(doc.nodes)) {
    for (const reference of executionReferences(node)) {
      const key = reference.field.replace(/\./g, "_");
      edges.push({ id: `e_${id}__${key}`, source: id, target: reference.to });
    }
  }
  return edges;
}

export function deriveBuilderEdges(doc: GraphDoc): GraphEdge[] {
  const rootEdges = Object.entries(doc.nodes)
    .filter((entry): entry is [string, GraphNode & { kind: "tool" }] => entry[1].kind === "tool")
    .map(([id]) => ({ id: `root_${id}`, source: MCP_ROOT_NODE_ID, target: id }));
  return [...rootEdges, ...deriveEdges(doc)];
}

export function builderEdgeLabel(doc: GraphDoc, sourceId: string, targetId: string): string {
  if (sourceId === MCP_ROOT_NODE_ID) return "Expose tool";
  const source = doc.nodes[sourceId];
  const target = doc.nodes[targetId];
  if (source?.kind === "parallel" && source.branches.some((branch) => branch.entry === targetId)) return "Run concurrently";
  if (!target) return "Continue";
  switch (target.kind) {
    case "action": return "Run request";
    case "command": return "Run command";
    case "script": return "Run script";
    case "code": return "Run custom code";
    case "parallel": return "Fan out";
    case "transform": return "Transform data";
    case "return": return "Return result";
    case "tool": return "Continue";
  }
}

export function nextNodeId(doc: GraphDoc, kind: NodeKind): string {
  let n = 1;
  while (doc.nodes[`${kind}_${n}`] !== undefined) n += 1;
  return `${kind}_${n}`;
}

function visitLayoutPath(
  doc: GraphDoc,
  entry: string | null,
  x: number,
  y: number,
  layout: Record<string, { x: number; y: number }>,
  placed: Set<string>,
): void {
  if (entry === null) return;
  const pending: Array<{ id: string; x: number; y: number }> = [{ id: entry, x, y }];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const item = pending.shift()!;
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    if (!placed.has(item.id)) {
      layout[item.id] = { x: item.x, y: item.y };
      placed.add(item.id);
    }
    const node = doc.nodes[item.id];
    if (!node) continue;
    const refs = executionReferences(node);
    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index]!;
      // Parallel branch columns spread around the owner while its `next`
      // continuation stays centered beneath the branch row.
      const branchOffset = node.kind === "parallel" && ref.field.startsWith("branches.")
        ? (index - (node.branches.length - 1) / 2) * 330
        : 0;
      pending.push({ id: ref.to, x: item.x + branchOffset, y: item.y + 230 });
    }
  }
}

export function fillMissingLayout(doc: GraphDoc): Record<string, { x: number; y: number }> {
  const layout: Record<string, { x: number; y: number }> = { ...(doc.layout ?? {}) };
  const placed = new Set(Object.keys(layout));
  const toolIds = Object.keys(doc.nodes).filter((id) => doc.nodes[id]?.kind === "tool");
  for (let col = 0; col < toolIds.length; col += 1) {
    const toolId = toolIds[col]!;
    const x = 80 + col * 410;
    if (!placed.has(toolId)) {
      layout[toolId] = { x, y: 80 };
      placed.add(toolId);
    }
    const tool = doc.nodes[toolId];
    visitLayoutPath(doc, tool?.kind === "tool" ? tool.entry : null, x, 310, layout, placed);
  }
  let row = 0;
  for (const id of Object.keys(doc.nodes)) {
    if (!placed.has(id)) {
      layout[id] = { x: 80 + toolIds.length * 410, y: 80 + row * 230 };
      placed.add(id);
      row += 1;
    }
  }
  if (!placed.has(MCP_ROOT_NODE_ID)) {
    const toolPositions = toolIds.map((id) => layout[id]).filter((position) => position !== undefined);
    const x = toolPositions.length > 0 ? toolPositions.reduce((sum, position) => sum + position.x, 0) / toolPositions.length : 80;
    const y = toolPositions.length > 0 ? Math.min(...toolPositions.map((position) => position.y)) - 230 : 60;
    layout[MCP_ROOT_NODE_ID] = { x, y };
  }
  return layout;
}

// ── Fixed layout algorithms ────────────────────────────────────────────
// Each function computes fresh positions for EVERY node (and the derived
// root), ignoring the doc's existing layout. The layout picker in the
// toolbar calls these through the store's `applyLayout` action.

export type LayoutDirection = "vertical" | "horizontal" | "grid";

/** Walk the execution graph from an entry, placing each node along the
 * primary axis (x for horizontal, y for vertical). Parallel branches
 * fan out along the secondary axis. */
function visitPath(
  doc: GraphDoc,
  entry: string | null,
  primary: number,
  secondary: number,
  layout: Record<string, { x: number; y: number }>,
  placed: Set<string>,
  horizontal: boolean,
): void {
  if (entry === null) return;
  const pending: Array<{ id: string; p: number; s: number }> = [{ id: entry, p: primary, s: secondary }];
  const visited = new Set<string>();
  // Step sizes: primary axis advances each chain link, secondary spreads
  // parallel branches. Horizontal mode swaps x ↔ y interpretation.
  const primaryStep = horizontal ? 330 : 230;
  const branchSpread = horizontal ? 230 : 330;
  while (pending.length > 0) {
    const item = pending.shift()!;
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    if (!placed.has(item.id)) {
      layout[item.id] = horizontal
        ? { x: item.p, y: item.s }
        : { x: item.s, y: item.p };
      placed.add(item.id);
    }
    const node = doc.nodes[item.id];
    if (!node) continue;
    const refs = executionReferences(node);
    for (let i = 0; i < refs.length; i += 1) {
      const ref = refs[i]!;
      const branchOffset =
        node.kind === "parallel" && ref.field.startsWith("branches.")
          ? (i - (node.branches.length - 1) / 2) * branchSpread
          : 0;
      pending.push({
        id: ref.to,
        p: item.p + primaryStep,
        s: item.s + branchOffset,
      });
    }
  }
}

/** Compute a complete layout for the given direction, placing every node
 * from scratch (existing positions are ignored). */
export function computeLayout(
  doc: GraphDoc,
  direction: LayoutDirection,
): Record<string, { x: number; y: number }> {
  const layout: Record<string, { x: number; y: number }> = {};
  const placed = new Set<string>();
  const toolIds = Object.keys(doc.nodes).filter((id) => doc.nodes[id]?.kind === "tool");

  if (direction === "grid") {
    // Grid: arrange every node in a compact matrix, ordered tools-first
    // then by insertion order. The root sits above the grid.
    const allIds = [...toolIds, ...Object.keys(doc.nodes).filter((id) => !toolIds.includes(id))];
    const cols = Math.max(2, Math.ceil(Math.sqrt(allIds.length)));
    for (let i = 0; i < allIds.length; i += 1) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      layout[allIds[i]!] = { x: 80 + col * 300, y: 260 + row * 200 };
    }
    // Root centered above the grid.
    const gridWidth = (cols - 1) * 300;
    layout[MCP_ROOT_NODE_ID] = { x: 80 + gridWidth / 2, y: 40 };
    return layout;
  }

  // Tree layouts: vertical (top→down) or horizontal (left→right).
  const horiz = direction === "horizontal";
  // Secondary-axis spacing between tool columns/rows.
  const toolSpread = horiz ? 410 : 410;
  // Entry point on the primary axis for the first chain link beneath tools.
  const chainStart = horiz ? 330 : 310;

  for (let col = 0; col < toolIds.length; col += 1) {
    const toolId = toolIds[col]!;
    const secondary = 80 + col * toolSpread;
    const primary = horiz ? 80 : 80;
    if (!placed.has(toolId)) {
      layout[toolId] = horiz
        ? { x: primary, y: secondary }
        : { x: secondary, y: primary };
      placed.add(toolId);
    }
    const tool = doc.nodes[toolId];
    visitPath(doc, tool?.kind === "tool" ? tool.entry : null, chainStart, secondary, layout, placed, horiz);
  }

  // Orphan nodes that are not reachable from any tool.
  let orphanIndex = 0;
  for (const id of Object.keys(doc.nodes)) {
    if (!placed.has(id)) {
      const secondary = 80 + toolIds.length * toolSpread;
      const primary = 80 + orphanIndex * (horiz ? 330 : 230);
      layout[id] = horiz
        ? { x: primary, y: secondary }
        : { x: secondary, y: primary };
      placed.add(id);
      orphanIndex += 1;
    }
  }

  // Root: centered above (vertical) or left-of (horizontal) the tools.
  if (horiz) {
    const yPositions = toolIds.map((id) => layout[id]).filter(Boolean);
    const y = yPositions.length > 0
      ? yPositions.reduce((sum, p) => sum + p!.y, 0) / yPositions.length
      : 80;
    layout[MCP_ROOT_NODE_ID] = { x: Math.max(40, (layout[toolIds[0]!]?.x ?? 80) - 280), y };
  } else {
    const xPositions = toolIds.map((id) => layout[id]).filter(Boolean);
    const x = xPositions.length > 0
      ? xPositions.reduce((sum, p) => sum + p!.x, 0) / xPositions.length
      : 80;
    layout[MCP_ROOT_NODE_ID] = { x, y: Math.max(40, (layout[toolIds[0]!]?.y ?? 80) - 230) };
  }

  return layout;
}

export function nextFreePosition(doc: GraphDoc): { x: number; y: number } {
  const positions = Object.values(doc.layout ?? {});
  if (positions.length === 0) return { x: 80, y: 80 };
  const maxY = Math.max(...positions.map((position) => position.y));
  const count = Object.keys(doc.nodes).length;
  return { x: 80 + (count % 4) * 60, y: maxY + 160 };
}

export function makeNode(kind: NodeKind): GraphNode {
  switch (kind) {
    case "tool":
      return { kind: "tool", name: "new_tool", description: "", inputs: [], annotations: { readOnly: true }, entry: null };
    case "action":
      return { kind: "action", http: { method: "GET", url: "" }, next: null };
    case "command":
      return { kind: "command", command: { executable: "node", args: [], output: "text" }, next: null };
    case "script":
      return { kind: "script", script: { runtime: "node", path: "scripts/tool.mjs", args: [], output: "json" }, next: null };
    case "code":
      return { kind: "code", language: "javascript", source: "// input, env, and prev are available\nreturn { ok: true };", next: null };
    case "parallel":
      return { kind: "parallel", branches: [], next: null };
    case "transform":
      return { kind: "transform", op: "pick", pick: [], next: null };
    case "return":
      return { kind: "return", format: "json" };
  }
}

function successorAfter(node: GraphNode): string | null {
  return node.kind === "tool" || node.kind === "return" ? null : node.next;
}

function replaceReference(node: GraphNode, removedId: string, successor: string | null): GraphNode {
  if (node.kind === "tool") return node.entry === removedId ? { ...node, entry: successor } : node;
  if (node.kind === "return") return node;
  if (node.kind === "parallel") {
    const branches = node.branches.map((branch) => branch.entry === removedId ? { ...branch, entry: successor } : branch);
    return { ...node, branches, next: node.next === removedId ? successor : node.next };
  }
  return node.next === removedId ? { ...node, next: successor } : node;
}

export function removeConnectedNode(doc: GraphDoc, id: string): GraphDoc {
  const removed = doc.nodes[id];
  if (!removed) return doc;
  const idsToDelete = new Set<string>([id]);
  if (removed.kind === "tool") {
    for (const ownedId of reachableExecutionNodeIds(doc, removed.entry)) idsToDelete.add(ownedId);
  } else if (removed.kind === "parallel") {
    // Branch paths are private children of the parallel node. Its `next` path
    // is the joined continuation and must survive so predecessors can splice
    // around the deleted fan-out without leaving invisible orphan branches.
    for (const branch of removed.branches) {
      for (const ownedId of reachableExecutionNodeIds(doc, branch.entry)) idsToDelete.add(ownedId);
    }
  }
  const successor = successorAfter(removed);
  const nodes: Record<string, GraphNode> = {};
  for (const [nodeId, node] of Object.entries(doc.nodes)) {
    if (idsToDelete.has(nodeId)) continue;
    nodes[nodeId] = replaceReference(node, id, successor);
  }
  const layout = { ...(doc.layout ?? {}) };
  for (const nodeId of idsToDelete) delete layout[nodeId];
  return { ...doc, nodes, layout };
}

export interface ConnectedNodeResult { id: string; doc: GraphDoc }

function setPrimaryContinuation(node: GraphNode, target: string): GraphNode | null {
  if (node.kind === "tool") return { ...node, entry: target };
  if (node.kind === "return") return null;
  return { ...node, next: target };
}

export function addConnectedNode(doc: GraphDoc, sourceId: string, kind: ConnectedNodeKind): ConnectedNodeResult | null {
  if (!allowedConnectedKinds(doc, sourceId).includes(kind)) return null;
  const id = nextNodeId(doc, kind);
  let node = makeNode(kind);
  const nodes: Record<string, GraphNode> = { ...doc.nodes };
  const layout = fillMissingLayout(doc);
  let oldTarget: string | null = null;
  if (sourceId === MCP_ROOT_NODE_ID) {
    nodes[id] = node;
  } else {
    const source = nodes[sourceId];
    if (!source || source.kind === "return" || kind === "tool") return null;
    oldTarget = source.kind === "tool" ? source.entry : source.next;
    if (node.kind !== "tool" && node.kind !== "return") node = { ...node, next: oldTarget };
    const updatedSource = setPrimaryContinuation(source, id);
    if (!updatedSource) return null;
    nodes[id] = node;
    nodes[sourceId] = updatedSource;
  }
  const sourcePosition = layout[sourceId] ?? nextFreePosition(doc);
  const siblingOffset = sourceId === MCP_ROOT_NODE_ID
    ? Object.values(doc.nodes).filter((candidate) => candidate.kind === "tool").length * 330
    : 0;
  for (const tailId of reachableExecutionNodeIds(doc, oldTarget)) {
    const position = layout[tailId];
    if (position) layout[tailId] = { ...position, y: position.y + 230 };
  }
  layout[id] = { x: sourcePosition.x + siblingOffset, y: sourcePosition.y + 230 };
  return { id, doc: { ...doc, nodes, layout } };
}

/** Adds a named path to a parallel node and creates its first operation in one
 * transaction, preserving the no-floating-node visual invariant. */
export function addParallelBranch(doc: GraphDoc, parallelId: string, kind: Exclude<NodeKind, "tool" | "return">): ConnectedNodeResult | null {
  const parallel = doc.nodes[parallelId];
  if (!parallel || parallel.kind !== "parallel") return null;
  const id = nextNodeId(doc, kind);
  const existingNames = new Set(parallel.branches.map((branch) => branch.name));
  let index = parallel.branches.length + 1;
  while (existingNames.has(`request_${index}`)) index += 1;
  const branches = [...parallel.branches, { name: `request_${index}`, entry: id }];
  const layout = fillMissingLayout(doc);
  const source = layout[parallelId] ?? nextFreePosition(doc);
  layout[id] = { x: source.x + (branches.length - 1) * 330 - ((branches.length - 1) * 330) / 2, y: source.y + 230 };
  return {
    id,
    doc: {
      ...doc,
      nodes: { ...doc.nodes, [parallelId]: { ...parallel, branches }, [id]: makeNode(kind) },
      layout,
    },
  };
}

/** Disconnect an exact serialized edge. Legacy source-only ids still clear the
 * primary continuation so old renderer actions remain compatible. */
export function disconnectEdge(doc: GraphDoc, edgeId: string): GraphDoc {
  if (!edgeId.startsWith("e_")) return doc;
  const encoded = edgeId.slice(2);
  const split = encoded.lastIndexOf("__");
  const sourceId = split >= 0 ? encoded.slice(0, split) : encoded;
  const field = split >= 0 ? encoded.slice(split + 2) : "next";
  const source = doc.nodes[sourceId];
  if (!source || source.kind === "return") return doc;
  let updated: GraphNode;
  if (source.kind === "tool") updated = { ...source, entry: null };
  else if (source.kind === "parallel" && field.startsWith("branches_")) {
    const index = Number(field.split("_")[1]);
    updated = { ...source, branches: source.branches.map((branch, i) => i === index ? { ...branch, entry: null } : branch) };
  } else updated = { ...source, next: null };
  return { ...doc, nodes: { ...doc.nodes, [sourceId]: updated } };
}

export function serializableDoc(doc: GraphDoc): GraphDoc {
  return { version: GRAPH_DOC_VERSION, server: doc.server, nodes: doc.nodes, edges: deriveEdges(doc), layout: doc.layout ?? {} };
}

export function serializeDocText(doc: GraphDoc): string {
  return JSON.stringify(serializableDoc(doc), null, 2) + "\n";
}
