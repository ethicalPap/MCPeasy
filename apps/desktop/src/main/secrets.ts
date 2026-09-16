import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateProjectName } from "../shared/projectName";
import { SECRET_NAME_MAX_LENGTH, SECRET_NAME_RE } from "../shared/secretName";

// Per-project secret store (user decision): env VALUES stay out of graph docs
// (invariant N5) but should survive restarts, so they live in their own file
//   <projectsRoot>/<id>/secrets.json   { version: 1, encrypted: <base64> }
// encrypted at rest via Electron safeStorage.
//
// WRITE-ONCE SEMANTICS (user decision): secrets behave like API keys — a
// value is seen exactly once, when the user enters it. This module therefore
// exposes NO operation that returns a stored value to the renderer: the
// public surface is list-names / set-one / delete-one / clear-all. The full
// decrypted map stays inside main (readProjectSecrets is exported for main's
// own use — e.g. resolving env at tool-run time — never for IPC exposure).
//
// The whole name→value map is one encrypted blob: one decrypt per operation,
// atomic last-writer-wins write — fine for a single-window app, and it keeps
// even secret NAMES out of plaintext on disk.

/** The slice of Electron's safeStorage this module needs, injected so vitest
 * (plain Node, no Electron runtime) can substitute a fake cipher while
 * main/index.ts passes the real safeStorage. Method names mirror the
 * electron.d.ts SafeStorage API (isEncryptionAvailable/encryptString/
 * decryptString) but are renamed here to make the injection seam obvious. */
export interface SecretsCipher {
  isAvailable(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

// Name rule + length cap live in shared/secretName so the Secrets page's
// inline validation can never drift from this server-side check.
// Entry cap mirrors the schema's env array cap (z.array(...).max(100)).
const MAX_ENTRIES = 100;
// Values are user-pasted API keys/tokens; 8 KiB is far beyond any real
// credential and bounds the file against renderer bugs or abuse.
const MAX_VALUE_LENGTH = 8192;

export type ListSecretNamesResult =
  | { ok: true; names: string[] }
  | { ok: false; error: string };

export type SecretsWriteResult = { ok: true } | { ok: false; error: string };

/** Internal + main-only: the decrypted map. NEVER route this through IPC —
 * the write-once contract depends on values staying on this side. */
export type ReadSecretsResult =
  | { ok: true; secrets: Record<string, string> }
  | { ok: false; error: string };

/** Renderer input is untrusted: verify the id round-trips through the same
 * slug rules saveDocToProject uses, so "..\\evil" can never escape the
 * library root, then confirm the project folder actually exists. */
async function resolveProjectDir(
  projectsRoot: string,
  projectId: unknown,
): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  const idResult = validateProjectName(projectId);
  if (typeof idResult !== "string" || idResult !== projectId) {
    return { ok: false, error: "unknown project" };
  }
  const dir = join(projectsRoot, idResult);
  try {
    if (!(await stat(dir)).isDirectory()) return { ok: false, error: "unknown project" };
  } catch {
    return { ok: false, error: "unknown project" };
  }
  return { ok: true, dir };
}

function nameError(name: unknown): string | null {
  if (typeof name !== "string") return "invalid secret name";
  if (name.length > SECRET_NAME_MAX_LENGTH || !SECRET_NAME_RE.test(name)) {
    return `invalid secret name "${name}" (use UPPER_SNAKE_CASE, e.g. API_KEY)`;
  }
  return null;
}

/** Accept only a plain string→string map that satisfies the env-name rule.
 * Applied to decrypted file content — the file is user-reachable on disk,
 * so it is not trusted either. */
function validateSecretsMap(
  raw: unknown,
): { ok: true; secrets: Record<string, string> } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "secrets must be a name→value object" };
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_ENTRIES) {
    return { ok: false, error: `too many secrets (limit ${MAX_ENTRIES})` };
  }
  const secrets: Record<string, string> = {};
  for (const [name, value] of entries) {
    const bad = nameError(name);
    if (bad !== null) return { ok: false, error: bad };
    if (typeof value !== "string") {
      return { ok: false, error: `secret "${name}" must be a string value` };
    }
    if (value.length > MAX_VALUE_LENGTH) {
      return { ok: false, error: `secret "${name}" is too long (limit ${MAX_VALUE_LENGTH} characters)` };
    }
    secrets[name] = value;
  }
  return { ok: true, secrets };
}

// Distinct decrypt-failure message: the most likely real-world cause is the
// project folder being copied from another machine/OS user (safeStorage keys
// are bound to the OS user), and "corrupt file" would send users down the
// wrong debugging path. The Secrets page shows this verbatim with a
// clear-and-reset option.
const DECRYPT_ERROR =
  "stored secrets could not be decrypted. They are tied to the OS user that saved them. " +
  "You can clear them and re-enter values.";

const CIPHER_UNAVAILABLE_ERROR =
  "OS-level encryption is unavailable (no keychain/keyring), so secrets cannot be stored securely";

const CORRUPT_ERROR = "secrets file is corrupt, you can clear it and re-enter values";

/** Main-internal read of the full decrypted map. Exported for main's own
 * consumers (tests, future run-time env resolution) — no IPC handler may
 * return this to the renderer (write-once contract). */
