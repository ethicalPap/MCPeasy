// Pure helpers for the {{var}} placeholder assistant. Kept React-free so the
// suggestion logic is unit-testable (apps/desktop/test/templateVars.test.ts)
// and so a future CLI "explain" command could reuse it.

import { reachableExecutionNodeIds, type GraphDoc, type ToolNode } from "@mcpeasy/schema";

export interface VarSuggestion {
  /** Exact token to insert, e.g. "{{input.city}}". */
  token: string;
  /** Where the value comes from — drives the chip group label. */
  scope: "input" | "env" | "prev";
  /** Human hint shown in the chip title. */
  hint: string;
}

/** Walk chains backward: which tool(s) can reach `nodeId`? A template field
 * on an action/transform/return should only offer the inputs of tools whose
 * chain actually flows through that node — offering every tool's inputs
 * would suggest variables that render as empty at runtime. */
export function toolsReaching(doc: GraphDoc, nodeId: string): ToolNode[] {
  const out: ToolNode[] = [];
  for (const node of Object.values(doc.nodes)) {
    if (node.kind !== "tool") continue;
    if (reachableExecutionNodeIds(doc, node.entry).includes(nodeId)) out.push(node);
  }
  return out;
}

/** Does any execution step run BEFORE `nodeId` in some chain? Only then does
 * {{prev}} hold a value worth suggesting. */
export function hasUpstreamStep(doc: GraphDoc, nodeId: string): boolean {
  for (const node of Object.values(doc.nodes)) {
    if (node.kind !== "tool") continue;
    const reachable = reachableExecutionNodeIds(doc, node.entry);
    const index = reachable.indexOf(nodeId);
    if (index > 0) return true;
  }
  return false;
}

/**
 * Every variable the user can legally insert into a template field on
 * `nodeId`: the reaching tools' inputs, the server's declared env names, and
 * {{prev}} when an upstream step exists. This is what makes raw `{{ }}`
 * typing unnecessary — the panel renders these as one-click chips.
 */
export function varSuggestionsFor(doc: GraphDoc, nodeId: string): VarSuggestion[] {
  const out: VarSuggestion[] = [];
  const seen = new Set<string>();
  for (const tool of toolsReaching(doc, nodeId)) {
    for (const input of tool.inputs) {
      if (!input.name || seen.has(input.name)) continue;
      seen.add(input.name);
      out.push({
        token: `{{input.${input.name}}}`,
        scope: "input",
        hint: input.description || `${input.type} argument of ${tool.name || "the tool"}`,
      });
    }
  }
  for (const name of doc.server.env) {
    if (!name) continue;
    out.push({ token: `{{env.${name}}}`, scope: "env", hint: "environment value (never stored in the doc)" });
  }
  if (hasUpstreamStep(doc, nodeId)) {
    out.push({ token: "{{prev}}", scope: "prev", hint: "the whole previous step result" });
    out.push({ token: "{{prev.field}}", scope: "prev", hint: "a field of the previous step (edit the path)" });
  }
  return out;
}

/** Insert `token` into `text` at the cursor, returning the new text and where
 * the caret should land (after the token — or ON the editable "field" part
 * for the {{prev.field}} teaching token, so typing replaces it directly). */
export function insertToken(
  text: string,
  selStart: number,
  selEnd: number,
  token: string,
): { text: string; caretStart: number; caretEnd: number } {
  const before = text.slice(0, selStart);
  const after = text.slice(selEnd);
  const fieldAt = token.indexOf("field");
  if (fieldAt >= 0) {
    // Select the "field" placeholder so the next keystroke replaces it.
    return {
      text: before + token + after,
      caretStart: selStart + fieldAt,
      caretEnd: selStart + fieldAt + "field".length,
    };
  }
  const caret = selStart + token.length;
  return { text: before + token + after, caretStart: caret, caretEnd: caret };
}
