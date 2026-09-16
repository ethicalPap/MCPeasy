import type { ExecNode, GraphDoc, GraphNode } from "./types.js";

export interface ExecutionReference {
  /** Field path relative to the node; used by validation and edge identities. */
  field: string;
  to: string;
}

export function isExecNode(node: GraphNode): node is ExecNode {
  return node.kind !== "tool";
}

export function isLocalExecutionNode(node: GraphNode): boolean {
  return node.kind === "command" || node.kind === "script" || node.kind === "code";
}

/** One source of truth for graph control-flow references. Parallel branches
 * fan out; `next` is the join continuation and deliberately remains last. */
export function executionReferences(node: GraphNode): ExecutionReference[] {
  if (node.kind === "tool") return node.entry === null ? [] : [{ field: "entry", to: node.entry }];
  if (node.kind === "return") return [];
  const references: ExecutionReference[] = [];
  if (node.kind === "parallel") {
    for (let index = 0; index < node.branches.length; index += 1) {
      const entry = node.branches[index]!.entry;
      if (entry !== null) references.push({ field: `branches.${index}.entry`, to: entry });
    }
  }
  if (node.next !== null) references.push({ field: "next", to: node.next });
  return references;
}

export function reachableExecutionNodeIds(doc: GraphDoc, entry: string | null): string[] {
  const found: string[] = [];
  const pending = entry === null ? [] : [entry];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const id = pending.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = doc.nodes[id];
    if (!node || !isExecNode(node)) continue;
    found.push(id);
    for (const reference of executionReferences(node)) pending.push(reference.to);
  }
  return found;
}

export function localExecutionNodeIdsForTool(doc: GraphDoc, toolName: string): string[] {
  const tool = Object.values(doc.nodes).find((node) => node.kind === "tool" && node.name === toolName);
  if (!tool || tool.kind !== "tool") return [];
  return reachableExecutionNodeIds(doc, tool.entry).filter((id) => {
    const node = doc.nodes[id];
    return node !== undefined && isLocalExecutionNode(node);
  });
}

/** Session approvals bind to the exact reachable local node definitions, not
 * just their ids. Editing code, argv, runtime, or path therefore requires a
 * fresh confirmation even when the canvas node id remains stable. */
export function localExecutionApprovalForTool(doc: GraphDoc, toolName: string): string | null {
  const entries = localExecutionNodeIdsForTool(doc, toolName).map((id) => [id, doc.nodes[id]]);
  return entries.length === 0 ? null : JSON.stringify(entries);
}

export function graphUsesLocalExecution(doc: GraphDoc): boolean {
  return Object.values(doc.nodes).some(isLocalExecutionNode);
}
