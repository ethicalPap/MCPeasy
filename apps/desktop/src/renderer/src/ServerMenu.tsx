import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectServerEntry } from "../../shared/ipc";
import { getApi } from "./browser/api";
import { useEditor } from "./store";
import {
  currentServerLabel,
  decideSwitch,
  serverChoices,
  type ServerChoice,
} from "./shared/serverSwitch";

// The builder's server switcher: which saved server the canvas is editing,
// and a menu to change it without leaving the page.
//
// Built on the same popup mechanics as the title bar's File/Help menus
// (TitlebarMenus.tsx:56-69) — outside-pointerdown and Escape both close —
// rather than a native <select>, because the rows carry a secondary "last
// saved" line and two trailing actions that a <select> cannot render.
//
// Like the workspace home, this mirrors the stored library instead of caching
// it: every open re-reads listProjects, so a server saved, renamed or deleted
// elsewhere in this session can never linger in the menu.

function formatWhen(ms: number): string {
  if (ms <= 0) return "";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** What the dialog is guarding: opening another saved server, or starting a
 *  fresh one. Both replace the canvas, so both deserve the same gate — a menu
 *  that protected one and not the other would be worse than protecting
 *  neither, because the inconsistency teaches the user the wrong rule. */
type PendingSwitch =
  | { kind: "open"; target: ServerChoice }
  | { kind: "new" };

/** Unsaved-changes gate for a switch. Three outcomes, not the usual two: the
 *  point of blocking is to offer the save the user almost certainly wants, so
 *  "Discard" is never the only way forward. */
function SwitchConfirmDialog({
  pending,
  currentName,
  busy,
  onSaveAndSwitch,
  onDiscardAndSwitch,
  onCancel,
}: {
  pending: PendingSwitch;
  /** The server being left, named so the prompt says what is at risk. */
  currentName: string;
  /** True while the save is in flight; keeps a double-click from saving twice. */
  busy: boolean;
  onSaveAndSwitch: () => void;
  onDiscardAndSwitch: () => void;
  onCancel: () => void;
}) {
  // Escape cancels, matching every other dialog in the app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <section
        className="confirm-dialog confirm-dialog--switch"
        role="dialog"
        aria-modal="true"
        aria-labelledby="switch-dialog-title"
      >
        <header className="confirm-dialog__header">
          <h2 id="switch-dialog-title">Unsaved changes</h2>
          <button className="panel-icon-btn" type="button" onClick={onCancel} aria-label="Cancel switch" title="Close">✕</button>
        </header>
        <div className="confirm-dialog__body">
          <p>
            <strong>{currentName}</strong> has changes that are not saved.{" "}
            {pending.kind === "open" ? (
              <>Opening <strong>{pending.target.name}</strong> replaces the canvas.</>
            ) : (
              <>Starting a new server replaces the canvas.</>
            )}
          </p>
          <div className="confirm-dialog__actions">
            <button type="button" className="confirm-dialog__cancel" onClick={onCancel}>
              Cancel
            </button>
            {/* Discard is the destructive path, so it wears the destructive
                style and sits away from the default action. */}
            <button type="button" className="confirm-dialog__delete" onClick={onDiscardAndSwitch} disabled={busy}>
              Discard changes
            </button>
            <button type="button" className="confirm-dialog__confirm" onClick={onSaveAndSwitch} disabled={busy}>
              {busy ? "Saving…" : "Save and switch"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function ServerMenu({
  onNewServer,
  onOpenHome,
}: {
  /** Start a fresh server on the canvas (App owns the page change). */
  onNewServer: () => void;
  /** Go to the workspace home, which owns tiles, rename and delete. */
  onOpenHome: () => void;
}) {
  const project = useEditor((s) => s.project);
  const filePath = useEditor((s) => s.filePath);
  const dirty = useEditor((s) => s.dirty);
  const serverName = useEditor((s) => s.doc.server.name);
  const openProjectDoc = useEditor((s) => s.openProjectDoc);
  const saveToProject = useEditor((s) => s.saveToProject);

  const [open, setOpen] = useState(false);
  const [servers, setServers] = useState<ProjectServerEntry[]>([]);
  // Distinguishes "still reading" from "this workspace has no servers"; the
  // empty state is a claim about the library, so it must not be made early.
  const [loaded, setLoaded] = useState(false);
  // Non-null while the unsaved-changes dialog is up, holding what it guards.
  const [pending, setPending] = useState<PendingSwitch | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (project === null) return; // the shell never renders this outside one
    try {
      const all = await getApi().listProjects();
      setServers(all.find((p) => p.id === project.id)?.servers ?? []);
    } catch {
      // A failed read leaves the previous list rather than blanking the menu;
      // the trigger still names the open server, which is the critical part.
      setServers([]);
    } finally {
      setLoaded(true);
    }
  }, [project]);

  // Re-read on every open: cheaper than subscribing, and guarantees the menu
  // reflects saves made from the toolbar, the home page or Ctrl+S.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const choices = serverChoices(servers, filePath);
  const openFileName = filePath === null ? null : filePath.replace(/^.*[\\/]/, "");
  const label = currentServerLabel(openFileName, serverName);

  /** Carry out a switch, unconditionally. Every caller has already cleared the
   *  unsaved-changes gate, so this never inspects `dirty` itself. */
  const commit = async (next: PendingSwitch): Promise<void> => {
    setPending(null);
    setOpen(false);
    if (next.kind === "new") { onNewServer(); return; }
    await openProjectDoc(next.target.path);
  };

  /** The single gate both canvas-replacing actions pass through. */
  const request = (next: PendingSwitch): void => {
    setError(null);
    if (next.kind === "open") {
      const decision = decideSwitch(next.target, dirty);
      if (decision.kind === "noop") { setOpen(false); return; }
      if (decision.kind === "confirm") {
        // Close the menu but keep the dialog: leaving a popup open behind a
        // modal gives two competing dismiss targets.
        setOpen(false);
        setPending(next);
        return;
      }
    } else if (dirty) {
      setOpen(false);
      setPending(next);
      return;
    }
    void commit(next);
  };

  const saveAndSwitch = async (): Promise<void> => {
    if (pending === null) return;
    setSaving(true);
    const res = await saveToProject();
    setSaving(false);
    // A failed save must NOT switch — that would discard the very changes the
    // user asked to keep. Keep the dialog up and show why.
    if (!res.ok) { setError(res.error); setPending(null); return; }
    await commit(pending);
  };

  return (
    <div className="server-menu" ref={rootRef}>
      <button
        className={`server-menu__trigger${open ? " server-menu__trigger--open" : ""}`}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={filePath ?? "not saved yet"}
      >
        <span className="server-menu__name">{label}</span>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="server-menu__popup" role="menu" aria-label="Switch server">
          <div className="server-menu__heading">Servers in {project?.name ?? "workspace"}</div>

          {!loaded && <div className="server-menu__empty">Reading workspace…</div>}

          {loaded && choices.length === 0 && (
            <div className="server-menu__empty">No servers saved yet. Save this one to add it.</div>
          )}

          {choices.map((choice) => (
            <button
              key={choice.path}
              type="button"
              role="menuitemradio"
              aria-checked={choice.isCurrent}
              className={`server-menu__item${choice.isCurrent ? " server-menu__item--current" : ""}`}
              onClick={() => request({ kind: "open", target: choice })}
              title={choice.path}
            >
              <span className="server-menu__item-text">
                <span className="server-menu__item-name">{choice.name}</span>
                <small className="server-menu__item-when">
                  {choice.isCurrent ? "open now" : formatWhen(choice.updatedAt)}
                </small>
              </span>
              {/* Check only on the open server: with aria-checked carrying the
                  state for assistive tech, the glyph is purely visual. */}
              {choice.isCurrent && (
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              )}
            </button>
          ))}

          <div className="app-menu__separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="server-menu__item server-menu__item--action"
            onClick={() => request({ kind: "new" })}
          >
            New server
          </button>
          <button
            type="button"
            role="menuitem"
            className="server-menu__item server-menu__item--action"
            onClick={() => { setOpen(false); onOpenHome(); }}
          >
            Workspace home…
          </button>
        </div>
      )}

      {/* Save failures surface next to the control that triggered them; the
          dialog is gone by then, so a toast-less inline note is the only
          place the reason can be read. */}
      {error !== null && (
        <div className="server-menu__error" role="alert">
          {error}
          <button type="button" className="panel-icon-btn" onClick={() => setError(null)} aria-label="Dismiss error">✕</button>
        </div>
      )}

      {pending !== null && (
        <SwitchConfirmDialog
          pending={pending}
          currentName={label}
          busy={saving}
          onSaveAndSwitch={() => void saveAndSwitch()}
          onDiscardAndSwitch={() => void commit(pending)}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
