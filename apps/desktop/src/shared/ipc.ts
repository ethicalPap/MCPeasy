// The IPC contract between renderer and main. This file is imported by all
// three bundles (main, preload, renderer) and must stay type-only in effect:
// no runtime imports, so the renderer bundle never drags in Node code.

/**
 * Structural mirror of the engine's EngineToolResult / the SDK's
 * CallToolResult. Deliberately re-declared here instead of imported from
 * @mcpeasy/engine: the renderer must never value-import the engine (it pulls
 * in Node-only MCP transports), and type re-declaration keeps that boundary
 * visible instead of relying on "import type" discipline.
 */
export interface ToolRunResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** doc travels as unknown: main revalidates via loadGraphDoc (never trusts the renderer). */
export interface RunToolRequest {
  doc: unknown;
  toolName: string;
  args: Record<string, unknown>;
  /** Renderer-computed fingerprint of the local/custom nodes reachable by this
   * tool. Main independently recomputes it before granting execution. */
  localExecutionApproval?: string;
  /** Env VALUES live only in renderer memory and in this transient message — never in the doc (N5). */
  env: Record<string, string>;
}

export type RunToolResponse =
  | { ok: true; result: ToolRunResult }
  | { ok: false; error: string };

/** One saved server (graph doc) inside a project's servers/ folder. */
export interface ProjectServerEntry {
  /** Absolute path — handed back to project:read-doc verbatim to open it. */
  path: string;
  fileName: string;
  /** mtime in epoch ms; the list UI shows it as "last saved". */
  updatedAt: number;
}

export interface ProjectInfo {
  /** Folder name under the projects root; also the save-target key. */
  id: string;
  /** Display name (project.json); may differ from id after slugging. */
  name: string;
  createdAt: number;
  servers: ProjectServerEntry[];
}

/** Errors travel as values, not thrown: an invalid name (or full disk) is the
 * user's actionable feedback, and ipcRenderer.invoke rejections lose shape. */
export type CreateProjectResponse =
  | { ok: true; project: ProjectInfo }
  | { ok: false; error: string };

export interface SaveDocToProjectRequest {
  projectId: string;
  /** Derives the file name; main sanitizes it for the filesystem. */
  serverName: string;
  text: string;
}

export type SaveDocToProjectResponse =
  | { ok: true; path: string }
  | { ok: false; error: string };

/** null = not a readable doc inside the project library; not an error. */
export type ReadProjectDocResponse = { path: string; text: string } | null;

export interface DeleteProjectDocRequest {
  projectId: string;
  /** The server file path exactly as returned by ProjectServerEntry.path. */
  serverPath: string;
}

export type DeleteProjectDocResponse = { ok: true } | { ok: false; error: string };

/** One file of an exported project; path is zip-relative, forward slashes.
 * Generation happens in the renderer (pure schema-only exporters); main only
 * validates paths, builds the archive, and writes where the user chose. */
export interface ExportZipRequest {
  files: Array<{ path: string; content: string }>;
  /** Save-dialog default, e.g. "my-server-typescript.zip". */
  suggestedName: string;
}

/** null = user cancelled the save dialog; errors travel as values because
 * ipcRenderer.invoke rejections lose shape (same rationale as projects). */
export type ExportZipResponse =
  | { ok: true; path: string }
  | { ok: false; error: string }
  | null;

/** Project secrets are WRITE-ONLY across this boundary (user decision:
 * API-key semantics). A value crosses renderer→main exactly once, at entry;
 * main never sends a stored value back — list returns NAMES only. The only
 * operations on a stored secret are replace and delete. Encrypted at rest by
 * main via OS safeStorage; never in docs, exports, or logs (extends N5). */
export type ListProjectSecretNamesResponse =
  | { ok: true; names: string[] }
  | { ok: false; error: string };

export interface SetProjectSecretRequest {
  projectId: string;
  name: string;
  /** Creates or silently replaces — write-once means the renderer cannot
   * read-modify-write, so per-key set IS the replace operation. */
  value: string;
}

export type SetProjectSecretResponse = { ok: true } | { ok: false; error: string };

