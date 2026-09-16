import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildLaunchCommand,
  entryNameFor,
  isMcpeasyEntryName,
  latestBackupPath,
  listMcpeasyEntries,
  readConfig,
  registerServer,
  resolveConfigPath,
  unregisterServer,
} from "../src/main/claudeCode";

// Real-tmpdir tests (no fs mocks), matching projects.test.ts: this module's
// whole job is filesystem behaviour on a file that holds the user's Claude Code
// login, so mocking the filesystem would only restate the implementation.
//
// The scenario that matters most is data preservation. `~/.claude.json` carries
// the OAuth session, a machine id, and per-project trust decisions; a register
// or unregister that drops any of it is the failure this module exists to
// prevent, so that is asserted explicitly rather than incidentally.

let root: string;
let configPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcpeasy-claudecode-"));
  configPath = join(root, ".claude.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A config shaped like a real one: app state around the MCP map, including a
 * third-party entry with a field this repo has no model for. */
const REALISTIC_CONFIG = {
  oauthAccount: { accountUuid: "abc-123", emailAddress: "user@example.com" },
  machineID: "machine-xyz",
  hasCompletedOnboarding: true,
  projects: {
    "C:/Users/dev/app": { hasTrustDialogAccepted: true },
    "c:/Users/dev/app": { hasTrustDialogAccepted: false },
  },
  mcpServers: {
    "third-party": {
      type: "stdio",
      command: "node",
      args: ["server.js"],
      description: "an undocumented field another tool wrote",
    },
  },
  someFutureKey: { nested: [1, 2, 3] },
};

async function writeConfig(value: unknown): Promise<void> {
  await writeFile(configPath, JSON.stringify(value, null, 2), "utf8");
}

async function readBack(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
}

const registration = {
  name: "mcpeasy-acme-weather",
  command: "C:/apps/MCPeasy.exe",
  args: ["--mcp-serve", "--project", "acme", "--server", "C:/lib/weather.json"],
};

describe("resolveConfigPath", () => {
  it("defaults to a SIBLING of ~/.claude", () => {
    expect(resolveConfigPath({}, "/home/dev")).toBe(join("/home/dev", ".claude.json"));
  });

  it("nests inside CLAUDE_CONFIG_DIR when set", () => {
    // Verified against the real CLI: with the variable set, the file lives at
    // <dir>/.claude.json — inside, not beside.
    expect(resolveConfigPath({ CLAUDE_CONFIG_DIR: "/custom/cfg" }, "/home/dev")).toBe(
      join("/custom/cfg", ".claude.json"),
    );
  });

  it("ignores a blank variable", () => {
    expect(resolveConfigPath({ CLAUDE_CONFIG_DIR: "   " }, "/home/dev")).toBe(join("/home/dev", ".claude.json"));
  });
});

describe("entryNameFor", () => {
  it("produces a name Claude Code accepts", () => {
    // Only letters, digits, hyphens, underscores are permitted.
    const name = entryNameFor("My Project!", "weather api.json");
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(name).toBe("mcpeasy-My-Project-weather-api");
  });

  it("is stable for the same inputs", () => {
    expect(entryNameFor("acme", "weather.json")).toBe(entryNameFor("acme", "weather.json"));
  });

  it("bounds very long names while keeping the ownership prefix", () => {
    const name = entryNameFor("x".repeat(200), "y".repeat(200));
    expect(name.length).toBeLessThanOrEqual(120);
    expect(isMcpeasyEntryName(name)).toBe(true);
  });
});

describe("readConfig", () => {
  it("treats a missing file as no entries yet, not an error", async () => {
    const result = await readConfig(configPath);
    expect(result).toEqual({ ok: true, config: {}, existed: false });
  });

  it("refuses a malformed file instead of replacing it", async () => {
    await writeFile(configPath, "{ not json", "utf8");
    const result = await readConfig(configPath);
    expect(result.ok).toBe(false);
  });

  it("refuses a non-object top level", async () => {
    await writeConfig([1, 2, 3]);
    expect((await readConfig(configPath)).ok).toBe(false);
  });

  it("preserves project keys differing only by case", async () => {
    // A case-folding parser merges these and destroys a trust decision.
    await writeConfig(REALISTIC_CONFIG);
    const result = await readConfig(configPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.config.projects as object)).toHaveLength(2);
  });
});

