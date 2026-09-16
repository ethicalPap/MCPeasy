import { z } from "zod";
import { executionReferences, isExecNode, isLocalExecutionNode } from "./execution.js";
import { CODE_LANGUAGES, LIMITS, type GraphDoc, type GraphNode } from "./types.js";

// Validation = structural integrity (shape, limits, dangling refs, cycles).
// Contract QUALITY (naming, descriptions, annotations) is lint's job — the
// two layers are deliberately separate so the editor can hold a structurally
// valid doc that still has lint problems (design §6.5 badges).

const templateString = (max: number) => z.string().max(max);

const inputFieldSchema = z.object({
  name: z.string().min(1).max(LIMITS.maxNameLength),
  type: z.enum(["string", "number", "boolean", "enum"]),
  description: z.string().max(LIMITS.maxDescriptionLength).optional(),
  required: z.boolean().optional(),
  enumValues: z.array(z.string().min(1)).max(100).optional(),
});

const toolNodeSchema = z.object({
  kind: z.literal("tool"),
  // Name PATTERN is a lint rule, not validation — only bound the length here.
  name: z.string().min(1).max(LIMITS.maxNameLength),
  description: z.string().max(LIMITS.maxDescriptionLength),
  inputs: z.array(inputFieldSchema).max(LIMITS.maxInputsPerTool),
  annotations: z.object({
    readOnly: z.boolean(),
    destructive: z.boolean().optional(),
  }),
  entry: z.string().nullable(),
});

const nextSchema = z.string().nullable();
const templateArgsSchema = z.array(templateString(LIMITS.maxTemplateLength)).max(LIMITS.maxLocalArgs);
const localOutputSchema = z.enum(["text", "json"]);

const actionNodeSchema = z.object({
  kind: z.literal("action"),
  http: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    url: templateString(LIMITS.maxTemplateLength).min(1),
    headers: z.record(z.string().max(256), templateString(LIMITS.maxTemplateLength)).optional(),
    body: templateString(LIMITS.maxTemplateLength).optional(),
  }),
  next: nextSchema,
});

const commandNodeSchema = z.object({
  kind: z.literal("command"),
  command: z.object({
    executable: z.string().min(1).max(1024),
    args: templateArgsSchema,
    stdin: templateString(LIMITS.maxTemplateLength).optional(),
    cwd: z.string().min(1).max(1024).optional(),
    output: localOutputSchema,
  }),
  next: nextSchema,
});

const scriptNodeSchema = z.object({
  kind: z.literal("script"),
  script: z.object({
    runtime: z.enum(["node", "python", "powershell", "bash"]),
    path: z.string().min(1).max(1024),
    args: templateArgsSchema,
    stdin: templateString(LIMITS.maxTemplateLength).optional(),
    cwd: z.string().min(1).max(1024).optional(),
    output: localOutputSchema,
  }),
  next: nextSchema,
});

const codeNodeSchema = z.object({
  kind: z.literal("code"),
  // Widened from z.literal("javascript"). Enumerating from the shared
  // CODE_LANGUAGES tuple keeps validation, the engine's runner table and the
  // editor's picker from drifting apart — adding a language in one place
  // without the others is exactly how a doc becomes saveable but unrunnable.
  language: z.enum(CODE_LANGUAGES),
  source: z.string().min(1).max(LIMITS.maxCodeLength),
  next: nextSchema,
});

const parallelNodeSchema = z.object({
  kind: z.literal("parallel"),
  branches: z.array(z.object({
    name: z.string().min(1).max(LIMITS.maxNameLength),
    entry: z.string().nullable(),
  })).max(LIMITS.maxParallelBranches),
  next: nextSchema,
});

const transformNodeSchema = z.object({
  kind: z.literal("transform"),
  op: z.enum(["pick", "template"]),
  pick: z.array(z.string().min(1).max(512)).max(100).optional(),
  template: templateString(LIMITS.maxTemplateLength).optional(),
  next: nextSchema,
});

const returnNodeSchema = z.object({
  kind: z.literal("return"),
  format: z.enum(["json", "text"]),
  template: templateString(LIMITS.maxTemplateLength).optional(),
});

const nodeSchema = z.discriminatedUnion("kind", [
  toolNodeSchema,
  actionNodeSchema,
  commandNodeSchema,
  scriptNodeSchema,
  codeNodeSchema,
  parallelNodeSchema,
  transformNodeSchema,
  returnNodeSchema,
]);

// Edges/layout are validated loosely: they are editor-only rendering state
// (decision #3) and must never be able to make a doc un-runnable.
const edgeSchema = z.object({ id: z.string(), source: z.string(), target: z.string() });

const graphDocSchema = z.object({
  version: z.number().int().positive(),
  server: z.object({
    name: z.string().min(1).max(LIMITS.maxNameLength),
    description: z.string().max(LIMITS.maxDescriptionLength).optional(),
    creator: z.string().max(LIMITS.maxNameLength).optional(),
    version: z.string().min(1).max(64),
    transport: z.enum(["stdio", "http"]),
    auth: z.object({ type: z.enum(["none", "bearer"]) }),
    execution: z.object({ allowLocal: z.boolean() }).optional(),
    env: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(LIMITS.maxNameLength)).max(100),
  }),
  nodes: z.record(z.string().min(1).max(128), nodeSchema),
  edges: z.array(edgeSchema).max(2000).optional(),
  // No entry-count cap here: ZodRecord has no .max(), and layout is bounded
  // in practice by maxNodes enforced on `nodes` (orphan layout entries are
  // harmless editor state).
  layout: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
});

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; doc: GraphDoc }
  | { ok: false; issues: ValidationIssue[] };

