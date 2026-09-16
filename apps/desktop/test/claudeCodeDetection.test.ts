import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectClaudeCode } from "../src/main/claudeCode";

// Detection is the part of the Claude Code integration that discovers state on
// THIS machine: where the CLI lives and where its config file is. Everything
// else in claudeCode.ts is handed a path by its caller.
//
// That makes this the only module where a hardcoded developer path could hide
// and still look correct on the machine it was written on. These tests exist to
// make that impossible to reintroduce: every one of them points detection at a
// synthetic home directory under tmpdir and asserts the result follows THAT,
// never the real user profile.
//
// Real tmpdir, no fs mocks — same rule as claudeCode.test.ts. A mocked
// filesystem here would assert that the mock was configured, not that discovery
// works.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcpeasy-detect-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Create a fake native-installer layout: <home>/.local/bin/claude[.exe].
 * Returns the executable path so a test can assert on it exactly. */
async function plantCli(home: string): Promise<string> {
  const binDir = join(home, ".local", "bin");
  await mkdir(binDir, { recursive: true });
  const executable = join(binDir, process.platform === "win32" ? "claude.exe" : "claude");
  // Content is irrelevant: detection tests for EXISTENCE, and any version/auth
  // probe against this stub fails harmlessly and degrades to null/unknown.
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  return executable;
}

describe("detectClaudeCode config path discovery", () => {
  it("resolves the config path under the injected home, not the real user profile", async () => {
    const home = join(root, "home-a");
    await mkdir(home, { recursive: true });

    const detection = await detectClaudeCode({ home, env: {} });

    expect(detection.configPath).toBe(join(home, ".claude.json"));
  });

  it("follows a different injected home to a different path", async () => {
    // Two homes in one test: proves the result is a function of the input
    // rather than a constant that happens to match the first assertion.
    const first = await detectClaudeCode({ home: join(root, "home-b"), env: {} });
    const second = await detectClaudeCode({ home: join(root, "home-c"), env: {} });

    expect(first.configPath).not.toBe(second.configPath);
    expect(first.configPath).toBe(join(root, "home-b", ".claude.json"));
    expect(second.configPath).toBe(join(root, "home-c", ".claude.json"));
  });

  it("honors CLAUDE_CONFIG_DIR over the home directory", async () => {
    const home = join(root, "home-d");
    const configDir = join(root, "custom-config");

    const detection = await detectClaudeCode({ home, env: { CLAUDE_CONFIG_DIR: configDir } });

    // NESTED inside the override, unlike the unset default where .claude.json
    // is a SIBLING of ~/.claude. Verified against the real CLI; see
    // docs/integrations-claude-code.md.
    expect(detection.configPath).toBe(join(configDir, ".claude.json"));
  });
});

describe("detectClaudeCode executable discovery", () => {
  it("finds a CLI planted in the injected home's native-installer location", async () => {
    const home = join(root, "home-e");
    const planted = await plantCli(home);

    const detection = await detectClaudeCode({ home, env: {} });

    expect(detection.cliFound).toBe(true);
    expect(detection.executablePath).toBe(planted);
  });

  it("reports not-found for a home with no CLI, even though this machine has one", async () => {
    // The developer machine that wrote this has Claude Code installed at
    // %USERPROFILE%\.local\bin\claude.exe. If detection ever fell back to the
    // real home or a baked-in path, this assertion is what catches it.
    const home = join(root, "home-f");
    await mkdir(home, { recursive: true });

    const detection = await detectClaudeCode({ home, env: {} });

    expect(detection.cliFound).toBe(false);
    expect(detection.executablePath).toBeNull();
    expect(detection.version).toBeNull();
    expect(detection.authState).toBe("unknown");
  });

  it("discovers a CLI on PATH when it is not in the home location", async () => {
    const home = join(root, "home-g");
    await mkdir(home, { recursive: true });
    const pathDir = join(root, "elsewhere", "bin");
    await mkdir(pathDir, { recursive: true });
    const executable = join(pathDir, process.platform === "win32" ? "claude.exe" : "claude");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");

    const detection = await detectClaudeCode({ home, env: { PATH: pathDir } });

    expect(detection.cliFound).toBe(true);
    expect(detection.executablePath).toBe(executable);
  });

  it("prefers the home native-installer location over a PATH entry", async () => {
    // Priority matters on Windows, where a global npm install puts a .cmd shim
    // on PATH that cannot be spawned with shell:false, while the native
    // installer's .exe can.
    const home = join(root, "home-h");
    const planted = await plantCli(home);
    const pathDir = join(root, "path-bin");
    await mkdir(pathDir, { recursive: true });
    await writeFile(join(pathDir, process.platform === "win32" ? "claude.exe" : "claude"), "stub", "utf8");

    const detection = await detectClaudeCode({ home, env: { PATH: pathDir } });

    expect(detection.executablePath).toBe(planted);
  });

  it("uses an explicit override and never silently substitutes a discovered CLI", async () => {
    const home = join(root, "home-i");
    await plantCli(home);
    const override = join(root, "does-not-exist", "claude.exe");

    const detection = await detectClaudeCode({ home, env: {}, executableOverride: override });

    // An override that does not exist must surface as not-found rather than
    // quietly falling back, matching the ELECTRON_EXEC_PATH escape-hatch rule.
    expect(detection.cliFound).toBe(false);
    expect(detection.executablePath).toBeNull();
  });

  it("degrades to unknown version when the CLI exists but cannot be executed", async () => {
    // REGRESSION (found by this suite): a file that exists but is not a
    // loadable image makes Windows throw `spawn UNKNOWN` synchronously out of
    // execFile. That escaped runCli's resolve-only promise and rejected all of
    // detectClaudeCode, which would take down the whole Integrations page
    // rather than degrading a single row.
    //
    // Real causes: a partially downloaded install, an antivirus quarantine
    // stub, or a `.ps1` shim. The planted stub reproduces the same shape.
    const home = join(root, "home-k");
    const planted = await plantCli(home);

    const detection = await detectClaudeCode({ home, env: {} });

    // Found on disk is still TRUE — the file is really there. What is unknown
    // is whether it runs, so version stays null instead of the call throwing.
    expect(detection.cliFound).toBe(true);
    expect(detection.executablePath).toBe(planted);
    expect(detection.version).toBeNull();
  });

  it("ignores empty PATH segments without probing the process working directory", async () => {
    const home = join(root, "home-j");
    await mkdir(home, { recursive: true });

    // A trailing delimiter yields an empty segment. Joining "" with "claude"
    // would probe a RELATIVE path, resolving against the current working
    // directory — a real way for detection to find something it should not.
    const detection = await detectClaudeCode({ home, env: { PATH: ";;" } });

    expect(detection.cliFound).toBe(false);
  });
});
