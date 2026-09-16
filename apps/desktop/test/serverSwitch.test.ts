import { describe, expect, it } from "vitest";
import {
  currentServerLabel,
  decideSwitch,
  serverChoices,
  serverDisplayName,
  type ServerChoice,
} from "../src/renderer/src/shared/serverSwitch";
import type { ProjectServerEntry } from "../src/shared/ipc";

// These cover the rules behind the builder's server dropdown. Two of them can
// cause real damage if they regress: a wrong `isCurrent` makes the menu mark
// the wrong server as open, and a wrong decideSwitch discards unsaved work
// without asking. The menu around them is presentation.

function entry(overrides: Partial<ProjectServerEntry> = {}): ProjectServerEntry {
  return {
    path: "C:\\lib\\proj\\servers\\weather.json",
    fileName: "weather.json",
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("serverDisplayName", () => {
  it("strips the .json the library adds when saving", () => {
    expect(serverDisplayName("weather.json")).toBe("weather");
  });

  it("only strips a trailing .json, not one inside the name", () => {
    // "json-tools.json" must not become "json-tools" by losing the wrong part,
    // and a name that merely contains ".json" keeps it.
    expect(serverDisplayName("json-tools.json")).toBe("json-tools");
    expect(serverDisplayName("a.json.backup")).toBe("a.json.backup");
  });
});

describe("serverChoices", () => {
  it("orders most-recently-saved first", () => {
    const rows = serverChoices(
      [
        entry({ path: "a", fileName: "alpha.json", updatedAt: 100 }),
        entry({ path: "c", fileName: "gamma.json", updatedAt: 300 }),
        entry({ path: "b", fileName: "beta.json", updatedAt: 200 }),
      ],
      null,
    );
    expect(rows.map((r) => r.name)).toEqual(["gamma", "beta", "alpha"]);
  });

  it("breaks ties on name so the order is stable", () => {
    // Input is reverse-alphabetical, so a missing tiebreak would preserve
    // insertion order and this test would fail.
    const rows = serverChoices(
      [
        entry({ path: "z", fileName: "zulu.json", updatedAt: 500 }),
        entry({ path: "a", fileName: "alpha.json", updatedAt: 500 }),
      ],
      null,
    );
    expect(rows.map((r) => r.name)).toEqual(["alpha", "zulu"]);
  });

  it("marks exactly the open doc as current", () => {
    const rows = serverChoices(
      [entry({ path: "open-one" }), entry({ path: "other", fileName: "other.json" })],
      "open-one",
    );
    expect(rows.filter((r) => r.isCurrent).map((r) => r.path)).toEqual(["open-one"]);
  });

  it("marks nothing as current for an unsaved doc", () => {
    // filePath is null before the first save; without the explicit null guard
    // a loose comparison could match an entry whose path is also falsy.
    const rows = serverChoices([entry({ path: "" })], null);
    expect(rows.every((r) => !r.isCurrent)).toBe(true);
  });

  it("returns an empty list for a workspace with no servers", () => {
    expect(serverChoices([], null)).toEqual([]);
  });
});

describe("currentServerLabel", () => {
  it("uses the saved file name without its extension", () => {
    expect(currentServerLabel("weather.json", "ignored")).toBe("weather");
  });

  it("falls back to the typed server name while unsaved", () => {
    // "Untitled" read as data loss to users, so a named-but-unsaved doc shows
    // the name they typed.
    expect(currentServerLabel(null, "weather-tools")).toBe("weather-tools");
  });

  it("falls back to Untitled only when the name is blank", () => {
    expect(currentServerLabel(null, "   ")).toBe("Untitled");
    expect(currentServerLabel(null, "")).toBe("Untitled");
  });
});

describe("decideSwitch", () => {
  const target = (overrides: Partial<ServerChoice> = {}): ServerChoice => ({
    path: "C:\\lib\\proj\\servers\\other.json",
    name: "other",
    updatedAt: 1,
    isCurrent: false,
    ...overrides,
  });

  it("opens immediately when nothing is unsaved", () => {
    expect(decideSwitch(target(), false)).toEqual({ kind: "open" });
  });

  it("confirms before discarding unsaved work", () => {
    expect(decideSwitch(target(), true)).toEqual({ kind: "confirm" });
  });

  it("does nothing when the target is already open", () => {
    // Re-loading the open doc would discard unsaved edits to arrive at the doc
    // the user is already looking at — the worst possible trade.
    expect(decideSwitch(target({ isCurrent: true }), false)).toEqual({ kind: "noop" });
  });

  it("does nothing for the open doc even when dirty", () => {
    // The dirty check must not outrank the identity check, or selecting the
    // current server would prompt to save against itself.
    expect(decideSwitch(target({ isCurrent: true }), true)).toEqual({ kind: "noop" });
  });
});
