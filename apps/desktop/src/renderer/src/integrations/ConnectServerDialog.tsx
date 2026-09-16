import { useEffect } from "react";
import type { McpClientInfo } from "../../../shared/ipc";
import { candidateBlockers, candidateDisplayName, type ConnectCandidate } from "../../../shared/connectTarget";

// Step ONE of connecting: choose WHICH saved server to register with a client.
//
// WHY THIS EXISTS: connecting used to register whatever server happened to be
// open in the builder. That is an invisible coupling — the Integrations page
// never showed which doc it meant, so the same button did different things
// depending on a tab the user might not have looked at for an hour. A client
// can hold several MCPeasy servers at once (they are separate keys under
// `mcpServers`), so "which one" is a real question with no safe default.
//
// FLOW: Connect -> this picker -> ConnectConfirmDialog -> the write. The
// picker answers "which server", the confirmation answers "are you sure", and
// only the confirmation can trigger the write. Splitting them keeps the single
// audited call site that ConnectConfirmDialog's header comment describes.
//
// ANATOMY IS ConnectConfirmDialog's, which in turn is DeleteConfirmDialog's
// (ProjectsPage.tsx): .modal-backdrop > .confirm-dialog, a header with a close
// button, then a body. The rows are their own block because they are a list of
// choices rather than a form — there is no submit here, since picking IS the
// action that advances.

export function ConnectServerDialog({
  client,
  candidates,
  loading,
  storedSecrets,
  openFilePath,
  builderDirty,
  onPick,
  onCancel,
}: {
  client: McpClientInfo;
  /** Every saved server in the active workspace, most recently saved first
   *  (the order listServers already returns, which doubles as "recent work"). */
  candidates: ConnectCandidate[];
  /** True while the docs are still being read. Distinguished from "none found"
   *  so an empty workspace is never claimed before the read finishes. */
  loading: boolean;
  /** Secret names present for this workspace, used to judge each candidate. */
  storedSecrets: readonly string[];
  /** Path of the doc open in the builder, or null. Only this one can be
   *  blocked by unsaved changes. */
  openFilePath: string | null;
  builderDirty: boolean;
  onPick: (candidate: ConnectCandidate) => void;
  onCancel: () => void;
}) {
  // Escape cancels, matching ConnectConfirmDialog, SidePanel and the titlebar
  // menus. Bound to the document because there is no input to hold focus here.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <section
        className="confirm-dialog confirm-dialog--connect"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pick-server-dialog-title"
      >
        <header className="confirm-dialog__header">
          <h2 id="pick-server-dialog-title">Connect a server to {client.name}</h2>
          <button
            className="panel-icon-btn"
            type="button"
            onClick={onCancel}
            aria-label="Cancel connecting"
            title="Close"
          >
            ✕
          </button>
        </header>
        <div className="confirm-dialog__body">
          <p>Choose which saved server to make available to {client.name}.</p>

          {loading ? (
            <p className="muted">Reading saved servers…</p>
          ) : candidates.length === 0 ? (
            <p className="muted">
              No servers are saved in this workspace yet. Build one on the canvas and save it, then connect it here.
            </p>
          ) : (
            <ul className="server-picker">
              {candidates.map((candidate) => {
                const blockers = candidateBlockers(candidate, {
                  storedSecrets,
                  isOpenInBuilder: candidate.path === openFilePath,
                  builderDirty,
                });
                const name = candidateDisplayName(candidate);
                const ready = blockers.length === 0;
                return (
                  <li key={candidate.path}>
                    {/* The whole row is the button: a blocked server stays
                        visible and explains itself rather than vanishing,
                        because "my server is missing" is a worse puzzle than
                        "my server needs a secret". */}
                    <button
                      type="button"
                      className="server-picker__row"
                      onClick={() => onPick(candidate)}
                      disabled={!ready}
                      title={candidate.path}
                    >
                      <span className="server-picker__name">
                        {name}
                        {candidate.path === openFilePath && (
                          <span className="server-picker__tag">open in builder</span>
                        )}
                      </span>
                      <span className="server-picker__meta">
                        {candidate.fileName}
                        {candidate.env.length > 0 && ` · ${candidate.env.length} env`}
                      </span>
                      {blockers.length > 0 && (
                        <span className="server-picker__blockers">{blockers.join(". ")}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="confirm-dialog__actions">
            <button type="button" className="confirm-dialog__cancel" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