describe("registerServer", () => {
  it("adds an entry to a config that does not exist yet", async () => {
    const result = await registerServer(configPath, registration);
    expect(result.ok).toBe(true);
    const config = await readBack();
    expect((config.mcpServers as Record<string, unknown>)[registration.name]).toEqual({
      type: "stdio",
      command: registration.command,
      args: registration.args,
    });
  });

  it("preserves every unrelated key, including unknown ones", async () => {
    await writeConfig(REALISTIC_CONFIG);
    const result = await registerServer(configPath, registration);
    expect(result.ok).toBe(true);

    const config = await readBack();
    // The user's login and trust map must survive untouched.
    expect(config.oauthAccount).toEqual(REALISTIC_CONFIG.oauthAccount);
    expect(config.machineID).toBe(REALISTIC_CONFIG.machineID);
    expect(config.projects).toEqual(REALISTIC_CONFIG.projects);
    expect(config.someFutureKey).toEqual(REALISTIC_CONFIG.someFutureKey);
    // Another tool's entry, including its undocumented `description`.
    expect((config.mcpServers as Record<string, unknown>)["third-party"]).toEqual(
      REALISTIC_CONFIG.mcpServers["third-party"],
    );
  });

  it("writes a backup before mutating", async () => {
    await writeConfig(REALISTIC_CONFIG);
    const result = await registerServer(configPath, registration);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backupPath).not.toBeNull();
    const backed = JSON.parse(await readFile(result.backupPath!, "utf8")) as Record<string, unknown>;
    // The backup is the PRE-write state, so it must not contain our entry.
    expect((backed.mcpServers as Record<string, unknown>)[registration.name]).toBeUndefined();
    expect(await latestBackupPath(configPath)).toBe(result.backupPath);
  });

  it("reports no backup when there was no file to back up", async () => {
    const result = await registerServer(configPath, registration);
    expect(result.ok && result.backupPath).toBeNull();
  });

  it("is idempotent", async () => {
    await registerServer(configPath, registration);
    await registerServer(configPath, registration);
    const config = await readBack();
    expect(Object.keys(config.mcpServers as object)).toEqual([registration.name]);
  });

  it("refuses to hijack a non-MCPeasy entry unless replace is explicit", async () => {
    await writeConfig(REALISTIC_CONFIG);
    const taken = { ...registration, name: "third-party" };
    const refused = await registerServer(configPath, taken);
    expect(refused.ok).toBe(false);

    const forced = await registerServer(configPath, taken, { replace: true });
    expect(forced.ok).toBe(true);
    const config = await readBack();
    expect((config.mcpServers as Record<string, { command: string }>)["third-party"]!.command).toBe(taken.command);
  });

  it("refuses to write when the config is malformed", async () => {
    await writeFile(configPath, "{ corrupt", "utf8");
    const before = await readFile(configPath, "utf8");
    const result = await registerServer(configPath, registration);
    expect(result.ok).toBe(false);
    // Critically: the file is untouched, not replaced with a fresh object.
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("recovers when mcpServers is present but not an object", async () => {
    await writeConfig({ ...REALISTIC_CONFIG, mcpServers: "nonsense" });
    const result = await registerServer(configPath, registration);
    expect(result.ok).toBe(true);
    const config = await readBack();
    expect((config.mcpServers as Record<string, unknown>)[registration.name]).toBeDefined();
  });

  it("never writes a secret-bearing env block", async () => {
    const result = await registerServer(configPath, registration);
    expect(result.ok).toBe(true);
    const entry = (await readBack()).mcpServers as Record<string, Record<string, unknown>>;
    expect(entry[registration.name]!.env).toBeUndefined();
    // Nothing anywhere in the file should look like a credential.
    expect(await readFile(configPath, "utf8")).not.toMatch(/secret|api[_-]?key|token/i);
  });
});

describe("unregisterServer", () => {
  it("removes only the named entry and leaves siblings intact", async () => {
    await writeConfig(REALISTIC_CONFIG);
    await registerServer(configPath, registration);

    const result = await unregisterServer(configPath, registration.name);
    expect(result.ok && result.removed).toBe(true);

    const config = await readBack();
    expect((config.mcpServers as Record<string, unknown>)[registration.name]).toBeUndefined();
    expect((config.mcpServers as Record<string, unknown>)["third-party"]).toEqual(
      REALISTIC_CONFIG.mcpServers["third-party"],
    );
    expect(config.oauthAccount).toEqual(REALISTIC_CONFIG.oauthAccount);
    expect(config.projects).toEqual(REALISTIC_CONFIG.projects);
  });

  it("removing an absent entry is a no-op success with no backup churn", async () => {
    await writeConfig(REALISTIC_CONFIG);
    const result = await unregisterServer(configPath, "mcpeasy-not-there");
    expect(result).toEqual({ ok: true, removed: false, backupPath: null });
    expect(await latestBackupPath(configPath)).toBeNull();
  });

  it("refuses when the config is malformed", async () => {
    await writeFile(configPath, "}{", "utf8");
    expect((await unregisterServer(configPath, registration.name)).ok).toBe(false);
  });
});

describe("listMcpeasyEntries", () => {
  it("lists only MCPeasy entries, derived from the file itself", async () => {
    await writeConfig(REALISTIC_CONFIG);
    await registerServer(configPath, registration);
    const result = await listMcpeasyEntries(configPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.name)).toEqual([registration.name]);
    expect(result.entries[0]!.args).toEqual(registration.args);
  });

  it("returns an empty list when no config exists", async () => {
    const result = await listMcpeasyEntries(configPath);
    expect(result).toEqual({ ok: true, entries: [] });
  });
});

describe("buildLaunchCommand", () => {
  it("packaged: execPath is the app binary", () => {
    const built = buildLaunchCommand({
      execPath: "C:/apps/MCPeasy.exe",
      appPath: "C:/apps/resources/app",
      isPackaged: true,
      projectId: "acme",
      serverPath: "C:/lib/weather.json",
    });
    expect(built.command).toBe("C:/apps/MCPeasy.exe");
    expect(built.args[0]).toBe("--mcp-serve");
  });

  it("development: the app path must lead, or Electron opens its own window", () => {
    const built = buildLaunchCommand({
      execPath: "C:/node_modules/electron/dist/electron.exe",
      appPath: "C:/dev/MCPeasy",
      isPackaged: false,
      projectId: "acme",
      serverPath: "C:/lib/weather.json",
    });
    expect(built.args[0]).toBe("C:/dev/MCPeasy");
    expect(built.args[1]).toBe("--mcp-serve");
  });

  it("carries no secret, only a project id and a path", () => {
    const built = buildLaunchCommand({
      execPath: "MCPeasy.exe",
      appPath: ".",
      isPackaged: true,
      projectId: "acme",
      serverPath: "/lib/weather.json",
    });
    expect(built.args).toContain("acme");
    expect(built.args.join(" ")).not.toMatch(/secret|key|token/i);
  });
});
