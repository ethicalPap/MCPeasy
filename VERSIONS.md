# Dependency versions — phase 0

Every version below was read from the npm registry (`registry.npmjs.org/<pkg>/latest`)
on 2026-09-03 during the phase-0 preflight, per the "never state a version from
memory" rule. Re-verify before each new phase.

## Phases 1–2 additions (desktop app) — registry check 2026-09-04

| Package | Pinned range | Latest at check | Why this choice |
|---|---|---|---|
| electron | ^44.3.0 | 44.3.0 | Latest stable; engines node >= 22.12 matches repo floor; postinstall (binary download) needs `allowBuilds` approval in pnpm-workspace.yaml |
| electron-vite | ^5.0.0 | 5.0.0 | Latest stable; peer `vite ^5 \|\| ^6 \|\| ^7` — this is what pins vite to 7.x here |
| vite | ^7.3.6 | 8.3.0 | **Deliberately NOT latest**: electron-vite 5.0.0's peer range stops at ^7. 7.3.6 is the newest 7.x ("previous" dist-tag). Bump when electron-vite supports 8 |
| @vitejs/plugin-react | ^5.1.2 | 6.1.1 | **Deliberately NOT latest**: 6.x peer-requires vite ^8. 5.1.2 supports vite ^4–^7 |
| react / react-dom | ^19.3.0 | 19.3.0 | Latest stable |
| @types/react / @types/react-dom | ^19.3.0 | 19.3.0 | Match react 19.3 |
| @xyflow/react | ^12.11.6 | 12.11.6 | Latest stable React Flow; peer react >= 17 |
| zustand | ^5.0.15 | 5.0.15 | Latest stable; React Flow itself depends on zustand 4.x internally — both coexist (different majors, separate stores) |

Facts established during the check: electron-vite 5.0.0 defaults to
`src/{main,preload,renderer}` entry points; ESM preloads require
`sandbox:false` (Electron ESM limitation), which is why the preload is
bundled to `.cjs` — keeping the Chromium sandbox ON.

| Package | Pinned range | Latest at check | Why this choice |
|---|---|---|---|
| typescript | ^7.0.2 | 7.0.2 (native/Go "tsgo" line; requires Node >= 16.20) | Latest stable; new major line, so `pnpm typecheck` output should be watched for behavioral drift vs 5.x |
| zod | ^4.5.4 | 4.5.4 | Latest stable major (v4 API). SDK peer range is `^3.25 \|\| ^4.0`, so v4 satisfies both us and the SDK |
| @modelcontextprotocol/sdk | ^1.30.0 | 1.30.0 | Latest stable; ships stdio + Streamable HTTP + InMemoryTransport; peer-depends on zod `^3.25 \|\| ^4.0`; engines node >= 18 |
| commander | ^15.0.0 | 15.0.0 | Latest stable; ESM; engines node >= 22.12 — this sets the repo's Node floor |
| vitest | ^4.1.11 | 4.1.11 | Latest stable; engines `^20 \|\| ^22 \|\| >= 24` |
| tsx | ^4.23.13 | 4.23.13 | Latest stable; runs the CLI from source without a build step in phase 0 |
| @types/node | ^26.4.1 | 26.4.1 | Latest; matches current Node LTS line |
| pnpm | 11.25.0 (packageManager) | 11.25.0 | Latest stable; engines node >= 22.13 |

Registry receipts (facts established):

- **SDK 1.30.0** `dependencies` include `zod ^3.25 || ^4.0` (peer), `zod-to-json-schema`,
  `express ^5`, `hono ^4`; `engines.node >= 18`. Exports include `./server/mcp.js`,
  `./server/stdio.js`, `./inMemory.js` (verified via the 1.30.0 tag's source tree:
  `src/inMemory.ts` exposes `InMemoryTransport.createLinkedPair()`).
- **SDK 1.30.0 docs/server.md** confirms `McpServer` + `registerTool` +
  `StdioServerTransport` usage shape, tool `annotations`, and that a raw JSON
  Schema object is accepted for `inputSchema` (validated internally via ajv).
- **zod 4.5.4** is dual v3/v4: subpath `zod/v4` exists; plain `zod` import is the
  v4 API in the 4.x line.
- **commander 15.0.0** `engines.node >= 22.12` is the strictest floor in the set →
  root `engines.node >= 22.12`.
- **typescript 7.0.2**: the 7.x "latest" is the native compiler line
  (platform-specific optional deps). If `tsc -p` behaves unexpectedly on this
  Windows box, fall back to the 6.x/5.x JS line — noted as a phase-0 risk.