/**
 * Shape-only parse (zod), skipping graph-level checks. Exists for the editor:
 * a doc whose SHAPE is right but whose graph has cycles/merges/dangling refs
 * must still OPEN (with the problems shown inline) rather than be refused —
 * refusing would lock users out of fixing their own file visually.
 */
export function parseGraphDocShape(raw: unknown): ValidationResult {
  const parsed = graphDocSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }
  return { ok: true, doc: parsed.data as GraphDoc };
}

/**
 * Full structural validation: zod shape first, then graph-level checks that
 * zod cannot express (dangling refs, shared chain segments, cycles, length).
 */
export function validateGraphDoc(raw: unknown): ValidationResult {
  const shape = parseGraphDocShape(raw);
  if (!shape.ok) return shape;
  const doc = shape.doc;
  const issues: ValidationIssue[] = [];

  const nodeIds = Object.keys(doc.nodes);
  if (nodeIds.length > LIMITS.maxNodes) {
    issues.push({ path: "nodes", message: `too many nodes (${nodeIds.length} > ${LIMITS.maxNodes})` });
  }

  // All executable references, including fan-out entries, participate in the
  // same ownership/cycle checks. A branch may end at null: its raw value is
  // joined by the owning parallel node instead of requiring a Return node.
  const refTargets: Array<{ from: string; to: string }> = [];
  for (const [id, node] of Object.entries(doc.nodes)) {
    for (const ref of executionReferences(node)) refTargets.push({ from: `${id}.${ref.field}`, to: ref.to });
  }
  for (const { from, to } of refTargets) {
    const target = doc.nodes[to];
    if (!target) issues.push({ path: from, message: `references missing node "${to}"` });
    else if (!isExecNode(target)) issues.push({ path: from, message: `references tool node "${to}"; execution paths may contain only operation/parallel/transform/return nodes` });
  }

  // Fan-in remains forbidden. An explicit parallel node owns both the fan-out
  // and its join; permitting branches to point at the same tail would run that
  // tail more than once and make its `prev` source ambiguous.
  const incoming = new Map<string, number>();
  for (const { to } of refTargets) incoming.set(to, (incoming.get(to) ?? 0) + 1);
  for (const [to, count] of incoming) {
    const target = doc.nodes[to];
    if (count > 1 && target && isExecNode(target)) {
      issues.push({ path: to, message: `${count} paths merge into this node; each execution node belongs to exactly one path` });
    }
  }

  // DFS follows normal and parallel successors. The recursion depth is bounded
  // before descent, so adversarial nested fan-out cannot overflow the stack.
  for (const [toolId, node] of Object.entries(doc.nodes)) {
    if (node.kind !== "tool" || node.entry === null) continue;
    const walk = (cursor: string, path: Set<string>, steps: number): void => {
      if (path.has(cursor)) {
        issues.push({ path: toolId, message: `chain contains a cycle through "${cursor}"` });
        return;
      }
      if (steps > LIMITS.maxChainLength) {
        issues.push({ path: toolId, message: `chain longer than ${LIMITS.maxChainLength} nodes` });
        return;
      }
      const current = doc.nodes[cursor];
      if (!current || !isExecNode(current)) return;
      const nextPath = new Set(path);
      nextPath.add(cursor);
      for (const ref of executionReferences(current)) walk(ref.to, nextPath, steps + 1);
    };
    walk(node.entry, new Set(), 1);
  }

  for (const [id, node] of Object.entries(doc.nodes)) {
    if (node.kind !== "parallel") continue;
    if (node.branches.length === 0) {
      issues.push({ path: `${id}.branches`, message: "parallel node needs at least one branch" });
    }
    const names = new Set<string>();
    for (let index = 0; index < node.branches.length; index += 1) {
      const branch = node.branches[index]!;
      if (names.has(branch.name)) {
        issues.push({ path: `${id}.branches`, message: `parallel branch names must be unique; "${branch.name}" is repeated` });
      }
      names.add(branch.name);
      const pending = branch.entry === null ? [] : [branch.entry];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const cursor = pending.shift()!;
        if (visited.has(cursor)) continue;
        visited.add(cursor);
        const branchNode = doc.nodes[cursor];
        if (!branchNode || !isExecNode(branchNode)) continue;
        if (branchNode.kind === "return") {
          issues.push({
            path: `${id}.branches.${index}.entry`,
            message: `parallel branch "${branch.name}" reaches a return node; return after the join instead`,
          });
          continue;
        }
        for (const reference of executionReferences(branchNode)) pending.push(reference.to);
      }
    }
  }

  const localNodeIds = Object.entries(doc.nodes)
    .filter(([, node]) => isLocalExecutionNode(node))
    .map(([id]) => id);
  if (localNodeIds.length > 0 && doc.server.execution?.allowLocal !== true) {
    issues.push({
      path: "server.execution.allowLocal",
      message: `local execution nodes (${localNodeIds.join(", ")}) require server.execution.allowLocal: true`,
    });
  }
  // Enum inputs must actually enumerate something, and non-enum inputs must
  // not carry stray enumValues that the JSON Schema projection would emit.
  for (const [id, node] of Object.entries(doc.nodes)) {
    if (node.kind !== "tool") continue;
    for (const input of node.inputs) {
      if (input.type === "enum" && (!input.enumValues || input.enumValues.length === 0)) {
        issues.push({ path: `${id}.inputs.${input.name}`, message: `enum input needs non-empty enumValues` });
      }
      if (input.type !== "enum" && input.enumValues) {
        issues.push({ path: `${id}.inputs.${input.name}`, message: `enumValues only allowed on enum inputs` });
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, doc };
}
