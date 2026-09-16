import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MCP_CLIENTS,
  clientById,
  clientCategories,
  entryNameFor,
  expandPath,
  inspectClient,
  isMcpeasyEntryName,
  listClientEntries,
  registerWithClient,
  resolveClientConfigPath,
  unregisterFromClient,
} from "../src/main/mcpClients";

// Real-tmpdir tests (no fs mocks), matching claudeCode.test.ts and
// projects.test.ts. These modules exist to be careful with files that belong to
// OTHER applications, so mocking the filesystem would only restate the
// implementation instead of testing the behaviour that matters.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcpeasy-clients-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const claudeCode = clientById("claude-code")!;
const vscode = clientById("vscode")!;
const cursor = clientById("cursor")!;

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("catalog", () => {
  it("gives every client a distinct id", () => {
    const ids = MCP_CLIENTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses the `servers` key for VS Code and `mcpServers` elsewhere", () => {
    // The single most consequential per-client difference: writing the wrong
    // key produces a config the client silently ignores.
    expect(vscode.serversKey).toBe("servers");
    for (const client of MCP_CLIENTS.filter((c) => c.id !== "vscode")) {
      expect(client.serversKey).toBe("mcpServers");
    }
  });

  it("lists categories in catalog order without duplicates", () => {
    const categories = clientCategories();
    expect(new Set(categories).size).toBe(categories.length);
    expect(categories).toContain("Coding agents");
  });

  it("gives every client at least one supported platform", () => {
    for (const client of MCP_CLIENTS) {
      const supported = [client.paths.win32, client.paths.darwin, client.paths.linux].filter((p) => p !== null);
      expect(supported.length).toBeGreaterThan(0);
    }
  });
});

describe("expandPath", () => {
  it("expands ~ to the home directory", () => {
    const result = expandPath("~/.cursor/mcp.json", { home: join(root, "home") });
    expect(result).toBe(join(root, "home", ".cursor", "mcp.json"));
  });

  it("expands %APPDATA% from the environment", () => {
    const result = expandPath("%APPDATA%/Claude/claude_desktop_config.json", {
      home: join(root, "home"),
      env: { APPDATA: join(root, "roaming") },
    });
    expect(result).toBe(join(root, "roaming", "Claude", "claude_desktop_config.json"));
  });

  it("falls back to the documented default when APPDATA is unset", () => {
    // Never leave a literal "%APPDATA%" in a path shown to the user.
    const result = expandPath("%APPDATA%/Claude/x.json", { home: join(root, "home"), env: {} });
    expect(result).toBe(join(root, "home", "AppData", "Roaming", "Claude", "x.json"));
  });

  it("returns null for a platform where the client does not exist", () => {
    expect(expandPath(null)).toBeNull();
  });
});

describe("resolveClientConfigPath", () => {
  it("reports Claude Desktop as unsupported on linux", () => {
    // Asserted because the UI must say "unsupported here", not "not installed".
    const result = resolveClientConfigPath(clientById("claude-desktop")!, {
      platform: "linux",
      home: join(root, "home"),
    });
    expect(result).toBeNull();
  });

  it("resolves a per-platform path", () => {
    const result = resolveClientConfigPath(vscode, { platform: "linux", home: join(root, "home") });
    expect(result).toBe(join(root, "home", ".config", "Code", "User", "mcp.json"));
  });
});

describe("entryNameFor", () => {
  it("is stable and uses only legal characters", () => {
    const name = entryNameFor("my project", "My Server.json");
    expect(name).toBe("mcpeasy-my-project-My-Server");
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(isMcpeasyEntryName(name)).toBe(true);
  });

  it("bounds very long names while keeping the prefix", () => {
    const name = entryNameFor("p".repeat(200), "s".repeat(200));
    expect(name.length).toBeLessThanOrEqual(120);
    expect(isMcpeasyEntryName(name)).toBe(true);
  });
});

