import { describe, expect, it } from "vitest";
import {
  candidateBlockers,
  candidateDisplayName,
  readCandidateFacts,
  type ConnectCandidate,
} from "../src/shared/connectTarget";

// These cover the rules that decide WHICH server a connect writes and whether
// it may be written at all. The picker dialog around them is presentation; this
// is the part that must not regress, because a wrong answer here either
// registers the wrong server or promises one that cannot start.

/** A connectable candidate; each test overrides only what it is about. */
function candidate(overrides: Partial<ConnectCandidate> = {}): ConnectCandidate {
  return {
    path: "C:\\lib\\proj\\servers\\weather.json",
    fileName: "weather.json",
    updatedAt: 1_700_000_000_000,
    serverName: "weather-tools",
    env: [],
    listening: false,
    loadError: null,
    ...overrides,
  };
}

const ready = { storedSecrets: [], isOpenInBuilder: false, builderDirty: false };

describe("candidateDisplayName", () => {
  it("prefers the doc's own name, which is the identity the user typed", () => {
    expect(candidateDisplayName({ serverName: "weather-tools", fileName: "wx.json" })).toBe("weather-tools");
  });

  it("trims incidental whitespace", () => {
    expect(candidateDisplayName({ serverName: "  weather-tools  ", fileName: "wx.json" })).toBe("weather-tools");
  });

  it("falls back to the file name when the doc has none", () => {
    // Hand-edited or pre-schema docs must still be nameable, or the row would
    // render blank and be impossible to confirm.
    expect(candidateDisplayName({ serverName: "", fileName: "weather.json" })).toBe("weather");
    expect(candidateDisplayName({ serverName: "   ", fileName: "My Server.JSON" })).toBe("My Server");
  });
});

describe("readCandidateFacts", () => {
  it("reads the name, env and transport a picker row needs", () => {
    const facts = readCandidateFacts(
      JSON.stringify({ server: { name: "weather", env: ["API_KEY"], transport: "stdio" } }),
    );
    expect(facts).toEqual({ serverName: "weather", env: ["API_KEY"], listening: false, loadError: null });
  });

  it("flags an http server as listening", () => {
    // This is the fact that stops a port-listening graph being registered as a
    // spawned stdio entry, which is the exact bug that made a connected server
    // answer nothing.
    expect(readCandidateFacts(JSON.stringify({ server: { name: "a", transport: "http" } })).listening).toBe(true);
  });

  it("treats a missing transport as stdio, matching the engine default", () => {
    expect(readCandidateFacts(JSON.stringify({ server: { name: "a" } })).listening).toBe(false);
  });

  it("reports unreadable files as a load error rather than throwing", () => {
    // One corrupt file must not blank the whole picker.
    expect(readCandidateFacts("{ not json").loadError).toBe("this file is not valid JSON");
    expect(readCandidateFacts("[]").loadError).toBe("this file is not a server document");
    expect(readCandidateFacts("null").loadError).toBe("this file is not a server document");
    expect(readCandidateFacts(JSON.stringify({ server: 42 })).loadError).toBe("this file is not a server document");
  });

  it("drops non-string env members instead of coercing them", () => {
    // Inventing "42" as a variable name would produce a blocker the user could
    // never satisfy, because no secret can be stored under that name.
    const facts = readCandidateFacts(JSON.stringify({ server: { name: "a", env: ["OK", 42, null] } }));
    expect(facts.env).toEqual(["OK"]);
  });

  it("survives a doc whose name is not a string", () => {
    expect(readCandidateFacts(JSON.stringify({ server: { name: 7 } })).serverName).toBe("");
  });
});

describe("candidateBlockers", () => {
  it("allows a saved, fully provisioned server", () => {
    expect(candidateBlockers(candidate(), ready)).toEqual([]);
  });

  it("blocks a server whose declared env has no stored secret", () => {
    // Without this the connect succeeds and serve mode exits non-zero at
    // launch, which every client reports only as a generic failure.
    const blockers = candidateBlockers(candidate({ env: ["API_KEY", "TOKEN"] }), {
      ...ready,
      storedSecrets: ["TOKEN"],
    });
    expect(blockers).toEqual(["no stored secret for API_KEY, add it on the Secrets page"]);
  });

  it("allows a server whose declared env is fully stored", () => {
    expect(candidateBlockers(candidate({ env: ["API_KEY"] }), { ...ready, storedSecrets: ["API_KEY"] })).toEqual([]);
  });

  it("blocks an http server, because a client spawns a stdio process", () => {
    expect(candidateBlockers(candidate({ listening: true }), ready)).toEqual([
      "this server uses the http transport, which listens on a port instead of being started by the client",
    ]);
  });

  it("blocks the open server only while the BUILDER has unsaved changes", () => {
    expect(candidateBlockers(candidate(), { ...ready, isOpenInBuilder: true, builderDirty: true })).toEqual([
      "this server is open in the builder with unsaved changes, save it first",
    ]);
    expect(candidateBlockers(candidate(), { ...ready, isOpenInBuilder: true, builderDirty: false })).toEqual([]);
  });

  it("does NOT block other servers because an unrelated buffer is dirty", () => {
    // The regression this guards: treating `dirty` as global would refuse every
    // saved server in the workspace whenever any doc had unsaved edits, which
    // is a lie about what is on disk.
    expect(candidateBlockers(candidate(), { ...ready, isOpenInBuilder: false, builderDirty: true })).toEqual([]);
  });

  it("reports every reason at once, so they can be fixed in one pass", () => {
    const blockers = candidateBlockers(candidate({ listening: true, env: ["API_KEY"] }), {
      storedSecrets: [],
      isOpenInBuilder: true,
      builderDirty: true,
    });
    expect(blockers).toHaveLength(3);
  });

  it("reports only the load error when the doc could not be read", () => {
    // Env and transport are unknowable for an unreadable doc, so stacking
    // secondary complaints on top would be inventing facts.
    expect(candidateBlockers(candidate({ loadError: "this file is not valid JSON" }), ready)).toEqual([
      "this file is not valid JSON",
    ]);
  });
});