export interface DeleteProjectSecretRequest {
  projectId: string;
  name: string;
}

export type DeleteProjectSecretResponse = { ok: true } | { ok: false; error: string };

/** Recovery path for an undecryptable store (e.g. project copied from another
 * OS user): removes the whole file, deliberately without needing the cipher. */
export type ClearProjectSecretsResponse = { ok: true } | { ok: false; error: string };

/** Claude Code integration (docs/integrations-claude-code.md).
 *
 * Registration is WRITE-SIDE ONLY from the renderer's perspective: the
 * renderer names a project + server, and main derives the launch command and
 * writes the entry. No secret value crosses this boundary in either
 * direction — the registered command resolves declared env values from the
 * encrypted store inside the launched process (contract §4). */
export interface ClaudeCodeStatus {
  cliFound: boolean;
  version: string | null;
  /** The resolved config path main would write to. Displayed in the UI so a
   * CLAUDE_CONFIG_DIR mismatch is visible rather than silent. */
  configPath: string;
  executablePath: string | null;
  /** "unknown" means the CLI could not be run — never a guess. */
  authState: "authenticated" | "unauthenticated" | "unknown";
  /** User-supplied executable override, echoed back so the UI can show it. */
  executableOverride: string | null;
}

export interface RegisterWithClaudeCodeRequest {
  projectId: string;
  /** Server file path exactly as returned by ProjectServerEntry.path. */
  serverPath: string;
  /** Explicit consent to take over an entry MCPeasy did not create. */
  replace?: boolean;
}

export type RegisterWithClaudeCodeResponse =
  | { ok: true; entryName: string; backupPath: string | null }
  | { ok: false; error: string };

export interface UnregisterFromClaudeCodeRequest {
  entryName: string;
}

export type UnregisterFromClaudeCodeResponse =
  | { ok: true; removed: boolean; backupPath: string | null }
  | { ok: false; error: string };

export interface ClaudeCodeRegistration {
  entryName: string;
  command: string;
  args: string[];
}

export type ListClaudeCodeRegistrationsResponse =
  | { ok: true; entries: ClaudeCodeRegistration[] }
  | { ok: false; error: string };

/** Local-execution grant for headless serve mode. A headless process has no
 * window, so the per-call native dialog used by console:run cannot be shown;
 * the grant is made once here and revalidated at launch.
 *
 * The renderer supplies the fingerprint it computed, but main RECOMPUTES it
 * from the doc on disk and refuses a mismatch — the same discipline
 * console:run already applies to localExecutionApproval. */
export interface LocalExecutionGrantRequest {
  projectId: string;
  serverPath: string;
  fingerprint: string;
}

export type LocalExecutionGrantResponse = { ok: true } | { ok: false; error: string };

export interface LocalExecutionGrantStatusRequest {
  projectId: string;
  serverPath: string;
}

/** `fingerprint: null` means the graph has no local nodes, so no grant is
 * needed; `granted: false` with a non-null fingerprint means it needs
 * approval (or re-approval after an edit changed the graph). */
export type LocalExecutionGrantStatusResponse =
  | { ok: true; granted: boolean; fingerprint: string | null }
  | { ok: false; error: string };

/** Multi-client integrations (docs/integrations-mcp-clients.md).
 *
 * Generalizes the Claude Code surface above to every MCP client that reads a
 * local JSON config. Same boundary discipline: the renderer names a project, a
 * saved server and a client id; main resolves the path, derives the launch
 * command, and writes the entry. No secret value crosses in either direction. */
export interface McpClientInfo {
  id: string;
  name: string;
  shortName: string;
  category: string;
  description: string;
  /** Which top-level key this client uses — shown in the detail panel because
   * it is the difference most likely to confuse someone editing by hand. */
  serversKey: string;
  activationHint: string;
  docsUrl: string;
  aliases: string[];
}

export interface McpClientEntryInfo {
  name: string;
  command: string;
  args: string[];
}

/** See ClientStatus in main/mcpClients.ts for what each value means. Note that
 * "unsupported" is distinct from "needs_setup": one is a fact about the
 * platform, the other about this machine. */
export type McpClientStatus = "connected" | "detected" | "warning" | "needs_setup" | "unsupported";

