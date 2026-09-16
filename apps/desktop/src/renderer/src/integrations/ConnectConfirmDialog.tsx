import { useEffect, useRef, useState, type FormEvent } from "react";
import type { McpClientInfo, McpClientState } from "../../../shared/ipc";
import { connectConfirmMatches } from "../../../shared/connectConfirm";

// Consent step for connecting a server to an MCP client.
//
// WHY THIS EXISTS: connecting writes to a JSON file MCPeasy does not own,
// OUTSIDE the workspace, which another application then reads and executes a
// command from. Nothing else on the Integrations page leaves the workspace.
// A single click was too little friction for that, so this states the
// consequences and requires the server's name to be typed — the same bar
// ProjectsPage.tsx already sets for deleting a server.
//
// ANATOMY IS DELIBERATELY DeleteConfirmDialog's (ProjectsPage.tsx:32-97):
// .modal-backdrop > .confirm-dialog, header with a close button, body, then a
// form whose submit stays disabled until the typed name matches. Reusing that
// structure means both confirmations look and behave identically, and the
// existing .confirm-dialog rules carry almost all the styling. Only the parts
// that differ — the "what will happen" list and the neutral (non-destructive)
// submit — are new.
//
// The match rule itself lives in shared/connectConfirm.ts so it can be tested;
// this file is presentation.

export function ConnectConfirmDialog({
  client,
  state,
  serverName,
  confirmTarget,
  entryName,
  busy,
  onConfirm,
  onCancel,
}: {
  client: McpClientInfo;
  state: McpClientState;
  /** Shown in the prose — what the user is exposing. */
  serverName: string;
  /** What must be typed. Usually equals serverName; kept separate because the
   *  fallback for an unnamed doc differs (see connectConfirmTarget). */
  confirmTarget: string;
  /** The exact key that will be added to the config, or null when it could not
   *  be determined (browser mode). Never invented — see ListMcpClientsResponse. */
  entryName: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const matches = connectConfirmMatches(typed, confirmTarget);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Escape cancels, matching SidePanel and the titlebar menus. Bound to the
  // document because focus starts in the input but may be moved by the user.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    // Re-checked rather than trusting the disabled attribute: a form can also
    // be submitted by Enter, and `busy` can become true between render and
    // submit while an earlier connect is still in flight.
    if (matches && !busy) onConfirm();
  };

  // Only claim a backup when there is a file to back up. Saying "your existing
  // config will be backed up" for a file that does not exist yet would be a
  // small lie about a safety net, which is the worst kind.
  const willBackUp = state.configExists;

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
        aria-labelledby="connect-dialog-title"
      >
        <header className="confirm-dialog__header">
          <h2 id="connect-dialog-title">Connect to {client.name}</h2>
          <button className="panel-icon-btn" type="button" onClick={onCancel} aria-label="Cancel connecting" title="Close">
            ✕
          </button>
        </header>
        <div className="confirm-dialog__body">
          <p>
            This will make <strong>{serverName}</strong>&apos;s tools available to {client.name} on this machine.
          </p>

          {/* The explicit "what will happen" list the user asked for. Each line
              is a fact this app can actually stand behind: the first two are
              read back from the client's own state, the rest are properties of
              registerWithClient in main/mcpClients.ts. */}
          <ul className="confirm-dialog__effects">
            <li>
              MCPeasy will write to <code>{state.configPath ?? "this client's config file"}</code>
              {!state.configExists && <span className="muted"> (creating it)</span>}.
            </li>
            <li>
              It adds one entry
              {entryName !== null ? (
                <>
                  {" "}
                  named <code>{entryName}</code>
                </>
              ) : null}{" "}
              under <code>{client.serversKey}</code>. Every other setting in that file is left untouched.
            </li>
            {willBackUp && <li>A timestamped backup of the current file is saved first.</li>}
            <li>
              No secret is written. Declared env values stay in the encrypted store and are resolved when the server
              starts.
            </li>
            <li>{client.activationHint}</li>
            <li className="muted">You can undo this at any time with Disconnect.</li>
          </ul>

          <p className="confirm-dialog__prompt">
            Type <strong>{confirmTarget}</strong> to confirm:
          </p>
          <form onSubmit={submit}>
            <input
              ref={inputRef}
              className="confirm-dialog__input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={confirmTarget}
              aria-label={`Type "${confirmTarget}" to confirm connecting to ${client.name}`}
              spellCheck={false}
              autoComplete="off"
            />
            <div className="confirm-dialog__actions">
              <button type="button" className="confirm-dialog__cancel" onClick={onCancel}>
                Cancel
              </button>
              <button type="submit" className="confirm-dialog__confirm" disabled={!matches || busy}>
                {busy ? "Connecting…" : `Connect to ${client.shortName}`}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