export async function readProjectSecrets(
  projectsRoot: string,
  cipher: SecretsCipher,
  projectId: unknown,
): Promise<ReadSecretsResult> {
  const resolved = await resolveProjectDir(projectsRoot, projectId);
  if (!resolved.ok) return resolved;
  let fileText: string;
  try {
    fileText = await readFile(join(resolved.dir, "secrets.json"), "utf8");
  } catch {
    // No file yet = a project that never stored secrets, not an error.
    return { ok: true, secrets: {} };
  }
  let encrypted: Buffer;
  try {
    const raw: unknown = JSON.parse(fileText);
    const envelope = raw as { version?: unknown; encrypted?: unknown };
    if (raw === null || typeof raw !== "object" || envelope.version !== 1 || typeof envelope.encrypted !== "string") {
      return { ok: false, error: CORRUPT_ERROR };
    }
    encrypted = Buffer.from(envelope.encrypted, "base64");
  } catch {
    return { ok: false, error: CORRUPT_ERROR };
  }
  // Availability is checked before decrypt too: on Linux without a keyring,
  // decryptString would throw anyway, but this gives the accurate message.
  if (!cipher.isAvailable()) return { ok: false, error: CIPHER_UNAVAILABLE_ERROR };
  let plaintext: string;
  try {
    plaintext = cipher.decrypt(encrypted);
  } catch {
    return { ok: false, error: DECRYPT_ERROR };
  }
  try {
    const validated = validateSecretsMap(JSON.parse(plaintext));
    // A decrypt that yields invalid shape means the blob was tampered with or
    // written by a different app version; surface it as corruption.
    if (!validated.ok) return { ok: false, error: CORRUPT_ERROR };
    return validated;
  } catch {
    return { ok: false, error: CORRUPT_ERROR };
  }
}

/** Encrypt and persist the full map. Private: every public mutation goes
 * through read-modify-write here so the on-disk blob is always a complete,
 * validated map. */
async function persistSecrets(
  dir: string,
  cipher: SecretsCipher,
  secrets: Record<string, string>,
): Promise<SecretsWriteResult> {
  // Fail closed: if OS encryption is unavailable the write is refused —
  // NEVER fall back to plaintext on disk (user decision; a silent downgrade
  // would betray the page's "encrypted at rest" promise).
  if (!cipher.isAvailable()) return { ok: false, error: CIPHER_UNAVAILABLE_ERROR };
  let encrypted: Buffer;
  try {
    encrypted = cipher.encrypt(JSON.stringify(secrets));
  } catch (cause) {
    // Encrypt failures don't include secret values in their messages, so the
    // message is safe to surface; never log/echo the map itself.
    return { ok: false, error: cause instanceof Error ? cause.message : "could not encrypt secrets" };
  }
  const envelope = { version: 1, encrypted: encrypted.toString("base64") };
  try {
    await writeFile(join(dir, "secrets.json"), JSON.stringify(envelope, null, 2), "utf8");
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "could not write secrets file" };
  }
  return { ok: true };
}

/** The renderer-visible read: names only, sorted for a stable UI order. */
export async function listProjectSecretNames(
  projectsRoot: string,
  cipher: SecretsCipher,
  projectId: unknown,
): Promise<ListSecretNamesResult> {
  const read = await readProjectSecrets(projectsRoot, cipher, projectId);
  if (!read.ok) return read;
  return { ok: true, names: Object.keys(read.secrets).sort() };
}

/** Create or replace ONE secret. The read-modify-write happens here in main
 * precisely so the renderer never needs (and never gets) the existing map. */
export async function setProjectSecret(
  projectsRoot: string,
  cipher: SecretsCipher,
  projectId: unknown,
  name: unknown,
  value: unknown,
): Promise<SecretsWriteResult> {
  const resolved = await resolveProjectDir(projectsRoot, projectId);
  if (!resolved.ok) return resolved;
  const badName = nameError(name);
  if (badName !== null) return { ok: false, error: badName };
  if (typeof value !== "string") return { ok: false, error: "secret value must be a string" };
  if (value.length > MAX_VALUE_LENGTH) {
    return { ok: false, error: `secret value is too long (limit ${MAX_VALUE_LENGTH} characters)` };
  }
  // An unreadable existing store must FAIL the set, not be silently replaced:
  // wiping other secrets because one write came in would destroy data the
  // user cannot re-derive. Recovery is the explicit clear operation.
  const read = await readProjectSecrets(projectsRoot, cipher, projectId);
  if (!read.ok) return read;
  const next = { ...read.secrets, [name as string]: value };
  if (Object.keys(next).length > MAX_ENTRIES) {
    return { ok: false, error: `too many secrets (limit ${MAX_ENTRIES})` };
  }
  return persistSecrets(resolved.dir, cipher, next);
}

/** Delete ONE secret by name. Deleting a name that is not stored is a no-op
 * success — the user's intent (name gone) already holds. */
export async function deleteProjectSecret(
  projectsRoot: string,
  cipher: SecretsCipher,
  projectId: unknown,
  name: unknown,
): Promise<SecretsWriteResult> {
  const resolved = await resolveProjectDir(projectsRoot, projectId);
  if (!resolved.ok) return resolved;
  if (typeof name !== "string") return { ok: false, error: "invalid secret name" };
  const read = await readProjectSecrets(projectsRoot, cipher, projectId);
  if (!read.ok) return read;
  if (!(name in read.secrets)) return { ok: true };
  const next = { ...read.secrets };
  delete next[name];
  return persistSecrets(resolved.dir, cipher, next);
}

/** Remove the whole store file. Deliberately needs NO cipher: this is the
 * recovery path for an undecryptable store (copied project / OS-user change),
 * which by definition cannot be opened before deletion. */
export async function clearProjectSecrets(
  projectsRoot: string,
  projectId: unknown,
): Promise<SecretsWriteResult> {
  const resolved = await resolveProjectDir(projectsRoot, projectId);
  if (!resolved.ok) return resolved;
  try {
    await rm(join(resolved.dir, "secrets.json"), { force: true });
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "could not delete secrets file" };
  }
  return { ok: true };
}
