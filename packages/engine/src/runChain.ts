import { LIMITS, type GraphDoc, type ParallelNode } from "@mcpeasy/schema";
import { EngineError, renderTemplate, type RenderScope } from "./render.js";
import { applyTransform } from "./transforms.js";
import { DEFAULT_HTTP_POLICY, runHttpAction, type HttpPolicy } from "./httpAction.js";
import {
  DEFAULT_LOCAL_EXECUTION_POLICY,
  runCode,
  runCommand,
  runScript,
  type LocalExecutionPolicy,
} from "./localExecution.js";

// Mirrors the SDK's CallToolResult shape without importing the SDK: the
// browser test console must be able to drive chains without the server
// wrapper, so the engine core stays SDK-neutral (locked decision #2).
export interface EngineToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface RunChainPolicy {
  http: HttpPolicy;
  local: LocalExecutionPolicy;
}

function asStructured(value: unknown): Record<string, unknown> {
  // structuredContent must be a JSON OBJECT per the MCP schema; arrays and
  // primitives are wrapped so clients still get typed access at a stable key.
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value };
}

function finish(
  value: unknown,
  format: "json" | "text",
  template: string | undefined,
  scope: RenderScope,
): EngineToolResult {
  if (format === "text") {
    const text =
      template !== undefined
        ? renderTemplate(template, scope)
        : typeof value === "string"
          ? value
          : JSON.stringify(value);
    return { content: [{ type: "text", text }] };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: asStructured(value),
  };
}

interface PathResult {
  value: unknown;
  returned?: EngineToolResult;
}

function cloneScope(scope: RenderScope): RenderScope {
  // Every request and parallel branch owns its `prev`. Sharing input/env is
  // intentional read-only data flow; branch mutation can never race another
  // branch through the scope object itself.
  return { input: scope.input, env: scope.env, prev: scope.prev };
}

async function runParallel(
  doc: GraphDoc,
  node: ParallelNode,
  scope: RenderScope,
  policy: RunChainPolicy,
  depth: number,
): Promise<Record<string, unknown>> {
  if (node.branches.length === 0) throw new EngineError("parallel node has no branches");
  const settled = await Promise.allSettled(
    node.branches.map(async (branch) => {
      if (branch.entry === null) throw new EngineError(`parallel branch "${branch.name}" is not connected`);
      const result = await runPath(doc, branch.entry, cloneScope(scope), policy, depth + 1, true);
      if (result.returned) throw new EngineError(`parallel branch "${branch.name}" reaches a return node; return after the join instead`);
      return [branch.name, result.value] as const;
    }),
  );
  // Every HTTP/process branch is already bounded. Waiting for all launched
  // branches to settle prevents a failed sibling from leaving background work
  // running after the tool result has returned.
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  return Object.fromEntries(settled.map((result) => (result as PromiseFulfilledResult<readonly [string, unknown]>).value));
}

async function runPath(
  doc: GraphDoc,
  entryId: string | null,
  scope: RenderScope,
  policy: RunChainPolicy,
  depth: number,
  allowNaturalEnd: boolean,
): Promise<PathResult> {
  if (depth > LIMITS.maxChainLength) throw new EngineError(`chain exceeded ${LIMITS.maxChainLength} steps`);
  let cursor = entryId;
  let steps = depth;
  while (cursor !== null) {
    steps += 1;
    if (steps > LIMITS.maxChainLength) throw new EngineError(`chain exceeded ${LIMITS.maxChainLength} steps`);
    const node = doc.nodes[cursor];
    if (!node || node.kind === "tool") throw new EngineError(`chain step "${cursor}" is not an execution node`);
    switch (node.kind) {
      case "action":
        scope.prev = await runHttpAction(node, scope, policy.http);
        cursor = node.next;
        break;
      case "command":
        scope.prev = await runCommand(node, scope, policy.local);
        cursor = node.next;
        break;
      case "script":
        scope.prev = await runScript(node, scope, policy.local);
        cursor = node.next;
        break;
      case "code":
        scope.prev = await runCode(node, scope, policy.local);
        cursor = node.next;
        break;
      case "parallel":
        scope.prev = await runParallel(doc, node, scope, policy, steps);
        cursor = node.next;
        break;
      case "transform":
        scope.prev = applyTransform(node, scope);
        cursor = node.next;
        break;
      case "return":
        return { value: scope.prev, returned: finish(scope.prev, node.format, node.template, scope) };
    }
  }
  if (allowNaturalEnd) return { value: scope.prev };
  throw new EngineError("chain never reaches a return node");
}

/** Backward-compatible policy input: old callers may pass an HttpPolicy;
 * current callers can additionally grant bounded local execution. */
export async function runChain(
  doc: GraphDoc,
  entryId: string | null,
  scope: RenderScope,
  policy: HttpPolicy | Partial<RunChainPolicy> = DEFAULT_HTTP_POLICY,
): Promise<EngineToolResult> {
  try {
    const resolved: RunChainPolicy = "mode" in policy
      ? { http: policy, local: DEFAULT_LOCAL_EXECUTION_POLICY }
      : {
          http: policy.http ?? DEFAULT_HTTP_POLICY,
          local: policy.local ?? DEFAULT_LOCAL_EXECUTION_POLICY,
        };
    const result = await runPath(doc, entryId, cloneScope(scope), resolved, 0, false);
    if (result.returned) return result.returned;
    throw new EngineError("chain never reaches a return node");
  } catch (cause) {
    if (cause instanceof EngineError) {
      return { isError: true, content: [{ type: "text", text: cause.message }] };
    }
    // Unknown failure: never leak internals, local stderr, source, paths, or
    // environment values into model-visible error text.
    return { isError: true, content: [{ type: "text", text: "internal engine error" }] };
  }
}
