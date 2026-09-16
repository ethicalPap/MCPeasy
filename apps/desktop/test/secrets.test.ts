import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject } from "../src/main/projects";
import {
  clearProjectSecrets,
  deleteProjectSecret,
  listProjectSecretNames,
  readProjectSecrets,
  setProjectSecret,
  type SecretsCipher,
} from "../src/main/secrets";

// Real-tmpdir tests with a fake cipher (same rationale as projects.test.ts):
// the module's job is file layout, validation, and failure routing — the real
// safeStorage needs an Electron runtime vitest doesn't have, and the cipher
// seam exists precisely so these tests exercise everything around it.
//
// The public surface is write-once (user decision): list-names / set-one /
// delete-one / clear-all. readProjectSecrets stays main-internal; tests use
// it to verify what actually landed on disk, exactly as main itself would.

/** Reversible, obviously-not-secure stand-in: base64 with a marker prefix so
 * decrypt can detect "ciphertext" produced by a different key (other OS user). */
function fakeCipher(overrides: Partial<SecretsCipher> = {}): SecretsCipher {
  return {
    isAvailable: () => true,
    encrypt: (text) => Buffer.from(`FAKE:${text}`, "utf8"),
    decrypt: (data) => {
      const text = data.toString("utf8");
      if (!text.startsWith("FAKE:")) throw new Error("decryption failed");
      return text.slice(5);
    },
    ...overrides,
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcpeasy-secrets-"));
  await createProject(root, "p1");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("project secrets store (write-once surface)", () => {
  it("stores per-key writes and lists names only, sorted", async () => {
    const cipher = fakeCipher();
    expect(await setProjectSecret(root, cipher, "p1", "DB_URL", "postgres://localhost")).toEqual({ ok: true });
    expect(await setProjectSecret(root, cipher, "p1", "API_KEY", "sk-123")).toEqual({ ok: true });
    // The renderer-visible read: names, never values.
    expect(await listProjectSecretNames(root, cipher, "p1")).toEqual({ ok: true, names: ["API_KEY", "DB_URL"] });
    // Main-internal read sees the values (this is the tool-run seam).
    expect(await readProjectSecrets(root, cipher, "p1")).toEqual({
      ok: true,
      secrets: { API_KEY: "sk-123", DB_URL: "postgres://localhost" },
    });
  });

  it("replaces one key without touching the others", async () => {
    const cipher = fakeCipher();
    await setProjectSecret(root, cipher, "p1", "A_KEY", "one");
    await setProjectSecret(root, cipher, "p1", "B_KEY", "two");
    await setProjectSecret(root, cipher, "p1", "A_KEY", "changed");
    expect(await readProjectSecrets(root, cipher, "p1")).toEqual({
      ok: true,
      secrets: { A_KEY: "changed", B_KEY: "two" },
    });
  });

  it("deletes one key; deleting an absent key is a no-op success", async () => {
    const cipher = fakeCipher();
    await setProjectSecret(root, cipher, "p1", "A_KEY", "one");
    await setProjectSecret(root, cipher, "p1", "B_KEY", "two");
    expect(await deleteProjectSecret(root, cipher, "p1", "A_KEY")).toEqual({ ok: true });
    expect(await deleteProjectSecret(root, cipher, "p1", "NEVER_WAS")).toEqual({ ok: true });
    expect(await listProjectSecretNames(root, cipher, "p1")).toEqual({ ok: true, names: ["B_KEY"] });
  });

  it("never writes plaintext values to disk", async () => {
    await setProjectSecret(root, fakeCipher(), "p1", "API_KEY", "super-secret-value");
    const onDisk = await readFile(join(root, "p1", "secrets.json"), "utf8");
    expect(onDisk).not.toContain("super-secret-value");
    expect(onDisk).not.toContain("API_KEY");
    expect(JSON.parse(onDisk)).toMatchObject({ version: 1 });
  });

  it("returns an empty name list when no secrets file exists", async () => {
    expect(await listProjectSecretNames(root, fakeCipher(), "p1")).toEqual({ ok: true, names: [] });
  });

  it("rejects unknown and path-escaping project ids", async () => {
    const cipher = fakeCipher();
    expect(await listProjectSecretNames(root, cipher, "nope")).toEqual({ ok: false, error: "unknown project" });
    expect(await setProjectSecret(root, cipher, "../escape", "A", "v")).toEqual({ ok: false, error: "unknown project" });
    expect(await setProjectSecret(root, cipher, 42, "A", "v")).toEqual({ ok: false, error: "unknown project" });
    expect(await clearProjectSecrets(root, "../escape")).toEqual({ ok: false, error: "unknown project" });
  });

  it("reports a corrupt file as corruption, not decryption failure", async () => {
    await writeFile(join(root, "p1", "secrets.json"), "not json at all", "utf8");
    const res = await listProjectSecretNames(root, fakeCipher(), "p1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("corrupt");
  });

  it("reports undecryptable data as tied to the OS user", async () => {
    // Simulates a secrets.json copied from another machine: valid envelope,
    // but ciphertext the local key cannot open.
    const envelope = { version: 1, encrypted: Buffer.from("OTHERKEY:xyz").toString("base64") };
    await writeFile(join(root, "p1", "secrets.json"), JSON.stringify(envelope), "utf8");
    const res = await listProjectSecretNames(root, fakeCipher(), "p1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("OS user");
  });

  it("refuses to set into an undecryptable store instead of wiping it", async () => {
    const envelope = { version: 1, encrypted: Buffer.from("OTHERKEY:xyz").toString("base64") };
    await writeFile(join(root, "p1", "secrets.json"), JSON.stringify(envelope), "utf8");
    const res = await setProjectSecret(root, fakeCipher(), "p1", "API_KEY", "v");
    expect(res.ok).toBe(false);
    // The unreadable file is untouched — recovery is the explicit clear.
    const onDisk = await readFile(join(root, "p1", "secrets.json"), "utf8");
    expect(JSON.parse(onDisk)).toEqual(envelope);
  });

  it("clear removes the store file without needing the cipher", async () => {
    const cipher = fakeCipher();
    await setProjectSecret(root, cipher, "p1", "API_KEY", "v");
    expect(await clearProjectSecrets(root, "p1")).toEqual({ ok: true });
    await expect(readFile(join(root, "p1", "secrets.json"), "utf8")).rejects.toThrow();
    // Clearing again (no file) still succeeds.
    expect(await clearProjectSecrets(root, "p1")).toEqual({ ok: true });
  });

  it("fails closed when the cipher is unavailable — never plaintext", async () => {
    const cipher = fakeCipher({ isAvailable: () => false });
    const write = await setProjectSecret(root, cipher, "p1", "API_KEY", "v");
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.error).toContain("encryption is unavailable");
    // Nothing was written at all — not even an empty envelope.
    await expect(readFile(join(root, "p1", "secrets.json"), "utf8")).rejects.toThrow();
  });

  it("rejects invalid secret names and non-string values", async () => {
    const cipher = fakeCipher();
    const bad = await setProjectSecret(root, cipher, "p1", "lower_case", "v");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("invalid secret name");
    expect((await setProjectSecret(root, cipher, "p1", "1BAD", "v")).ok).toBe(false);
    expect((await setProjectSecret(root, cipher, "p1", 7, "v")).ok).toBe(false);
    expect((await setProjectSecret(root, cipher, "p1", "GOOD", 7)).ok).toBe(false);
    // Valid UPPER_SNAKE names still pass.
    expect(await setProjectSecret(root, cipher, "p1", "API_KEY_2", "v")).toEqual({ ok: true });
  });

  it("caps the number of entries", async () => {
    const cipher = fakeCipher();
    for (let i = 0; i < 100; i++) {
      expect((await setProjectSecret(root, cipher, "p1", `KEY_${i}`, "v")).ok).toBe(true);
    }
    const overflow = await setProjectSecret(root, cipher, "p1", "KEY_100", "v");
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error).toContain("too many secrets");
    // Replacing an existing key still works at the cap.
    expect(await setProjectSecret(root, cipher, "p1", "KEY_0", "v2")).toEqual({ ok: true });
  });

  it("caps value length", async () => {
    const res = await setProjectSecret(root, fakeCipher(), "p1", "API_KEY", "x".repeat(8193));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("too long");
  });
});
