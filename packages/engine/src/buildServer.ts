import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  lintErrorCount,
  lintGraphDoc,
  migrateGraphDoc,
  toolMcpDefinition,
  validateGraphDoc,
  type GraphDoc,
  type ToolNode,
} from "@mcpeasy/schema";
import { runChain } from "./runChain.js";
import { DEFAULT_HTTP_POLICY, type HttpPolicy } from "./httpAction.js";
import {
  DEFAULT_LOCAL_EXECUTION_POLICY,
  type LocalExecutionPolicy,
} from "./localExecution.js";

export interface BuildOptions {
  httpPolicy?: Partial<HttpPolicy>;
  /** Host-owned grant. Graph `server.execution.allowLocal` only declares
   * intent; both gates must be true before machine code can execute. */
  localExecutionPolicy?: Partial<LocalExecutionPolicy>;
}

export class BuildError extends Error {}

/**
 * Load = migrate → validate → check env → check lint errors. Warnings remain
 * authoring advice; missing returns are deferred to the invoked tool at runtime
 * so unfinished tools do not prevent testing independent, completed tools.
 */
export function loadGraphDoc(raw: unknown, env: Record<string, string>): GraphDoc {
  const migrated = migrateGraphDoc(raw);
  const result = validateGraphDoc(migrated);
  if (!result.ok) {
    const detail = result.issues.map((i) => `  ${i.path}: ${i.message}`).join("\n");
    throw new BuildError(`graph doc is invalid:\n${detail}`);
  }
  const missing = result.doc.server.env.filter((name) => env[name] === undefined);
  if (missing.length > 0) {
    // Fail at startup, not mid-call: a missing env var at call time would
    // surface as a confusing upstream 401 instead of a clear local error.
    throw new BuildError(`missing required env vars: ${missing.join(", ")}`);
  }
  const lint = lintGraphDoc(result.doc);
  if (lintErrorCount(lint) > 0) {
    const detail = Object.entries(lint)
      .flatMap(([id, problems]) =>
        problems.filter((p) => p.severity === "error").map((p) => `  ${id}: [${p.rule}] ${p.message}`),
      )
      .join("\n");
    throw new BuildError(`graph doc has lint errors:\n${detail}`);
  }
  return result.doc;
}

function coerceArgs(tool: ToolNode, args: Record<string, unknown>): Record<string, unknown> {
  // The SDK validated args against our JSON Schema already; this pass only
  // fills absent OPTIONAL inputs with "" so templates render deterministically
  // instead of printing the string "undefined".
  const out: Record<string, unknown> = {};
  for (const input of tool.inputs) {
    const value = args[input.name];
    out[input.name] = value === undefined ? "" : value;
  }
  return out;
}

/**
 * The ONLY seam between the SDK and the engine core (locked decision #2):
 * one tools/list + tools/call handler pair over the SDK's LOW-LEVEL Server.
 * The high-level McpServer.registerTool stopped accepting raw JSON Schema
 * (SDK 1.30.0 requires Zod schemas/raw shapes and throws on plain objects),
 * and round-tripping our schema through Zod would let the SDK's converter
 * reshape the wire format. The low-level handlers keep the wire bytes equal
 * to schema's toolInputJsonSchema — the projection the editor preview (F3)
 * and the compiler must reproduce — so MCP spec churn stays contained here
 * (risk table §11).
 */
export function buildServer(
  doc: GraphDoc,
  env: Record<string, string>,
  options?: BuildOptions,
): Server {
  const server = new Server(
    {
      name: doc.server.name,
      version: doc.server.version,
      ...(doc.server.description?.trim() ? { description: doc.server.description } : {}),
    },
    { capabilities: { tools: {} } },
  );
  const httpPolicy: HttpPolicy = { ...DEFAULT_HTTP_POLICY, ...options?.httpPolicy };
  const localPolicy: LocalExecutionPolicy = {
    ...DEFAULT_LOCAL_EXECUTION_POLICY,
    ...options?.localExecutionPolicy,
    // A host grant cannot override a document that did not explicitly declare
    // local execution. This prevents an innocuous graph from gaining powers
    // because the containing process was started permissively.
    enabled:
      doc.server.execution?.allowLocal === true &&
      options?.localExecutionPolicy?.enabled === true,
  };

  const tools = new Map<string, ToolNode>();
  for (const node of Object.values(doc.nodes)) {
    if (node.kind === "tool") tools.set(node.name, node);
  }

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...tools.values()].map((tool) => ({
      ...toolMcpDefinition(tool),
      annotations: {
        // SDK/spec hint names differ from our doc field names on purpose;
        // our doc favors the words users see in the properties panel.
        readOnlyHint: tool.annotations.readOnly,
        ...(tool.annotations.destructive !== undefined
          ? { destructiveHint: tool.annotations.destructive }
          : {}),
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.get(request.params.name);
    if (!tool) {
      // Unknown tool is a PROTOCOL error (the client addressed nothing),
      // unlike chain failures which are isError tool RESULTS below.
      throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${request.params.name}`);
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    // The high-level SDK used to validate args for us; the low-level path
    // does not, so enforce the one rule templates depend on: required
    // inputs must be present (absent optionals become "" in coerceArgs).
    const missing = tool.inputs
      .filter((i) => i.required !== false && args[i.name] === undefined)
      .map((i) => i.name);
    if (missing.length > 0) {
      throw new McpError(ErrorCode.InvalidParams, `missing required arguments: ${missing.join(", ")}`);
    }
    const scope = { input: coerceArgs(tool, args), env, prev: undefined };
    // EngineToolResult mirrors CallToolResult structurally (decision #2: the
    // engine core stays SDK-neutral); the cast bridges the SDK's branded
    // union type, which structural typing alone cannot satisfy.
    return (await runChain(doc, tool.entry, scope, { http: httpPolicy, local: localPolicy })) as CallToolResult;
  });

  return server;
}
