// The consent rule for connecting a server to an MCP client.
//
// Connecting is a WRITE to a file MCPeasy does not own, outside the workspace,
// that another application will then execute a command from. That is the same
// class of action as deleting a server (ProjectsPage.tsx DeleteConfirmDialog),
// so it uses the same protection: the user types the exact name to confirm.
//
// WHY THIS LIVES IN shared/ AND NOT IN THE DIALOG: the repo's test environment
// is node (vitest.config.ts:21), so a React component cannot be rendered in a
// test. Keeping the decision — what must be typed, and whether what was typed
// matches — as plain functions means the rule that guards the write is covered
// by tests, while the dialog is left as presentation. Same split as
// secretName.ts, which holds the rule the Secrets page merely displays.

/** Trim only. Case and inner spacing are deliberately NOT normalised: the point
 *  of type-to-confirm is deliberate transcription, and case-folding would let
 *  "vs code" confirm a write intended for "VS Code". Leading/trailing spaces are
 *  forgiven because they are an artefact of copy/paste, not of intent.
 *
 *  This matches DeleteConfirmDialog's exact `typed === displayName` comparison,
 *  with the whitespace allowance added — that dialog requires a filename, which
 *  cannot carry stray spaces, whereas a server name can. */
export function connectConfirmMatches(typed: string, target: string): boolean {
  // An empty target would make every input match, including the empty string,
  // which would silently disable the whole guard. Refuse instead.
  if (target.trim().length === 0) return false;
  return typed.trim() === target;
}

/**
 * What the user must type to confirm.
 *
 * The SERVER's name, not the client's: the question being answered is "are you
 * sure you want to expose THIS server", and the server is the thing whose tools
 * become reachable. Using the client name instead would mean every connect in
 * a session asks for a different word while the consequential noun — which
 * server — never gets typed at all.
 *
 * Falls back to the file name when the doc has no name. The schema requires a
 * non-empty name (validate.ts:121), so this is defensive: a doc loaded from an
 * older or hand-edited file must still produce something typeable rather than
 * an empty target that `connectConfirmMatches` would reject forever.
 */
export function connectConfirmTarget(serverName: string, fileName: string | null): string {
  const name = serverName.trim();
  if (name.length > 0) return name;
  const base = (fileName ?? "").replace(/^.*[\\/]/, "").replace(/\.json$/i, "").trim();
  return base;
}
