import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ProjectInfo, ProjectServerEntry } from "../../shared/ipc";
import { getApi } from "./browser/api";
import { useEditor } from "./store";

// The WORKSPACE HOME: workspaces drive the tool, so this page shows the
// ACTIVE workspace — its saved servers as tiles, a "New server" tile, a
// "Save current server" action, and "Switch workspace" back to the startup
// chooser. Creation/selection of workspaces lives in the startup chooser
// (ProjectStartPage), not here: one concern per surface.
//
// All state lives in the backing store (main's filesystem library in the
// desktop app, localStorage in plain-browser dev mode); this component only
// mirrors it, so every mutation ends with a refresh() re-read instead of
// optimistic local edits that could drift from the stored truth.

function formatWhen(ms: number): string {
  if (ms <= 0) return "";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Delete-confirmation dialog ────────────────────────────────────────────
// Destructive action: the user must type the exact server name to confirm.
// This prevents accidental clicks and makes the intent unambiguous.

function DeleteConfirmDialog({
  server,
  onConfirmed,
  onCancel,
}: {
  server: ProjectServerEntry;
  onConfirmed: () => void;
  onCancel: () => void;
}) {
  const displayName = server.fileName.replace(/\.json$/, "");
  const [typed, setTyped] = useState("");
  const matches = typed === displayName;

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (matches) onConfirmed();
  };

  return (
    // Same backdrop pattern as HelpDialog — click outside dismisses.
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
        <header className="confirm-dialog__header">
          <h2 id="delete-dialog-title">Delete server</h2>
          <button className="panel-icon-btn" type="button" onClick={onCancel} aria-label="Cancel deletion" title="Close">✕</button>
        </header>
        <div className="confirm-dialog__body">
          <p>
            This will permanently delete <strong>{displayName}</strong>. This action cannot be undone.
          </p>
          <p className="confirm-dialog__prompt">
            Type <strong>{displayName}</strong> to confirm:
          </p>
          <form onSubmit={submit}>
            <input
              autoFocus
              className="confirm-dialog__input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={displayName}
              aria-label={`Type "${displayName}" to confirm deletion`}
              spellCheck={false}
              autoComplete="off"
            />
            <div className="confirm-dialog__actions">
              <button type="button" className="confirm-dialog__cancel" onClick={onCancel}>
                Cancel
              </button>
              <button
                type="submit"
                className="confirm-dialog__delete"
                disabled={!matches}
              >
                Delete server
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}

export function ProjectsPage({
  onOpenServer,
  onSwitchProject,
}: {
  /** Navigate to the builder after a server (or a fresh one) is opened. */
  onOpenServer: () => void;
  /** Return to the startup chooser (App owns the dirty confirmation). */
  onSwitchProject: () => void;
}) {
  const project = useEditor((s) => s.project);
  const saveToProject = useEditor((s) => s.saveToProject);
  const openProjectDoc = useEditor((s) => s.openProjectDoc);
  const newDoc = useEditor((s) => s.newDoc);
  const serverName = useEditor((s) => s.doc.server.name);
  const filePath = useEditor((s) => s.filePath);
  const dirty = useEditor((s) => s.dirty);

  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // The server entry pending deletion; non-null opens the confirm dialog.
  const [deleting, setDeleting] = useState<ProjectServerEntry | null>(null);

  const refresh = useCallback(async () => {
    if (project === null) return; // shell never renders this page without one
    const all = await getApi().listProjects();
    setInfo(all.find((p) => p.id === project.id) ?? null);
  }, [project]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveHere = async (): Promise<void> => {
    const res = await saveToProject();
    setNotice(
      res.ok
        ? { kind: "ok", text: `Saved "${serverName || "server"}"` }
        : { kind: "error", text: res.error },
    );
    if (res.ok) await refresh();
  };

  const openServer = async (path: string): Promise<void> => {
    await openProjectDoc(path);
    // Jump to the canvas so the click visibly did something; a load error
    // surfaces there as the builder's load-error banner.
    onOpenServer();
  };

  const confirmDelete = async (): Promise<void> => {
    if (deleting === null || project === null) return;
    const res = await getApi().deleteProjectDoc({
      projectId: project.id,
      serverPath: deleting.path,
    });
    setDeleting(null);
    if (res.ok) {
      // If the deleted server is the one currently open in the builder,
      // clear the editor so the user doesn't keep editing a ghost file.
      if (filePath === deleting.path) newDoc();
      setNotice({ kind: "ok", text: `Deleted "${deleting.fileName.replace(/\.json$/, "")}"` });
      await refresh();
    } else {
      setNotice({ kind: "error", text: res.error });
    }
  };

  if (project === null) return null;

  return (
    <div className="projects-page">
      <header className="project-home__header">
        <div>
          <h2 className="project-home__name">{project.name}</h2>
          <p className="muted">
            {info === null ? "" : `${info.servers.length} server${info.servers.length === 1 ? "" : "s"} saved`}
          </p>
        </div>
        <div className="project-home__actions">
          <button type="button" className="project-card__save" onClick={() => void saveHere()}>
            Save current server{dirty ? " •" : ""}
          </button>
          <button type="button" className="project-home__switch" onClick={onSwitchProject}>
            Switch workspace
          </button>
        </div>
      </header>

      {notice !== null && (
        <p className={`projects-notice${notice.kind === "error" ? " projects-notice--error" : ""}`} role="status">
          {notice.text}
        </p>
      )}

      <div className="start-tiles">
        {/* New server first: the primary forward action of a project home. */}
        <button
          type="button"
          className="start-tile"
          onClick={() => {
            newDoc();
            onOpenServer();
          }}
        >
          <span className="start-tile__logo start-tile__logo--primary">
            <svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="4" />
              <path d="M12 8v8M8 12h8" />
            </svg>
          </span>
          <span className="start-tile__label">New server</span>
        </button>

        {(info?.servers ?? []).map((server) => {
          const name = server.fileName.replace(/\.json$/, "");
          const isOpen = filePath === server.path;
          return (
            <div key={server.path} className="server-tile-wrapper">
              <button
                type="button"
                className={`start-tile${isOpen ? " start-tile--current" : ""}`}
                onClick={() => void openServer(server.path)}
                title={server.path}
              >
                <span className="start-tile__logo">
                  {/* Server glyph: stacked node card with ports. */}
                  <svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="7" rx="2" />
                    <rect x="3" y="13" width="18" height="7" rx="2" />
                    <path d="M6.5 7.5h.01M6.5 16.5h.01" />
                  </svg>
                </span>
                <span className="start-tile__label">
                  {name}
                  <small className="start-tile__hint">
                    {isOpen ? "open now" : formatWhen(server.updatedAt)}
                  </small>
                </span>
              </button>
              {/* Delete button — sits in the top-right corner of the tile,
                  visible on hover. stopPropagation prevents the tile's own
                  click (open server) from firing. */}
              <button
                type="button"
                className="server-tile__delete"
                title={`Delete ${name}`}
                aria-label={`Delete ${name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleting(server);
                }}
              >
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <path d="M10 11v6M14 11v6" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>

      {info !== null && info.servers.length === 0 && (
        <p className="muted">No servers saved yet. Build one on the canvas, then save it here.</p>
      )}

      {deleting !== null && (
        <DeleteConfirmDialog
          server={deleting}
          onConfirmed={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
