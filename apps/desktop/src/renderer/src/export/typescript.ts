import type { GraphDoc } from "@mcpeasy/schema";
import { exportSlug, unsupportedCodeLanguages, type ExportFile } from "./types";

// TypeScript export: a runnable npm project. The graph travels as DATA
// (graph.json) and server.ts is a small generic runtime with the same
// semantics as @mcpeasy/engine — one runtime that executes any graph, so
// exported behavior cannot drift per-tool from what the test console showed.
// (The alternative — transpiling each chain into bespoke code — is the
// phase-4 compiler's job; duplicating it here would fork the semantics.)

// Versions verified against npmjs.org at generation-feature build time and
// kept consistent with this repo's own pins (package.json / VERSIONS.md).
const SDK_VERSION = "^1.30.0";
const TSX_VERSION = "^4.23.13";
const TYPES_NODE_VERSION = "^26.4.1";

function packageJson(doc: GraphDoc, slug: string): string {
  return JSON.stringify(
    {
      name: slug,
      version: doc.server.version || "0.1.0",
      private: true,
      type: "module",
      description: doc.server.description || `MCP server exported from MCPeasy`,
      scripts: {
        start: "tsx src/server.ts",
      },
      // Node >= 20: the SDK itself needs >= 18, but the inline custom-code
      // runner spawns child node processes and 20 is the oldest line still
      // in its support window.
      engines: { node: ">=20" },
      dependencies: {
        "@modelcontextprotocol/sdk": SDK_VERSION,
      },
      devDependencies: {
        tsx: TSX_VERSION,
        "@types/node": TYPES_NODE_VERSION,
      },
    },
    null,
    2,
  ) + "\n";
}

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["ES2022"],
      types: ["node"],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ["src"],
  },
  null,
  2,
) + "\n";

/** The generic runtime. Deliberately avoids template literals so this file
 * can be emitted from one without an escaping minefield. */
