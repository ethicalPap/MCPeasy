import { GRAPH_DOC_VERSION } from "./types.js";

/**
 * Upgrades a raw parsed JSON doc to the current version BEFORE validation
 * (validation only understands the current shape). Additive-versioning rule
 * (design decision #2): every released version gets a step function here and
 * steps are applied in order, so a v1 doc keeps loading forever.
 */
const steps: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = {
  // 1 → 2 will be the first real entry. v1 needs no step.
};

export function migrateGraphDoc(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return raw; // not doc-shaped; let validation produce the real error
  }
  const doc = { ...(raw as Record<string, unknown>) };
  if (typeof doc.version !== "number") {
    return raw; // same: validation reports a missing/invalid version
  }
  let version = doc.version;
  if (version > GRAPH_DOC_VERSION) {
    // Downgrades are refused loudly rather than best-effort: a newer editor
    // may rely on fields this build cannot see, and silently dropping them
    // would corrupt the user's doc on the next save.
    throw new Error(
      `graph doc version ${version} is newer than this build supports (${GRAPH_DOC_VERSION}); upgrade mcpeasy`,
    );
  }
  let out = doc;
  while (version < GRAPH_DOC_VERSION) {
    const step = steps[version];
    if (!step) throw new Error(`no migration from graph doc version ${version}`);
    out = step(out);
    version += 1;
    out.version = version;
  }
  return out;
}
