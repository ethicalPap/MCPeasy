import { describe, expect, it } from "vitest";
import {
  PROJECTS_STORAGE_KEY,
  createProject,
  listProjects,
  readProjectDoc,
  saveDocToProject,
  type KeyValueStorage,
} from "../src/renderer/src/browser/library";

// The browser library must mirror the desktop (filesystem) library's
// semantics — duplicate refusal, overwrite-on-same-name, unknown-project
// errors, out-of-library reads returning null — so a user switching between
// modes sees the same behavior. These tests assert those same contracts
// against a Map-backed storage fake (no DOM in the vitest node environment).

function fakeStorage(): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

describe("browser project library", () => {
  it("creates and lists projects", () => {
    const storage = fakeStorage();
    const res = createProject(storage, "My Project");
    expect(res.ok).toBe(true);
    const projects = listProjects(storage);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe("My Project");
    expect(projects[0]!.servers).toEqual([]);
  });

  it("refuses duplicate project names (same as the desktop EEXIST branch)", () => {
    const storage = fakeStorage();
    expect(createProject(storage, "dup").ok).toBe(true);
    const second = createProject(storage, "dup");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("already exists");
  });

  it("rejects names that slug to nothing", () => {
    const storage = fakeStorage();
    expect(createProject(storage, "...").ok).toBe(false);
    expect(createProject(storage, 42).ok).toBe(false);
  });

  it("saves a doc into a project and reads it back via its path", () => {
    const storage = fakeStorage();
    createProject(storage, "p1");
    const saved = saveDocToProject(storage, "p1", "my server", '{"a":1}');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.path).toBe("browser://projects/p1/servers/my server.json");
    const read = readProjectDoc(storage, saved.path);
    expect(read).toEqual({ path: saved.path, text: '{"a":1}' });
  });

  it("overwrites on same-name save (Ctrl+S semantics)", () => {
    const storage = fakeStorage();
    createProject(storage, "p1");
    saveDocToProject(storage, "p1", "s", "v1");
    const saved = saveDocToProject(storage, "p1", "s", "v2");
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(readProjectDoc(storage, saved.path)?.text).toBe("v2");
    expect(listProjects(storage)[0]!.servers).toHaveLength(1);
  });

  it("refuses saves to unknown or non-slug project ids", () => {
    const storage = fakeStorage();
    createProject(storage, "p1");
    expect(saveDocToProject(storage, "missing", "s", "{}").ok).toBe(false);
    // An id that would need re-slugging came from nowhere legitimate.
    expect(saveDocToProject(storage, "p1?", "s", "{}").ok).toBe(false);
  });

  it("returns null for paths outside the browser:// library scheme", () => {
    const storage = fakeStorage();
    createProject(storage, "p1");
    saveDocToProject(storage, "p1", "s", "{}");
    expect(readProjectDoc(storage, "C:/somewhere/else.json")).toBeNull();
    expect(readProjectDoc(storage, "browser://projects/p1/other/s.json")).toBeNull();
    expect(readProjectDoc(storage, 42)).toBeNull();
  });

  it("degrades corrupt stored JSON to an empty library instead of throwing", () => {
    const storage = fakeStorage();
    storage.map.set(PROJECTS_STORAGE_KEY, "{not json");
    expect(listProjects(storage)).toEqual([]);
    // And the library is usable again immediately.
    expect(createProject(storage, "fresh").ok).toBe(true);
  });

  it("orders projects and servers most-recent-first like the desktop library", () => {
    const storage = fakeStorage();
    createProject(storage, "old");
    createProject(storage, "new");
    const raw = JSON.parse(storage.map.get(PROJECTS_STORAGE_KEY)!) as Record<
      string,
      { createdAt: number; servers: Record<string, { updatedAt: number }> }
    >;
    // Force distinct timestamps (Date.now() can tie inside one test run).
    raw["old"]!.createdAt = 1;
    raw["new"]!.createdAt = 2;
    storage.map.set(PROJECTS_STORAGE_KEY, JSON.stringify(raw));
    expect(listProjects(storage).map((p) => p.id)).toEqual(["new", "old"]);
  });
});
