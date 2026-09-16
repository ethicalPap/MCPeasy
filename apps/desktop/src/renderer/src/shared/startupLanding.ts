import type { ProjectServerEntry } from "../../../shared/ipc";

// Where the app lands when a workspace is ENTERED without the user naming a
// server — launch restore, workspace creation, and picking a workspace from the
// startup chooser.
//
// WHY THIS EXISTS: three separate call sites used to decide this independently,
// and all three could end on a blank unsaved server. App.tsx only reopened a doc
// when a serverPath had been persisted; ProjectStartPage sent "create" straight
// to the builder; and store.openProject resets the canvas to emptyDoc() on the
// way in, so ANY path that did not immediately load a doc left a blank
// "my-server" on screen. A blank canvas that the user did not ask for reads as
// data loss when the workspace actually holds saved work.
//
// The rule (user decision) is now: an automatic landing opens an EXISTING saved
// server or it shows the workspace home. It never creates a server. Creating one
// stays an explicit act — File > New, Ctrl+N, the builder dropdown's "New
// server", and the home page's "New server" tile all still work exactly as
// before; they are user intent, not an automatic landing.
//
// WHY IT LIVES IN shared/ AND NOT IN App.tsx: the repo's test environment is
// node (vitest.config.ts), so a React component cannot be rendered in a test.
// Keeping the decision as a plain function means the rule that governs what the
// user sees on launch is covered by tests while the component stays wiring.
// Identical split to serverSwitch.ts, connectConfirm.ts and secretName.ts.

/** Which page the shell should show after entering a workspace. Mirrors the
 *  PageId values App.tsx sets, but deliberately narrowed to the two an
 *  automatic landing may choose — nothing here may select, say, Integrations. */
export type LandingPage = "builder" | "repository";

export interface StartupLanding {
  /** Absolute path of the server to open before showing the page, or null to
   *  leave the canvas as-is. Handed to openProjectDoc verbatim, exactly like
   *  the workspace-home tiles and the builder dropdown do. */
  openServerPath: string | null;
  /** "builder" only ever accompanies a non-null openServerPath: the builder is
   *  shown because there is real work to show in it. */
  page: LandingPage;
}

/**
 * Decide what a freshly entered workspace should show.
 *
 * @param servers   The workspace's saved servers, as listProjects returns them.
 * @param rememberedPath The server persisted from the last session
 *   (LastWorkspace.serverPath), or null when none was recorded.
 *
 * Only a REMEMBERED server is reopened, and only when it still exists. A stale
 * path (the file was deleted or renamed outside the app) falls through to the
 * workspace home rather than silently substituting a different server — the
 * user chose that specific doc, so quietly loading its neighbour would be
 * answering a question they did not ask. Landing on the home page instead puts
 * the choice back in front of them with every server visible.
 */
export function resolveStartupLanding(
  servers: readonly ProjectServerEntry[],
  rememberedPath: string | null,
): StartupLanding {
  if (rememberedPath !== null) {
    // Exact match only. Paths come from the same listProjects source that
    // produced the remembered value, so no normalisation is warranted here —
    // and inventing some (case-folding, separator swapping) would risk matching
    // a DIFFERENT file on a case-sensitive filesystem.
    const match = servers.find((entry) => entry.path === rememberedPath);
    if (match !== undefined) return { openServerPath: match.path, page: "builder" };
  }
  // No remembered server, or it is gone: show the workspace home. This is the
  // empty-workspace case too — a brand-new workspace has nothing to open, and
  // the home page's "New server" tile is the intended next step.
  return { openServerPath: null, page: "repository" };
}
