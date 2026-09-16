import { execFile, type ExecFileException } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { CodeLanguage, CodeNode, CommandNode, LocalOutput, ScriptNode } from "@mcpeasy/schema";
import { EngineError, renderTemplate, renderValue, type RenderScope } from "./render.js";

export interface LocalExecutionPolicy {
  /** Host-owned grant. The graph's allowLocal flag is necessary but cannot
   * grant this permission to itself. */
  enabled: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}

export const DEFAULT_LOCAL_EXECUTION_POLICY: LocalExecutionPolicy = {
  enabled: false,
  timeoutMs: 15_000,
  maxOutputBytes: 1_048_576,
};

export class LocalExecutionError extends EngineError {}

interface ProcessResult {
  stdout: string;
}

/** Keep the child environment intentionally narrow. Passing all of process.env
 * would expose unrelated desktop/CI secrets to every executable in the graph.
 * The declared MCP env values are the only project-specific values inherited. */
function childEnvironment(scope: RenderScope, runAsNode: boolean): NodeJS.ProcessEnv {
  // LOCALAPPDATA/APPDATA/XDG_CACHE_HOME are here for COMPILED languages:
  // `go run` refuses to start without a build cache location and reports
  // "GOCACHE is not defined and %LocalAppData% is not defined". They point
  // at per-user cache directories, not secrets, so inheriting them does not
  // widen the exposure this allowlist exists to prevent.
  const inheritedNames = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "HOME", "TMP", "TEMP",
    "LOCALAPPDATA", "APPDATA", "XDG_CACHE_HOME", "USERPROFILE",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of inheritedNames) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, scope.env);
  if (runAsNode && process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

function runProcess(
  executable: string,
  args: string[],
  stdin: string | undefined,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  policy: LocalExecutionPolicy,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    // execFile launches the executable directly (shell:false), so a rendered
    // model argument remains one argv value instead of becoming shell syntax.
    const child = execFile(
      executable,
      args,
      {
        cwd,
        env,
        encoding: "utf8",
        timeout: policy.timeoutMs,
        maxBuffer: policy.maxOutputBytes,
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout: string) => {
        if (error) {
          if (error.killed === true || typeof error.signal === "string") {
            reject(new LocalExecutionError(`local process timed out after ${policy.timeoutMs} ms`));
          } else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            reject(new LocalExecutionError(`local process output exceeded ${policy.maxOutputBytes} bytes`));
          } else if (typeof error.code === "number") {
            reject(new LocalExecutionError(`local process exited with code ${error.code}`));
          } else {
            reject(new LocalExecutionError("local process failed to start"));
          }
          return;
        }
        resolve({ stdout });
      },
    );
    child.stdin?.end(stdin);
  });
}

function parseOutput(stdout: string, output: LocalOutput): unknown {
  const text = stdout.replace(/\r?\n$/, "");
  if (output === "text") return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new LocalExecutionError("local process stdout is not valid JSON");
  }
}

function renderedStdin(template: string | undefined, scope: RenderScope): string | undefined {
  if (template === undefined) return undefined;
  const value = renderValue(template, scope);
  return typeof value === "string" ? value : JSON.stringify(value);
}

function ensureEnabled(policy: LocalExecutionPolicy): void {
  if (!policy.enabled) {
    throw new LocalExecutionError("local execution is disabled by the host");
  }
}

export async function runCommand(
  node: CommandNode,
  scope: RenderScope,
  policy: LocalExecutionPolicy,
): Promise<unknown> {
  ensureEnabled(policy);
  const args = node.command.args.map((arg) => renderTemplate(arg, scope));
  const result = await runProcess(
    node.command.executable,
    args,
    renderedStdin(node.command.stdin, scope),
    node.command.cwd,
    childEnvironment(scope, false),
    policy,
  );
  return parseOutput(result.stdout, node.command.output);
}

const SCRIPT_RUNTIME: Record<ScriptNode["script"]["runtime"], { executable: () => string; prefix: string[] }> = {
  node: { executable: () => process.execPath, prefix: [] },
  python: { executable: () => "python", prefix: [] },
  powershell: { executable: () => "powershell", prefix: ["-NoProfile", "-File"] },
  bash: { executable: () => "bash", prefix: [] },
};