describe("registerWithClient", () => {
  it("creates the file and the map when nothing exists", async () => {
    const configPath = join(root, "fresh", "mcp.json");
    const result = await registerWithClient(configPath, cursor, {
      name: "mcpeasy-p-s",
      command: "app.exe",
      args: ["--mcp-serve"],
    });
    expect(result.ok).toBe(true);
    const config = await readJson(configPath);
    expect(config.mcpServers).toMatchObject({
      "mcpeasy-p-s": { type: "stdio", command: "app.exe", args: ["--mcp-serve"] },
    });
  });

  it("writes VS Code entries under `servers`, not `mcpServers`", async () => {
    const configPath = join(root, "vscode", "mcp.json");
    await registerWithClient(configPath, vscode, { name: "mcpeasy-p-s", command: "app.exe", args: [] });
    const config = await readJson(configPath);
    expect(config.servers).toBeDefined();
    expect(config.mcpServers).toBeUndefined();
  });

  it("preserves unrelated top-level keys and other tools' entries", async () => {
    // The data-preservation assertion this module exists for. Claude Code's
    // config carries the user's OAuth session; losing it costs them their login.
    const configPath = join(root, "claude", ".claude.json");
    await writeJson(configPath, {
      oauthAccount: { accountUuid: "abc-123" },
      projects: { "C:/a": { trusted: true }, "c:/a": { trusted: false } },
      mcpServers: { "third-party": { command: "node", args: ["s.js"], custom: "keep me" } },
      futureKey: [1, 2, 3],
    });

    const result = await registerWithClient(configPath, claudeCode, {
      name: "mcpeasy-p-s",
      command: "app.exe",
      args: [],
    });
    expect(result.ok).toBe(true);

    const config = await readJson(configPath);
    expect(config.oauthAccount).toEqual({ accountUuid: "abc-123" });
    expect(config.futureKey).toEqual([1, 2, 3]);
    // Drive-letter-case keys must both survive: a case-folding JSON parser
    // would silently merge them and destroy a trust decision.
    expect(Object.keys(config.projects as object)).toHaveLength(2);
    const servers = config.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers["third-party"]).toEqual({ command: "node", args: ["s.js"], custom: "keep me" });
    expect(servers["mcpeasy-p-s"]).toBeDefined();
  });

  it("backs the file up before mutating it", async () => {
    const configPath = join(root, "claude", ".claude.json");
    await writeJson(configPath, { mcpServers: {}, keep: "original" });
    const result = await registerWithClient(configPath, claudeCode, {
      name: "mcpeasy-p-s",
      command: "app.exe",
      args: [],
    });
    expect(result.ok && result.backupPath).toBeTruthy();
    if (result.ok && result.backupPath !== null) {
      const backup = await readJson(result.backupPath);
      expect(backup.keep).toBe("original");
      expect(backup.mcpServers).toEqual({});
    }
  });

  it("refuses to write when the config is malformed", async () => {
    // Refusing is the point: overwriting an unparseable file would discard
    // whatever the user actually has in it.
    const configPath = join(root, "bad", "mcp.json");
    await mkdir(join(root, "bad"), { recursive: true });
    await writeFile(configPath, "{ not json", "utf8");
    const result = await registerWithClient(configPath, cursor, {
      name: "mcpeasy-p-s",
      command: "app.exe",
      args: [],
    });
    expect(result.ok).toBe(false);
    // The original bytes must still be on disk, untouched.
    expect(await readFile(configPath, "utf8")).toBe("{ not json");
  });

  it("refuses a non-object top level", async () => {
    const configPath = join(root, "arr", "mcp.json");
    await writeJson(configPath, [1, 2, 3]);
    const result = await registerWithClient(configPath, cursor, { name: "x", command: "c", args: [] });
    expect(result.ok).toBe(false);
  });

  it("refuses to take over a foreign entry name unless replace is passed", async () => {
    const configPath = join(root, "c", "mcp.json");
    await writeJson(configPath, { mcpServers: { "their-server": { command: "theirs" } } });

    const refused = await registerWithClient(configPath, cursor, {
      name: "their-server",
      command: "ours",
      args: [],
    });
    expect(refused.ok).toBe(false);
    expect((await readJson(configPath)).mcpServers).toMatchObject({ "their-server": { command: "theirs" } });

    const forced = await registerWithClient(
      configPath,
      cursor,
      { name: "their-server", command: "ours", args: [] },
      { replace: true },
    );
    expect(forced.ok).toBe(true);
  });

  it("keeps extra fields on re-registration of its own entry", async () => {
    const configPath = join(root, "c", "mcp.json");
    await registerWithClient(configPath, cursor, { name: "mcpeasy-p-s", command: "old", args: ["a"] });
    const configPathJson = await readJson(configPath);
    const servers = configPathJson.mcpServers as Record<string, Record<string, unknown>>;
    servers["mcpeasy-p-s"].userAdded = "keep";
    await writeJson(configPath, configPathJson);

    await registerWithClient(configPath, cursor, { name: "mcpeasy-p-s", command: "new", args: ["b"] });
    const after = (await readJson(configPath)).mcpServers as Record<string, Record<string, unknown>>;
    expect(after["mcpeasy-p-s"].userAdded).toBe("keep");
    expect(after["mcpeasy-p-s"].command).toBe("new");
  });

  it("never writes an env block", async () => {
    // Invariant N5: no secret value may reach another application's config.
    const configPath = join(root, "c", "mcp.json");
    await registerWithClient(configPath, cursor, { name: "mcpeasy-p-s", command: "app", args: [] });
    const servers = (await readJson(configPath)).mcpServers as Record<string, Record<string, unknown>>;
    expect(servers["mcpeasy-p-s"].env).toBeUndefined();
  });
});

