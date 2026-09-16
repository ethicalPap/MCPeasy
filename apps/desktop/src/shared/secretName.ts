// Secret name rule, shared by the main-process store (server-side validation)
// and the Secrets page (inline feedback) — the projectName.ts precedent: one
// rule set, or a name accepted in the UI could be rejected on write.
//
// The pattern deliberately equals the schema's server.env declaration rule
// (validate.ts: /^[A-Z][A-Z0-9_]*$/) so every storable secret name is usable
// as a {{env.X}} reference and vice versa.

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** Mirrors the schema's LIMITS.maxNameLength; re-declared because shared/
 * modules must stay dependency-free of the schema package (ipc.ts precedent). */
export const SECRET_NAME_MAX_LENGTH = 128;

/** null = valid; otherwise the user-facing reason. */
export function secretNameError(name: string): string | null {
  if (name.length === 0) return "name is required";
  if (name.length > SECRET_NAME_MAX_LENGTH) return `name is too long (limit ${SECRET_NAME_MAX_LENGTH})`;
  if (!SECRET_NAME_RE.test(name)) return "use UPPER_SNAKE_CASE (letters, digits, _; must start with a letter)";
  return null;
}
