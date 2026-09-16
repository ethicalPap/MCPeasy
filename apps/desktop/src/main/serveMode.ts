import { resolve } from "node:path";
import { isLocalExecutionNode, type GraphDoc } from "@mcpeasy/schema";

// Headless MCP serve mode: the desktop binary serves ONE saved graph doc over
// stdio with no window, so Claude Code can launch a MCPeasy server without any
// secret value being written into its config file.
//
// WHY THE APP AND NOT THE CLI (docs/integrations-claude-code.md §4): Claude
// Code expands `${VAR}` in a stdio entry's `env` from its OWN process
// environment — there is no keychain indirection — so a config file could only
// ever carry a plaintext secret. `secrets.ts` already refuses to write
// plaintext when OS encryption is unavailable, and Electron `safeStorage` can
// only decrypt inside an Electron process. Therefore the registered `command`
// is this app, and the config entry holds only a project id and a file path.
//
// This module is deliberately FREE OF ELECTRON IMPORTS so vitest can exercise
// it under plain Node. Everything that needs the app (safeStorage, app.getPath,
// serveStdio) lives in main/index.ts and calls these pure helpers.

/** Flag that switches the app from "open a window" to "serve over stdio". */
export const SERVE_FLAG = "--mcp-serve";
const PROJECT_FLAG = "--project";
const SERVER_FLAG = "--server";

export interface ServeArgs {
  projectId: string;
  /** Absolute path to the saved graph doc inside the project library. */
  serverPath: string;
}

/** Three outcomes, not two: an argv that asks for serve mode but is malformed
 * must NOT silently fall through and open a window. Claude Code would then see
 * a process that never speaks JSON-RPC and report a connection timeout, which
 * is far harder to diagnose than an immediate stderr message. */
export type ServeArgsResult =
  | { mode: "window" }
  | { mode: "serve"; args: ServeArgs }
  | { mode: "invalid"; error: string };

/** Read `--flag value` from anywhere in argv.
 *
 * Scanning the whole array rather than indexing from a fixed offset is
 * deliberate: argv[0..1] differ between a packaged build (`MCPeasy.exe`,
 * then args) and development (`electron.exe`, app path, then args), and an
 * offset that is right in one shape is silently wrong in the other. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  // A flag followed by another flag (or nothing) is a missing value, not a
  // value of "--server" — catching it here keeps the error specific.
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

export function parseServeArgs(argv: readonly string[]): ServeArgsResult {
  if (!argv.includes(SERVE_FLAG)) return { mode: "window" };
  const projectId = flagValue(argv, PROJECT_FLAG);
  const serverPath = flagValue(argv, SERVER_FLAG);
  if (projectId === undefined) {
    return { mode: "invalid", error: `${SERVE_FLAG} requires ${PROJECT_FLAG} <project id>` };
  }
  if (serverPath === undefined) {
    return { mode: "invalid", error: `${SERVE_FLAG} requires ${SERVER_FLAG} <absolute path to a saved server>` };
  }
  return { mode: "serve", args: { projectId, serverPath } };
}

/** Env resolution for serve mode.
 *
 * Reports EVERY missing name at once rather than failing on the first: the
 * message is the only diagnostic the user gets (Claude Code shows a bare
 * connection failure), so naming all of them saves a round trip per secret. */
export type ServeEnvResult =
  | { ok: true; env: Record<string, string> }
  | { ok: false; missing: string[] };

export function resolveDeclaredEnv(
  declared: readonly string[],
  secrets: Readonly<Record<string, string>>,
): ServeEnvResult {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of declared) {
    const value = secrets[name];
    if (value === undefined) missing.push(name);
    else env[name] = value;
  }
  if (missing.length > 0) return { ok: false, missing };
  // Only DECLARED names are passed through. A project may hold secrets for
  // other servers; forwarding them would widen this server's blast radius for
  // no benefit (buildServer only reads declared names anyway).
  return { ok: true, env };
}

/**
 * Does this saved doc use a transport a stdio client entry cannot start?
 *
 * Every client in the catalog is registered with a stdio entry: the client
 * SPAWNS the command and speaks JSON-RPC over its pipe. A graph set to `http`
 * listens on a socket instead and answers nothing on stdout, so the client
 * reports a timeout and shows no tools -- indistinguishable, from the user's
 * side, from a broken server. Refusing at registration time with the reason is
 * far kinder than writing an entry that can never work.
 *
 * Takes the RAW parsed JSON rather than a validated GraphDoc on purpose: this
 * runs before validation, and a doc that fails validation should surface the
 * engine's specific error, not a transport complaint. Anything unparseable or
 * unexpected returns false, so this can only ever add a refusal.
 */