describe("unregisterFromClient", () => {
  it("removes only the named entry", async () => {
    const configPath = join(root, "c", "mcp.json");
    await writeJson(configPath, {
      keep: "me",
      mcpServers: { "mcpeasy-a": { command: "a" }, "third-party": { command: "b" } },
    });
    const result = await unregisterFromClient(configPath, cursor, "mcpeasy-a");
    expect(result.ok && result.removed).toBe(true);
    const config = await readJson(configPath);
    expect(config.keep).toBe("me");
    expect(Object.keys(config.mcpServers as object)).toEqual(["third-party"]);
  });

  it("treats an absent entry as success without writing", async () => {
    const configPath = join(root, "c", "mcp.json");
    await writeJson(configPath, { mcpServers: {} });
    const result = await unregisterFromClient(configPath, cursor, "mcpeasy-missing");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.removed).toBe(false);
      expect(result.backupPath).toBeNull();
    }
  });

  it("refuses when the config is malformed", async () => {
    const configPath = join(root, "bad", "mcp.json");
    await mkdir(join(root, "bad"), { recursive: true });
    await writeFile(configPath, "nope", "utf8");
    const result = await unregisterFromClient(configPath, cursor, "mcpeasy-a");
    expect(result.ok).toBe(false);
  });
});

describe("listClientEntries", () => {
  it("returns only MCPeasy entries", async () => {
    const configPath = join(root, "c", "mcp.json");
    await writeJson(configPath, {
      mcpServers: { "mcpeasy-a": { command: "a", args: ["x"] }, other: { command: "b" } },
    });
    const listed = await listClientEntries(configPath, cursor);
    expect(listed.ok && listed.entries.map((e) => e.name)).toEqual(["mcpeasy-a"]);
  });

  it("recognises a renamed entry by its ownership marker", async () => {
    // A user who renames our entry should still be able to remove it from the
    // UI; the name prefix alone cannot express that.
    const configPath = join(root, "c", "mcp.json");
    await writeJson(configPath, { mcpServers: { renamed: { command: "a", "x-mcpeasy": true } } });
    const listed = await listClientEntries(configPath, cursor);
    expect(listed.ok && listed.entries.map((e) => e.name)).toEqual(["renamed"]);
  });

  it("reads VS Code's `servers` key", async () => {
    const configPath = join(root, "v", "mcp.json");
    await writeJson(configPath, { servers: { "mcpeasy-a": { command: "a" } } });
    const listed = await listClientEntries(configPath, vscode);
    expect(listed.ok && listed.entries).toHaveLength(1);
  });

  it("survives a non-object server map", async () => {
    const configPath = join(root, "c", "mcp.json");
    await writeJson(configPath, { mcpServers: "oops" });
    const listed = await listClientEntries(configPath, cursor);
    expect(listed.ok && listed.entries).toEqual([]);
  });

  it("reports an empty list for a missing file", async () => {
    const listed = await listClientEntries(join(root, "nothing", "mcp.json"), cursor);
    expect(listed.ok && listed.entries).toEqual([]);
  });
});

describe("inspectClient", () => {
  it("reports unsupported on a platform the client does not run on", async () => {
    const state = await inspectClient(clientById("claude-desktop")!, { platform: "linux", home: root });
    expect(state.status).toBe("unsupported");
    expect(state.configPath).toBeNull();
  });

  it("reports needs_setup when nothing is on disk", async () => {
    const state = await inspectClient(cursor, { platform: "linux", home: join(root, "empty") });
    expect(state.status).toBe("needs_setup");
    expect(state.statusReason).toContain("No configuration found");
  });

  it("reports detected when the install directory exists but the server is not registered", async () => {
    const home = join(root, "home");
    await mkdir(join(home, ".cursor"), { recursive: true });
    const state = await inspectClient(cursor, { platform: "linux", home, expectedEntryName: "mcpeasy-p-s" });
    expect(state.status).toBe("detected");
  });

  it("reports connected when the expected entry is present", async () => {
    const home = join(root, "home");
    await writeJson(join(home, ".cursor", "mcp.json"), { mcpServers: { "mcpeasy-p-s": { command: "a" } } });
    const state = await inspectClient(cursor, { platform: "linux", home, expectedEntryName: "mcpeasy-p-s" });
    expect(state.status).toBe("connected");
    expect(state.entries.map((e) => e.name)).toEqual(["mcpeasy-p-s"]);
  });

  it("reports warning with the parse error when the config is malformed", async () => {
    const home = join(root, "home");
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(join(home, ".cursor", "mcp.json"), "{{{", "utf8");
    const state = await inspectClient(cursor, { platform: "linux", home });
    expect(state.status).toBe("warning");
    expect(state.error).toContain("could not be parsed");
  });

  it("always states a reason for its status", async () => {
    for (const client of MCP_CLIENTS) {
      const state = await inspectClient(client, { platform: "linux", home: join(root, "none") });
      expect(state.statusReason.length).toBeGreaterThan(0);
    }
  });
});
