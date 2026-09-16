# mcpeasy

Visual builder for Model Context Protocol servers. A server is designed as a
**graph doc** (JSON) and run by one **engine** everywhere: browser test
console, local CLI over stdio, hosted over Streamable HTTP. Code export is a
separate compiler validated against the engine by golden tests.

This repo is at **phase 0** of the build plan: schema + engine + CLI `dev`/`lint`,
with the golden harness already in place. See `docs/build-plan.md`.

## Layout

| Path | What |
|---|---|
| `packages/schema` | Graph doc types, zod validation, migrations, the 10 lint rules, JSON Schema projection. Zero runtime deps beyond zod. |
| `packages/engine` | `{{template}}` renderer, transforms, HTTP action (timeout/size cap/private-range guard), chain runner, SDK adapter (`buildServer`), stdio serving. |
| `apps/cli` | `mcpeasy dev <graph.json>` (stdio server), `mcpeasy lint <graph.json>`. |
| `examples/` | Graph docs that double as golden-test fixtures. |
| `tests/golden/` | Golden harness + result normalization (the N3 "identical results" contract). |

## Quickstart

```powershell
corepack enable            # provides pnpm per package.json packageManager
pnpm install
pnpm test                  # vitest: schema, engine, golden suites
pnpm typecheck             # tsc, noEmit

# Run the echo example over stdio (MCP Inspector attaches to this):
pnpm mcpeasy dev examples/echo.json

# Lint a graph doc:
pnpm mcpeasy lint examples/http-get.json
```

### Connect to Claude Code (from the desktop app)

Open a saved server in the desktop app, go to **Integrations**, and press
**Connect** on a client's tile. A dialog states exactly what will happen —
which file is written, the entry name, the JSON key, and that a backup is taken
first — and asks you to type the server's name to confirm. Nothing is written
until that name matches. Start or restart the client to load the server.

Connecting is the only action on that page that writes outside the workspace,
which is why it asks for the same deliberate confirmation as deleting a server.

The registered entry launches **MCPeasy itself in headless serve mode**, not
the CLI. That is what keeps secrets out of the config file: Claude Code's
`${VAR}` expansion resolves from its own environment with no keychain
indirection, so the launched process resolves declared env values from the
encrypted project store instead. The entry holds only a project id and a file
path.

The page blocks the connect and says why when the server is unsaved, has lint
or validation errors, or declares an env var with no stored secret. See
[`docs/integrations-claude-code.md`](docs/integrations-claude-code.md) for the
citation-backed contract this implements against.

### Try it in Claude Desktop (still manual)

Claude Desktop has no MCPeasy registration flow yet — it remains a hand-edited
config. Add to `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "mcpeasy-echo": {
      "command": "pnpm",
      "args": ["--dir", "C:/dev/MCPeasy/MCPeasy", "mcpeasy", "dev", "examples/echo.json"]
    }
  }
}
```

Restart Claude Desktop, then ask it to "echo the message hello".

## Invariants worth knowing before editing

- **Execution lives in `tool.entry` → `node.next` chains.** `edges`/`layout`
  are editor rendering only; the engine never reads them.
- **`{{input.x}} {{env.Y}} {{prev.z}}` is the entire dynamic surface.** No
  expressions, no code, until sandboxing is proven (design decision #5).
- **stdout is sacred in stdio mode.** All logging goes to stderr; one stray
  `console.log` corrupts the JSON-RPC stream.
- **Graph docs never contain secret values** — env var *names* only.
- **A client config written by MCPeasy never contains a secret value.** The
  registered command launches the app in headless serve mode, which decrypts
  declared env values through OS `safeStorage` inside its own process. Writing
  a value into a client config would also contradict the fail-closed rule in
  `apps/desktop/src/main/secrets.ts`, which refuses plaintext on disk.
- **Claude Code's `~/.claude.json` is merged, never replaced.** It holds the
  user's OAuth session and per-project trust decisions, so every MCPeasy write
  backs it up first, writes atomically, and refuses outright when the file
  cannot be parsed.
- **Additive schema changes only**, with a migration step per version bump.
- Upstream HTTP error bodies are never echoed into tool errors (status code
  only) so secrets can't leak into model-visible text.
