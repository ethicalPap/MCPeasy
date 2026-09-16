import { create } from "zustand";
import {
  GRAPH_DOC_VERSION,
  lintGraphDoc,
  migrateGraphDoc,
  parseGraphDocShape,
  validateGraphDoc,
  type GraphDoc,
  type GraphNode,
  type LintReport,
  type ServerConfig,
  type ValidationIssue,
} from "@mcpeasy/schema";
import {
  MCP_ROOT_NODE_ID,
  addConnectedNode,
  addParallelBranch,
  computeLayout,
  disconnectEdge,
  fillMissingLayout,
  removeConnectedNode,
  serializeDocText,
  type LayoutDirection,
  type NodeKind,
} from "./graph";
import { getApi } from "./browser/api";
import { generatePythonProject } from "./export/python";
import { generateTypescriptProject } from "./export/typescript";
import type { ExportLanguage } from "./export/types";

// Doc-as-store (design decision from the build plan): the GraphDoc IS the
// state; canvas nodes/edges are derived views of it. Every mutation goes
// through applyDoc so lint + validation + dirty stay coherent — bypassing it
// (setState({doc}) directly) would silently desync the badges.

/** The workspace the whole app is working inside (workspaces drive the tool:
 * the startup chooser sets one before any editing can happen). */
export interface ActiveProject {
  id: string;
  name: string;
}

export interface EditorState {
  doc: GraphDoc;
  /** Increments on New/Open. Panels with buffered text fields key off this
   * so switching documents remounts them (fresh buffers from the new doc). */
  docId: number;
  /** null until the startup chooser picks/creates one; the App renders the
   * chooser instead of the shell while null, so the editor never runs
   * workspace-less. */
  project: ActiveProject | null;
  filePath: string | null;
  dirty: boolean;
  selectedId: string | null;
  lint: LintReport;
  /** Graph-level validation issues (cycles/merges/dangling refs) keyed for badges. */
  validation: ValidationIssue[];
  /** Non-null while the doc on disk could not even be shape-parsed. */
  loadError: string | null;

  newDoc(): void;
  /** Enter a workspace (startup chooser or switch): resets to a fresh unsaved
   * server so nothing from the previous workspace leaks across. */
  openProject(project: ActiveProject): void;
  /** Leave the current workspace and return to the startup chooser. The
   * caller owns the dirty-confirmation; this just resets. */
  closeProject(): void;
  select(id: string | null): void;
  /** Node creation is connection-driven: create and wire in one transaction
   * so the visual builder cannot manufacture floating orphan blocks. */
  addConnectedNode(sourceId: string, kind: NodeKind): void;
  addParallelBranch(parallelId: string, kind: Exclude<NodeKind, "tool" | "return">): void;
  deleteNode(id: string): void;
  updateNode(id: string, node: GraphNode): void;
  updateServer(server: ServerConfig): void;
  /** Advanced mode: replace the whole doc from edited JSON text. Same
   * migrate → shape-parse pipeline as loading, but keeps the current
   * file association and marks dirty (it IS an edit, not a load). */
  applyDocText(text: string): { ok: true } | { ok: false; error: string };
  /** Save the current doc into the ACTIVE workspace (no OS dialog) — the only
   * doc save in the app now; Ctrl+S and File → Save land here. The result
   * travels back so callers can show inline feedback. */
  saveToProject(): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Open a server from the active workspace by path (from listProjects). */
  openProjectDoc(path: string): Promise<void>;
  /** Export the current server as a runnable project zip in the given
   * language. null = user cancelled the save dialog (not an error). */
  exportProject(language: ExportLanguage): Promise<{ ok: true; path: string } | { ok: false; error: string } | null>;
  moveNode(id: string, pos: { x: number; y: number }): void;
  /** Recompute layout for every node using a fixed algorithm and mark dirty. */
  applyLayout(direction: LayoutDirection): void;
  connect(sourceId: string, targetId: string): void;
  disconnectFrom(sourceId: string): void;
  dismissLoadError(): void;
}

