import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ProjectInfo, ProjectServerEntry } from "../shared/ipc";

// App-managed project library (user decision): projects live under the app's
// userData folder, not user-picked directories, so create/save/open need no
// OS dialogs. Layout:
//   <projectsRoot>/<id>/project.json          { name, createdAt }
//   <projectsRoot>/<id>/servers/<name>.json   graph docs
// The filesystem IS the store — no index file to drift out of sync; listing
// re-reads the tree every time (a few dozen stat calls, well under dialog
// latency the old flow already paid).

// Slugging/validation moved to shared/projectName so the browser-mode
// localStorage library applies the identical rules; re-exported to keep this
// module the single import for filesystem-library consumers and tests.
import { validateProjectName } from "../shared/projectName";

export { slugify, validateProjectName, type ProjectValidationError } from "../shared/projectName";

async function readProjectMeta(dir: string): Promise<{ name: string; createdAt: number } | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(dir, "project.json"), "utf8"));
    if (raw !== null && typeof raw === "object" && typeof (raw as { name?: unknown }).name === "string") {
      const createdAt = (raw as { createdAt?: unknown }).createdAt;
      return { name: (raw as { name: string }).name, createdAt: typeof createdAt === "number" ? createdAt : 0 };
    }
  } catch {
    // Missing/corrupt project.json: fall through — the folder still counts as
    // a project (its servers are the user's data; metadata is recoverable).
  }
  return null;
}

async function listServers(dir: string): Promise<ProjectServerEntry[]> {
  const serversDir = join(dir, "servers");
  let names: string[];
  try {
    names = await readdir(serversDir);
  } catch {
    return []; // no servers saved yet
  }
  const entries: ProjectServerEntry[] = [];
  for (const fileName of names) {
    if (!fileName.endsWith(".json")) continue;
    const path = join(serversDir, fileName);
    try {
      const info = await stat(path);
      if (info.isFile()) entries.push({ path, fileName, updatedAt: info.mtimeMs });
    } catch {
      // Raced deletion; skip rather than fail the whole listing.
    }
  }
  // Most recently saved first — the list doubles as "recent work".
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return entries;
}

export async function listProjects(projectsRoot: string): Promise<ProjectInfo[]> {
  let ids: string[];
  try {
    ids = await readdir(projectsRoot);
  } catch {
    return []; // root not created yet = zero projects, not an error
  }
  const projects: ProjectInfo[] = [];
  for (const id of ids) {
    const dir = join(projectsRoot, id);
    try {
      if (!(await stat(dir)).isDirectory()) continue;
    } catch {
      continue;
    }
    const meta = await readProjectMeta(dir);
    projects.push({
      id,
      name: meta?.name ?? id,
      createdAt: meta?.createdAt ?? 0,
      servers: await listServers(dir),
    });
  }
  projects.sort((a, b) => b.createdAt - a.createdAt);
  return projects;
}

export async function createProject(
  projectsRoot: string,
  rawName: unknown,
): Promise<{ ok: true; project: ProjectInfo } | { ok: false; error: string }> {
  const validated = validateProjectName(rawName);
  if (typeof validated !== "string") return { ok: false, error: validated.error };
  const id = validated;
  const dir = join(projectsRoot, id);
  try {
    // recursive:true makes the root on first use; the inner mkdir without it
    // is the existence check — EEXIST means a project already claimed the id.
    await mkdir(projectsRoot, { recursive: true });
    await mkdir(dir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      return { ok: false, error: `a project named "${id}" already exists` };
    }
    return { ok: false, error: cause instanceof Error ? cause.message : "could not create project" };
  }
  const createdAt = Date.now();
  // Display name keeps the user's exact (trimmed) text; the id is its slug.
  const name = typeof rawName === "string" ? rawName.trim() : id;
  await writeFile(join(dir, "project.json"), JSON.stringify({ name, createdAt }, null, 2), "utf8");
  return { ok: true, project: { id, name, createdAt, servers: [] } };
}

export async function saveDocToProject(
  projectsRoot: string,
  projectId: unknown,
  serverName: unknown,
  text: unknown,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (typeof text !== "string") return { ok: false, error: "invalid save request" };
  // projectId came from listProjects but the renderer is untrusted: re-slug so
  // "..\\evil" can never escape the library root.
  const idResult = validateProjectName(projectId);
  if (typeof idResult !== "string" || idResult !== projectId) {
    return { ok: false, error: "unknown project" };
  }
  const dir = join(projectsRoot, idResult);
  try {
    if (!(await stat(dir)).isDirectory()) return { ok: false, error: "unknown project" };
  } catch {
    return { ok: false, error: "unknown project" };
  }
  const fileResult = validateProjectName(serverName);
  const fileName = `${typeof fileResult === "string" ? fileResult : "server"}.json`;
  const serversDir = join(dir, "servers");
  await mkdir(serversDir, { recursive: true });
  const path = join(serversDir, fileName);
  // Same-name saves overwrite by design: "save my server into the project"
  // means updating it, exactly like Ctrl+S on a file path.
  await writeFile(path, text, "utf8");
  return { ok: true, path };
}

/** Only paths inside the library root are readable through this channel; the
 * generic file dialog (doc:open) remains the road to everything else. */
export async function readProjectDoc(
  projectsRoot: string,
  rawPath: unknown,
): Promise<{ path: string; text: string } | null> {
  if (typeof rawPath !== "string") return null;
  const path = resolve(rawPath);
  const root = resolve(projectsRoot) + sep;
  if (!path.startsWith(root)) return null;
  try {
    return { path, text: await readFile(path, "utf8") };
  } catch {
    return null; // deleted outside the app; list refresh will reflect it
  }
}

/** Remove a single server file from the project library. The path must
 *  resolve inside projectsRoot (same path-jail as readProjectDoc) to prevent
 *  an untrusted renderer from deleting arbitrary files. */
export async function deleteProjectDoc(
  projectsRoot: string,
  projectId: unknown,
  rawPath: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof rawPath !== "string") return { ok: false, error: "invalid path" };
  // Validate the project id — renderer is untrusted.
  const idResult = validateProjectName(projectId);
  if (typeof idResult !== "string" || idResult !== projectId) {
    return { ok: false, error: "unknown project" };
  }
  // Resolve and jail the path: it must live under <root>/<id>/servers/.
  const path = resolve(rawPath);
  const serversRoot = resolve(join(projectsRoot, idResult, "servers")) + sep;
  if (!path.startsWith(serversRoot)) return { ok: false, error: "path outside project library" };
  try {
    await unlink(path);
    return { ok: true };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      // Already gone (concurrent deletion or external removal) — not an error
      // from the user's perspective; a list refresh will reflect the truth.
      return { ok: true };
    }
    return { ok: false, error: cause instanceof Error ? cause.message : "could not delete server" };
  }
}
