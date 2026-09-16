// The graph doc is the product's public contract (design doc §6.2). Changes to
// these types must be ADDITIVE ONLY: new optional fields or new node kinds,
// never renames or removals. Breaking a field here breaks every saved doc.

export const GRAPH_DOC_VERSION = 1;

// Hard structural limits (design doc §7, "malicious graph doc" threat).
// Validation rejects docs beyond these before the engine ever walks them.
export const LIMITS = {
  maxNodes: 500,
  maxChainLength: 50,
  maxTemplateLength: 4096,
  maxInputsPerTool: 100,
  maxNameLength: 128,
  maxDescriptionLength: 4096,
  maxParallelBranches: 16,
  maxLocalArgs: 100,
  maxCodeLength: 65_536,
} as const;

export type TransportKind = "stdio" | "http";
export type AuthMode = "none" | "bearer";

export interface ServerConfig {
  name: string;
  /** Published as serverInfo.description during MCP initialization. */
  description?: string;
  /** MCP defines no creator field; retained as MCPeasy project metadata. */
  creator?: string;
  version: string;
  transport: TransportKind;
  auth: { type: AuthMode };
  /** Graph-level acknowledgement that this document intentionally contains
   * operations able to execute code on the server machine. A host still has to
   * grant execution separately; a graph can never authorize itself. */
  execution?: { allowLocal: boolean };
  /**
   * Names of required environment variables. NAMES ONLY — secret values must
   * never appear in a graph doc (requirement N5). The engine refuses to start
   * when a declared name is missing from the provided env.
   */
  env: string[];
}

export type InputType = "string" | "number" | "boolean" | "enum";

export interface InputField {
  name: string;
  type: InputType;
  description?: string;
  /** Defaults to true when omitted; optional inputs render as "" in templates. */
  required?: boolean;
  /** Only meaningful when type === "enum"; validated to be non-empty then. */
  enumValues?: string[];
}

export interface ToolAnnotations {
  readOnly: boolean;
  /**
   * Deliberately optional (tri-state): lint warns when a write-ish tool name
   * leaves this UNSET, which is only expressible if undefined is allowed.
   */
  destructive?: boolean;
}

export interface ToolNode {
  kind: "tool";
  name: string;
  description: string;
  inputs: InputField[];
  annotations: ToolAnnotations;
  /** First execution node of the chain; null while the user is still wiring. */
  entry: string | null;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ActionNode {
  kind: "action";
  http: {
    method: HttpMethod;
    /** Template: {{input.x}} / {{env.Y}} / {{prev.z}} allowed. */
    url: string;
    headers?: Record<string, string>;
    /** Template. Only sent for methods with a body. */
    body?: string;
  };
  next: string | null;
}

export type TransformOp = "pick" | "template";

export interface TransformNode {
  kind: "transform";
  op: TransformOp;
  /** Dot-paths into prev for op "pick"; last segment becomes the output key. */
  pick?: string[];
  /** Template string for op "template". */
  template?: string;
  next: string | null;
}

export type LocalOutput = "text" | "json";

export interface CommandNode {
  kind: "command";
  command: {
    /** Executed directly, never through a shell. Templates resolve per argument
     * so model input cannot become shell syntax. */
    executable: string;
    args: string[];
    /** Optional templated stdin. A single {{ref}} preserves JSON; mixed text
     * is sent as UTF-8. Nothing is sent when omitted. */
    stdin?: string;
    cwd?: string;
    output: LocalOutput;
  };
  next: string | null;
}

export interface ScriptNode {
  kind: "script";
  script: {
    runtime: "node" | "python" | "powershell" | "bash";
    path: string;
    args: string[];
    /** Optional templated stdin. A single {{ref}} preserves JSON; mixed text
     * is sent as UTF-8. Nothing is sent when omitted. */
    stdin?: string;
    cwd?: string;
    output: LocalOutput;
  };
  next: string | null;
}

/**
 * Languages an inline custom-code block can be written in.
 *
 * Two tiers, and the difference is load-bearing for the UI:
 *  - javascript/typescript run on the Node runtime MCPeasy already ships, so
 *    they work on every machine with zero setup. TypeScript is executed by
 *    Node's own type stripping, never type-checked — types are erased.
 *  - the rest spawn an interpreter that must already be installed and on
 *    PATH. The editor detects those and warns, because the alternative is an
 *    opaque failure inside the model's client long after the graph was saved.
 *
 * Ordering is the UI's display order (bundled first, then alphabetical).
 * "javascript" MUST stay first: it is the historical single value of this
 * field and the default for newly created blocks.
 */
export const CODE_LANGUAGES = [
  "javascript",
  "typescript",
  "python",
  "bash",
  "powershell",
  "ruby",
  "php",
  "go",
] as const;

export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

export interface CodeNode {
  kind: "code";
  /**
   * Widening this from the former `"javascript"` literal is additive: every
   * previously saved doc holds "javascript", which is still a member of the
   * union, so no doc-version bump is needed (design decision #2).
   */
  language: CodeLanguage;
  /** Function body with `input`, `env`, and `prev` parameters. The host runs
   * this in a separate process because node:vm is not a security boundary. */
  source: string;
  next: string | null;
}

export interface ParallelBranch {
  name: string;
  /** A null entry is legal while the user is still wiring the branch. */
  entry: string | null;
}

export interface ParallelNode {
  kind: "parallel";
  /** Results are joined into `{ [name]: result }` in this declaration order. */
  branches: ParallelBranch[];
  next: string | null;
}

export interface ReturnNode {
  kind: "return";
  format: "json" | "text";
  /** Optional template for "text"; falls back to stringified prev. */
  template?: string;
}

export type LinearExecNode = ActionNode | TransformNode | CommandNode | ScriptNode | CodeNode;
export type ExecNode = LinearExecNode | ParallelNode | ReturnNode;
export type GraphNode = ToolNode | ExecNode;

/**
 * Edges and layout exist ONLY for the editor's rendering. Execution semantics
 * live in tool.entry / node.next (design decision #3). The engine must never
 * read these two fields — that invariant is what keeps the editor free to
 * re-render without touching behavior.
 */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface GraphDoc {
  version: number;
  server: ServerConfig;
  nodes: Record<string, GraphNode>;
  edges?: GraphEdge[];
  layout?: Record<string, { x: number; y: number }>;
}

export type LintSeverity = "error" | "warning";

export interface LintProblem {
  rule: string;
  severity: LintSeverity;
  message: string;
}

/** nodeId → problems. Problems about the whole server attach to key "server". */
export type LintReport = Record<string, LintProblem[]>;
