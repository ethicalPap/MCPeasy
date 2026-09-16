import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import {
  MCP_CLIENTS,
  type ClientPaths,
  type McpClientDefinition,
} from "../shared/mcpClientCatalog";

// Generalized MCP-client registration: path resolution, reading, writing and
// status derivation for every client in the shared catalog.
//
// Claude Code was the first client MCPeasy could write to (claudeCode.ts). This
// module is the same discipline applied to every other MCP client that reads a
// local JSON config: one merge-never-clobber writer driven by the catalog's
// per-client facts.
//
// The catalog itself lives in shared/mcpClientCatalog.ts so the renderer can
// draw the same list without a second source of truth. Every external fact in
// it is pinned with a citation in docs/integrations-mcp-clients.md.
//
// THE ONE THING THAT MAKES THIS NON-TRIVIAL: the config key is NOT the same
// across clients. VS Code uses `servers`; everyone else uses `mcpServers`.
// Writing the wrong key produces a file the client silently ignores, which
// looks identical to "the server is broken" from the user's side. That is why
// `serversKey` is a per-client field rather than a constant.
//
// Errors are returned as VALUES, never thrown — same reason as claudeCode.ts
// and projects.ts: these cross an IPC boundary where rejections lose shape.

// Re-exported so main-process callers have one import site for both the
// catalog data and the behaviour that acts on it.
export { MCP_CLIENTS, clientById, clientCategories } from "../shared/mcpClientCatalog";
export type { ClientCategory, ClientPaths, McpClientDefinition } from "../shared/mcpClientCatalog";


/**
 * Expand a catalog path template for the current platform.
 *
 * Returns null when the client does not exist on this platform, which the
 * caller must report as "unsupported here" rather than "not installed" — those
 * are different facts and conflating them misleads the user.
 */
export function expandPath(
  template: string | null,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): string | null {
  if (template === null) return null;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  let value = template;
  if (value.startsWith("~/")) value = join(home, value.slice(2));
  if (value.includes("%APPDATA%")) {
    // Fall back to the documented default location rather than producing a
    // path with a literal "%APPDATA%" in it, which would be a confusing thing
    // to show a user in the config-path row.
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    value = value.replace("%APPDATA%", appData);
  }
  // Normalize the forward slashes used in the catalog to this platform's
  // separator, so the displayed path matches what the OS shows.
  return join(value);
}

function platformKey(platform: NodeJS.Platform = process.platform): keyof ClientPaths {
  if (platform === "win32") return "win32";
  if (platform === "darwin") return "darwin";
  return "linux";
}

export function resolveClientConfigPath(
  client: McpClientDefinition,
  options: { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): string | null {
  return expandPath(client.paths[platformKey(options.platform)], options);
}

export function resolveClientInstallHint(
  client: McpClientDefinition,
  options: { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): string | null {
  return expandPath(client.installHints[platformKey(options.platform)], options);
}

// ── Config reading and writing ──────────────────────────────────────────

const NAME_PREFIX = "mcpeasy";

/** Written into the entry so a later read can tell MCPeasy's own entries from
 * anything else, even if the naming scheme changes. Unknown keys are preserved
 * by every client we write to, and ignored by all of them. */
const OWNER_MARK = "x-mcpeasy";

export type ClientConfigRead =
  | { ok: true; config: Record<string, unknown>; existed: boolean }
  | { ok: false; error: string };

export type ClientWriteResult =
  | { ok: true; entryName: string; backupPath: string | null }
  | { ok: false; error: string };

export type ClientRemoveResult =
  | { ok: true; removed: boolean; backupPath: string | null }
  | { ok: false; error: string };

function malformedError(client: McpClientDefinition): string {
  return (
    `${client.name}'s configuration file could not be parsed as JSON. MCPeasy will not overwrite it, because it may ` +
    `hold settings this app does not understand. Fix or restore the file, then try again.`
  );
}

/**
 * Derive a stable entry name.
 *
 * Shared with claudeCode.ts's rules because they are the strictest of the four
 * clients: letters, digits, hyphens and underscores only. A name legal for
 * Claude Code is legal everywhere else in the catalog, so one scheme serves
 * all of them and the user sees a consistent name across clients.
 */
export function entryNameFor(projectId: string, serverFileName: string): string {
  const base = serverFileName.replace(/\.json$/i, "");
  const clean = (value: string): string =>
    value
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  const name = `${NAME_PREFIX}-${clean(projectId)}-${clean(base)}`;
  return name.length <= 120 ? name : name.slice(0, 120).replace(/-$/, "");
}

export function isMcpeasyEntryName(name: string): boolean {
  return name.startsWith(`${NAME_PREFIX}-`);
}

/**
 * Read a client config tolerantly.
 *
 * A missing file means "nothing registered yet", not an error: the user may
 * connect before ever opening the client. Malformed JSON IS an error and
 * blocks every write — replacing an unparseable file with a fresh object is
 * precisely the data loss this module exists to prevent.
 */
export async function readClientConfig(configPath: string, client: McpClientDefinition): Promise<ClientConfigRead> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return { ok: true, config: {}, existed: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: malformedError(client) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: malformedError(client) };
  }
  return { ok: true, config: parsed as Record<string, unknown>, existed: true };
}