function emptyDoc(): GraphDoc {
  return {
    version: GRAPH_DOC_VERSION,
    server: {
      name: "my-server",
      description: "",
      creator: "",
      version: "0.1.0",
      transport: "stdio",
      auth: { type: "none" },
      env: [],
    },
    nodes: {},
    edges: [],
    layout: { [MCP_ROOT_NODE_ID]: { x: 80, y: 60 } },
  };
}

/** Push the dirty flag to main so the close-window guard sees it (browser fallback no-ops). */
function syncDirty(dirty: boolean): void {
  getApi().setDirty(dirty);
}

/** Write-through: persist the current workspace + active server path so the
 * next app launch restores both. Call after any action that changes which
 * workspace or server doc is "current" (open project, open doc, save-as,
 * new doc, close project). */
function persistWorkspaceRef(
  project: { id: string; name: string } | null,
  serverPath?: string | null,
): void {
  if (project === null) {
    void getApi().setLastWorkspace(null).catch(() => undefined);
  } else {
    void getApi()
      .setLastWorkspace({ id: project.id, name: project.name, serverPath: serverPath ?? null })
      .catch(() => undefined);
  }
}

export const useEditor = create<EditorState>((set, get) => {
  // Lint + graph validation on every change, synchronously. The build plan
  // sketched a lint WORKER for the web app; in the desktop renderer both
  // passes are linear walks over ≤500 nodes (LIMITS.maxNodes), far below
  // frame budget, so a worker would only add async badge lag. Revisit if a
  // future rule stops being linear.
  function applyDoc(doc: GraphDoc, extra?: Partial<EditorState>): void {
    const validation = validateGraphDoc(doc);
    set({
      doc,
      lint: lintGraphDoc(doc),
      validation: validation.ok ? [] : validation.issues,
      dirty: true,
      loadError: null,
      ...extra,
    });
    syncDirty(get().dirty);
  }

  // The one load pipeline (project library today; keep any future open path
  // on it too): parse → migrate → shape-parse → fillMissingLayout.
  // Shape-only parse on
  // open is deliberate — a doc with cycles or dangling refs must still open
  // so the user can fix it visually; those problems surface as validation
  // badges, not a refusal. Newer-version docs are refused loudly (no lossy
  // downgrade); migrateGraphDoc's error text already says "upgrade mcpeasy".
  function loadPicked(picked: { path: string; text: string }): void {
    let raw: unknown;
    try {
      raw = JSON.parse(picked.text);
    } catch {
      set({ loadError: `${picked.path} is not valid JSON` });
      return;
    }
    let migrated: unknown;
    try {
      migrated = migrateGraphDoc(raw);
    } catch (cause) {
      set({ loadError: cause instanceof Error ? cause.message : "migration failed" });
      return;
    }
    const shape = parseGraphDocShape(migrated);
    if (!shape.ok) {
      const detail = shape.issues.map((i) => `${i.path}: ${i.message}`).join("\n");
      set({ loadError: `not a graph doc:\n${detail}` });
      return;
    }
    const doc = { ...shape.doc, layout: fillMissingLayout(shape.doc) };
    const validation = validateGraphDoc(doc);
    set({
      doc,
      docId: get().docId + 1,
      filePath: picked.path,
      dirty: false,
      selectedId: null,
      lint: lintGraphDoc(doc),
      validation: validation.ok ? [] : validation.issues,
      loadError: null,
    });
    syncDirty(false);
  }

  const initial = emptyDoc();
  return {
    doc: initial,
    docId: 0,
    project: null,
    filePath: null,
    dirty: false,
    selectedId: null,
    lint: lintGraphDoc(initial),
    validation: [],
    loadError: null,

    newDoc() {
      const doc = emptyDoc();
      set({
        doc,
        docId: get().docId + 1,
        filePath: null,
        dirty: false,
        selectedId: null,
        lint: lintGraphDoc(doc),
        validation: [],
        loadError: null,
      });
      syncDirty(false);
      // Clear the persisted server path (new blank doc has no file yet).
      const { project } = get();
      if (project) persistWorkspaceRef(project, null);
    },

    openProject(project) {
      // Same reset as newDoc plus the workspace switch: entering a workspace
      // must never carry the previous workspace's doc or selection along.
      const doc = emptyDoc();
      set({
        project,
        doc,
        docId: get().docId + 1,
        filePath: null,
        dirty: false,
        selectedId: null,
        lint: lintGraphDoc(doc),
        validation: [],
        loadError: null,
      });
      syncDirty(false);
      // Persist workspace (no server yet — openProjectDoc will add it).
      persistWorkspaceRef(project, null);
    },

    closeProject() {
      const doc = emptyDoc();
      set({
        project: null,
        doc,
        docId: get().docId + 1,
        filePath: null,
        dirty: false,
        selectedId: null,
        lint: lintGraphDoc(doc),
        validation: [],
        loadError: null,
      });
      syncDirty(false);
      // Clear the persisted reference so the next launch shows the chooser.
      persistWorkspaceRef(null);
    },

    async openProjectDoc(path) {
      const picked = await getApi().readProjectDoc(path);
      if (!picked) {
        // The file vanished between listing and click (deleted externally).
        set({ loadError: `${path} is no longer in the workspace library` });
        return;
      }
      loadPicked(picked);
      // Persist the server path so the next launch restores this doc.
      const { project } = get();
      if (project) persistWorkspaceRef(project, picked.path);
    },

    async saveToProject() {
      const { doc, project } = get();
      // Unreachable through the UI (the shell only renders inside a workspace),
      // but the guard keeps a stray shortcut from writing nowhere silently.
      if (project === null) return { ok: false as const, error: "no workspace is open" };
      const res = await getApi().saveDocToProject({
        projectId: project.id,
        serverName: doc.server.name || "server",
        text: serializeDocText(doc),
      });
      if (!res.ok) return res;
      // The workspace copy is the working file: further Ctrl+S saves overwrite
      // it, and the title bar shows its name.
      set({ filePath: res.path, dirty: false });
      syncDirty(false);
      // Persist the (possibly new) server path for next-launch restore.
      persistWorkspaceRef(project, res.path);
      return { ok: true as const };
    },

    async exportProject(language) {
      const { doc } = get();
      // The embedded graph.json uses the same serializer as Save, so an
      // exported project's graph re-opens in MCPeasy byte-identically.
      const docJson = serializeDocText(doc);
      const generated =
        language === "typescript"
          ? generateTypescriptProject(doc, docJson)
          : generatePythonProject(doc, docJson);
      return getApi().exportZip({
        files: generated.files,
        suggestedName: `${generated.slug}-${language}.zip`,
      });
    },

    select(id) {
      set({ selectedId: id });
    },

    addConnectedNode(sourceId, kind) {
      const result = addConnectedNode(get().doc, sourceId, kind);
      if (!result) return;
      // Adding a local/custom operation declares graph intent, but execution
      // remains host-gated and first-run-confirmed in main.
      const doc = kind === "command" || kind === "script" || kind === "code"
        ? { ...result.doc, server: { ...result.doc.server, execution: { allowLocal: true } } }
        : result.doc;
      applyDoc(doc, { selectedId: result.id });
    },

    addParallelBranch(parallelId, kind) {
      const result = addParallelBranch(get().doc, parallelId, kind);
      if (!result) return;
      const doc = kind === "command" || kind === "script" || kind === "code"
        ? { ...result.doc, server: { ...result.doc.server, execution: { allowLocal: true } } }
        : result.doc;
      applyDoc(doc, { selectedId: result.id });
    },

    deleteNode(id) {
      const { doc, selectedId } = get();
      if (id === MCP_ROOT_NODE_ID) return;
      const node = doc.nodes[id];
      if (!node) return;
      // Confirm here (not in the panel button) so the canvas Delete key gets
      // the same friction: there is no undo, and removing a tool/parallel
      // cascades to every execution block it owns (see removeConnectedNode).
      const label = node.kind === "tool" && node.name ? `tool "${node.name}"` : `this ${node.kind} block`;
      const cascades = node.kind === "tool" || node.kind === "parallel";
      const warning = cascades
        ? `Delete ${label}? All blocks it owns will be deleted too. This cannot be undone.`
        : `Delete ${label}? This cannot be undone.`;
      if (!window.confirm(warning)) return;
      applyDoc(removeConnectedNode(doc, id), selectedId === id ? { selectedId: null } : undefined);
    },

    updateNode(id, node) {
      const { doc } = get();
      applyDoc({ ...doc, nodes: { ...doc.nodes, [id]: node } });
    },

    updateServer(server) {
      const { doc } = get();
      applyDoc({ ...doc, server });
    },

    applyDocText(text) {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (cause) {
        return { ok: false, error: `not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
      let migrated: unknown;
      try {
        migrated = migrateGraphDoc(raw);
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : "migration failed" };
      }
      const shape = parseGraphDocShape(migrated);
      if (!shape.ok) {
        return { ok: false, error: shape.issues.map((i) => `${i.path}: ${i.message}`).join("\n") };
      }
      const doc = { ...shape.doc, layout: fillMissingLayout(shape.doc) };
      // Selection may point at a node the edit removed; clear it then.
      const keepSelection = get().selectedId !== null && doc.nodes[get().selectedId as string] !== undefined;
      applyDoc(doc, keepSelection ? undefined : { selectedId: null });
      return { ok: true };
    },

    moveNode(id, pos) {
      // Layout-only change: skip lint/validation recompute (the engine never
      // reads layout). The derived root id is intentionally accepted even
      // though it is absent from doc.nodes; its saved position belongs to the
      // editor view just like every block position.
      const { doc, dirty } = get();
      if (id !== MCP_ROOT_NODE_ID && doc.nodes[id] === undefined) return;
      set({ doc: { ...doc, layout: { ...(doc.layout ?? {}), [id]: pos } }, dirty: true });
      if (!dirty) syncDirty(true);
    },

    applyLayout(direction) {
      const { doc, dirty } = get();
      const layout = computeLayout(doc, direction);
      set({ doc: { ...doc, layout }, dirty: true });
      if (!dirty) syncDirty(true);
    },

    connect(sourceId, targetId) {
      const { doc } = get();
      const source = doc.nodes[sourceId];
      const target = doc.nodes[targetId];
      if (!source || !target) return;
      // Chains contain only exec nodes; a tool can never be a target. The
      // canvas also blocks this via handle types — this guard is the truth,
      // the handles are the affordance.
      if (target.kind === "tool") return;
      let updated: GraphNode;
      if (source.kind === "tool") updated = { ...source, entry: targetId };
      else if (source.kind !== "return") updated = { ...source, next: targetId };
      else return; // return nodes terminate; no outgoing edge
      applyDoc({ ...doc, nodes: { ...doc.nodes, [sourceId]: updated } });
    },

    disconnectFrom(sourceId) {
      const { doc } = get();
      // Canvas now supplies the full derived edge id so parallel branch
      // entries can be disconnected independently of the join continuation.
      const edgeId = sourceId.startsWith("e_") ? sourceId : `e_${sourceId}`;
      applyDoc(disconnectEdge(doc, edgeId));
    },

    dismissLoadError() {
      set({ loadError: null });
    },
  };
});

/** Problem badge counts per node: lint plus graph-level validation issues
 * (whose paths start with the node id, e.g. "tool_1.entry" or "tool_1"). */
export function problemsFor(state: EditorState, nodeId: string): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const p of state.lint[nodeId] ?? []) {
    if (p.severity === "error") errors += 1;
    else warnings += 1;
  }
  for (const issue of state.validation) {
    if (issue.path === nodeId || issue.path.startsWith(`${nodeId}.`)) errors += 1;
  }
  return { errors, warnings };
}
