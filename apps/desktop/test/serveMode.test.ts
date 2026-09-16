import { describe, expect, it } from "vitest";
import { GRAPH_DOC_VERSION, type GraphDoc } from "@mcpeasy/schema";
import {
  SERVE_FLAG,
  grantKey,
  hasLocalExecutionGrant,
  localExecutionFingerprint,
  parseServeArgs,
  resolveDeclaredEnv,
  usesListeningTransport,
  withLocalExecutionGrant,
  withoutLocalExecutionGrant,
} from "../src/main/serveMode";

// serveMode.ts is deliberately Electron-free so these run under plain Node.
// The behaviours worth testing are the ones a wrong implementation would get
// silently wrong: argv shape differences between dev and packaged builds,
// which env names reach the server, and when a local-execution grant lapses.

function docWith(nodes: GraphDoc["nodes"], env: string[] = []): GraphDoc {
  return {
    version: GRAPH_DOC_VERSION,
    server: { name: "test", version: "0.1.0", transport: "stdio", auth: { type: "none" }, env },
    nodes,
    edges: [],
  } as GraphDoc;
}

const commandNode = (executable: string, args: string[] = []): GraphDoc["nodes"][string] =>
  ({
    kind: "command",
    command: { executable, args, output: "text" },
    next: null,
  }) as unknown as GraphDoc["nodes"][string];

const returnNode = (): GraphDoc["nodes"][string] =>
  ({ kind: "return", body: "done" }) as unknown as GraphDoc["nodes"][string];

describe("parseServeArgs", () => {
  it("opens a window when the serve flag is absent", () => {
    expect(parseServeArgs(["electron.exe", "."])).toEqual({ mode: "window" });
  });

  it("reads flags positioned anywhere, so dev and packaged argv both work", () => {
    // Packaged: [MCPeasy.exe, --mcp-serve, ...]. Dev: [electron.exe, appPath, ...].
    const packaged = parseServeArgs(["MCPeasy.exe", SERVE_FLAG, "--project", "acme", "--server", "C:/x/weather.json"]);
    const dev = parseServeArgs(["electron.exe", ".", SERVE_FLAG, "--project", "acme", "--server", "C:/x/weather.json"]);
    expect(packaged).toEqual({ mode: "serve", args: { projectId: "acme", serverPath: "C:/x/weather.json" } });
    expect(dev).toEqual(packaged);
  });

  it("reports invalid instead of falling back to a window when a value is missing", () => {
    // Critical: falling through to window mode would leave Claude Code waiting
    // on a process that never speaks JSON-RPC.
    const noProject = parseServeArgs([SERVE_FLAG, "--server", "C:/x.json"]);
    expect(noProject.mode).toBe("invalid");
    const noServer = parseServeArgs([SERVE_FLAG, "--project", "acme"]);
    expect(noServer.mode).toBe("invalid");
  });

  it("treats a following flag as a missing value, not as the value", () => {
    const result = parseServeArgs([SERVE_FLAG, "--project", "--server", "C:/x.json"]);
    expect(result.mode).toBe("invalid");
    if (result.mode === "invalid") expect(result.error).toContain("--project");
  });
});

describe("usesListeningTransport", () => {
  // Client entries are always stdio: the client spawns the command. An http
  // graph registered that way answers nothing on the pipe, which the user sees
  // as "the server has no tools" -- the exact symptom this release fixed.
  it("flags an http doc so it is never registered as a stdio client entry", () => {
    expect(usesListeningTransport({ server: { transport: "http" } })).toBe(true);
  });

  it("allows a stdio doc", () => {
    expect(usesListeningTransport({ server: { transport: "stdio" } })).toBe(false);
  });

  it("allows anything malformed, so it can only ever add a refusal", () => {
    // Validation belongs to the engine, which gives a far better message; this
    // guard must not pre-empt it by rejecting docs for the wrong reason.
    for (const raw of [null, undefined, 42, "http", [], {}, { server: null }, { server: 7 }]) {
      expect(usesListeningTransport(raw)).toBe(false);
    }
  });
});

describe("resolveDeclaredEnv", () => {
  it("passes through only declared names", () => {
    const result = resolveDeclaredEnv(["API_KEY"], { API_KEY: "v", OTHER_SERVER_KEY: "leak" });
    expect(result).toEqual({ ok: true, env: { API_KEY: "v" } });
  });

  it("reports every missing name at once", () => {
    // One round trip per missing secret would be a poor diagnostic when the
    // only channel is a stderr line behind a connection failure.
    const result = resolveDeclaredEnv(["A", "B", "C"], { B: "set" });
    expect(result).toEqual({ ok: false, missing: ["A", "C"] });
  });

  it("succeeds with an empty env when nothing is declared", () => {
    expect(resolveDeclaredEnv([], {})).toEqual({ ok: true, env: {} });
  });

  it("treats an empty-string secret as present", () => {
    // Only `undefined` means "not stored"; "" is a value the user chose.
    expect(resolveDeclaredEnv(["EMPTY"], { EMPTY: "" })).toEqual({ ok: true, env: { EMPTY: "" } });
  });
});

