import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectCodeRuntimes } from "../src/main/codeRuntimes";

// Detection must follow the MACHINE IT IS GIVEN, not the machine running the
// suite. Every test here drives a synthetic PATH containing fake executables,
// so the results are deterministic whether or not Python/Go/Ruby happen to be
// installed on the developer's box or on CI.

const windows = process.platform === "win32";
/** Windows only recognizes an executable by extension; POSIX by permission
 *  bit. Detection probes existence, so the extension is what must match. */
const exe = (name: string) => (windows ? `${name}.exe` : name);

let root = "";
let binA = "";
let binB = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mcpeasy-runtimes-"));
  binA = join(root, "bin-a");
  binB = join(root, "bin-b");
  await mkdir(binA, { recursive: true });
  await mkdir(binB, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fakeExecutable(dir: string, name: string): Promise<void> {
  await writeFile(join(dir, name), "", { mode: 0o755 });
}

describe("detectCodeRuntimes", () => {
  it("reports the bundled runtimes as available without touching PATH", async () => {
    // JavaScript/TypeScript run on the Node that MCPeasy already is, so an
    // empty PATH must not make them look missing — that would be a false
    // warning on a language that literally cannot be absent.
    const report = await detectCodeRuntimes({ env: { PATH: "" } });
    expect(report.javascript).toMatchObject({ available: true, bundled: true, path: null });
    expect(report.typescript).toMatchObject({ available: true, bundled: true, path: null });
  });

  it("finds an interpreter present on the injected PATH", async () => {
    await fakeExecutable(binA, exe("python"));
    const report = await detectCodeRuntimes({ env: { PATH: binA } });
    expect(report.python?.available).toBe(true);
    expect(report.python?.path).toBe(join(binA, exe("python")));
    expect(report.python?.bundled).toBe(false);
  });

  it("reports an interpreter absent from the injected PATH as unavailable", async () => {
    // The decisive anti-hardcoding check: this machine may well have Go
    // installed, but detection must answer about the PATH it was handed.
    const report = await detectCodeRuntimes({ env: { PATH: binA } });
    expect(report.go?.available).toBe(false);
    expect(report.go?.path).toBeNull();
  });

  it("searches PATH entries in order and returns the first match", async () => {
    await fakeExecutable(binA, exe("ruby"));
    await fakeExecutable(binB, exe("ruby"));
    const first = await detectCodeRuntimes({ env: { PATH: [binA, binB].join(delimiter) } });
    expect(first.ruby?.path).toBe(join(binA, exe("ruby")));
    // Reversing the PATH must move the answer, proving the order is honored
    // rather than a directory being preferred for some other reason.
    const second = await detectCodeRuntimes({ env: { PATH: [binB, binA].join(delimiter) } });
    expect(second.ruby?.path).toBe(join(binB, exe("ruby")));
  });

  it("accepts either executable name for a language with aliases", async () => {
    // POSIX commonly ships python3 without python; Windows the reverse. The
    // language must be reported available in either case.
    const aliasDir = join(root, "bin-alias");
    await mkdir(aliasDir, { recursive: true });
    await fakeExecutable(aliasDir, exe(windows ? "python3" : "python"));
    const report = await detectCodeRuntimes({ env: { PATH: aliasDir } });
    expect(report.python?.available).toBe(true);
  });

  it("covers every language in the schema, so a new one cannot be silently unreported", async () => {
    const report = await detectCodeRuntimes({ env: { PATH: "" } });
    for (const language of ["javascript", "typescript", "python", "bash", "powershell", "ruby", "php", "go"]) {
      expect(report[language], `missing report entry for ${language}`).toBeDefined();
    }
  });

  it("treats an absent PATH variable as no interpreters rather than throwing", async () => {
    // A stripped environment is realistic in a packaged app launch; detection
    // is advisory and must degrade, never break the editor.
    const report = await detectCodeRuntimes({ env: {} });
    expect(report.python?.available).toBe(false);
    expect(report.javascript?.available).toBe(true);
  });

  it("ignores empty PATH segments instead of probing the process cwd", async () => {
    // An empty segment means "current directory" to some shells. Probing it
    // would make detection depend on where the app was launched from.
    const report = await detectCodeRuntimes({ env: { PATH: `${delimiter}${delimiter}` } });
    expect(report.php?.available).toBe(false);
  });
});
