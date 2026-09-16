// Which saved server is being connected, and whether it CAN be connected.
//
// WHY THIS EXISTS: connecting used to be implicit — the Integrations page
// registered whatever server happened to be open in the builder, and its
// "Before connecting" list described that one doc. Once the user picks the
// server explicitly, every one of those judgements has to be made per
// candidate instead: a workspace can hold a saved, valid server and a
// half-finished one at the same time, and the picker must say which is which
// BEFORE the write, not fail afterwards with a message from main.
//
// WHY IT LIVES IN shared/ AND NOT IN THE DIALOG: the repo's test environment is
// node (vitest.config.ts), so a React component cannot be rendered in a test.
// Keeping the decision — what a server is called, and what stops it being
// connected — as plain functions means the rules that gate a write outside the
// workspace are covered by tests while the dialog stays presentation. Identical
// split to connectConfirm.ts and secretName.ts.

/** A saved server as the picker sees it: the stored file plus everything that
 *  had to be read out of the doc to judge it. Deliberately NOT the full
 *  GraphDoc — the picker needs four facts, and narrowing them here keeps this
 *  module free of a schema dependency (and therefore trivially testable). */
export interface ConnectCandidate {
  /** Absolute path, exactly as ProjectServerEntry.path reports it. Handed back
   *  to clients:connect verbatim; main re-resolves it against the library jail
   *  rather than trusting it (index.ts resolveServerRequest). */
  path: string;
  /** File name including the .json suffix, e.g. "weather.json". */
  fileName: string;
  /** mtime in epoch ms, shown as "last saved" — the same ordering signal the
   *  workspace home already uses to mean "recent work". */
  updatedAt: number;
  /** `doc.server.name`, or "" when the doc could not be read or parsed. */
  serverName: string;
  /** Declared env var names. Each one without a stored secret is a blocker,
   *  because serve mode exits non-zero at launch when one is missing and the
   *  client reports only a generic connection failure. */
  env: string[];
  /** True when `doc.server.transport === "http"`. Such a server listens on a
   *  port instead of being spawned, so a stdio client entry for it could never
   *  work — main refuses it (index.ts resolveServerRequest), and the picker
   *  says so up front rather than letting the user reach the confirmation. */
  listening: boolean;
  /** Non-null when the file could not be read or parsed. Such a server is
   *  never connectable, and the reason is worth showing verbatim. */
  loadError: string | null;
}

/** The four facts the picker needs out of a saved doc's raw text.
 *
 *  DELIBERATELY A SHALLOW READ, not migrate + parseGraphDocShape. Two reasons:
 *  main's own transport guard reads the doc exactly this way
 *  (index.ts resolveServerRequest calls usesListeningTransport on a bare
 *  JSON.parse), so a stricter reader here could refuse a server that main
 *  would happily register — the picker would then be lying about what is
 *  connectable. And a doc that is merely old or has a graph-level problem is
 *  still perfectly connectable; refusing to LIST it would hide a server the
 *  user can see on the workspace home.
 *
 *  Anything unreadable comes back as a loadError rather than an exception, so
 *  one corrupt file cannot blank the whole picker. */
export function readCandidateFacts(text: string): {
  serverName: string;
  env: string[];
  listening: boolean;
  loadError: string | null;
} {
  const empty = { serverName: "", env: [], listening: false };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...empty, loadError: "this file is not valid JSON" };
  }
  if (raw === null || typeof raw !== "object") {
    return { ...empty, loadError: "this file is not a server document" };
  }
  const server = (raw as { server?: unknown }).server;
  if (server === null || typeof server !== "object") {
    return { ...empty, loadError: "this file is not a server document" };
  }
  const fields = server as { name?: unknown; env?: unknown; transport?: unknown };
  return {
    serverName: typeof fields.name === "string" ? fields.name : "",
    // Non-string members are dropped rather than coerced: a number in this
    // array is corruption, and inventing "42" as an env var name would produce
    // a blocker the user could never satisfy.
    env: Array.isArray(fields.env) ? fields.env.filter((n): n is string => typeof n === "string") : [],
    listening: fields.transport === "http",
    loadError: null,
  };
}

/** What to call a server in the UI. The doc's own name is the identity the
 *  user typed and the thing whose tools become reachable; the file name is
 *  only a fallback for a doc that has none (hand-edited or pre-schema). */
export function candidateDisplayName(candidate: {
  serverName: string;
  fileName: string;
}): string {
  const name = candidate.serverName.trim();
  if (name.length > 0) return name;
  return candidate.fileName.replace(/\.json$/i, "");
}

/** Everything that stops THIS server being connected right now, in the order a
 *  user would fix them. Empty means connectable.
 *
 *  Returning a list rather than a boolean is the same idiom the test console
 *  and the old page-wide block already used: a user with two problems should
 *  see both and fix them in one pass, not discover the second only after
 *  fixing the first.
 *
 *  NOTE ON `dirty`: unsaved changes are a property of the BUILDER, not of the
 *  file on disk, so they can only ever block the one server currently open.
 *  Every other saved server is unaffected by an unsaved buffer elsewhere —
 *  which is precisely why this check takes `isOpenInBuilder` rather than a
 *  bare dirty flag. Blocking every candidate because an unrelated doc has
 *  unsaved edits would be a lie about what is on disk. */
export function candidateBlockers(
  candidate: ConnectCandidate,
  context: {
    /** Secret names present in the encrypted store for this workspace. */
    storedSecrets: readonly string[];
    /** True when this candidate is the doc open in the builder. */
    isOpenInBuilder: boolean;
    /** The builder's unsaved-changes flag. Only consulted when the candidate
     *  is the open doc. */
    builderDirty: boolean;
  },
): string[] {
  const blockers: string[] = [];

  // Checked first: when the doc cannot be read, nothing below it can be
  // trusted (env and transport would both be empty defaults), so reporting
  // only this avoids stacking misleading secondary complaints on top.
  if (candidate.loadError !== null) return [candidate.loadError];

  if (context.isOpenInBuilder && context.builderDirty) {
    blockers.push("this server is open in the builder with unsaved changes, save it first");
  }

  if (candidate.listening) {
    blockers.push(
      "this server uses the http transport, which listens on a port instead of being started by the client",
    );
  }

  const stored = new Set(context.storedSecrets);
  const missing = candidate.env.filter((name) => !stored.has(name));
  if (missing.length > 0) {
    blockers.push(`no stored secret for ${missing.join(", ")}, add it on the Secrets page`);
  }

  return blockers;
}
