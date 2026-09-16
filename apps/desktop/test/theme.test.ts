import { describe, expect, it } from "vitest";
import { parseThemePreference, resolveTheme } from "../src/renderer/src/theme";

describe("theme preferences", () => {
  it("accepts supported persisted values and rejects stale ones", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference("purple")).toBe("system");
    expect(parseThemePreference(null)).toBe("system");
  });

  it("resolves system dynamically while explicit preferences win", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
