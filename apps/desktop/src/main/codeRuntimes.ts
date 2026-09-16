import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import process from "node:process";
import { CODE_LANGUAGES, type CodeLanguage } from "@mcpeasy/schema";

// Detects which custom-code interpreters exist on THIS machine, so the editor
// can say "Python is not installed" while the user is writing the block —
// rather than letting them save, connect a client, and discover it as an
// opaque tool failure inside the model's client days later.
//
// Design mirrors claudeCode.ts's CLI detection deliberately: candidate paths
// from PATH honoring PATHEXT on Windows, existence-only probing, and a
// never-rejecting contract so one missing runtime degrades a single row
// instead of taking down the panel.
//
// Existence only, never execution: running an unknown interpreter to ask its
// version would spawn an arbitrary binary from PATH every time the panel
// opens. The engine reports the real failure if the binary is present but
// broken; the editor only needs to answer "is it installed?".

/** Runtimes that ship with MCPeasy, so they cannot be missing. Kept in sync
 *  with CODE_RUNTIME.bundled in packages/engine/src/localExecution.ts — the
 *  engine is the authority on what it can run without help. */
const BUNDLED: ReadonlySet<CodeLanguage> = new Set<CodeLanguage>(["javascript", "typescript"]);

/** Executable base names to look for, in priority order. python3 is listed
 *  first on POSIX because `python` is frequently absent or Python 2 there,
 *  while Windows installers provide `python` and usually no `python3`. */
function executableNames(language: CodeLanguage): string[] {
  const windows = process.platform === "win32";
  switch (language) {
    case "python":
      return windows ? ["python", "python3", "py"] : ["python3", "python"];
    case "bash":
      return ["bash"];
    case "powershell":
      return windows ? ["powershell", "pwsh"] : ["pwsh"];
    case "ruby":
      return ["ruby"];
    case "php":
      return ["php"];
    case "go":
      return ["go"];
    default:
      return [];
  }
}

export interface RuntimeStatus {
  language: CodeLanguage;
  /** True when the block can run with no further setup. */
  available: boolean;
  /** Resolved absolute path, or null when not found / bundled. */
  path: string | null;
  /** True for runtimes MCPeasy ships; the UI hides install hints for these. */
  bundled: boolean;
}

export type RuntimeReport = Record<string, RuntimeStatus>;

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.F_OK);
      return candidate;
    } catch {
      // keep looking — a missing candidate is the normal case, not an error
    }
  }
  return null;
}

/** Expand a bare executable name into concrete candidate paths across PATH,
 *  applying Windows executable extensions so `python` matches `python.exe`. */
function candidatePaths(name: string, env: NodeJS.ProcessEnv): string[] {
  const windows = process.platform === "win32";
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = windows ? [".exe", ".cmd", ".bat"] : [""];
  const out: string[] = [];
  for (const dir of pathValue.split(delimiter)) {
    if (dir.trim() === "") continue;
    for (const extension of extensions) out.push(join(dir, `${name}${extension}`));
  }
  return out;
}

/**
 * Probe every custom-code language. `env` is injectable so tests can drive a
 * synthetic PATH instead of depending on what happens to be installed on the
 * machine running the suite.
 */
export async function detectCodeRuntimes(options: { env?: NodeJS.ProcessEnv } = {}): Promise<RuntimeReport> {
  const env = options.env ?? process.env;
  const report: RuntimeReport = {};
  await Promise.all(
    CODE_LANGUAGES.map(async (language) => {
      if (BUNDLED.has(language)) {
        // The bundled runtime is the process MCPeasy is already running in,
        // so reporting a PATH lookup for it would be both wrong and useless.
        report[language] = { language, available: true, path: null, bundled: true };
        return;
      }
      const names = executableNames(language);
      let found: string | null = null;
      for (const name of names) {
        found = await firstExisting(candidatePaths(name, env));
        if (found !== null) break;
      }
      report[language] = { language, available: found !== null, path: found, bundled: false };
    }),
  );
  return report;
}
