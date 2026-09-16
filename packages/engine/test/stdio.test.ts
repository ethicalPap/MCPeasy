import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { serveStdio } from "../src/stdio.js";

// REGRESSION: Claude Desktop and Claude Code connected to a MCPeasy server,
// the process started, logged "serving ... over stdio" to stderr -- and then
// answered nothing. Every tool was invisible to the model.
//
// Cause: serveStdio built `new StdioServerTransport()` with no arguments, so
// the SDK defaulted to `process.stdin`. In an Electron MAIN process on Windows
// that stream emits "end" immediately, before the client writes a byte, so the
// transport's "data" listener never fired. Reading fd 0 directly works.
//
// These tests pin the SEAM that makes the fix possible -- that serveStdio
// reads from an injected stream rather than reaching for `process.stdin`
// itself. A regression to the no-argument constructor makes the first test
// time out, because nothing written to the injected stream is ever read.

function toolServer(): Server {
  const server = new Server({ name: "probe", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "probe_tool", description: "", inputSchema: { type: "object", properties: {} } }],
  }));
  return server;
}

/** One JSON-RPC line, the framing ReadBuffer expects. */
function line(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

describe("serveStdio", () => {
  it("reads requests from the supplied stdin stream rather than process.stdin", async () => {
    const stdin = new PassThrough();
    const server = toolServer();

    // Capture what the server writes without touching the real descriptor.
    const written: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    const serving = serveStdio(server, { stdin });
    try {
      stdin.write(
        line({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        }),
      );
      stdin.write(line({ jsonrpc: "2.0", method: "notifications/initialized" }));
      stdin.write(line({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));

      // Poll rather than sleep a fixed interval: the SDK answers across several
      // microtask turns and a fixed delay would be flaky on a loaded machine.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !written.join("").includes("probe_tool")) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      process.stdout.write = realWrite;
    }

    const stream = written.join("");
    expect(stream).toContain('"serverInfo"');
    // The actual user-visible symptom: the tool list never arrived.
    expect(stream).toContain("probe_tool");

    await server.close();
    await serving;
  });

  it("resolves when the client closes the pipe", async () => {
    const stdin = new PassThrough();
    const server = toolServer();
    // Deliberately NOT awaiting connect before closing: a client can drop the
    // pipe while the server is still starting. serveStdio registers its close
    // handler before connect precisely so this settles instead of hanging a
    // windowless process that holds decrypted secrets.
    const serving = serveStdio(server, { stdin });
    await server.close();
    await expect(serving).resolves.toBeUndefined();
  });
});
