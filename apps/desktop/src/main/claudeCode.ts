import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";

// Claude Code MCP registration. Every external fact this module relies on is
// pinned with a citation in docs/integrations-claude-code.md — re-read that
// before changing a path, flag, or JSON key here.
//
// THE CENTRAL SAFETY CONSTRAINT (contract §6): `~/.claude.json` is NOT a
// dedicated MCP config file. It is Claude Code's application state, holding the
// user's OAuth session (`oauthAccount`), `machineID`, and a per-project trust
// map — ~97 KB and ~100 top-level keys on a real machine. Overwriting it would
// destroy the user's login. Hence: merge never clobber, back up before every
// mutation, refuse on malformed, and write atomically.
//
// Errors are returned as VALUES, never thrown, matching projects.ts and
// secrets.ts: these cross an IPC boundary where rejections lose their shape.
// Filesystem roots and the config path are injected so vitest can drive the
// whole module against a real tmpdir (same seam idiom as SecretsCipher).

/** Entry shape for a stdio server (contract §3). `type` is written explicitly
 * even though Claude Code defaults to stdio, because a typeless entry with a
 * `url` is a documented configuration error and explicitness costs nothing. */
export interface StdioServerEntry {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Unknown keys from other tools are preserved verbatim on merge. */
  [key: string]: unknown;
}

export interface McpeasyRegistration {
  /** The key under `mcpServers`. */
  name: string;
  command: string;
  args: string[];
}

export type ConfigReadResult =
  | { ok: true; config: Record<string, unknown>; existed: boolean }
  | { ok: false; error: string };

export type RegisterResult =
  | { ok: true; entryName: string; backupPath: string | null }
  | { ok: false; error: string };

export type UnregisterResult =
  | { ok: true; removed: boolean; backupPath: string | null }
  | { ok: false; error: string };

export interface ClaudeCodeDetection {
  cliFound: boolean;
  version: string | null;
  /** Resolved path we would write to, shown in the UI so a CLAUDE_CONFIG_DIR
   * mismatch is visible rather than silent. */
  configPath: string;
  executablePath: string | null;
  /** "unknown" when the CLI could not be run at all — never guessed. */
  authState: "authenticated" | "unauthenticated" | "unknown";
}

/** Prefix keeps derived names clear of Claude Code's reserved built-in names
 * (`workspace`, `claude-in-chrome`, `computer-use`, `Claude Preview`,
 * `Claude Browser`) — contract §2. */
const NAME_PREFIX = "mcpeasy";

const MALFORMED_ERROR =
  "Claude Code's configuration file could not be parsed. MCPeasy will not overwrite it, because it holds your " +
  "Claude Code login and per-project trust settings. Fix or restore the file, then try again.";

/**
 * Resolve the config file path.
 *
 * `CLAUDE_CONFIG_DIR` relocates it to `<dir>/.claude.json` — note the NESTING,
 * which differs from the unset default where `.claude.json` is a SIBLING of
 * `~/.claude`. Verified by probing the CLI with a nonexistent directory
 * (contract §3); getting this backwards would point MCPeasy at a file Claude
 * Code never reads.
 */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configDir = env.CLAUDE_CONFIG_DIR;
  if (typeof configDir === "string" && configDir.trim() !== "") {
    return join(configDir, ".claude.json");
  }
  return join(home, ".claude.json");
}

/**
 * Derive the entry name for one saved server.
 *
 * Claude Code accepts only letters, digits, hyphens, and underscores in a
 * server name (contract §2), so every other character is folded to a hyphen.
 * The name must also be STABLE and filesystem-independent: it is the identity
 * MCPeasy uses to find its own entry again on unregister.
 */
export function entryNameFor(projectId: string, serverFileName: string): string {
  const base = serverFileName.replace(/\.json$/i, "");
  const clean = (value: string): string =>
    value
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  const name = `${NAME_PREFIX}-${clean(projectId)}-${clean(base)}`;
  // Very long project/server names must not produce an unusable key; truncate
  // to a bounded length while keeping the prefix intact so ownership detection
  // (isMcpeasyEntryName) still works.
  return name.length <= 120 ? name : name.slice(0, 120).replace(/-$/, "");
}

