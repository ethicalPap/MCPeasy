import type {
  CreateProjectResponse,
  DeleteProjectDocResponse,
  ProjectInfo,
  ReadProjectDocResponse,
  SaveDocToProjectResponse,
} from "../../../shared/ipc";
import { validateProjectName } from "../../../shared/projectName";

// Browser-mode project library (user decision: plain-browser mode is a DEV
// convenience, but it should have full feature parity). Projects live in
// localStorage under one key; this store is per-browser and NOT shared with
// the desktop app's filesystem library. The name rules come from the same
// shared/projectName module main uses, so a project name valid in one mode
// is valid in the other.
//
// Storage is injected (same pattern as theme.ts) so tests can run under Node
// with a Map-backed fake instead of a DOM Storage.

export const PROJECTS_STORAGE_KEY = "mcpeasy.projects";

/** Structural subset of DOM Storage — keeps this module free of lib.dom so
 * the Node-side tests can typecheck it. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface StoredServer {
  text: string;
  updatedAt: number;
}

interface StoredProject {
  name: string;
  createdAt: number;
  servers: Record<string, StoredServer>;
}

type StoredLibrary = Record<string, StoredProject>;

// Synthetic path scheme so the path-based McpeasyApi contract works without a
// filesystem. ids and file names are slugs (no "/" survives slugify), so the
// two path segments parse unambiguously.
const PATH_PREFIX = "browser://projects/";

function serverPath(projectId: string, fileName: string): string {
  return `${PATH_PREFIX}${projectId}/servers/${fileName}`;
}

function readLibrary(storage: KeyValueStorage): StoredLibrary {
  // Stored JSON may be stale or hand-edited; anything unreadable degrades to
  // an empty library rather than wedging the page (dev data, not user docs).
  try {
    const raw: unknown = JSON.parse(storage.getItem(PROJECTS_STORAGE_KEY) ?? "{}");
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    const library: StoredLibrary = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === null || typeof value !== "object") continue;
      const { name, createdAt, servers } = value as Partial<StoredProject>;
      if (typeof name !== "string") continue;
      const cleanServers: Record<string, StoredServer> = {};
      if (servers !== null && typeof servers === "object") {
        for (const [fileName, server] of Object.entries(servers as Record<string, unknown>)) {
          if (server === null || typeof server !== "object") continue;
          const { text, updatedAt } = server as Partial<StoredServer>;
          if (typeof text !== "string") continue;
          cleanServers[fileName] = { text, updatedAt: typeof updatedAt === "number" ? updatedAt : 0 };
        }
      }
      library[id] = {
        name,
        createdAt: typeof createdAt === "number" ? createdAt : 0,
        servers: cleanServers,
      };
    }
    return library;
  } catch {
    return {};
  }
}

function writeLibrary(storage: KeyValueStorage, library: StoredLibrary): void {
  storage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(library));
}

export function listProjects(storage: KeyValueStorage): ProjectInfo[] {
  const library = readLibrary(storage);
  const projects: ProjectInfo[] = Object.entries(library).map(([id, project]) => ({
    id,
    name: project.name,
    createdAt: project.createdAt,
    servers: Object.entries(project.servers)
      .map(([fileName, server]) => ({
        path: serverPath(id, fileName),
        fileName,
        updatedAt: server.updatedAt,
      }))
      // Most recently saved first — mirrors the desktop library's ordering.
      .sort((a, b) => b.updatedAt - a.updatedAt),
  }));
  projects.sort((a, b) => b.createdAt - a.createdAt);
  return projects;
}

export function createProject(storage: KeyValueStorage, rawName: unknown): CreateProjectResponse {
  const validated = validateProjectName(rawName);
  if (typeof validated !== "string") return { ok: false, error: validated.error };
  const id = validated;
  const library = readLibrary(storage);
  // Same duplicate semantics (and near-identical message) as the desktop
  // library's EEXIST branch.
  if (library[id] !== undefined) return { ok: false, error: `a project named "${id}" already exists` };
  const createdAt = Date.now();
  const name = typeof rawName === "string" ? rawName.trim() : id;
  library[id] = { name, createdAt, servers: {} };
  writeLibrary(storage, library);
  return { ok: true, project: { id, name, createdAt, servers: [] } };
}

export function saveDocToProject(
  storage: KeyValueStorage,
  projectId: unknown,
  serverName: unknown,
  text: unknown,
): SaveDocToProjectResponse {
  if (typeof text !== "string") return { ok: false, error: "invalid save request" };
  // Same strictness as main: the id must already BE a slug (it came from
  // listProjects); anything else is treated as unknown, not re-slugged.
  const idResult = validateProjectName(projectId);
  if (typeof idResult !== "string" || idResult !== projectId) return { ok: false, error: "unknown project" };
  const library = readLibrary(storage);
  const project = library[idResult];
  if (project === undefined) return { ok: false, error: "unknown project" };
  const fileResult = validateProjectName(serverName);
  const fileName = `${typeof fileResult === "string" ? fileResult : "server"}.json`;
  // Same-name saves overwrite by design, matching the desktop library.
  project.servers[fileName] = { text, updatedAt: Date.now() };
  writeLibrary(storage, library);
  return { ok: true, path: serverPath(idResult, fileName) };
}

export function readProjectDoc(storage: KeyValueStorage, rawPath: unknown): ReadProjectDocResponse {
  if (typeof rawPath !== "string" || !rawPath.startsWith(PATH_PREFIX)) return null;
  const segments = rawPath.slice(PATH_PREFIX.length).split("/");
  // Exactly <id>/servers/<fileName>; the scheme itself is the library-root
  // boundary (nothing outside localStorage is reachable through it).
  if (segments.length !== 3 || segments[1] !== "servers") return null;
  const [projectId, , fileName] = segments;
  const server = readLibrary(storage)[projectId!]?.servers[fileName!];
  if (server === undefined) return null;
  return { path: rawPath, text: server.text };
}

/** Remove a single server entry from the localStorage library. */
export function deleteProjectDoc(
  storage: KeyValueStorage,
  projectId: unknown,
  rawPath: unknown,
): DeleteProjectDocResponse {
  if (typeof rawPath !== "string" || !rawPath.startsWith(PATH_PREFIX)) {
    return { ok: false, error: "invalid path" };
  }
  const segments = rawPath.slice(PATH_PREFIX.length).split("/");
  if (segments.length !== 3 || segments[1] !== "servers") {
    return { ok: false, error: "invalid path" };
  }
  const [pathProjectId, , fileName] = segments;
  if (typeof projectId !== "string" || pathProjectId !== projectId) {
    return { ok: false, error: "unknown project" };
  }
  const library = readLibrary(storage);
  const project = library[projectId];
  if (project === undefined) return { ok: false, error: "unknown project" };
  // Already absent is not an error — mirrors the desktop library's ENOENT handling.
  delete project.servers[fileName!];
  writeLibrary(storage, library);
  return { ok: true };
}
