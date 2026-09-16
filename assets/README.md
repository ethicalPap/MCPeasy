# assets

Images embedded by the top-level [`README.md`](../README.md).

This directory exists because `.gitignore` line 8 ignores `docs/` wholesale — an
image placed under `docs/` would be silently untracked and every README image
would render as a broken link on GitHub. Keep images here.

| File | Shows | Referenced from |
|---|---|---|
| `wordmark.svg` | The animated "MCPeasy" wordmark in the app's pink→purple brand gradient. **Committed.** | README title |
| `canvas.png` | The graph canvas: a server node fanning out to two tools via *Expose tool*, each tool running an HTTP request and returning JSON. | README "What it looks like" |
| `test-console.png` | The test console: a tool invocation, the raw response, and the collapsible *Input schema as the model sees it*. | README "Test before you connect" |
| `claude-code.png` | Claude Code's `/mcp` listing, showing a connected MCPeasy server and its tools with their read-only annotations. | README "Connect to Claude Code" |

Use these exact filenames — the README links to them directly. The three
screenshots are PNG; please keep them reasonably narrow (the canvas shot is
~1300px wide, which renders without horizontal scrolling on GitHub).

## About `wordmark.svg`

Its two gradient stops are the app's own `.heading-gradient` token
(`apps/desktop/src/renderer/src/styles.css:151`) converted to sRGB hex —
`hsl(340 82% 60%)` = `#ED457D` and `hsl(273 70% 58%)` = `#9B49DF`. **If that
token is ever retuned, retune the SVG with it**, otherwise the README drifts
away from what the running app shows on its welcome screen.

It is deliberately self-contained: GitHub renders README images inside an `img`
element, which SVG 2 processes in [secure animated
mode](https://www.w3.org/TR/SVG2/conform.html#referencing-modes) — declarative
animation runs, but scripts and *external references* are disabled. So the file
carries no webfont and no script, and it animates via SMIL rather than JS. It
also honours `prefers-reduced-motion`, falling back to a flat mid-gradient fill.