export function isMcpeasyEntryName(name: string): boolean {
  return name.startsWith(`${NAME_PREFIX}-`);
}

/**
 * Read the config tolerantly.
 *
 * A missing file is "no entries yet", not an error: Claude Code creates it on
 * first run, and a user may register before ever launching it. Malformed JSON
 * IS an error and blocks every write — replacing an unparseable file with a
 * fresh object is exactly the data loss this module exists to prevent.
 *
 * Parsing uses Node's `JSON.parse`, which is CASE-SENSITIVE. That matters:
 * real config files carry project keys differing only by drive-letter case
 * (`C:/...` vs `c:/...`), and a case-folding parser silently merges them,
 * destroying trust decisions (contract §6).
 */
export async function readConfig(configPath: string): Promise<ConfigReadResult> {
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
    return { ok: false, error: MALFORMED_ERROR };
  }
  // A non-object top level (array, string, null) is equally unsafe to replace.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: MALFORMED_ERROR };
  }
  return { ok: true, config: parsed as Record<string, unknown>, existed: true };
}

/** Timestamped copy beside the config, written BEFORE any mutation. Claude
 * Code keeps its own five rotating backups, but those are written on ITS
 * rewrites, not ours — this one is what makes a MCPeasy write reversible. */
async function writeBackup(configPath: string): Promise<string | null> {
  try {
    await access(configPath, constants.F_OK);
  } catch {
    return null; // nothing to back up yet
  }
  const backupDir = join(dirname(configPath), ".mcpeasy-backups");
  await mkdir(backupDir, { recursive: true });
  const backupPath = join(backupDir, `claude.json.${Date.now()}.bak`);
  await copyFile(configPath, backupPath);
  return backupPath;
}

/**
 * Atomic write: a temp file in the same directory, then rename. An interrupted
 * write must never leave Claude Code with a truncated config, which would cost
 * the user their login. Same-directory temp keeps the rename on one volume,
 * where it is atomic.
 */
async function writeConfigAtomic(configPath: string, config: Record<string, unknown>): Promise<void> {
  const tempPath = `${configPath}.mcpeasy-${process.pid}.tmp`;
  // 2-space indentation matches what Claude Code itself writes. The merge is
  // value-preserving but not byte-preserving; the backup covers that.
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tempPath, configPath);
}

/** Read the `mcpServers` map defensively — the key may be absent or, in a
 * hand-edited file, not an object. */
function readServerMap(config: Record<string, unknown>): Record<string, unknown> {
  const existing = config.mcpServers;
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) return {};
  return existing as Record<string, unknown>;
}

/**
 * Add or replace exactly ONE entry under `mcpServers`, preserving every other
 * key byte-for-byte — including keys this repo has never heard of, such as the
 * OAuth session and unknown fields inside other tools' entries.
 *
 * Refuses to overwrite an entry MCPeasy did not create unless `replace` is
 * explicitly passed: silently stealing another tool's server name would be
 * both surprising and hard to undo.
 */
export async function registerServer(
  configPath: string,
  registration: McpeasyRegistration,
  options: { replace?: boolean } = {},
): Promise<RegisterResult> {
  const read = await readConfig(configPath);
  if (!read.ok) return read;

  const servers = readServerMap(read.config);
  const existing = servers[registration.name];
  if (existing !== undefined && !isMcpeasyEntryName(registration.name) && options.replace !== true) {
    return { ok: false, error: `"${registration.name}" already exists in Claude Code and was not created by MCPeasy` };
  }

  const entry: StdioServerEntry = {
    // Spread the existing entry first so a re-registration keeps any fields a
    // future Claude Code version (or the user) added to OUR entry.
    ...(existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {}),
    type: "stdio",
    command: registration.command,
    args: registration.args,
  };
  // No `env` block, deliberately: the launched process resolves declared env
  // values from the encrypted secret store, so no secret reaches this file.

  let backupPath: string | null;
  try {
    backupPath = await writeBackup(configPath);
  } catch (cause) {
    // Do not proceed without a backup — that is the whole safety net.
    return { ok: false, error: cause instanceof Error ? cause.message : "could not back up Claude Code's config" };
  }

  try {
    await writeConfigAtomic(configPath, {
      ...read.config,
      mcpServers: { ...servers, [registration.name]: entry },
    });
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "could not write Claude Code's config" };
  }
  return { ok: true, entryName: registration.name, backupPath };
}