export async function runScript(
  node: ScriptNode,
  scope: RenderScope,
  policy: LocalExecutionPolicy,
): Promise<unknown> {
  ensureEnabled(policy);
  const runtime = SCRIPT_RUNTIME[node.script.runtime];
  const args = [
    ...runtime.prefix,
    node.script.path,
    ...node.script.args.map((arg) => renderTemplate(arg, scope)),
  ];
  const result = await runProcess(
    runtime.executable(),
    args,
    renderedStdin(node.script.stdin, scope),
    node.script.cwd,
    childEnvironment(scope, node.script.runtime === "node"),
    policy,
  );
  return parseOutput(result.stdout, node.script.output);
}

// The runner owns stdout as a one-message JSON protocol. User console calls go
// to stderr so logging cannot corrupt the returned value. The permission flag
// used below is a seat belt (no fs/child/worker grants), not a malicious-code
// sandbox; UI/CLI approval therefore calls this code trusted explicitly.
const INLINE_RUNNER = String.raw`
let source = "";
for await (const chunk of process.stdin) source += chunk;
const request = JSON.parse(source);
const log = (...values) => process.stderr.write(values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ") + "\n");
const customConsole = Object.freeze({ log, info: log, warn: log, error: log });
try {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("input", "env", "prev", "console", "\"use strict\";\n" + request.source);
  const value = await fn(request.input, request.env, request.prev, customConsole);
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch {
  process.stdout.write(JSON.stringify({ ok: false }));
}
`;

// Every non-JS runner follows the identical contract as the Node one above:
// read a single JSON request from stdin, expose input/env/prev, send exactly
// one JSON envelope on stdout, and keep user logging on stderr. Holding all
// languages to one protocol is what lets runCode stay a single function
// instead of a per-language special case.
//
// Each runner wraps the user's source in a function/scope so that `return` is
// legal at the top level of what the user typed. That is the contract the
// JavaScript runner established and the UI documents, so every language must
// honour it or the same snippet would mean different things per language.

const PYTHON_RUNNER = String.raw`
import sys, json, asyncio, inspect
request = json.loads(sys.stdin.read())
# textwrap.indent would also re-indent blank lines inconsistently across
# versions; a plain per-line prefix keeps the user's own indentation exact.
body = "".join("    " + line + "\n" for line in request["source"].split("\n"))
wrapper = "async def __mcpeasy_main(input, env, prev):\n" + (body or "    pass\n")
scope = {}
try:
    # print() must not corrupt stdout, which carries the result envelope.
    _stdout = sys.stdout
    sys.stdout = sys.stderr
    exec(wrapper, scope)
    value = asyncio.run(scope["__mcpeasy_main"](request["input"], request["env"], request["prev"]))
    sys.stdout = _stdout
    sys.stdout.write(json.dumps({"ok": True, "value": value}))
except BaseException:
    sys.stdout = _stdout
    sys.stdout.write(json.dumps({"ok": False}))
`;

const RUBY_RUNNER = String.raw`
require 'json'
request = JSON.parse($stdin.read)
begin
  # $stdout is reassigned so the user's puts cannot corrupt the envelope.
  real_stdout = $stdout.dup
  $stdout = $stderr
  fn = eval("lambda { |input, env, prev|\n" + request['source'] + "\n}")
  value = fn.call(request['input'], request['env'], request['prev'])
  real_stdout.write(JSON.generate({ 'ok' => true, 'value' => value }))
rescue Exception
  real_stdout.write(JSON.generate({ 'ok' => false }))
end
`;

const PHP_RUNNER = String.raw`
$request = json_decode(file_get_contents('php://stdin'), true);
$err = fopen('php://stderr', 'w');
try {
    // Output buffering sends any user echo to stderr instead of stdout.
    ob_start(function ($chunk) use ($err) { fwrite($err, $chunk); return ''; });
    $fn = eval('return function ($input, $env, $prev) {' . $request['source'] . '};');
    $value = $fn($request['input'], $request['env'], $request['prev']);
    ob_end_flush();
    fwrite(fopen('php://stdout', 'w'), json_encode(['ok' => true, 'value' => $value]));
} catch (Throwable $e) {
    ob_end_flush();
    fwrite(fopen('php://stdout', 'w'), json_encode(['ok' => false]));
}
`;