/** Timestamped copy beside the config, written BEFORE any mutation. This is
 * what makes a MCPeasy write reversible by hand. */
async function writeBackup(configPath: string): Promise<string | null> {
  try {
    await access(configPath, constants.F_OK);
  } catch {
    return null; // nothing to back up yet
  }
  const backupDir = join(dirname(configPath), ".mcpeasy-backups");
  await mkdir(backupDir, { recursive: true });
  const backupPath = join(backupDir, `${Date.now()}.bak`);
  await copyFile(configPath, backupPath);
  return backupPath;
}

/** Temp file in the same directory, then rename. An interrupted write must
 * never leave the client with a truncated config; same-directory temp keeps
 * the rename on one volume, where it is atomic. */
async function writeConfigAtomic(configPath: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.mcpeasy-${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tempPath, configPath);
}

/** Read the server map defensively — the key may be absent or, in a
 * hand-edited file, not an object. */
function readServerMap(config: Record<string, unknown>, client: McpClientDefinition): Record<string, unknown> {
  const existing = config[client.serversKey];
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) return {};
  return existing as Record<string, unknown>;
}

export interface ServerRegistration {
  name: string;
  command: string;
  args: string[];
}

/**
 * Add or replace exactly ONE entry, preserving every other key byte-for-byte —
 * including keys this repo has never heard of.
 *
 * Refuses to overwrite an entry MCPeasy did not create unless `replace` is
 * explicitly passed: silently taking over another tool's server name would be
 * both surprising and hard to undo.
 */
export async function registerWithClient(
  configPath: string,
  client: McpClientDefinition,
  registration: ServerRegistration,
  options: { replace?: boolean } = {},
): Promise<ClientWriteResult> {
  const read = await readClientConfig(configPath, client);
  if (!read.ok) return read;

  const servers = readServerMap(read.config, client);
  const existing = servers[registration.name];
  if (existing !== undefined && !isMcpeasyEntryName(registration.name) && options.replace !== true) {
    return {
      ok: false,
      error: `"${registration.name}" already exists in ${client.name} and was not created by MCPeasy`,
    };
  }

  const entry: Record<string, unknown> = {
    // Spread the existing entry first so a re-registration keeps any field a
    // future client version (or the user) added to OUR entry.
    ...(existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {}),
    // Written explicitly even though every client in the catalog defaults to
    // stdio: a typeless entry is ambiguous, and explicitness costs nothing.
    type: "stdio",
    command: registration.command,
    args: registration.args,
    [OWNER_MARK]: true,
  };
  // No `env` block, deliberately: the launched process resolves declared env
  // values from the encrypted secret store, so no secret reaches this file.

  let backupPath: string | null;
  try {
    backupPath = await writeBackup(configPath);
  } catch (cause) {
    // Do not proceed without a backup — that is the whole safety net.
    return { ok: false, error: cause instanceof Error ? cause.message : `could not back up ${client.name}'s config` };
  }

  try {
    await writeConfigAtomic(configPath, {
      ...read.config,
      [client.serversKey]: { ...servers, [registration.name]: entry },
    });
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : `could not write ${client.name}'s config` };
  }
  return { ok: true, entryName: registration.name, backupPath };
}

/** Remove only the named entry. Removing an absent entry is a no-op success —
 * the user's intent (entry gone) already holds. */
export async function unregisterFromClient(
  configPath: string,
  client: McpClientDefinition,
  entryName: string,
): Promise<ClientRemoveResult> {
  const read = await readClientConfig(configPath, client);
  if (!read.ok) return read;

  const servers = readServerMap(read.config, client);
  if (!(entryName in servers)) return { ok: true, removed: false, backupPath: null };

  let backupPath: string | null;
  try {
    backupPath = await writeBackup(configPath);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : `could not back up ${client.name}'s config` };
  }

  const nextServers = { ...servers };
  delete nextServers[entryName];
  try {
    await writeConfigAtomic(configPath, { ...read.config, [client.serversKey]: nextServers });
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : `could not write ${client.name}'s config` };
  }
  return { ok: true, removed: true, backupPath };
}