export interface McpClientState {
  id: string;
  status: McpClientStatus;
  statusReason: string;
  configPath: string | null;
  configExists: boolean;
  entries: McpClientEntryInfo[];
  error: string | null;
}

export interface ListMcpClientsRequest {
  /** Project + server currently open, so main can report which clients already
   * have THIS server. Null when nothing is saved yet — the catalog still
   * renders, every client simply cannot be "connected". */
  projectId: string | null;
  serverPath: string | null;
}

export type ListMcpClientsResponse = {
  clients: McpClientInfo[];
  states: McpClientState[];
  /** The entry name MCPeasy would write for the currently open server, or null
   * when nothing is saved yet.
   *
   * Main already derives this to decide which clients report "connected"
   * (index.ts clients:list). It is returned rather than kept private so the
   * connect-confirmation dialog can name the EXACT key it is about to add to
   * the user's config file. Re-deriving it in the renderer would duplicate
   * entryNameFor's slugging rules and let the dialog promise a key different
   * from the one actually written. */
  expectedEntryName: string | null;
  /** The entry name MCPeasy would write for EVERY saved server in the project,
   * keyed by the server's absolute path (ProjectServerEntry.path).
   *
   * Exists because connecting is no longer implicitly about the open doc: the
   * user picks a server first, and the confirmation must name that server's
   * key. Extends the same invariant as expectedEntryName above — derivation
   * stays in main, so the dialog can never promise a key different from the one
   * clients:connect actually writes. Empty when no project was supplied, or in
   * browser mode, where nothing can be read. */
  entryNames: Record<string, string>;
};

/** One custom-code language's availability on this machine. */
export interface CodeRuntimeStatus {
  language: string;
  /** True when a block in this language can run with no further setup. */
  available: boolean;
  /** Resolved executable path, or null when missing or bundled. */
  path: string | null;
  /** True for runtimes MCPeasy ships (JavaScript/TypeScript), which cannot be
   * missing; the editor shows no install hint for these. */
  bundled: boolean;
}

/** Keyed by language id. A language absent from the map is treated as unknown
 *  rather than unavailable, so a future language cannot be falsely reported
 *  as missing by an older renderer. */
export type CodeRuntimeReport = Record<string, CodeRuntimeStatus>;

export interface ConnectMcpClientRequest {
  clientId: string;
  projectId: string;
  serverPath: string;
  /** Explicit consent to take over an entry MCPeasy did not create. */
  replace?: boolean;
}

export type ConnectMcpClientResponse =
  | { ok: true; entryName: string; backupPath: string | null; activationHint: string }
  | { ok: false; error: string };

export interface DisconnectMcpClientRequest {
  clientId: string;
  entryName: string;
}

export type DisconnectMcpClientResponse =
  | { ok: true; removed: boolean; backupPath: string | null }
  | { ok: false; error: string };

export type ThemePreference = "system" | "light" | "dark";

/** Minimal workspace reference persisted across launches so the app can
 * reopen the last-used workspace instead of showing the chooser.
 * `serverPath` remembers the last-opened server doc so the builder
 * doesn't fall back to an empty default when the workspace reopens. */
export interface LastWorkspace {
  id: string;
  name: string;
  /** Relative server doc path (e.g. "my-server.json"). Null/undefined
   * means no specific server was open — the builder opens empty. */
  serverPath?: string | null;
}

export interface AppInfoResponse {
  version: string;
  /** False until a packaged release feed exists; update UI must not claim a
   * network check happened when this development build has nowhere to check. */
  updateChannelConfigured: boolean;
}

/** The full surface preload exposes as window.mcpeasy. Wrapper functions
 * only — never the raw ipcRenderer (IPC security note in electron-vite docs). */
