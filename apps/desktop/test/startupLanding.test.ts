import { describe, expect, it } from "vitest";
import { resolveStartupLanding } from "../src/renderer/src/shared/startupLanding";
import type { ProjectServerEntry } from "../src/shared/ipc";

// The rule governing what the user sees when a workspace is entered without
// naming a server. The failure this guards against is specific and was real:
// every path used to be able to land on a blank unsaved "my-server" canvas,
// which reads as data loss when the workspace actually holds saved work.
//
// The invariant every test below defends: an automatic landing NEVER creates a
// server. It opens an existing saved one, or it shows the workspace home.

function entry(overrides: Partial<ProjectServerEntry> = {}): ProjectServerEntry {
  return {
    path: "C:\\lib\\proj\\servers\\weather.json",
    fileName: "weather.json",
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("resolveStartupLanding", () => {
  it("reopens the remembered server and shows the builder", () => {
    const servers = [
      entry({ path: "C:\\lib\\p\\servers\\a.json", fileName: "a.json", updatedAt: 3 }),
      entry({ path: "C:\\lib\\p\\servers\\b.json", fileName: "b.json", updatedAt: 1 }),
    ];
    expect(resolveStartupLanding(servers, "C:\\lib\\p\\servers\\b.json")).toEqual({
      openServerPath: "C:\\lib\\p\\servers\\b.json",
      page: "builder",
    });
  });

  it("honours the remembered server even when it is not the most recent", () => {
    // Guards against a tempting 'simplification' to "just open servers[0]".
    // The user's last doc wins over recency; b.json above is the OLDER file and
    // must still be the one restored.
    const servers = [
      entry({ path: "/p/new.json", fileName: "new.json", updatedAt: 9_000 }),
      entry({ path: "/p/old.json", fileName: "old.json", updatedAt: 1 }),
    ];
    expect(resolveStartupLanding(servers, "/p/old.json").openServerPath).toBe("/p/old.json");
  });

  it("shows the workspace home when nothing was remembered", () => {
    // The decisive case for the reported bug: a workspace WITH saved servers
    // and no remembered path must not open a blank new server. It also must not
    // guess a server (user decision) — the home page lets the user choose.
    const servers = [entry({ path: "/p/a.json", updatedAt: 5 })];
    expect(resolveStartupLanding(servers, null)).toEqual({
      openServerPath: null,
      page: "repository",
    });
  });

  it("shows the workspace home when the remembered server is gone", () => {
    // Deleted or renamed outside the app. Substituting a different server would
    // answer a question the user did not ask, so this falls through to home
    // rather than silently loading the neighbour.
    const servers = [entry({ path: "/p/still-here.json" })];
    expect(resolveStartupLanding(servers, "/p/deleted.json")).toEqual({
      openServerPath: null,
      page: "repository",
    });
  });

  it("shows the workspace home for a brand-new empty workspace", () => {
    // The create-workspace path. This is where "create => builder" used to put
    // an unsaved blank server on screen automatically.
    expect(resolveStartupLanding([], null)).toEqual({
      openServerPath: null,
      page: "repository",
    });
  });

  it("does not open a server for an empty workspace even with a stale memory", () => {
    // Every server deleted since last launch. The remembered path cannot match,
    // and there is nothing to fall back to.
    expect(resolveStartupLanding([], "/p/gone.json")).toEqual({
      openServerPath: null,
      page: "repository",
    });
  });

  it("matches the remembered path exactly, never case-insensitively", () => {
    // Paths on both sides come from the same listProjects source, so no
    // normalisation is warranted — and on a case-sensitive filesystem a
    // case-folded match could load a genuinely DIFFERENT file.
    const servers = [entry({ path: "/p/Weather.json", fileName: "Weather.json" })];
    expect(resolveStartupLanding(servers, "/p/weather.json").openServerPath).toBeNull();
  });

  it("never returns the builder without a server to show in it", () => {
    // The load-bearing invariant: "builder" is only ever justified by real work
    // being loaded into it. Checked across every shape the callers can produce.
    const cases: Array<[ProjectServerEntry[], string | null]> = [
      [[], null],
      [[], "/p/x.json"],
      [[entry({ path: "/p/a.json" })], null],
      [[entry({ path: "/p/a.json" })], "/p/missing.json"],
      [[entry({ path: "/p/a.json" })], "/p/a.json"],
    ];
    for (const [servers, remembered] of cases) {
      const landing = resolveStartupLanding(servers, remembered);
      if (landing.page === "builder") expect(landing.openServerPath).not.toBeNull();
      else expect(landing.openServerPath).toBeNull();
    }
  });
});