function serverTs(doc: GraphDoc): string {
  const title = doc.server.name || "mcp-server";
  return `// ${title}, exported by MCPeasy.
// graph.json is the server definition; this file is a generic runtime that
// serves it over stdio with the same semantics as MCPeasy's test console.
// From here on this project is yours. Edit freely, or re-export from
// MCPeasy and replace graph.json to pick up canvas changes.
//
//   npm install
//   npm start          (serves over stdio, e.g. for Claude Desktop)

import { readFileSync } from "node:fs";
import { execFile, type ExecFileException } from "node:child_process";
import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Graph doc shape (structural mirror of MCPeasy's schema, doc version 1).

interface InputField {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  description?: string;
  required?: boolean;
  enumValues?: string[];
}
interface ToolNode {
  kind: "tool";
  name: string;
  description: string;
  inputs: InputField[];
  annotations: { readOnly: boolean; destructive?: boolean };
  entry: string | null;
}
interface ActionNode {
  kind: "action";
  http: { method: string; url: string; headers?: Record<string, string>; body?: string };
  next: string | null;
}
interface TransformNode {
  kind: "transform";
  op: "pick" | "template";
  pick?: string[];
  template?: string;
  next: string | null;
}
type LocalOutput = "text" | "json";
interface CommandNode {
  kind: "command";
  command: { executable: string; args: string[]; stdin?: string; cwd?: string; output: LocalOutput };
  next: string | null;
}
interface ScriptNode {
  kind: "script";
  script: {
    runtime: "node" | "python" | "powershell" | "bash";
    path: string;
    args: string[];
    stdin?: string;
    cwd?: string;
    output: LocalOutput;
  };
  next: string | null;
}
/** language is a plain string, not a union of the eight MCPeasy supports:
 *  this runtime implements javascript/typescript and rejects the rest at
 *  runtime (see runCode), so narrowing the type here would make a graph the
 *  exporter can legally produce fail to COMPILE instead of failing clearly. */
interface CodeNode { kind: "code"; language?: string; source: string; next: string | null }
interface ParallelNode { kind: "parallel"; branches: Array<{ name: string; entry: string | null }>; next: string | null }
interface ReturnNode { kind: "return"; format: "json" | "text"; template?: string }
type GraphNode = ToolNode | ActionNode | TransformNode | CommandNode | ScriptNode | CodeNode | ParallelNode | ReturnNode;
interface GraphDoc {
  version: number;
  server: {
    name: string;
    description?: string;
    version: string;
    env: string[];
    execution?: { allowLocal: boolean };
  };
  nodes: Record<string, GraphNode>;
}

const doc = JSON.parse(readFileSync(new URL("../graph.json", import.meta.url), "utf8")) as GraphDoc;

// Fail at startup, not mid-call: a missing env var at call time would surface
// as a confusing upstream 401 instead of a clear local error.
const env: Record<string, string> = {};
const missingEnv: string[] = [];
for (const name of doc.server.env) {
  const value = process.env[name];
  if (value === undefined) missingEnv.push(name);
  else env[name] = value;
}
if (missingEnv.length > 0) {
  // stderr only — stdout belongs to the JSON-RPC transport.
  console.error("missing required env vars: " + missingEnv.join(", "));
  process.exit(1);
}

// Command/script/custom-code blocks run with YOUR user permissions. Two gates,
// both required (mirrors MCPeasy's host-grant model): the graph declares
// execution.allowLocal AND the operator sets MCPEASY_ALLOW_LOCAL=1.
const allowLocal =
  doc.server.execution?.allowLocal === true &&
  ["1", "true"].includes((process.env.MCPEASY_ALLOW_LOCAL ?? "").toLowerCase());

const LIMITS = {
  maxChainLength: 50,
  httpTimeoutMs: 15_000,
  maxResponseBytes: 1_048_576,
  localTimeoutMs: 15_000,
  maxOutputBytes: 1_048_576,
};

/** Expected chain failures; their messages are safe to show the model. */
class ChainError extends Error {}

// ---------------------------------------------------------------------------
// {{...}} templates. The root set is closed on purpose: anything else must
// fail parsing rather than silently pass through to an HTTP request.

interface Scope { input: Record<string, unknown>; env: Record<string, string>; prev: unknown }

const REF_RE = /\\{\\{\\s*(input|env|prev)((?:\\.[A-Za-z0-9_$-]+)*)\\s*\\}\\}/g;

interface Ref { root: "input" | "env" | "prev"; path: string[]; raw: string; start: number; end: number }

function parseRefs(template: string): Ref[] {
  const refs: Ref[] = [];
  for (const m of template.matchAll(REF_RE)) {
    const rawPath = m[2] ?? "";
    refs.push({
      root: m[1] as Ref["root"],
      path: rawPath === "" ? [] : rawPath.slice(1).split("."),
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return refs;
}

function lookup(ref: Ref, scope: Scope): unknown {
  let value: unknown = ref.root === "input" ? scope.input : ref.root === "env" ? scope.env : scope.prev;
  // Traversing INTO a non-object is an authoring error and throws; a missing
  // LEAF renders as "" (predictable when upstream APIs omit optional fields).
  for (const segment of ref.path) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object") {
      throw new ChainError(ref.raw + ": cannot read \\"" + segment + "\\" of a " + typeof value);
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** URL rendering percent-encodes runtime data (input/prev) so it cannot
 * inject path segments; env refs stay raw so {{env.BASE_URL}}/x composes. */
function renderTemplate(template: string, scope: Scope, encode?: (ref: Ref) => boolean): string {
  const refs = parseRefs(template);
  let out = "";
  let cursor = 0;
  for (const ref of refs) {
    out += template.slice(cursor, ref.start);
    const text = stringify(lookup(ref, scope));
    out += encode?.(ref) ? encodeURIComponent(text) : text;
    cursor = ref.end;
  }
  return out + template.slice(cursor);
}

/** A template that is exactly one {{ref}} passes the VALUE through with its
 * type intact — this is what lets a POST body of "{{prev}}" forward JSON. */
function renderValue(template: string, scope: Scope): unknown {
  const refs = parseRefs(template);
  if (refs.length === 1 && refs[0]!.start === 0 && refs[0]!.end === template.length) {
    return lookup(refs[0]!, scope);
  }
  return renderTemplate(template, scope);
}

// ---------------------------------------------------------------------------
// Transforms.

function pickInto(source: unknown, path: string): { key: string; value: unknown } {
  const segments = path.split(".");
  // Last segment names the output key: picking "address.city" yields { city }.
  const key = segments[segments.length - 1]!;
  let value: unknown = source;
  for (const segment of segments) {
    if (value === null || typeof value !== "object") return { key, value: undefined };
    value = (value as Record<string, unknown>)[segment];
  }
  return { key, value };
}

function pickObject(source: unknown, paths: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const { key, value } = pickInto(source, path);
    // Missing paths are skipped, not errors: optional API fields are the
    // primary use case. Colliding output keys: last path wins.
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function applyTransform(node: TransformNode, scope: Scope): unknown {
  if (node.op === "pick") {
    const paths = node.pick ?? [];
    // Arrays map element-wise so picking fields from a list endpoint works.
    if (Array.isArray(scope.prev)) return scope.prev.map((el) => pickObject(el, paths));
    return pickObject(scope.prev, paths);
  }
  if (node.template === undefined) throw new ChainError("transform op \\"template\\" requires a template string");
  return renderValue(node.template, scope);
}

// ---------------------------------------------------------------------------
// HTTP actions.

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

async function runHttpAction(node: ActionNode, scope: Scope): Promise<unknown> {
  let url = renderTemplate(node.http.url, scope, (ref) => ref.root !== "env");
  // Scheme-less URLs default to https (mirrors the MCPeasy engine). Requires a
  // full "scheme://" so "localhost:3000/x" is not mistaken for a scheme, and
  // explicit non-http schemes still hit the rejection below.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\//.test(url)) {
    url = "https://" + url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ChainError("invalid URL after templating: " + url);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ChainError("only http(s) URLs are allowed, got " + parsed.protocol);
  }
  const headers = new Headers();
  for (const [name, template] of Object.entries(node.http.headers ?? {})) {
    headers.set(name, renderTemplate(template, scope));
  }
  let body: string | undefined;
  if (node.http.body !== undefined && BODY_METHODS.has(node.http.method)) {
    const value = renderValue(node.http.body, scope);
    body = typeof value === "string" ? value : JSON.stringify(value);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(parsed, {
      method: node.http.method,
      headers,
      body,
      signal: AbortSignal.timeout(LIMITS.httpTimeoutMs),
      redirect: "follow",
    });
  } catch (cause) {
    const reason =
      cause instanceof Error && cause.name === "TimeoutError"
        ? "timed out after " + LIMITS.httpTimeoutMs + " ms"
        : "network error";
    // Deliberately no cause message: upstream errors can echo request URLs
    // containing rendered secrets.
    throw new ChainError("request to " + parsed.hostname + " " + reason);
  }
  if (!response.ok) {
    // Status only, never the upstream body: error text reaches the model and
    // the upstream body may quote auth headers or secrets.
    throw new ChainError("upstream returned HTTP " + response.status);
  }
  const text = await readCapped(response, LIMITS.maxResponseBytes);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new ChainError("upstream sent invalid JSON");
    }
  }
  return text;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ChainError("response exceeded " + maxBytes + " byte cap");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

// ---------------------------------------------------------------------------
// Local execution (command / script / custom code).

function ensureLocalAllowed(): void {
  if (!allowLocal) {
    throw new ChainError(
      "local execution is disabled, start the server with MCPEASY_ALLOW_LOCAL=1 (and the graph must declare execution.allowLocal)",
    );
  }
}

/** Keep the child environment narrow: passing all of process.env would hand
 * unrelated machine secrets to every executable in the graph. */
function childEnvironment(scope: Scope): NodeJS.ProcessEnv {
  const inherited = ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "HOME", "TMP", "TEMP"];
  const child: NodeJS.ProcessEnv = {};
  for (const name of inherited) {
    const value = process.env[name];
    if (value !== undefined) child[name] = value;
  }
  Object.assign(child, scope.env);
  return child;
}

function runProcess(
  executable: string,
  args: string[],
  stdin: string | undefined,
  cwd: string | undefined,
  child: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // execFile launches the executable directly (shell:false), so a rendered
    // model argument stays one argv value instead of becoming shell syntax.
    const proc = execFile(
      executable,
      args,
      {
        cwd,
        env: child,
        encoding: "utf8",
        timeout: LIMITS.localTimeoutMs,
        maxBuffer: LIMITS.maxOutputBytes,
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout: string) => {
        if (error) {
          if (error.killed === true || typeof error.signal === "string") {
            reject(new ChainError("local process timed out after " + LIMITS.localTimeoutMs + " ms"));
          } else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            reject(new ChainError("local process output exceeded " + LIMITS.maxOutputBytes + " bytes"));
          } else if (typeof error.code === "number") {
            reject(new ChainError("local process exited with code " + error.code));
          } else {
            reject(new ChainError("local process failed to start"));
          }
          return;
        }
        resolve(stdout);
      },
    );
    proc.stdin?.end(stdin);
  });
}

function parseOutput(stdout: string, output: LocalOutput): unknown {
  const text = stdout.replace(/\\r?\\n$/, "");
  if (output === "text") return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new ChainError("local process stdout is not valid JSON");
  }
}

function renderedStdin(template: string | undefined, scope: Scope): string | undefined {
  if (template === undefined) return undefined;
  const value = renderValue(template, scope);
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function runCommand(node: CommandNode, scope: Scope): Promise<unknown> {
  ensureLocalAllowed();
  const args = node.command.args.map((arg) => renderTemplate(arg, scope));
  const stdout = await runProcess(
    node.command.executable,
    args,
    renderedStdin(node.command.stdin, scope),
    node.command.cwd,
    childEnvironment(scope),
  );
  return parseOutput(stdout, node.command.output);
}

const SCRIPT_RUNTIME: Record<ScriptNode["script"]["runtime"], { executable: string; prefix: string[] }> = {
  // process.execPath is the node binary even under tsx.
  node: { executable: process.execPath, prefix: [] },
  python: { executable: "python", prefix: [] },
  powershell: { executable: "powershell", prefix: ["-NoProfile", "-File"] },
  bash: { executable: "bash", prefix: [] },
};

async function runScript(node: ScriptNode, scope: Scope): Promise<unknown> {
  ensureLocalAllowed();
  const runtime = SCRIPT_RUNTIME[node.script.runtime];
  const args = [...runtime.prefix, node.script.path, ...node.script.args.map((arg) => renderTemplate(arg, scope))];
  const stdout = await runProcess(
    runtime.executable,
    args,
    renderedStdin(node.script.stdin, scope),
    node.script.cwd,
    childEnvironment(scope),
  );
  return parseOutput(stdout, node.script.output);
}

// The runner owns stdout as a one-message JSON protocol; user console calls go
// to stderr so logging cannot corrupt the returned value. The child process is
// a fault boundary, not a malicious-code sandbox — the operator enabling
// MCPEASY_ALLOW_LOCAL declared this graph's code trusted. (MCPeasy's engine
// additionally passes Node's permission flag; that flag's name varies across
// Node versions, so this standalone runtime omits it rather than pinning one.)
const INLINE_RUNNER =
  'let source = "";\\n' +
  "for await (const chunk of process.stdin) source += chunk;\\n" +
  "const request = JSON.parse(source);\\n" +
  'const log = (...values) => process.stderr.write(values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ") + "\\\\n");\\n' +
  "const customConsole = Object.freeze({ log, info: log, warn: log, error: log });\\n" +
  "try {\\n" +
  "  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;\\n" +
  '  const fn = new AsyncFunction("input", "env", "prev", "console", "\\\\"use strict\\\\";\\\\n" + request.source);\\n' +
  "  const value = await fn(request.input, request.env, request.prev, customConsole);\\n" +
  "  process.stdout.write(JSON.stringify({ ok: true, value }));\\n" +
  "} catch {\\n" +
  "  process.stdout.write(JSON.stringify({ ok: false }));\\n" +
  "}\\n";

async function runCode(node: CodeNode, scope: Scope): Promise<unknown> {
  ensureLocalAllowed();
  // The exported runtime implements JavaScript and TypeScript only. MCPeasy's
  // own engine additionally runs Python/Bash/PowerShell/Ruby/PHP/Go by
  // spawning those interpreters; reproducing all six here would ship six more
  // embedded runners in every export. Failing LOUDLY with the language name
  // beats a silent wrong answer, and the README states the same limitation.
  if (node.language !== undefined && node.language !== "javascript" && node.language !== "typescript") {
    throw new ChainError("custom code language \\"" + node.language + "\\" is not supported by the exported runtime");
  }
  // A TypeScript block's annotations must be erased before the runner's
  // AsyncFunction sees them, or they are a syntax error. stripTypeScriptTypes
  // (Node >= 22.6) only ERASES; it never downlevels, so TS-only runtime
  // constructs such as enum are rejected rather than silently mistranslated.
  let source = node.source;
  if (node.language === "typescript") {
    const { stripTypeScriptTypes } = await import("node:module");
    if (typeof stripTypeScriptTypes !== "function") {
      throw new ChainError("typescript custom code needs Node 22.6 or newer");
    }
    source = stripTypeScriptTypes(
      "async function __mcpeasy_main(input, env, prev, console) {\\n" + node.source + "\\n}",
      { mode: "strip" },
    ) + "\\nreturn __mcpeasy_main(input, env, prev, console);";
  }
  const payload = JSON.stringify({ source, input: scope.input, env: scope.env, prev: scope.prev });
  const stdout = await runProcess(
    process.execPath,
    ["--input-type=module", "--eval", INLINE_RUNNER],
    payload,
    undefined,
    childEnvironment(scope),
  );
  let envelope: { ok?: unknown; value?: unknown };
  try {
    envelope = JSON.parse(stdout) as { ok?: unknown; value?: unknown };
  } catch {
    throw new ChainError("custom code returned an invalid result");
  }
  if (envelope.ok !== true) throw new ChainError("custom code failed");
  return envelope.value;
}

// ---------------------------------------------------------------------------
// Chain walker.

function asStructured(value: unknown): Record<string, unknown> {
  // structuredContent must be a JSON OBJECT per the MCP schema; arrays and
  // primitives are wrapped so clients still get typed access at a stable key.
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value };
}

function finish(value: unknown, node: ReturnNode, scope: Scope): CallToolResult {
  if (node.format === "text") {
    const text =
      node.template !== undefined
        ? renderTemplate(node.template, scope)
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

function cloneScope(scope: Scope): Scope {
  // Every request and parallel branch owns its prev; input/env sharing is
  // intentional read-only data flow.
  return { input: scope.input, env: scope.env, prev: scope.prev };
}

interface PathResult { value: unknown; returned?: CallToolResult }

async function runParallel(node: ParallelNode, scope: Scope, depth: number): Promise<Record<string, unknown>> {
  if (node.branches.length === 0) throw new ChainError("parallel node has no branches");
  const settled = await Promise.allSettled(
    node.branches.map(async (branch) => {
      if (branch.entry === null) throw new ChainError("parallel branch \\"" + branch.name + "\\" is not connected");
      const result = await runPath(branch.entry, cloneScope(scope), depth + 1, true);
      if (result.returned) {
        throw new ChainError("parallel branch \\"" + branch.name + "\\" reaches a return node; return after the join instead");
      }
      return [branch.name, result.value] as const;
    }),
  );
  // Wait for ALL launched branches so a failed sibling never leaves background
  // work running after the tool result has returned.
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  return Object.fromEntries(
    settled.map((result) => (result as PromiseFulfilledResult<readonly [string, unknown]>).value),
  );
}

async function runPath(entryId: string | null, scope: Scope, depth: number, allowNaturalEnd: boolean): Promise<PathResult> {
  let cursor = entryId;
  let steps = depth;
  while (cursor !== null) {
    steps += 1;
    if (steps > LIMITS.maxChainLength) throw new ChainError("chain exceeded " + LIMITS.maxChainLength + " steps");
    const node = doc.nodes[cursor];
    if (!node || node.kind === "tool") throw new ChainError("chain step \\"" + cursor + "\\" is not an execution node");
    switch (node.kind) {
      case "action":
        scope.prev = await runHttpAction(node, scope);
        cursor = node.next;
        break;
      case "command":
        scope.prev = await runCommand(node, scope);
        cursor = node.next;
        break;
      case "script":
        scope.prev = await runScript(node, scope);
        cursor = node.next;
        break;
      case "code":
        scope.prev = await runCode(node, scope);
        cursor = node.next;
        break;
      case "parallel":
        scope.prev = await runParallel(node, scope, steps);
        cursor = node.next;
        break;
      case "transform":
        scope.prev = applyTransform(node, scope);
        cursor = node.next;
        break;
      case "return":
        return { value: scope.prev, returned: finish(scope.prev, node, scope) };
    }
  }
  if (allowNaturalEnd) return { value: scope.prev };
  throw new ChainError("chain never reaches a return node");
}

async function runChain(entryId: string | null, scope: Scope): Promise<CallToolResult> {
  try {
    const result = await runPath(entryId, cloneScope(scope), 0, false);
    if (result.returned) return result.returned;
    throw new ChainError("chain never reaches a return node");
  } catch (cause) {
    if (cause instanceof ChainError) {
      return { isError: true, content: [{ type: "text", text: cause.message }] };
    }
    // Unknown failure: never leak internals, paths, or env values into
    // model-visible error text.
    return { isError: true, content: [{ type: "text", text: "internal engine error" }] };
  }
}

// ---------------------------------------------------------------------------
// MCP wiring (the same low-level Server + handler pair MCPeasy's engine uses).

function toolInputSchema(tool: ToolNode): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const field of tool.inputs) {
    const schema: Record<string, unknown> =
      field.type === "enum"
        ? { type: "string", enum: [...(field.enumValues ?? [])] }
        : { type: field.type };
    if (field.description) schema.description = field.description;
    properties[field.name] = schema;
    if (field.required !== false) required.push(field.name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

const tools = new Map<string, ToolNode>();
for (const node of Object.values(doc.nodes)) {
  if (node.kind === "tool") tools.set(node.name, node);
}

const server = new Server(
  {
    name: doc.server.name,
    version: doc.server.version,
    ...(doc.server.description?.trim() ? { description: doc.server.description } : {}),
  },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [...tools.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toolInputSchema(tool) as { type: "object" },
    annotations: {
      readOnlyHint: tool.annotations.readOnly,
      ...(tool.annotations.destructive !== undefined ? { destructiveHint: tool.annotations.destructive } : {}),
    },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.get(request.params.name);
  if (!tool) {
    // Unknown tool is a PROTOCOL error (the client addressed nothing), unlike
    // chain failures which are isError tool RESULTS.
    throw new McpError(ErrorCode.InvalidParams, "unknown tool: " + request.params.name);
  }
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  const missing = tool.inputs
    .filter((i) => i.required !== false && args[i.name] === undefined)
    .map((i) => i.name);
  if (missing.length > 0) {
    throw new McpError(ErrorCode.InvalidParams, "missing required arguments: " + missing.join(", "));
  }
  // Absent OPTIONAL inputs become "" so templates render deterministically
  // instead of printing the string "undefined".
  const input: Record<string, unknown> = {};
  for (const field of tool.inputs) {
    const value = args[field.name];
    input[field.name] = value === undefined ? "" : value;
  }
  return runChain(tool.entry, { input, env, prev: undefined });
});

// INVARIANT: nothing in this process may write to stdout except the transport —
// a single stray console.log corrupts the JSON-RPC stream. Log to stderr.
const transport = new StdioServerTransport();
await server.connect(transport);
await new Promise<void>((resolve) => {
  transport.onclose = () => resolve();
});
`;
}