/** Remove only the named entry. Removing an absent entry is a no-op success —
 * the user's intent (entry gone) already holds (same idiom as
 * deleteProjectSecret). */
export async function unregisterServer(configPath: string, entryName: string): Promise<UnregisterResult> {
  const read = await readConfig(configPath);
  if (!read.ok) return read;

  const servers = readServerMap(read.config);
  if (!(entryName in servers)) return { ok: true, removed: false, backupPath: null };

  let backupPath: string | null;
  try {
    backupPath = await writeBackup(configPath);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "could not back up Claude Code's config" };
  }

  const nextServers = { ...servers };
  delete nextServers[entryName];
  try {
    await writeConfigAtomic(configPath, { ...read.config, mcpServers: nextServers });
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "could not write Claude Code's config" };
  }
  return { ok: true, removed: true, backupPath };
}

export interface McpeasyEntry {
  name: string;
  command: string;
  args: string[];
}

/** Derive the registered list from the config file itself. No index file:
 * projects.ts establishes "the filesystem IS the store", and a second source
 * of truth would drift the moment the user edits the config by hand. */
export async function listMcpeasyEntries(
  configPath: string,
): Promise<{ ok: true; entries: McpeasyEntry[] } | { ok: false; error: string }> {
  const read = await readConfig(configPath);
  if (!read.ok) return read;
  const entries: McpeasyEntry[] = [];
  for (const [name, value] of Object.entries(readServerMap(read.config))) {
    if (!isMcpeasyEntryName(name)) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as { command?: unknown; args?: unknown };
    entries.push({
      name,
      command: typeof record.command === "string" ? record.command : "",
      args: Array.isArray(record.args) ? record.args.filter((a): a is string => typeof a === "string") : [],
    });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, entries };
}

// ── CLI detection ───────────────────────────────────────────────────────

/** Candidate executable paths, in priority order.
 *
 * Windows has TWO distinct install shapes (contract §1): the native installer
 * produces a real `claude.exe`, which spawns directly; a global npm install
 * produces npm's `.cmd`/`.ps1` shims, which cannot be spawned with
 * `shell: false`. Preferring the `.exe` avoids the shim problem entirely when
 * both are present. */
function detectionCandidates(env: NodeJS.ProcessEnv, home: string, override: string | null): string[] {
  if (override !== null && override.trim() !== "") return [override];
  const windows = process.platform === "win32";
  const candidates: string[] = [];
  // Documented native-installer location, confirmed on a real machine.
  candidates.push(windows ? join(home, ".local", "bin", "claude.exe") : join(home, ".local", "bin", "claude"));
  // Then PATH, honoring PATHEXT ordering on Windows so .exe wins over .cmd.
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = windows ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (dir.trim() === "") continue;
    for (const extension of extensions) candidates.push(join(dir, `claude${extension}`));
  }
  return candidates;
}

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.F_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Run the CLI and capture stdout plus the exit code. Never uses `shell: true`
 * with an interpolated string — that is the shape behind the Windows
 * argument-injection class of bug. A `.cmd` shim is invoked through
 * `cmd.exe /d /s /c` with the path passed as a separate argv entry. */