export interface ClientEntry {
  name: string;
  command: string;
  args: string[];
}

/** Derive the registered list from the config file itself. No index file:
 * projects.ts establishes "the filesystem IS the store", and a second source
 * of truth would drift the moment the user edits a config by hand. */
export async function listClientEntries(
  configPath: string,
  client: McpClientDefinition,
): Promise<{ ok: true; entries: ClientEntry[] } | { ok: false; error: string }> {
  const read = await readClientConfig(configPath, client);
  if (!read.ok) return read;
  const entries: ClientEntry[] = [];
  for (const [name, value] of Object.entries(readServerMap(read.config, client))) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as { command?: unknown; args?: unknown; [key: string]: unknown };
    // Ownership is the name prefix OR the explicit marker: the marker covers
    // an entry a user renamed by hand, which would otherwise become
    // unremovable through the UI.
    if (!isMcpeasyEntryName(name) && record[OWNER_MARK] !== true) continue;
    entries.push({
      name,
      command: typeof record.command === "string" ? record.command : "",
      args: Array.isArray(record.args) ? record.args.filter((a): a is string => typeof a === "string") : [],
    });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, entries };
}

// ── Status derivation ───────────────────────────────────────────────────

/**
 * Four-state status, following the reference implementation's model
 * (connected / detected / warning / needs_setup) but derived entirely from the
 * local filesystem, since MCPeasy has no backend to ask.
 *
 * - `connected`  — this server is registered with this client right now.
 * - `detected`   — the client is installed but this server is not registered.
 * - `warning`    — the config exists but could not be read or parsed.
 * - `needs_setup`— no sign of the client on this machine.
 * - `unsupported`— the client does not run on this platform at all.
 */
export type ClientStatus = "connected" | "detected" | "warning" | "needs_setup" | "unsupported";

export interface ClientState {
  id: string;
  status: ClientStatus;
  /** Plain-language justification for the status. Always populated: a status
   * with no stated reason is the kind of opaque UI this repo avoids. */
  statusReason: string;
  /** Resolved path, or null when unsupported on this platform. */
  configPath: string | null;
  /** True when the config file itself exists on disk. */
  configExists: boolean;
  /** MCPeasy entries currently registered with this client. */
  entries: ClientEntry[];
  /** Populated only for `warning`, so the UI can show what went wrong. */
  error: string | null;
}

async function pathExists(path: string | null): Promise<boolean> {
  if (path === null) return false;
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inspect one client on this machine.
 *
 * Pure filesystem reads — this never launches the client or the network, so it
 * is safe to call on every page render.
 *
 * `expectedEntryName` is the entry MCPeasy would write for the currently open
 * server; when it is already present, the client reports `connected`.
 */
export async function inspectClient(
  client: McpClientDefinition,
  options: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    expectedEntryName?: string | null;
  } = {},
): Promise<ClientState> {
  const configPath = resolveClientConfigPath(client, options);
  if (configPath === null) {
    return {
      id: client.id,
      status: "unsupported",
      statusReason: `${client.name} is not available on this operating system.`,
      configPath: null,
      configExists: false,
      entries: [],
      error: null,
    };
  }

  const configExists = await pathExists(configPath);
  const installed = configExists || (await pathExists(resolveClientInstallHint(client, options)));

  const listed = await listClientEntries(configPath, client);
  if (!listed.ok) {
    return {
      id: client.id,
      status: "warning",
      statusReason: listed.error,
      configPath,
      configExists,
      entries: [],
      error: listed.error,
    };
  }

  const expected = options.expectedEntryName ?? null;
  const connected = expected !== null && listed.entries.some((entry) => entry.name === expected);
  if (connected) {
    return {
      id: client.id,
      status: "connected",
      statusReason: "This server is registered with this client.",
      configPath,
      configExists,
      entries: listed.entries,
      error: null,
    };
  }

  if (installed) {
    return {
      id: client.id,
      status: "detected",
      statusReason:
        listed.entries.length > 0
          ? `Installed. ${listed.entries.length} other MCPeasy server(s) registered.`
          : "Installed, but this server is not registered yet.",
      configPath,
      configExists,
      entries: listed.entries,
      error: null,
    };
  }

  return {
    id: client.id,
    // "not found" is a claim about THIS machine, so the reason says exactly
    // what was checked rather than asserting the app is not installed.
    status: "needs_setup",
    statusReason: `No configuration found at ${configPath}.`,
    configPath,
    configExists,
    entries: listed.entries,
    error: null,
  };
}
