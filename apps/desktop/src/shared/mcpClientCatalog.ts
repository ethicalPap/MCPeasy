// The MCP client catalog: WHICH clients MCPeasy can register a server with,
// and the facts needed to describe them.
//
// This lives in `shared/` rather than `main/` for one reason: the renderer needs
// the same list to draw the catalog, and browser mode needs it to explain what
// it cannot do. Duplicating it would give the app two sources of truth that
// drift the moment a client is added.
//
// It is DATA ONLY — no filesystem access, no node builtins — so it imports
// cleanly into the renderer bundle. All path resolution, reading and writing
// lives in main/mcpClients.ts, which imports this module.
//
// Every external fact here (file path, JSON key, entry shape) is pinned with a
// citation in docs/integrations-mcp-clients.md. Nothing is from memory.

/** Grouping for the catalog UI, following the reference implementation's
 * category rail, narrowed to what MCPeasy can actually talk to. */
export type ClientCategory = "Coding agents" | "Editors" | "Desktop apps";

/** Where a client's config lives, per platform. A null entry means the client
 * does not exist on that platform at all — a different fact from "not
 * installed", and the UI must not conflate them. */
export interface ClientPaths {
  win32: string | null;
  darwin: string | null;
  linux: string | null;
}

export interface McpClientDefinition {
  id: string;
  name: string;
  /** Short label for a narrow tile. */
  shortName: string;
  category: ClientCategory;
  /** One line explaining what connecting actually does for this client. */
  description: string;
  /**
   * The top-level JSON key holding the server map.
   *
   * `"servers"` for VS Code, `"mcpServers"` for the Claude family and Cursor.
   * Writing the wrong key produces a config the client silently ignores, which
   * from the user's side looks identical to a broken server. This is the most
   * consequential per-client difference in the whole catalog.
   */
  serversKey: "mcpServers" | "servers";
  /** Config path per platform. `~` means the home directory and `%APPDATA%`
   * the Windows roaming app-data directory; both are expanded in main. */
  paths: ClientPaths;
  /** Directories whose presence means the app is installed even when no MCP
   * config has been written yet. Without these, a freshly installed client is
   * indistinguishable from an absent one. */
  installHints: ClientPaths;
  /** What the user must do after MCPeasy writes the entry. */
  activationHint: string;
  /** Docs page for this client's MCP support. */
  docsUrl: string;
  /** Free-text search terms, following the reference catalog's `aliases`. */
  aliases: string[];
}

/**
 * The catalog.
 *
 * Deliberately only clients that read a LOCAL JSON config file: that is the
 * only integration MCPeasy can perform honestly without a network call or a
 * vendor account. A client needing an OAuth handshake does not belong here
 * until that flow actually exists.
 */
export const MCP_CLIENTS: McpClientDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    shortName: "Claude Code",
    category: "Coding agents",
    description:
      "Anthropic's terminal coding agent. MCPeasy writes a stdio entry that launches this server headlessly, so declared env values stay in the encrypted store.",
    serversKey: "mcpServers",
    paths: {
      // ~/.claude.json is Claude Code's whole application state, not a
      // dedicated MCP file — see main/claudeCode.ts for why that matters.
      win32: "~/.claude.json",
      darwin: "~/.claude.json",
      linux: "~/.claude.json",
    },
    installHints: { win32: "~/.claude", darwin: "~/.claude", linux: "~/.claude" },
    activationHint: "Start or restart Claude Code to load the server.",
    docsUrl: "https://code.claude.com/docs/en/mcp",
    aliases: ["claude code", "claude", "anthropic", "cli", "terminal", "agent"],
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    shortName: "Claude",
    category: "Desktop apps",
    description:
      "The Claude desktop app. Connecting adds this server to its developer configuration; Claude asks for your approval before each tool call.",
    serversKey: "mcpServers",
    paths: {
      win32: "%APPDATA%/Claude/claude_desktop_config.json",
      darwin: "~/Library/Application Support/Claude/claude_desktop_config.json",
      // The MCP docs describe Claude Desktop as macOS and Windows only.
      linux: null,
    },
    installHints: {
      win32: "%APPDATA%/Claude",
      darwin: "~/Library/Application Support/Claude",
      linux: null,
    },
    activationHint: "Quit Claude Desktop completely and reopen it. It loads MCP servers only at startup.",
    docsUrl: "https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers",
    aliases: ["claude desktop", "claude", "anthropic", "desktop", "app"],
  },
  {
    id: "vscode",
    name: "Visual Studio Code",
    shortName: "VS Code",
    category: "Editors",
    description:
      "GitHub Copilot's agent mode in VS Code. VS Code uses a `servers` key rather than `mcpServers`; MCPeasy handles that difference for you.",
    // VERIFIED DIFFERENT from every other entry — see the serversKey doc above.
    serversKey: "servers",
    paths: {
      win32: "%APPDATA%/Code/User/mcp.json",
      darwin: "~/Library/Application Support/Code/User/mcp.json",
      linux: "~/.config/Code/User/mcp.json",
    },
    installHints: {
      win32: "%APPDATA%/Code/User",
      darwin: "~/Library/Application Support/Code/User",
      linux: "~/.config/Code/User",
    },
    activationHint: "VS Code picks up the change automatically; if not, run “MCP: List Servers” and start it.",
    docsUrl: "https://code.visualstudio.com/docs/agents/reference/mcp-configuration",
    aliases: ["vscode", "vs code", "visual studio code", "copilot", "editor", "microsoft"],
  },
  {
    id: "cursor",
    name: "Cursor",
    shortName: "Cursor",
    category: "Editors",
    description:
      "The Cursor editor's agent. Connecting writes a global entry, making this server available in every Cursor workspace.",
    serversKey: "mcpServers",
    paths: {
      win32: "~/.cursor/mcp.json",
      darwin: "~/.cursor/mcp.json",
      linux: "~/.cursor/mcp.json",
    },
    installHints: { win32: "~/.cursor", darwin: "~/.cursor", linux: "~/.cursor" },
    activationHint: "Open Cursor's Customize panel to enable the server, or restart Cursor.",
    docsUrl: "https://cursor.com/docs/mcp",
    aliases: ["cursor", "editor", "agent", "anysphere"],
  },
];

export function clientById(id: string): McpClientDefinition | undefined {
  return MCP_CLIENTS.find((client) => client.id === id);
}

/** Categories in catalog order, skipping any that hold no clients. Mirrors the
 * reference's `categorySections` so the UI never renders an empty heading. */
export function clientCategories(): ClientCategory[] {
  const seen: ClientCategory[] = [];
  for (const client of MCP_CLIENTS) {
    if (!seen.includes(client.category)) seen.push(client.category);
  }
  return seen;
}