function runCli(executable: string, args: string[], timeoutMs = 10_000): Promise<{ code: number; stdout: string }> {
  const useCmdShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
  const file = useCmdShim ? (process.env.COMSPEC ?? "cmd.exe") : executable;
  const argv = useCmdShim ? ["/d", "/s", "/c", executable, ...args] : args;
  return new Promise((resolvePromise) => {
    // INVARIANT: this promise resolves and never rejects. Detection treats a
    // failed probe as "version/auth unknown", so a rejection here would take
    // down the whole Integrations page instead of degrading one row.
    //
    // execFile can fail in TWO different ways and both must be caught. The
    // usual one is asynchronous, via the callback. But on Windows, spawning a
    // file that exists and yet is not a loadable image — a corrupt or
    // partially downloaded install, an antivirus quarantine stub, a `.ps1`
    // shim — throws `spawn UNKNOWN` SYNCHRONOUSLY out of execFile, which would
    // escape the callback path entirely and reject this promise.
    try {
      execFile(file, argv, { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
        // A non-zero exit is DATA here, not a failure: `claude auth status`
        // exits 1 to mean "not logged in" (contract §5). A spawn error arrives
        // with a STRING code ("ENOENT", "UNKNOWN"), which the numeric check
        // below deliberately rejects so it collapses to the generic failure 1.
        const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
        resolvePromise({ code, stdout: stdout ?? "" });
      });
    } catch {
      resolvePromise({ code: 1, stdout: "" });
    }
  });
}

/**
 * Detect the CLI, its version, and authentication state.
 *
 * Auth uses only the documented contract: `claude auth status` exits 0 when
 * logged in and 1 when not (contract §5). The JSON body's field names are
 * observed but undocumented, so they are read defensively and never required.
 */
export async function detectClaudeCode(options: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  executableOverride?: string | null;
} = {}): Promise<ClaudeCodeDetection> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const override = options.executableOverride ?? null;
  const configPath = resolveConfigPath(env, home);

  const executablePath = await firstExisting(detectionCandidates(env, home, override));
  if (executablePath === null) {
    // An explicit override that does not exist is an error surfaced as
    // "not found", never silently replaced by a discovered default — the same
    // escape-hatch rule as ELECTRON_EXEC_PATH in scripts/ensure-electron.mjs.
    return { cliFound: false, version: null, configPath, executablePath: null, authState: "unknown" };
  }

  const versionRun = await runCli(executablePath, ["--version"]);
  // Output looks like "2.1.270 (Claude Code)"; keep just the version token.
  const version = versionRun.code === 0 ? (versionRun.stdout.trim().split(/\s+/)[0] ?? null) : null;

  const authRun = await runCli(executablePath, ["auth", "status"]);
  const authState: ClaudeCodeDetection["authState"] = authRun.code === 0 ? "authenticated" : "unauthenticated";

  return { cliFound: true, version, configPath, executablePath, authState };
}

/** Most recent MCPeasy backup, so the UI can name the file it wrote without
 * the caller threading it through every response. */
export async function latestBackupPath(configPath: string): Promise<string | null> {
  const backupDir = join(dirname(configPath), ".mcpeasy-backups");
  try {
    const names = (await readdir(backupDir)).filter((n) => n.endsWith(".bak")).sort();
    const newest = names[names.length - 1];
    return newest === undefined ? null : join(backupDir, newest);
  } catch {
    return null;
  }
}

/**
 * Build the command + args that start headless serve mode.
 *
 * Development and packaged builds differ: packaged, `process.execPath` IS the
 * app binary; in development it is Electron's own binary and the app path must
 * follow as its first argument, or Electron opens its default window instead
 * of loading this app.
 *
 * No secret value appears in the command or args — only a project id and a
 * file path (contract §4).
 */
export function buildLaunchCommand(input: {
  execPath: string;
  appPath: string;
  isPackaged: boolean;
  projectId: string;
  serverPath: string;
}): { command: string; args: string[] } {
  const serveArgs = ["--mcp-serve", "--project", input.projectId, "--server", resolve(input.serverPath)];
  return {
    command: input.execPath,
    args: input.isPackaged ? serveArgs : [input.appPath, ...serveArgs],
  };
}
