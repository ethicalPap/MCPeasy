import { describe, expect, it } from "vitest";
import { connectConfirmMatches, connectConfirmTarget } from "../src/shared/connectConfirm";

// These cover the RULE that guards a write to a file outside the workspace.
// The dialog around it is presentation; this is the part that must not regress.

describe("connectConfirmTarget", () => {
  it("asks for the server name, because that is what becomes reachable", () => {
    expect(connectConfirmTarget("weather-tools", "weather.json")).toBe("weather-tools");
  });

  it("trims incidental whitespace from the doc's name", () => {
    expect(connectConfirmTarget("  weather-tools  ", "weather.json")).toBe("weather-tools");
  });

  it("falls back to the file's base name when the doc has no name", () => {
    // The schema requires a non-empty name, so this is the hand-edited /
    // older-file case. It must still yield something typeable.
    expect(connectConfirmTarget("", "weather.json")).toBe("weather");
    expect(connectConfirmTarget("   ", "sub/dir/my-server.JSON")).toBe("my-server");
    expect(connectConfirmTarget("", "C:\\projects\\thing.json")).toBe("thing");
  });

  it("yields an empty target when neither source gives a name", () => {
    // Paired with the guard in connectConfirmMatches below: an empty target
    // must block confirmation rather than accept anything.
    expect(connectConfirmTarget("", null)).toBe("");
  });
});

describe("connectConfirmMatches", () => {
  it("accepts the exact name", () => {
    expect(connectConfirmMatches("weather-tools", "weather-tools")).toBe(true);
  });

  it("forgives surrounding whitespace from copy/paste", () => {
    expect(connectConfirmMatches("  weather-tools ", "weather-tools")).toBe(true);
  });

  it("rejects a different case, so transcription stays deliberate", () => {
    expect(connectConfirmMatches("WEATHER-TOOLS", "weather-tools")).toBe(false);
    expect(connectConfirmMatches("vs code", "VS Code")).toBe(false);
  });

  it("rejects partial, empty and near-miss input", () => {
    expect(connectConfirmMatches("", "weather-tools")).toBe(false);
    expect(connectConfirmMatches("weather", "weather-tools")).toBe(false);
    expect(connectConfirmMatches("weather tools", "weather-tools")).toBe(false);
    expect(connectConfirmMatches("weather-tools2", "weather-tools")).toBe(false);
  });

  it("refuses everything when the target is empty, rather than accepting everything", () => {
    // Without this guard an unnamed doc would silently disable the confirmation
    // step entirely — the empty input would equal the empty target.
    expect(connectConfirmMatches("", "")).toBe(false);
    expect(connectConfirmMatches("anything", "")).toBe(false);
    expect(connectConfirmMatches("", "   ")).toBe(false);
  });
});
