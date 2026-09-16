import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProject,
  listProjects,
  readProjectDoc,
  saveDocToProject,
  slugify,
  validateProjectName,
} from "../src/main/projects";

// Real-tmpdir tests (no fs mocks): the module's whole job is filesystem
// behavior — EEXIST collisions, escape prevention, listing order — and a
// mock would just restate the implementation.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcpeasy-projects-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("slugify / validateProjectName", () => {
  it("strips Windows-reserved characters and trailing dots", () => {
    expect(slugify('we/ird: "name"?.')).toBe("we-ird- -name--");
    expect(slugify("plain name")).toBe("plain name");
  });

  it("rejects names that slug to nothing", () => {
    expect(validateProjectName("...")).toEqual({ error: "project name needs at least one usable character" });
    expect(validateProjectName(42)).toEqual({ error: "project name must be a string" });
  });
});

describe("project library", () => {
  it("creates, lists and refuses duplicate projects", async () => {
    const created = await createProject(root, "My Project");
    expect(created.ok).toBe(true);
    const dup = await createProject(root, "My Project");
    expect(dup).toEqual({ ok: false, error: 'a project named "My Project" already exists' });

    const projects = await listProjects(root);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ id: "My Project", name: "My Project", servers: [] });
  });

  it("lists zero projects when the root does not exist yet", async () => {
    expect(await listProjects(join(root, "never-created"))).toEqual([]);
  });

  it("saves a doc into a project and lists it as a server", async () => {
    await createProject(root, "p1");
    const saved = await saveDocToProject(root, "p1", "echo-server", '{"version":1}');
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(await readFile(saved.path, "utf8")).toBe('{"version":1}');
    }
    const [project] = await listProjects(root);
    expect(project?.servers.map((s) => s.fileName)).toEqual(["echo-server.json"]);
  });

  it("overwrites on same-name save instead of duplicating", async () => {
    await createProject(root, "p1");
    await saveDocToProject(root, "p1", "srv", "one");
    await saveDocToProject(root, "p1", "srv", "two");
    const [project] = await listProjects(root);
    expect(project?.servers).toHaveLength(1);
    const doc = await readProjectDoc(root, project!.servers[0]!.path);
    expect(doc?.text).toBe("two");
  });

  it("rejects saves into unknown or path-traversal project ids", async () => {
    expect(await saveDocToProject(root, "nope", "srv", "{}")).toEqual({ ok: false, error: "unknown project" });
    expect(await saveDocToProject(root, "../escape", "srv", "{}")).toEqual({ ok: false, error: "unknown project" });
  });

  it("refuses to read paths outside the library root", async () => {
    expect(await readProjectDoc(root, join(root, "..", "outside.json"))).toBeNull();
    expect(await readProjectDoc(root, 123 as unknown as string)).toBeNull();
  });
});