// Bash and PowerShell have no return-a-value concept, so their contract is
// "write the result to stdout" — the runner reads what the snippet emitted
// and wraps it in the same envelope. Documented in the editor per language.
// Bash is the awkward one, for a reason worth recording: on Windows `bash`
// frequently resolves to the WSL launcher, which crosses an OS boundary and
// does NOT inherit the Windows child environment (verified here: even a
// plain FOO=bar set via execFile arrives empty). So the request cannot be
// passed through env vars — stdin is the only channel that survives, exactly
// like every other language's runner.
//
// Bash also has no JSON parser and requiring jq would add a second
// missing-tool failure mode, so the harness does the parsing: the snippet is
// delivered on fd 3 and the scope values are exported by the preamble that
// the engine prepends. Whatever the snippet writes to stdout becomes the
// value; the wrapper turns it into the standard envelope.
// Bash is invoked as `bash -s`, which reads the SCRIPT ITSELF from stdin.
// That matters on Windows, where `bash` often resolves to the WSL launcher:
// `-c "<runner>"` plus a `$(cat)` inside it deadlocks against itself because
// both the runner and the request want the same pipe, and the runner then
// reads an empty string. Verified: `bash -s` round-trips a script across the
// WSL boundary correctly, while the -c form yielded LEN=0.
//
// Consequence: the whole script (preamble + user source + wrapper) is
// assembled by the engine and sent as one stdin document, so BASH_RUNNER is
// only the trailing wrapper. Bash also has no JSON parser and requiring jq
// would add a second missing-tool failure mode, so the scope values arrive
// as pre-quoted shell assignments and whatever the snippet prints on stdout
// becomes the value.
const BASH_RUNNER = String.raw`
__mcpeasy_status=$?
if [ "$__mcpeasy_status" -ne 0 ]; then
  printf '{"ok":false}'
else
  # Encode the captured stdout as a JSON string without jq: escape the
  # characters JSON forbids raw, then emit it as the value.
  __mcpeasy_esc=$(printf '%s' "$__mcpeasy_out" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' -e 's/\r/\\r/g' | sed -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g')
  printf '{"ok":true,"value":"%s"}' "$__mcpeasy_esc"
fi
`;

// TypeScript: identical to the JS runner except the source is type stripped
// first. Node's stripTypeScriptTypes only ERASES types (no downlevel emit),
// so TS-only runtime constructs (enum, namespace, parameter properties) are
// rejected by design rather than silently mis-executed.
const TYPESCRIPT_RUNNER = String.raw`
import { stripTypeScriptTypes } from "node:module";
let source = "";
for await (const chunk of process.stdin) source += chunk;
const request = JSON.parse(source);
const log = (...values) => process.stderr.write(values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ") + "\n");
const customConsole = Object.freeze({ log, info: log, warn: log, error: log });
try {
  if (typeof stripTypeScriptTypes !== "function") throw new Error("node too old for typescript");
  // Wrapped in a function body first so top-level "return" survives the
  // strip: a bare "return" is a syntax error outside a function.
  const stripped = stripTypeScriptTypes("async function __mcpeasy_main(input, env, prev, console) {\n" + request.source + "\n}", { mode: "strip" });
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("input", "env", "prev", "console", "\"use strict\";\n" + stripped + "\nreturn __mcpeasy_main(input, env, prev, console);");
  const value = await fn(request.input, request.env, request.prev, customConsole);
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch {
  process.stdout.write(JSON.stringify({ ok: false }));
}
`;

// PowerShell writes objects, not return values, so the snippet's output is
// captured and the LAST emitted object becomes the result — matching how a
// PowerShell user expects a script block to "return" something.
//
// The scope variables are DELIBERATELY not named $input: PowerShell reserves
// $input as the automatic pipeline enumerator and silently rebinds it inside
// any script block, so a block reading $input.value got $null. They are set
// as $global: so the block (its own scope) can see them. Verified against
// powershell.exe 5.1 — renaming was the only thing that made it work.
const POWERSHELL_RUNNER = String.raw`
$ErrorActionPreference = 'Stop'
$raw = [Console]::In.ReadToEnd()
$request = $raw | ConvertFrom-Json
try {
  $block = [ScriptBlock]::Create($request.source)
  $global:mcp_input = $request.input
  $global:mcp_env = $request.env
  $global:mcp_prev = $request.prev
  $out = & $block
  $value = if ($out -is [array]) { $out[-1] } else { $out }
  [Console]::Out.Write((ConvertTo-Json @{ ok = $true; value = $value } -Depth 32 -Compress))
} catch {
  [Console]::Out.Write((ConvertTo-Json @{ ok = $false } -Compress))
}
`;

