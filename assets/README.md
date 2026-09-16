# assets

Screenshots embedded by the top-level [`README.md`](../README.md).

This directory exists because `.gitignore` line 8 ignores `docs/` wholesale — an
image placed under `docs/` would be silently untracked and every README image
would render as a broken link on GitHub. Keep screenshots here.

| File | Shows | Referenced from |
|---|---|---|
| `canvas.png` | The graph canvas: a server node fanning out to two tools via *Expose tool*, each tool running an HTTP request and returning JSON. | README "What it looks like" |
| `test-console.png` | The test console: a tool invocation, the raw response, and the collapsible *Input schema as the model sees it*. | README "Test before you connect" |
| `claude-code.png` | Claude Code's `/mcp` listing, showing a connected MCPeasy server and its tools with their read-only annotations. | README "Connect to Claude Code" |

Use these exact filenames — the README links to them directly. PNG, and please
keep them reasonably narrow (the canvas shot is ~1300px wide, which renders
without horizontal scrolling on GitHub).
