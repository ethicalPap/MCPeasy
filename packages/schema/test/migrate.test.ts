import { describe, expect, it } from "vitest";
import { migrateGraphDoc } from "../src/migrate.js";

describe("migrateGraphDoc", () => {
  it("passes current-version docs through untouched", () => {
    const doc = { version: 1, server: {}, nodes: {} };
    expect(migrateGraphDoc(doc)).toEqual(doc);
  });

  it("refuses docs from a newer build", () => {
    expect(() => migrateGraphDoc({ version: 99 })).toThrow(/newer than this build/);
  });

  it("passes non-doc values through for validation to reject", () => {
    expect(migrateGraphDoc(null)).toBe(null);
    expect(migrateGraphDoc("x")).toBe("x");
    expect(migrateGraphDoc({ noVersion: true })).toEqual({ noVersion: true });
  });

  it("does not mutate its argument", () => {
    const doc = { version: 1, nodes: {} };
    const before = JSON.stringify(doc);
    migrateGraphDoc(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
