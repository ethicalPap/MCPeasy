import { useCallback, useEffect, useState } from "react";
import type { ClaudeCodeStatus } from "../../../shared/ipc";
import { getApi } from "../browser/api";
import { useEditor } from "../store";
import { PanelFacts, type SidePanelSection } from "./SidePanel";

// Claude-Code-specific controls, surfaced as SECTIONS of the Integrations side
// panel rather than as a standing block on the page.
//
// WHY THESE ARE NOT IN THE CATALOG: every other client in the catalog is a
// config file and nothing more. Claude Code additionally has a CLI to detect, a
// version, an authentication state, an executable path the user may need to
// override, and a persisted local-execution grant. None of those generalize, so
// forcing them into the shared client shape would mean four clients carrying
// five always-null fields.
//
// WHY A HOOK RATHER THAN A COMPONENT: the panel needs these as `sections` data
// (each with a key, label and body) so they can appear in its nav rail beside
// the generic Overview and Registered sections. A component could only render
// one opaque blob, which would put a second, differently-styled navigation
// inside the panel.

/** Commands are shown with a copy button rather than run for the user: they
 *  affect the user's own Claude Code account, and running an auth flow behind
 *  their back would be the wrong kind of helpful. */
function CommandRow({ command, hint }: { command: string; hint: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(command).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  };
  return (
    <div className="integrations__command">
      <code>{command}</code>
      <button type="button" onClick={copy} title="Copy to clipboard">
        {copied ? "Copied" : "Copy"}
      </button>
      <p className="muted">{hint}</p>
    </div>
  );
}

/** The catalog id this panel's extra sections belong to. Kept next to the code
 *  that needs it rather than exported from the catalog: this is a UI decision
 *  about which client gets bespoke controls, not part of the client contract. */
const CLAUDE_CODE_ID = "claude-code";

/** Builds the Claude-Code-only sections for the side panel. Returns an empty
 *  array for every other client, so the caller can concatenate unconditionally. */