// Go must be compiled, so unlike every other language it needs a real file on
// disk. The temp directory is removed in a finally block even on timeout, or
// each failed tool call would leak a module directory.
const GO_RUNNER_MAIN = String.raw`package main

import (
	"encoding/json"
	"fmt"
	"os"
)

type request struct {
	Input map[string]any ` + "`json:\"input\"`" + `
	Env   map[string]any ` + "`json:\"env\"`" + `
	Prev  any            ` + "`json:\"prev\"`" + `
}

func fail() {
	out, _ := json.Marshal(map[string]any{"ok": false})
	os.Stdout.Write(out)
	os.Exit(0)
}

func main() {
	var req request
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil {
		fail()
	}
	value, err := run(req.Input, req.Env, req.Prev)
	if err != nil {
		fail()
	}
	out, err := json.Marshal(map[string]any{"ok": true, "value": value})
	if err != nil {
		fail()
	}
	fmt.Fprint(os.Stdout, string(out))
}

func run(input map[string]any, env map[string]any, prev any) (any, error) {
`;

/** Go has no eval, so the snippet becomes the body of a real function in a
 *  throwaway module that `go run` compiles. Kept separate from runCode's
 *  single-process path because the temp-file lifecycle has no analogue there. */
async function runGoCode(
  node: CodeNode,
  scope: RenderScope,
  policy: LocalExecutionPolicy,
): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "mcpeasy-go-"));
  try {
    await writeFile(join(dir, "go.mod"), "module mcpeasycode\n\ngo 1.21\n", "utf8");
    await writeFile(join(dir, "main.go"), GO_RUNNER_MAIN + node.source + "\n}\n", "utf8");
    const payload = JSON.stringify({ source: node.source, input: scope.input, env: scope.env, prev: scope.prev });
    let result: ProcessResult;
    try {
      result = await runProcess("go", ["run", "."], payload, dir, childEnvironment(scope, false), policy);
    } catch (error) {
      if (error instanceof LocalExecutionError && /failed to start/.test(error.message)) {
        throw new LocalExecutionError('custom code needs "go" on PATH to run go, and it was not found');
      }
      throw error;
    }
    return parseCodeEnvelope(result.stdout);
  } finally {
    // force:true so cleanup cannot itself throw and mask the real error.
    await rm(dir, { recursive: true, force: true });
  }
}

interface CodeRuntime {
  /** Resolved lazily: process.execPath is only correct at call time, and an
   * interpreter's presence on PATH can change between calls. */
  executable: () => string;
  args: (runner: string) => string[];
  runner: string;
  /** True when the runtime ships with MCPeasy, so it cannot be missing. */
  bundled: boolean;
}

// Declared AFTER every runner constant: this is a `const` object literal that
// reads them eagerly, so hoisting it above their definitions throws a
// temporal-dead-zone ReferenceError at import time. Keep it last.
const CODE_RUNTIME: Record<CodeLanguage, CodeRuntime> = {
  // --permission is a seat belt (no fs/child/worker grants), not a
  // malicious-code sandbox; UI/CLI approval calls this code trusted already.
  javascript: {
    executable: () => process.execPath,
    args: (runner) => ["--permission", "--input-type=module", "--eval", runner],
    runner: INLINE_RUNNER,
    bundled: true,
  },
  // TypeScript runs through the SAME JavaScript runner: the source is type
  // stripped before it reaches the AsyncFunction, so types are erased and
  // never checked. Node >= 22.6 provides stripTypeScriptTypes; the runner
  // degrades to a clean error when the host Node is older.
  typescript: {
    executable: () => process.execPath,
    args: (runner) => ["--permission", "--input-type=module", "--eval", runner],
    runner: TYPESCRIPT_RUNNER,
    bundled: true,
  },
  python: {
    executable: () => (process.platform === "win32" ? "python" : "python3"),
    args: (runner) => ["-c", runner],
    runner: PYTHON_RUNNER,
    bundled: false,
  },
  // -s = read the script from stdin; the engine sends preamble + user source
  // + BASH_RUNNER as one document (see BASH_RUNNER for why -c cannot work).
  bash: {
    executable: () => "bash",
    args: () => ["-s"],
    runner: BASH_RUNNER,
    bundled: false,
  },
  powershell: {
    executable: () => (process.platform === "win32" ? "powershell" : "pwsh"),
    args: (runner) => ["-NoProfile", "-NonInteractive", "-Command", runner],
    runner: POWERSHELL_RUNNER,
    bundled: false,
  },
  ruby: { executable: () => "ruby", args: (runner) => ["-e", runner], runner: RUBY_RUNNER, bundled: false },
  php: { executable: () => "php", args: (runner) => ["-r", runner], runner: PHP_RUNNER, bundled: false },
  // Go has no eval: runGoCode writes the snippet to a temp module and uses
  // `go run`, which compiles it. Slower than the others by design.
  go: { executable: () => "go", args: () => [], runner: "", bundled: false },
};