export function usesListeningTransport(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object") return false;
  const server = (raw as { server?: unknown }).server;
  if (server === null || typeof server !== "object") return false;
  return (server as { transport?: unknown }).transport === "http";
}

/**
 * Stable fingerprint of every local-execution node in the doc.
 *
 * Mirrors the intent of schema's `localExecutionApprovalForTool`: the grant
 * binds to the node DEFINITIONS, not just their ids, so editing a command's
 * argv, a script's path, or inline code invalidates the stored grant even
 * though the canvas node id is unchanged.
 *
 * Whole-doc rather than per-tool because a headless server exposes every tool
 * at once — there is no single invoked tool to scope the grant to.
 *
 * Returns null when the graph contains no local nodes: there is nothing to
 * grant, and null lets callers skip the grant check entirely.
 */
export function localExecutionFingerprint(doc: GraphDoc): string | null {
  const entries = Object.entries(doc.nodes)
    .filter(([, node]) => isLocalExecutionNode(node))
    // Sort by id: Object.entries follows insertion order, so re-saving a doc
    // whose nodes were created in a different sequence would otherwise produce
    // a different fingerprint for an identical graph and revoke a valid grant.
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0 ? null : JSON.stringify(entries);
}

/** One persisted grant: the fingerprint that was approved for one server. */
export interface LocalExecutionGrant {
  fingerprint: string;
}

export type LocalExecutionGrants = Record<string, LocalExecutionGrant>;

/** Key a grant by project id + resolved server path.
 *
 * `resolve` normalizes separators and relative segments so the key the
 * Integrations page writes matches the key serve mode looks up, even though
 * the two receive the path through different routes (IPC vs argv). */
export function grantKey(projectId: string, serverPath: string): string {
  return `${projectId}\u0000${resolve(serverPath)}`;
}

/**
 * A grant is valid only when the stored fingerprint still matches the doc on
 * disk. Fails CLOSED: an unknown key, a changed graph, or a malformed grants
 * object all yield false.
 *
 * Note this is only ONE of the two gates. `buildServer` independently ANDs the
 * host policy with the doc's own `server.execution.allowLocal`, so a graph
 * still cannot authorize itself by being launched permissively.
 */
export function hasLocalExecutionGrant(
  grants: unknown,
  projectId: string,
  serverPath: string,
  fingerprint: string | null,
): boolean {
  if (fingerprint === null) return false;
  if (grants === null || typeof grants !== "object") return false;
  const entry = (grants as Record<string, unknown>)[grantKey(projectId, serverPath)];
  if (entry === null || typeof entry !== "object") return false;
  return (entry as { fingerprint?: unknown }).fingerprint === fingerprint;
}

/** Add or replace one grant, returning a NEW object (callers persist the
 * result). Kept here beside the reader so the key derivation cannot drift. */
export function withLocalExecutionGrant(
  grants: unknown,
  projectId: string,
  serverPath: string,
  fingerprint: string,
): LocalExecutionGrants {
  const next: LocalExecutionGrants = sanitizeGrants(grants);
  next[grantKey(projectId, serverPath)] = { fingerprint };
  return next;
}

/** Remove one grant. Removing an absent grant is a no-op success — the user's
 * intent (no grant for this server) already holds. */
export function withoutLocalExecutionGrant(
  grants: unknown,
  projectId: string,
  serverPath: string,
): LocalExecutionGrants {
  const next: LocalExecutionGrants = sanitizeGrants(grants);
  delete next[grantKey(projectId, serverPath)];
  return next;
}

/** app-state.json is user-reachable on disk, so its contents are not trusted:
 * keep only well-shaped entries instead of propagating arbitrary JSON. */
function sanitizeGrants(grants: unknown): LocalExecutionGrants {
  const out: LocalExecutionGrants = {};
  if (grants === null || typeof grants !== "object") return out;
  for (const [key, value] of Object.entries(grants as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const fingerprint = (value as { fingerprint?: unknown }).fingerprint;
    if (typeof fingerprint === "string") out[key] = { fingerprint };
  }
  return out;
}
