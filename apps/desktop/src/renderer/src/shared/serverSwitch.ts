import type { ProjectServerEntry } from "../../../shared/ipc";

// The rules behind the builder's server dropdown, kept separate from the menu
// that renders them. A wrong answer here either shows the user the wrong
// "currently open" server or silently discards unsaved work, so these are the
// parts worth testing without a DOM.

/** One row in the server dropdown. */
export interface ServerChoice {
  /** Absolute path — handed to openProjectDoc verbatim, like the home tiles. */
  path: string;
  /** Label shown in the menu (file name minus the .json extension). */
  name: string;
  /** mtime in epoch ms, used for ordering and the "last saved" hint. */
  updatedAt: number;
  /** True for the doc currently on the canvas, which the menu marks and
   *  refuses to re-open (re-opening would discard unsaved edits for nothing). */
  isCurrent: boolean;
}

/** Strip the extension the library adds when saving. Mirrors the workspace
 *  home (ProjectsPage.tsx:213) so the two surfaces never label the same file
 *  differently — a user who sees "weather" on one page must not see
 *  "weather.json" on the other. */
export function serverDisplayName(fileName: string): string {
  return fileName.replace(/\.json$/, "");
}

/**
 * Build the dropdown rows for a workspace.
 *
 * Ordered most-recently-saved first, because the menu's job is switching
 * between the handful of servers you are actually working on; alphabetical
 * would bury today's work under an old "api-*" file. Ties break on name so the
 * order is total and the list cannot flicker between renders — two files saved
 * in the same millisecond is rare but a jittering menu is a real bug.
 */
export function serverChoices(
  servers: readonly ProjectServerEntry[],
  openPath: string | null,
): ServerChoice[] {
  return servers
    .map((entry) => ({
      path: entry.path,
      name: serverDisplayName(entry.fileName),
      updatedAt: entry.updatedAt,
      isCurrent: openPath !== null && entry.path === openPath,
    }))
    .sort((a, b) => (b.updatedAt - a.updatedAt) || a.name.localeCompare(b.name));
}

/**
 * What the trigger says. The dropdown is now the only place the open server is
 * named (the toolbar's right-hand group keeps just the dirty dot and Save), so
 * this must always produce something meaningful.
 *
 * An unsaved doc falls back to the server name typed into the server panel,
 * matching the label App.tsx already derived for the old file-status: after
 * reopening a workspace the canvas holds real work, and users read "Untitled"
 * as data loss. Only a genuinely empty name reaches "Untitled".
 */
export function currentServerLabel(openFileName: string | null, serverName: string): string {
  if (openFileName !== null) return serverDisplayName(openFileName);
  return serverName.trim() || "Untitled";
}

/** What selecting a server from the menu should do. */
export type SwitchDecision =
  /** Load it now — nothing would be lost. */
  | { kind: "open" }
  /** Already on the canvas; just close the menu. Re-loading would throw away
   *  unsaved edits to reach a doc the user is already looking at. */
  | { kind: "noop" }
  /** Unsaved edits would be discarded — ask first (save / discard / cancel). */
  | { kind: "confirm" };

/**
 * Gate a server switch.
 *
 * Deliberately stricter than the workspace-home tiles, which swap servers with
 * no warning at all (ProjectsPage.tsx:141). That was survivable when switching
 * meant navigating to another page first; a dropdown in the builder's own
 * toolbar makes it a one-click action, so the same silent discard becomes a
 * trap. This matches the app's other one-click destructive-adjacent path,
 * File → Open workspace…, which confirms before dropping a dirty doc.
 */
export function decideSwitch(target: ServerChoice, dirty: boolean): SwitchDecision {
  if (target.isCurrent) return { kind: "noop" };
  return dirty ? { kind: "confirm" } : { kind: "open" };
}