function readme(doc: GraphDoc, slug: string): string {
  const envList = doc.server.env.length
    ? doc.server.env.map((n) => `- \`${n}\``).join("\n")
    : "_(none declared)_";
  const hasLocal = Object.values(doc.nodes).some(
    (n) => n.kind === "command" || n.kind === "script" || n.kind === "code",
  );
  return `# ${doc.server.name || slug}

${doc.server.description || "MCP server exported from MCPeasy."}

Exported from MCPeasy as a runnable TypeScript project. \`graph.json\` is the
server definition (it can be re-opened in MCPeasy); \`src/server.ts\` is a
generic runtime that serves it over stdio.
${doc.server.transport === "http" ? `
> **Note on transport.** This graph is set to the \`http\` transport in MCPeasy,
> but the exported runtime serves **stdio**. The MCPeasy desktop app runs the
> http transport itself; the exported project does not yet. The tools and their
> behaviour are identical either way, only the way a client reaches them differs.
` : ""}

## Run

\`\`\`bash
npm install
npm start
\`\`\`

Requires Node.js 20 or newer.

## Required environment variables

${envList}

The server refuses to start while any of these are missing.
${hasLocal ? `
## Local execution

This graph contains command/script/custom-code blocks that run **with your
user permissions**. They stay disabled unless you explicitly start the server
with \`MCPEASY_ALLOW_LOCAL=1\`.
` : ""}${unsupportedCodeLanguages(doc).length > 0 ? `
> **Note on custom-code languages.** This runtime runs JavaScript and
> TypeScript blocks. This graph also uses ${unsupportedCodeLanguages(doc).map((l) => `\`${l}\``).join(", ")},
> which the MCPeasy desktop app runs but this exported project does not — those
> blocks raise a clear error naming the language instead of returning a wrong
> result.
` : ""}
## Use with Claude Desktop

Add to \`claude_desktop_config.json\`:

\`\`\`json
{
  "mcpServers": {
    "${slug}": {
      "command": "npx",
      "args": ["tsx", "${slug}/src/server.ts"]
    }
  }
}
\`\`\`

(Adjust the path to where you extracted this project, and add an \`"env"\`
object for the variables listed above.)
`;
}

/** Generate the runnable TypeScript project for a graph doc. `docJson` is the
 * exact serialized doc text so the embedded graph.json round-trips back into
 * MCPeasy byte-identically with the app's own save format. */
export function generateTypescriptProject(doc: GraphDoc, docJson: string): { files: ExportFile[]; slug: string } {
  const slug = exportSlug(doc.server.name);
  const root = slug + "/";
  return {
    slug,
    files: [
      { path: root + "package.json", content: packageJson(doc, slug) },
      { path: root + "tsconfig.json", content: TSCONFIG },
      { path: root + "graph.json", content: docJson },
      { path: root + "src/server.ts", content: serverTs(doc) },
      { path: root + "README.md", content: readme(doc, slug) },
      { path: root + ".gitignore", content: "node_modules/\n" },
    ],
  };
}
