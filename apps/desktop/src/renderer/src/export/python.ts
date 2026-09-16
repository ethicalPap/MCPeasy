import type { GraphDoc } from "@mcpeasy/schema";
import { exportSlug, unsupportedCodeLanguages, type ExportFile } from "./types";

// Python export: a runnable uv project over the official `mcp` SDK's v1
// low-level Server. Same architecture as the TypeScript export: graph.json is
// DATA, server.py is one generic runtime with the engine's semantics, so the
// two language exports (and the in-app test console) cannot drift per-tool.

// Versions verified against pypi.org at generation-feature build time:
// mcp 1.30.0 is the newest v1-line release (pip/uv unpinned now resolves to
// 2.x, so the PyPI readme itself says to keep a `<2` bound while on v1 —
// v1's low-level API matches this runtime); httpx is an mcp 1.30.0
// dependency re-declared here because server.py imports it directly.
const MCP_REQUIREMENT = "mcp>=1.30,<2";
const HTTPX_REQUIREMENT = "httpx>=0.27.1,<1";

function pyprojectToml(doc: GraphDoc, slug: string): string {
  const description = (doc.server.description || "MCP server exported from MCPeasy").replace(/"/g, "'");
  return `[project]
name = "${slug}"
version = "${doc.server.version || "0.1.0"}"
description = "${description.replace(/\r?\n/g, " ")}"
requires-python = ">=3.10"
dependencies = [
    "${MCP_REQUIREMENT}",
    "${HTTPX_REQUIREMENT}",
]
`;
}

/** The generic Python runtime. Kept as one file so `uv run server.py` works
 * with zero project scaffolding knowledge. */
function serverPy(doc: GraphDoc): string {
  const title = doc.server.name || "mcp-server";
  return `"""${title}, exported by MCPeasy.

graph.json is the server definition; this file is a generic runtime that
serves it over stdio with the same semantics as MCPeasy's test console.
From here on this project is yours. Edit freely, or re-export from MCPeasy
and replace graph.json to pick up canvas changes.

    uv sync
    uv run server.py        (serves over stdio, e.g. for Claude Desktop)
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import httpx
import mcp.server.stdio
import mcp.types as types
from mcp.server.lowlevel import NotificationOptions, Server
from mcp.server.models import InitializationOptions

DOC = json.loads((Path(__file__).parent / "graph.json").read_text(encoding="utf-8"))

# Fail at startup, not mid-call: a missing env var at call time would surface
# as a confusing upstream 401 instead of a clear local error.
ENV: dict[str, str] = {}
_missing = [name for name in DOC["server"].get("env", []) if os.environ.get(name) is None]
if _missing:
    # stderr only — stdout belongs to the JSON-RPC transport.
    print("missing required env vars: " + ", ".join(_missing), file=sys.stderr)
    sys.exit(1)
for name in DOC["server"].get("env", []):
    ENV[name] = os.environ[name]

# Command/script/custom-code blocks run with YOUR user permissions. Two gates,
# both required (mirrors MCPeasy's host-grant model): the graph declares
# execution.allowLocal AND the operator sets MCPEASY_ALLOW_LOCAL=1.
ALLOW_LOCAL = (
    DOC["server"].get("execution", {}).get("allowLocal") is True
    and os.environ.get("MCPEASY_ALLOW_LOCAL", "").lower() in ("1", "true")
)

MAX_CHAIN_LENGTH = 50
HTTP_TIMEOUT_S = 15.0
MAX_RESPONSE_BYTES = 1_048_576
LOCAL_TIMEOUT_S = 15.0
MAX_OUTPUT_BYTES = 1_048_576


class ChainError(Exception):
    """Expected chain failure; its message is safe to show the model."""


# ---------------------------------------------------------------------------
# {{...}} templates. The root set is closed on purpose: anything else must
# fail parsing rather than silently pass through to an HTTP request.

REF_RE = re.compile(r"\\{\\{\\s*(input|env|prev)((?:\\.[A-Za-z0-9_$-]+)*)\\s*\\}\\}")


_MISSING = object()  # sentinel: JSON null is a real value, absence is not


def _member(container: Any, segment: str) -> Any:
    # Arrays are objects in the engine's JS lookup: el["0"] indexes them.
    if isinstance(container, dict):
        return container.get(segment, _MISSING)
    if isinstance(container, list):
        if segment.lstrip("-").isdigit():
            index = int(segment)
            return container[index] if 0 <= index < len(container) else _MISSING
        return _MISSING
    return _MISSING


def _lookup(root: str, path: list[str], raw: str, scope: dict[str, Any]) -> Any:
    value: Any = scope[root]
    # Traversing INTO a non-object is an authoring error and raises; a missing
    # LEAF renders as "" (predictable when upstream APIs omit optional fields).
    for segment in path:
        if value is None or value is _MISSING:
            return _MISSING
        if not isinstance(value, (dict, list)):
            raise ChainError(f'{raw}: cannot read "{segment}" of a non-object')
        value = _member(value, segment)
    return None if value is _MISSING else value


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        # Values originate from JSON, so integers stay Python ints and render
        # "1" (not "1.0") — matching what the TS runtime's String() produces.
        return json.dumps(value)
    return json.dumps(value, separators=(",", ":"))


def _encode_component(text: str) -> str:
    # Equivalent of JS encodeURIComponent (same unescaped set).
    from urllib.parse import quote

    return quote(text, safe="-_.!~*'()")


def render_template(template: str, scope: dict[str, Any], encode_runtime: bool = False) -> str:
    out: list[str] = []
    cursor = 0
    for m in REF_RE.finditer(template):
        out.append(template[cursor : m.start()])
        root = m.group(1)
        raw_path = m.group(2) or ""
        path = raw_path[1:].split(".") if raw_path else []
        text = _stringify(_lookup(root, path, m.group(0), scope))
        # URL rendering percent-encodes runtime data (input/prev) so it cannot
        # inject path segments; env refs stay raw so {{env.BASE_URL}}/x works.
        if encode_runtime and root != "env":
            text = _encode_component(text)
        out.append(text)
        cursor = m.end()
    out.append(template[cursor:])
    return "".join(out)


def render_value(template: str, scope: dict[str, Any]) -> Any:
    """A template that is exactly one {{ref}} passes the VALUE through with
    its type intact — this is what lets a POST body of "{{prev}}" forward JSON."""
    m = REF_RE.fullmatch(template)
    if m is not None:
        raw_path = m.group(2) or ""
        path = raw_path[1:].split(".") if raw_path else []
        return _lookup(m.group(1), path, m.group(0), scope)
    return render_template(template, scope)


# ---------------------------------------------------------------------------
# Transforms.


def _pick_into(source: Any, path: str) -> tuple[str, Any]:
    segments = path.split(".")
    # Last segment names the output key: picking "address.city" yields {city}.
    key = segments[-1]
    value: Any = source
    for segment in segments:
        if value is None or not isinstance(value, (dict, list)):
            return key, _MISSING
        value = _member(value, segment)
    return key, value


def _pick_object(source: Any, paths: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for path in paths:
        key, value = _pick_into(source, path)
        # MISSING paths are skipped, not errors — but a present JSON null is a
        # real value and survives, matching the engine's undefined-only skip.
        if value is not _MISSING:
            out[key] = value
    return out


def apply_transform(node: dict[str, Any], scope: dict[str, Any]) -> Any:
    if node["op"] == "pick":
        paths = node.get("pick") or []
        # Arrays map element-wise so picking fields from a list endpoint works.
        if isinstance(scope["prev"], list):
            return [_pick_object(el, paths) for el in scope["prev"]]
        return _pick_object(scope["prev"], paths)
    template = node.get("template")
    if template is None:
        raise ChainError('transform op "template" requires a template string')
    return render_value(template, scope)


# ---------------------------------------------------------------------------
# HTTP actions.

BODY_METHODS = {"POST", "PUT", "PATCH"}


async def run_http_action(node: dict[str, Any], scope: dict[str, Any]) -> Any:
    http = node["http"]
    url = render_template(http["url"], scope, encode_runtime=True)
    # Scheme-less URLs default to https (mirrors the MCPeasy engine). Requires
    # a full "scheme://" so "localhost:3000/x" is not mistaken for a scheme,
    # and explicit non-http schemes still hit the rejection below.
    if not re.match(r"[a-zA-Z][a-zA-Z0-9+.-]*://", url):
        url = "https://" + url
    if not url.startswith(("http://", "https://")):
        raise ChainError(f"only http(s) URLs are allowed: {url}")
    headers = {name: render_template(tpl, scope) for name, tpl in (http.get("headers") or {}).items()}
    body: str | None = None
    if http.get("body") is not None and http["method"] in BODY_METHODS:
        value = render_value(http["body"], scope)
        body = value if isinstance(value, str) else json.dumps(value)
        if not any(k.lower() == "content-type" for k in headers):
            headers["content-type"] = "application/json"
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=HTTP_TIMEOUT_S) as client:
            async with client.stream(http["method"], url, headers=headers, content=body) as response:
                if response.status_code >= 400:
                    # Status only, never the upstream body: error text reaches
                    # the model and the body may quote auth headers or secrets.
                    raise ChainError(f"upstream returned HTTP {response.status_code}")
                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > MAX_RESPONSE_BYTES:
                        raise ChainError(f"response exceeded {MAX_RESPONSE_BYTES} byte cap")
                    chunks.append(chunk)
                text = b"".join(chunks).decode("utf-8", errors="replace")
                content_type = response.headers.get("content-type", "")
    except httpx.TimeoutException:
        raise ChainError(f"request timed out after {int(HTTP_TIMEOUT_S * 1000)} ms") from None
    except httpx.HTTPError:
        # Deliberately no cause message: upstream errors can echo request URLs
        # containing rendered secrets.
        raise ChainError("network error") from None
    if "json" in content_type:
        try:
            return json.loads(text)
        except ValueError:
            raise ChainError("upstream sent invalid JSON") from None
    return text


# ---------------------------------------------------------------------------
# Local execution (command / script / custom code).


def _ensure_local_allowed() -> None:
    if not ALLOW_LOCAL:
        raise ChainError(
            "local execution is disabled, start the server with MCPEASY_ALLOW_LOCAL=1 "
            "(and the graph must declare execution.allowLocal)"
        )


def _child_environment(scope: dict[str, Any]) -> dict[str, str]:
    # Keep the child environment narrow: passing all of os.environ would hand
    # unrelated machine secrets to every executable in the graph.
    inherited = ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "HOME", "TMP", "TEMP"]
    env = {name: os.environ[name] for name in inherited if name in os.environ}
    env.update(scope["env"])
    return env


def _run_process(
    executable: str,
    args: list[str],
    stdin: str | None,
    cwd: str | None,
    env: dict[str, str],
) -> str:
    try:
        # shell=False (the default): a rendered model argument stays one argv
        # value instead of becoming shell syntax.
        completed = subprocess.run(
            [executable, *args],
            input=stdin,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            timeout=LOCAL_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        raise ChainError(f"local process timed out after {int(LOCAL_TIMEOUT_S * 1000)} ms") from None
    except OSError:
        raise ChainError("local process failed to start") from None
    if len(completed.stdout.encode("utf-8", errors="replace")) > MAX_OUTPUT_BYTES:
        raise ChainError(f"local process output exceeded {MAX_OUTPUT_BYTES} bytes")
    if completed.returncode != 0:
        raise ChainError(f"local process exited with code {completed.returncode}")
    return completed.stdout


def _parse_output(stdout: str, output: str) -> Any:
    text = re.sub(r"\\r?\\n$", "", stdout)
    if output == "text":
        return text
    try:
        return json.loads(text)
    except ValueError:
        raise ChainError("local process stdout is not valid JSON") from None


def _rendered_stdin(template: str | None, scope: dict[str, Any]) -> str | None:
    if template is None:
        return None
    value = render_value(template, scope)
    return value if isinstance(value, str) else json.dumps(value)


async def run_command(node: dict[str, Any], scope: dict[str, Any]) -> Any:
    _ensure_local_allowed()
    command = node["command"]
    args = [render_template(arg, scope) for arg in command.get("args", [])]
    stdout = await asyncio.to_thread(
        _run_process,
        command["executable"],
        args,
        _rendered_stdin(command.get("stdin"), scope),
        command.get("cwd"),
        _child_environment(scope),
    )
    return _parse_output(stdout, command["output"])


SCRIPT_RUNTIME = {
    "node": ("node", []),
    "python": (sys.executable, []),
    "powershell": ("powershell", ["-NoProfile", "-File"]),
    "bash": ("bash", []),
}


async def run_script(node: dict[str, Any], scope: dict[str, Any]) -> Any:
    _ensure_local_allowed()
    script = node["script"]
    executable, prefix = SCRIPT_RUNTIME[script["runtime"]]
    args = [*prefix, script["path"], *(render_template(a, scope) for a in script.get("args", []))]
    stdout = await asyncio.to_thread(
        _run_process,
        executable,
        args,
        _rendered_stdin(script.get("stdin"), scope),
        script.get("cwd"),
        _child_environment(scope),
    )
    return _parse_output(stdout, script["output"])


# JavaScript custom-code blocks run through a Node.js child process — Node must
# be installed for graphs that use them. Python blocks skip this entirely and
# run in-process (see _run_python_code). The runner owns stdout as a one-message
# JSON protocol; user console calls go to stderr.
INLINE_RUNNER = r"""
let source = "";
for await (const chunk of process.stdin) source += chunk;
const request = JSON.parse(source);
const log = (...values) => process.stderr.write(values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ") + "\\n");
const customConsole = Object.freeze({ log, info: log, warn: log, error: log });
try {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("input", "env", "prev", "console", "\\"use strict\\";\\n" + request.source);
  const value = await fn(request.input, request.env, request.prev, customConsole);
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch {
  process.stdout.write(JSON.stringify({ ok: false }));
}
"""


async def run_code(node: dict[str, Any], scope: dict[str, Any]) -> Any:
    _ensure_local_allowed()
    language = node.get("language") or "javascript"
    # This runtime is already Python, so a Python block runs in-process: no
    # child, no interpreter lookup, and it works on a machine with no Node.
    if language == "python":
        return _run_python_code(node, scope)
    # JavaScript still needs Node. Every OTHER language would mean embedding
    # that language's runner here too; MCPeasy's desktop engine supports them,
    # the exported runtime does not, and the README says so. Fail loudly with
    # the language named rather than silently producing a wrong answer.
    if language != "javascript":
        raise ChainError(f'custom code language "{language}" is not supported by the exported runtime')
    payload = json.dumps(
        {"source": node["source"], "input": scope["input"], "env": scope["env"], "prev": scope["prev"]}
    )
    stdout = await asyncio.to_thread(
        _run_process,
        "node",
        ["--input-type=module", "--eval", INLINE_RUNNER],
        payload,
        None,
        _child_environment(scope),
    )
    try:
        envelope = json.loads(stdout)
    except ValueError:
        raise ChainError("custom code returned an invalid result") from None
    if envelope.get("ok") is not True:
        raise ChainError("custom code failed")
    return envelope.get("value")


def _run_python_code(node: dict[str, Any], scope: dict[str, Any]) -> Any:
    # Wrapped in a function so a top-level return is legal, matching the
    # contract every other language's block follows. stdout is redirected to
    # stderr for the duration so a stray print() cannot corrupt the MCP stdio
    # stream this server is speaking on.
    body = "".join("    " + line + "\n" for line in node["source"].split("\n"))
    wrapper = "def __mcpeasy_main(input, env, prev):\n" + (body or "    pass\n")
    namespace: dict[str, Any] = {}
    real_stdout = sys.stdout
    try:
        sys.stdout = sys.stderr
        exec(wrapper, namespace)  # noqa: S102 - the operator declared this graph trusted
        return namespace["__mcpeasy_main"](scope["input"], scope["env"], scope["prev"])
    except Exception:
        # Deliberately opaque: the traceback can contain file paths or secret
        # values from the scope, which must not reach the model.
        raise ChainError("custom code failed") from None
    finally:
        sys.stdout = real_stdout


# ---------------------------------------------------------------------------
# Chain walker.


def _as_structured(value: Any) -> dict[str, Any]:
    # structuredContent must be a JSON OBJECT per the MCP schema; arrays and
    # primitives are wrapped so clients still get typed access at a stable key.
    if isinstance(value, dict):
        return value
    return {"result": value}


def _finish(value: Any, node: dict[str, Any], scope: dict[str, Any]) -> types.CallToolResult:
    if node["format"] == "text":
        template = node.get("template")
        if template is not None:
            text = render_template(template, scope)
        elif isinstance(value, str):
            text = value
        else:
            text = json.dumps(value)
        return types.CallToolResult(content=[types.TextContent(type="text", text=text)])
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=json.dumps(value, indent=2))],
        structuredContent=_as_structured(value),
    )


def _clone_scope(scope: dict[str, Any]) -> dict[str, Any]:
    # Every request and parallel branch owns its prev; input/env sharing is
    # intentional read-only data flow.
    return {"input": scope["input"], "env": scope["env"], "prev": scope["prev"]}


async def _run_parallel(node: dict[str, Any], scope: dict[str, Any], depth: int) -> dict[str, Any]:
    branches = node.get("branches", [])
    if not branches:
        raise ChainError("parallel node has no branches")

    async def run_branch(branch: dict[str, Any]) -> tuple[str, Any]:
        if branch.get("entry") is None:
            raise ChainError(f'parallel branch "{branch["name"]}" is not connected')
        value, returned = await _run_path(branch["entry"], _clone_scope(scope), depth + 1, True)
        if returned is not None:
            raise ChainError(
                f'parallel branch "{branch["name"]}" reaches a return node; return after the join instead'
            )
        return branch["name"], value

    # gather waits for ALL branches so a failed sibling never leaves
    # background work running after the tool result has returned.
    results = await asyncio.gather(*(run_branch(b) for b in branches), return_exceptions=True)
    for result in results:
        if isinstance(result, BaseException):
            raise result
    return dict(r for r in results if not isinstance(r, BaseException))


async def _run_path(
    entry_id: str | None,
    scope: dict[str, Any],
    depth: int,
    allow_natural_end: bool,
) -> tuple[Any, types.CallToolResult | None]:
    cursor = entry_id
    steps = depth
    while cursor is not None:
        steps += 1
        if steps > MAX_CHAIN_LENGTH:
            raise ChainError(f"chain exceeded {MAX_CHAIN_LENGTH} steps")
        node = DOC["nodes"].get(cursor)
        if node is None or node["kind"] == "tool":
            raise ChainError(f'chain step "{cursor}" is not an execution node')
        kind = node["kind"]
        if kind == "action":
            scope["prev"] = await run_http_action(node, scope)
        elif kind == "command":
            scope["prev"] = await run_command(node, scope)
        elif kind == "script":
            scope["prev"] = await run_script(node, scope)
        elif kind == "code":
            scope["prev"] = await run_code(node, scope)
        elif kind == "parallel":
            scope["prev"] = await _run_parallel(node, scope, steps)
        elif kind == "transform":
            scope["prev"] = apply_transform(node, scope)
        elif kind == "return":
            return scope["prev"], _finish(scope["prev"], node, scope)
        cursor = node.get("next")
    if allow_natural_end:
        return scope["prev"], None
    raise ChainError("chain never reaches a return node")


async def run_chain(entry_id: str | None, scope: dict[str, Any]) -> types.CallToolResult:
    try:
        _, returned = await _run_path(entry_id, _clone_scope(scope), 0, False)
        if returned is not None:
            return returned
        raise ChainError("chain never reaches a return node")
    except ChainError as error:
        return types.CallToolResult(
            isError=True, content=[types.TextContent(type="text", text=str(error))]
        )
    except Exception:
        # Unknown failure: never leak internals, paths, or env values into
        # model-visible error text.
        return types.CallToolResult(
            isError=True, content=[types.TextContent(type="text", text="internal engine error")]
        )


# ---------------------------------------------------------------------------
# MCP wiring (mirrors MCPeasy's engine: one tools/list + tools/call pair over
# the SDK's low-level Server, so the wire format matches the app's preview).


def _tool_input_schema(tool: dict[str, Any]) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []
    for field in tool.get("inputs", []):
        if field["type"] == "enum":
            schema: dict[str, Any] = {"type": "string", "enum": list(field.get("enumValues") or [])}
        else:
            schema = {"type": field["type"]}
        if field.get("description"):
            schema["description"] = field["description"]
        properties[field["name"]] = schema
        if field.get("required") is not False:
            required.append(field["name"])
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


TOOLS: dict[str, dict[str, Any]] = {
    node["name"]: node for node in DOC["nodes"].values() if node["kind"] == "tool"
}

server = Server(DOC["server"]["name"])


@server.list_tools()
async def handle_list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name=tool["name"],
            description=tool["description"],
            inputSchema=_tool_input_schema(tool),
            annotations=types.ToolAnnotations(
                readOnlyHint=tool["annotations"]["readOnly"],
                destructiveHint=tool["annotations"].get("destructive"),
            ),
        )
        for tool in TOOLS.values()
    ]


@server.call_tool()
async def handle_call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
    tool = TOOLS.get(name)
    if tool is None:
        # Unknown tool is a PROTOCOL error (the client addressed nothing),
        # unlike chain failures which are isError tool RESULTS.
        raise ValueError(f"unknown tool: {name}")
    args = arguments or {}
    missing = [
        i["name"] for i in tool.get("inputs", []) if i.get("required") is not False and i["name"] not in args
    ]
    if missing:
        raise ValueError("missing required arguments: " + ", ".join(missing))
    # Absent OPTIONAL inputs become "" so templates render deterministically.
    scope_input = {i["name"]: args.get(i["name"], "") for i in tool.get("inputs", [])}
    return await run_chain(tool.get("entry"), {"input": scope_input, "env": ENV, "prev": None})


async def main() -> None:
    # INVARIANT: nothing may write to stdout except the transport — a single
    # stray print() corrupts the JSON-RPC stream. Log to stderr.
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name=DOC["server"]["name"],
                server_version=DOC["server"]["version"],
                capabilities=server.get_capabilities(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={},
                ),
            ),
        )


if __name__ == "__main__":
    asyncio.run(main())
`;
}

function readme(doc: GraphDoc, slug: string): string {
  const envList = doc.server.env.length
    ? doc.server.env.map((n) => `- \`${n}\``).join("\n")
    : "_(none declared)_";
  const hasLocal = Object.values(doc.nodes).some(
    (n) => n.kind === "command" || n.kind === "script" || n.kind === "code",
  );
  const hasCode = Object.values(doc.nodes).some((n) => n.kind === "code");
  return `# ${doc.server.name || slug}

${doc.server.description || "MCP server exported from MCPeasy."}

Exported from MCPeasy as a runnable Python project. \`graph.json\` is the
server definition (it can be re-opened in MCPeasy); \`server.py\` is a generic
runtime that serves it over stdio.
${doc.server.transport === "http" ? `
> **Note on transport.** This graph is set to the \`http\` transport in MCPeasy,
> but the exported runtime serves **stdio**. The MCPeasy desktop app runs the
> http transport itself; the exported project does not yet. The tools and their
> behaviour are identical either way, only the way a client reaches them differs.
` : ""}

## Run

\`\`\`bash
uv sync
uv run server.py
\`\`\`

Requires Python 3.10 or newer ([uv](https://docs.astral.sh/uv/) recommended;
\`pip install "mcp>=1.30,<2" "httpx>=0.27.1,<1"\` also works).

## Required environment variables

${envList}

The server refuses to start while any of these are missing.
${hasLocal ? `
## Local execution

This graph contains command/script/custom-code blocks that run **with your
user permissions**. They stay disabled unless you explicitly start the server
with \`MCPEASY_ALLOW_LOCAL=1\`.${hasCode ? `

Python custom-code blocks run inside this server, with no extra dependency.
JavaScript blocks are executed through a Node.js child process, so Node.js
must be installed for those to work.` : ""}
` : ""}${unsupportedCodeLanguages(doc, ["javascript", "python"]).length > 0 ? `
> **Note on custom-code languages.** This runtime runs Python and JavaScript
> blocks. This graph also uses ${unsupportedCodeLanguages(doc, ["javascript", "python"]).map((l) => `\`${l}\``).join(", ")},
> which the MCPeasy desktop app runs but this exported project does not — those
> blocks raise a clear error naming the language instead of returning a wrong
> result.
` : ""}
## Use with Claude Desktop

Add to \`claude_desktop_config.json\`:

\`\`\`json
{
  "mcpServers": {
    "${slug}": {
      "command": "uv",
      "args": ["run", "--project", "${slug}", "server.py"]
    }
  }
}
\`\`\`

(Adjust the path to where you extracted this project, and add an \`"env"\`
object for the variables listed above.)
`;
}

/** Generate the runnable Python project for a graph doc. `docJson` is the
 * exact serialized doc text so graph.json round-trips back into MCPeasy. */
export function generatePythonProject(doc: GraphDoc, docJson: string): { files: ExportFile[]; slug: string } {
  const slug = exportSlug(doc.server.name);
  const root = slug + "/";
  return {
    slug,
    files: [
      { path: root + "pyproject.toml", content: pyprojectToml(doc, slug) },
      { path: root + "graph.json", content: docJson },
      { path: root + "server.py", content: serverPy(doc) },
      { path: root + "README.md", content: readme(doc, slug) },
      { path: root + ".gitignore", content: ".venv/\n__pycache__/\n" },
    ],
  };
}