export async function runCode(
  node: CodeNode,
  scope: RenderScope,
  policy: LocalExecutionPolicy,
): Promise<unknown> {
  ensureEnabled(policy);
  // Default to javascript so a doc written by an older build — where the
  // field was the single literal "javascript" — keeps its exact behavior
  // even if the field were somehow absent.
  const language: CodeLanguage = node.language ?? "javascript";
  const runtime = CODE_RUNTIME[language];
  if (!runtime) throw new LocalExecutionError(`unsupported custom code language "${language}"`);
  if (language === "go") return runGoCode(node, scope, policy);

  // Bash receives a shell script on stdin rather than the JSON request: it
  // cannot parse JSON, and its env is unreliable across the WSL boundary
  // (see BASH_RUNNER). Single-quoted heredoc-free assignment keeps the JSON
  // literal intact — the values are quoted with shellQuote, never
  // interpolated, so a value containing a quote cannot end the assignment.
  const payload = language === "bash"
    ? [
        `MCPEASY_INPUT=${shellQuote(JSON.stringify(scope.input))}`,
        `MCPEASY_ENV=${shellQuote(JSON.stringify(scope.env))}`,
        `MCPEASY_PREV=${shellQuote(JSON.stringify(scope.prev ?? null))}`,
        "export MCPEASY_INPUT MCPEASY_ENV MCPEASY_PREV",
        // The user's source runs inside a command substitution so its stdout
        // is captured as the value instead of corrupting the envelope. 2>&1
        // folds stderr in, since a bash snippet's diagnostics are usually
        // part of what the author means to return.
        `__mcpeasy_out="$(${node.source}\n)"`,
        BASH_RUNNER,
      ].join("\n")
    : JSON.stringify({ source: node.source, input: scope.input, env: scope.env, prev: scope.prev });
  const childEnv = childEnvironment(scope, runtime.bundled);
  let result: ProcessResult;
  try {
    result = await runProcess(
      runtime.executable(),
      runtime.args(runtime.runner),
      payload,
      undefined,
      childEnv,
      policy,
    );
  } catch (error) {
    // A missing interpreter is the single most likely failure for the
    // non-bundled languages, and "local process failed to start" gives the
    // user nothing to act on. Name the runtime they need to install.
    if (!runtime.bundled && error instanceof LocalExecutionError && /failed to start/.test(error.message)) {
      throw new LocalExecutionError(
        `custom code needs "${runtime.executable()}" on PATH to run ${language}, and it was not found`,
      );
    }
    throw error;
  }
  return parseCodeEnvelope(result.stdout);
}

/** POSIX single-quoting: inside '...' the shell expands nothing at all, so
 *  this is the only form where an arbitrary JSON value cannot become shell
 *  syntax. A literal quote is emitted as '\'' (close, escaped quote, reopen),
 *  which is the standard idiom because \' is NOT special inside '...'. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Shared envelope decoding. Failures are deliberately opaque: the child's
 *  exception text can contain file paths or secret values from the scope. */
function parseCodeEnvelope(stdout: string): unknown {
  let envelope: { ok?: unknown; value?: unknown };
  try {
    envelope = JSON.parse(stdout) as { ok?: unknown; value?: unknown };
  } catch {
    throw new LocalExecutionError("custom code returned an invalid result");
  }
  if (envelope.ok !== true) throw new LocalExecutionError("custom code failed");
  return envelope.value;
}