Node runtime on this machine: NOT verified (command execution was unavailable
during preflight; see README "verify locally" checklist).

## Export-to-language additions — registry check 2026-09-08

Versions embedded in EXPORTED projects (apps/desktop/src/renderer/src/export/).
These are strings written into generated package.json / pyproject.toml, not
dependencies of this repo itself.

| Package (ecosystem) | Emitted range | Latest at check | Why this choice |
|---|---|---|---|
| @modelcontextprotocol/sdk (npm) | ^1.30.0 | 1.30.0 | Latest stable; matches the repo's own pin so exported behavior tracks the tested SDK |
| tsx (npm) | ^4.23.13 | 4.23.13 | Latest stable; `npm start` runs server.ts without a build step |
| @types/node (npm) | ^26.4.1 | 26.4.1 | Matches repo pin |
| mcp (PyPI) | >=1.30,<2 | 2.2.0 (v2 line) | **Deliberately NOT latest major**: `pip install mcp` now resolves 2.x, a breaking rework. The generated server.py uses the v1 low-level API (`mcp.server.lowlevel.Server`, verified at py.sdk.modelcontextprotocol.io/v1/low-level-server/), and PyPI's own readme says to keep a `<2` bound while on v1. 1.30.0 is the newest v1 release (checked pypi.org/pypi/mcp/1.30.0) |
| httpx (PyPI) | >=0.27.1,<1 | — | mcp 1.30.0's own floor (`httpx<1.0.0,>=0.27.1` in its requires_dist); re-declared because server.py imports httpx directly |

Facts established: Node's `zlib.crc32` (used by the new dependency-free zip
writer in apps/desktop/src/main/exportZip.ts) landed in Node 22.2 — inside
this repo's `>=22.12` floor, so no archiver package is needed.

## Claude Code integration — docs check 2026-09-15

Claude Code is an EXTERNAL tool this repo integrates with, not a dependency it
installs. No package.json changes. The full citation-backed contract lives in
`docs/integrations-claude-code.md`; this section records only the version facts.

| Component | Observed | Latest at check | Why it matters here |
|---|---|---|---|
| `@anthropic-ai/claude-code` (npm) | 2.1.270 installed locally | 2.1.272 | Not a dependency — the user installs it. Registry entry read for `bin`/`engines` only |
| Claude Code CLI on this machine | `claude.exe` 2.1.270 | — | `claude --version` → `2.1.270 (Claude Code)`; resolved at `%USERPROFILE%\.local\bin\claude.exe` |
| Node floor required by the CLI | `>=22.0.0` | — | Below this repo's own `>=22.12`, so no new constraint |

Facts established (each cited in `docs/integrations-claude-code.md`):

- **The registered launcher must be the Electron app, not the Node CLI.**
  Claude Code expands `${VAR}` in a stdio entry's `env`, but resolves it from
  its *own* process environment — there is no keychain indirection. A config
  file could therefore only carry a plaintext secret, which
  `apps/desktop/src/main/secrets.ts` already refuses to write. Electron
  `safeStorage` decrypts only inside an Electron process, so serve mode lives
  in main.
- **`~/.claude.json` is Claude Code's application state, not an MCP config
  file.** The live file here is ~97 KB with ~100 top-level keys including the
  OAuth session (`oauthAccount`), `machineID`, and 30 per-project trust
  entries. Any write must merge and never clobber.
- **Parse that file only with a case-sensitive JSON parser.** Five project keys
  on this machine differ only by drive-letter case; PowerShell's
  `ConvertFrom-Json` rejects the file outright as having duplicate keys. Node's
  `JSON.parse` is case-sensitive and round-trips all 30 entries intact.
- **`claude auth status` exit code is the documented contract** (0 logged in,
  1 not). Its JSON field names are observed on 2.1.270 but undocumented, so
  they are read defensively or not at all.
- **`CLAUDE_CONFIG_DIR=<dir>` relocates the file to `<dir>/.claude.json`** —
  nested inside the directory, unlike the default where `.claude.json` is a
  sibling of `~/.claude`. Confirmed by probing a nonexistent directory and
  reading the path the CLI reported.
- Server names accepted by `claude mcp` are limited to letters, digits,
  hyphens, and underscores, and the built-in names (`workspace`,
  `claude-in-chrome`, `computer-use`, `Claude Preview`, `Claude Browser`) are
  reserved.