describe("localExecutionFingerprint", () => {
  it("is null when the graph has no local nodes", () => {
    expect(localExecutionFingerprint(docWith({ r: returnNode() }))).toBeNull();
  });

  it("is stable across an unrelated edit", () => {
    const before = localExecutionFingerprint(docWith({ c: commandNode("git"), r: returnNode() }));
    const after = localExecutionFingerprint(
      docWith({ c: commandNode("git"), r: returnNode(), extra: returnNode() }),
    );
    expect(after).toBe(before);
  });

  it("changes when a local node's definition changes", () => {
    // The whole point of the grant: approving `git` must not also approve
    // `rm` under the same node id.
    const before = localExecutionFingerprint(docWith({ c: commandNode("git") }));
    const after = localExecutionFingerprint(docWith({ c: commandNode("rm") }));
    expect(after).not.toBe(before);
  });

  it("changes when only an argument changes", () => {
    const before = localExecutionFingerprint(docWith({ c: commandNode("git", ["status"]) }));
    const after = localExecutionFingerprint(docWith({ c: commandNode("git", ["push", "--force"]) }));
    expect(after).not.toBe(before);
  });

  it("ignores node insertion order", () => {
    // Object.entries follows insertion order, so without the sort an identical
    // graph saved in a different sequence would revoke a valid grant.
    const a = localExecutionFingerprint(docWith({ a: commandNode("one"), b: commandNode("two") }));
    const b = localExecutionFingerprint(docWith({ b: commandNode("two"), a: commandNode("one") }));
    expect(a).toBe(b);
  });
});

describe("local execution grants", () => {
  const doc = docWith({ c: commandNode("git") });
  const fingerprint = localExecutionFingerprint(doc)!;

  it("round-trips a grant", () => {
    const grants = withLocalExecutionGrant({}, "acme", "/lib/weather.json", fingerprint);
    expect(hasLocalExecutionGrant(grants, "acme", "/lib/weather.json", fingerprint)).toBe(true);
  });

  it("lapses when the graph changes", () => {
    const grants = withLocalExecutionGrant({}, "acme", "/lib/weather.json", fingerprint);
    const edited = localExecutionFingerprint(docWith({ c: commandNode("rm") }))!;
    expect(hasLocalExecutionGrant(grants, "acme", "/lib/weather.json", edited)).toBe(false);
  });

  it("does not leak across projects or servers", () => {
    const grants = withLocalExecutionGrant({}, "acme", "/lib/weather.json", fingerprint);
    expect(hasLocalExecutionGrant(grants, "other", "/lib/weather.json", fingerprint)).toBe(false);
    expect(hasLocalExecutionGrant(grants, "acme", "/lib/other.json", fingerprint)).toBe(false);
  });

  it("normalizes the path so IPC and argv spellings agree", () => {
    expect(grantKey("acme", "/lib/sub/../weather.json")).toBe(grantKey("acme", "/lib/weather.json"));
  });

  it("fails closed on a null fingerprint or malformed store", () => {
    const grants = withLocalExecutionGrant({}, "acme", "/lib/weather.json", fingerprint);
    expect(hasLocalExecutionGrant(grants, "acme", "/lib/weather.json", null)).toBe(false);
    expect(hasLocalExecutionGrant(null, "acme", "/lib/weather.json", fingerprint)).toBe(false);
    expect(hasLocalExecutionGrant("nonsense", "acme", "/lib/weather.json", fingerprint)).toBe(false);
    expect(hasLocalExecutionGrant({ [grantKey("acme", "/lib/weather.json")]: 7 }, "acme", "/lib/weather.json", fingerprint)).toBe(false);
  });

  it("revokes without disturbing other grants", () => {
    let grants = withLocalExecutionGrant({}, "acme", "/lib/a.json", fingerprint);
    grants = withLocalExecutionGrant(grants, "acme", "/lib/b.json", fingerprint);
    grants = withoutLocalExecutionGrant(grants, "acme", "/lib/a.json");
    expect(hasLocalExecutionGrant(grants, "acme", "/lib/a.json", fingerprint)).toBe(false);
    expect(hasLocalExecutionGrant(grants, "acme", "/lib/b.json", fingerprint)).toBe(true);
  });

  it("revoking an absent grant is a no-op success", () => {
    expect(withoutLocalExecutionGrant({}, "acme", "/lib/none.json")).toEqual({});
  });

  it("drops malformed entries when writing", () => {
    const grants = withLocalExecutionGrant({ bad: 1, worse: { fingerprint: 2 } }, "acme", "/lib/a.json", fingerprint);
    expect(Object.keys(grants)).toEqual([grantKey("acme", "/lib/a.json")]);
  });
});