export interface McpeasyApi {
  // Doc I/O is projects-only by design (user decision): servers live in the
  // app-managed project library, and the only way OUT is the zip export.
  // There is deliberately no loose-file open/save dialog surface anymore.
  listProjects(): Promise<ProjectInfo[]>;
  createProject(name: string): Promise<CreateProjectResponse>;
  saveDocToProject(req: SaveDocToProjectRequest): Promise<SaveDocToProjectResponse>;
  /** Read a doc from the project library (no OS dialog; path came from listProjects). */
  readProjectDoc(path: string): Promise<ReadProjectDocResponse>;
  /** Permanently delete a saved server file from the project library. */
  deleteProjectDoc(req: DeleteProjectDocRequest): Promise<DeleteProjectDocResponse>;
  /** List stored secret NAMES only — values never cross back to the renderer. */
  listProjectSecretNames(projectId: string): Promise<ListProjectSecretNamesResponse>;
  /** Create or replace one secret (the single point where a value crosses to main). */
  setProjectSecret(req: SetProjectSecretRequest): Promise<SetProjectSecretResponse>;
  /** Delete one stored secret by name. */
  deleteProjectSecret(req: DeleteProjectSecretRequest): Promise<DeleteProjectSecretResponse>;
  /** Delete the whole store file — recovery for an undecryptable store. */
  clearProjectSecrets(projectId: string): Promise<ClearProjectSecretsResponse>;
  /** Zip the given files and save them where the user chooses. */
  exportZip(req: ExportZipRequest): Promise<ExportZipResponse>;
  /** Detect the Claude Code CLI, its version, auth state, and config path. */
  getClaudeCodeStatus(): Promise<ClaudeCodeStatus>;
  /** Register the given saved server with Claude Code (merge-never-clobber). */
  registerWithClaudeCode(req: RegisterWithClaudeCodeRequest): Promise<RegisterWithClaudeCodeResponse>;
  /** Remove one MCPeasy entry from Claude Code's config. */
  unregisterFromClaudeCode(req: UnregisterFromClaudeCodeRequest): Promise<UnregisterFromClaudeCodeResponse>;
  /** List the MCPeasy entries currently in Claude Code's config. */
  listClaudeCodeRegistrations(): Promise<ListClaudeCodeRegistrationsResponse>;
  /** Persist a manual path to the Claude Code executable (null clears it). */
  setClaudeCodeExecutablePath(path: string | null): Promise<void>;
  /** The full MCP client catalog plus each client's state on this machine. */
  listMcpClients(req: ListMcpClientsRequest): Promise<ListMcpClientsResponse>;
  /** Register the open server with one client (merge-never-clobber). */
  connectMcpClient(req: ConnectMcpClientRequest): Promise<ConnectMcpClientResponse>;
  /** Remove one MCPeasy entry from one client's config. */
  disconnectMcpClient(req: DisconnectMcpClientRequest): Promise<DisconnectMcpClientResponse>;
  /** Report whether this server has a valid local-execution grant. */
  getLocalExecutionGrant(req: LocalExecutionGrantStatusRequest): Promise<LocalExecutionGrantStatusResponse>;
  /** Grant local execution for one server; main revalidates the fingerprint. */
  grantLocalExecution(req: LocalExecutionGrantRequest): Promise<LocalExecutionGrantResponse>;
  /** Revoke a previously made local-execution grant. */
  revokeLocalExecution(req: LocalExecutionGrantStatusRequest): Promise<LocalExecutionGrantResponse>;
  /**
   * Which custom-code interpreters exist on this machine. Detection lives in
   * main because the renderer cannot read PATH or touch the filesystem; the
   * editor uses it to warn BEFORE a graph is saved, instead of letting the
   * block fail opaquely inside the model's client later.
   */
  detectCodeRuntimes(): Promise<CodeRuntimeReport>;
  runTool(req: RunToolRequest): Promise<RunToolResponse>;
  setTheme(theme: ThemePreference): Promise<void>;
  getAppInfo(): Promise<AppInfoResponse>;
  /**
   * Fire-and-forget dirty-state sync so main can guard window close against
   * losing unsaved work (main cannot read renderer state synchronously).
   */
  setDirty(dirty: boolean): void;
  /** Read the last-opened workspace reference (null = none persisted). */
  getLastWorkspace(): Promise<LastWorkspace | null>;
  /** Persist the workspace reference so the next launch restores it.
   * null clears the saved reference (used when switching workspaces). */
  setLastWorkspace(ws: LastWorkspace | null): Promise<void>;
}