export function useClaudeCodeSections({
  clientId,
  busy,
  onNotice,
}: {
  /** Which client's panel is open, or null when none is. Sections are produced
   *  only for Claude Code. */
  clientId: string | null;
  busy: boolean;
  onNotice: (notice: { kind: "ok" | "error"; text: string }) => void;
}): SidePanelSection[] {
  const project = useEditor((s) => s.project);
  const filePath = useEditor((s) => s.filePath);

  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
  const [overrideText, setOverrideText] = useState("");
  const [grant, setGrant] = useState<{ granted: boolean; fingerprint: string | null }>({
    granted: false,
    fingerprint: null,
  });

  const isClaude = clientId === CLAUDE_CODE_ID;

  const refresh = useCallback(async () => {
    // Probing SPAWNS the CLI, so it must not run for a project-less shell, and
    // must not run at all while a different client's panel is open. This is the
    // behavioural gain of moving into the panel: detection is now on-demand
    // instead of on every visit to the page.
    if (project === null || !isClaude) return;
    const api = getApi();
    const next = await api.getClaudeCodeStatus();
    setStatus(next);
    setOverrideText(next.executableOverride ?? "");

    // Grant state is keyed to the doc ON DISK, so it is only meaningful for a
    // saved server; an unsaved buffer has nothing to fingerprint.
    if (filePath !== null) {
      const g = await api.getLocalExecutionGrant({ projectId: project.id, serverPath: filePath });
      if (g.ok) setGrant({ granted: g.granted, fingerprint: g.fingerprint });
    } else {
      setGrant({ granted: false, fingerprint: null });
    }
  }, [project, filePath, isClaude]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleGrant = async (): Promise<void> => {
    if (project === null || filePath === null || grant.fingerprint === null) return;
    const api = getApi();
    if (grant.granted) {
      await api.revokeLocalExecution({ projectId: project.id, serverPath: filePath });
      await refresh();
      return;
    }
    // Same seriousness as the native per-call dialog in console:run — this
    // grant persists, so the warning has to be explicit about what it allows.
    const ok = window.confirm(
      "Allow this server to run local code?\n\n" +
        "Claude Code will be able to execute this graph's command, script, and custom-code blocks with your user " +
        "permissions, without asking again. Editing any of those blocks cancels the approval.\n\n" +
        "Only continue if you trust this graph.",
    );
    if (!ok) return;
    const result = await api.grantLocalExecution({
      projectId: project.id,
      serverPath: filePath,
      fingerprint: grant.fingerprint,
    });
    if (!result.ok) onNotice({ kind: "error", text: result.error });
    await refresh();
  };

  const saveOverride = async (): Promise<void> => {
    await getApi().setClaudeCodeExecutablePath(overrideText.trim() === "" ? null : overrideText.trim());
    await refresh();
  };

  // Hooks above run unconditionally (rules of hooks); the early return is here,
  // after all of them, so a non-Claude panel simply contributes no sections.
  if (!isClaude || project === null) return [];

  const sections: SidePanelSection[] = [
    {
      key: "cli",
      label: "CLI",
      icon: "⌘",
      content: (
        <section className="integrations__section">
          <h3>Claude Code CLI</h3>
          {status === null ? (
            <p className="muted">Checking…</p>
          ) : (
            <PanelFacts
              rows={[
                [
                  "CLI",
                  // The version alone carries "found" implicitly, so the word is
                  // redundant when we have one. It is NOT redundant when
                  // detection succeeded but `claude --version` did not parse:
                  // dropping the text entirely there would render an empty cell
                  // that reads as a failure, so that case states the gap.
                  status.cliFound ? (status.version !== null ? `v${status.version}` : "version unknown") : "not found",
                ],
                [
                  "Signed in",
                  status.authState === "authenticated"
                    ? "yes"
                    : status.authState === "unauthenticated"
                      ? "no"
                      : "unknown",
                ],
                // null drops the row entirely — see PanelFacts. An undetected
                // CLI has no path, and a blank value would read as a failure.
                ["Executable", status.executablePath !== null ? <code>{status.executablePath}</code> : null],
              ]}
            />
          )}

          <div className="integrations__override">
            <label htmlFor="claude-exec">Executable path (optional)</label>
            <input
              id="claude-exec"
              value={overrideText}
              onChange={(e) => setOverrideText(e.target.value)}
              placeholder="leave empty to detect automatically"
              spellCheck={false}
            />
            <button type="button" onClick={() => void saveOverride()}>
              Save
            </button>
          </div>
        </section>
      ),
    },
  ];

  // Sign-in help — only when we KNOW the user is signed out. "unknown" must not
  // trigger this, or the app asserts something it never checked.
  if (status !== null && status.cliFound && status.authState === "unauthenticated") {
    sections.push({
      key: "sign-in",
      label: "Sign in",
      icon: "→",
      content: (
        <section className="integrations__section">
          <h3>Sign in to Claude Code</h3>
          <p className="muted">Run either of these in your terminal. MCPeasy never handles your credentials.</p>
          <CommandRow command="claude auth login" hint="Opens your browser to sign in with your Anthropic account." />
          <CommandRow
            command="claude auth login --console"
            hint="Signs in with Anthropic Console for API usage billing instead of a subscription."
          />
          <p className="muted">
            Or set the <code>ANTHROPIC_API_KEY</code> environment variable before starting Claude Code. When it is set,
            it is used instead of a subscription.
          </p>
        </section>
      ),
    });
  }

  // Local execution — only when the graph actually has local nodes.
  if (grant.fingerprint !== null) {
    sections.push({
      key: "local-execution",
      label: "Local execution",
      icon: "▶",
      badge: grant.granted ? "on" : undefined,
      content: (
        <section className="integrations__section">
          <h3>Local execution</h3>
          <p className="muted">
            This graph contains command, script, or custom-code blocks. A client launches the server without a window,
            so it cannot ask for per-call approval. The grant is made here and can be revoked at any time. Editing any
            of those blocks cancels it automatically.
          </p>
          <p className={grant.granted ? "integrations__grant--on" : "integrations__grant--off"}>
            {grant.granted ? "Granted for this server." : "Not granted. Local steps will fail until you approve."}
          </p>
          <button type="button" onClick={() => void toggleGrant()} disabled={busy}>
            {grant.granted ? "Revoke local execution" : "Grant local execution"}
          </button>
        </section>
      ),
    });
  }

  return sections;
}
