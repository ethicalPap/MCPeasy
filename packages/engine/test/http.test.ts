import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { serveHttp, type HttpServerHandle } from "../src/http.js";

// The `http` transport was selectable in the UI for a long time while nothing
// implemented it, so these tests exist to keep the option honest: they drive a
// REAL MCP client over a REAL socket rather than asserting on internals.

function toolServer(): Server {
  const server = new Server({ name: "http-probe", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "probe_tool", description: "", inputSchema: { type: "object", properties: {} } }],
  }));
  return server;
}

// Port 0 asks the OS for a free port. A fixed port would make these tests fail
// when run concurrently or when a real MCPeasy server happens to be running.
const EPHEMERAL = 0;

let open: HttpServerHandle[] = [];

async function serve(options: Parameters<typeof serveHttp>[1] = {}): Promise<HttpServerHandle> {
  const handle = await serveHttp(toolServer(), { port: EPHEMERAL, ...options });
  open.push(handle);
  return handle;
}

afterEach(async () => {
  // Leaked listeners would hold the vitest process open and make later runs
  // fail on a bound port, so teardown is unconditional.
  await Promise.all(open.map((h) => h.close().catch(() => {})));
  open = [];
});

describe("serveHttp", () => {
  it("advertises tools to a real MCP client over a socket", async () => {
    const handle = await serve();
    const client = new Client({ name: "test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url));
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("probe_tool");
    } finally {
      await transport.close();
    }
  });

  it("binds loopback by default so the graph is not exposed to the network", async () => {
    const handle = await serve();
    // The default is a security boundary: a graph can hold upstream
    // credentials and local-execution nodes.
    expect(handle.host).toBe("127.0.0.1");
    expect(handle.url.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("serves MCP only at /mcp", async () => {
    const handle = await serve();
    const response = await fetch(`http://127.0.0.1:${handle.port}/not-mcp`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  it("rejects a request with no bearer token when one is configured", async () => {
    const handle = await serve({ bearerToken: "s3cret-token" });
    const response = await fetch(handle.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(401);
    // A compliant client needs to be told HOW to authenticate.
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects a wrong bearer token", async () => {
    const handle = await serve({ bearerToken: "s3cret-token" });
    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it("accepts the correct bearer token end to end", async () => {
    const token = "s3cret-token";
    const handle = await serve({ bearerToken: token });
    const client = new Client({ name: "test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("probe_tool");
    } finally {
      await transport.close();
    }
  });

  it("rejects a foreign Host header (DNS rebinding protection)", async () => {
    const handle = await serve();
    // A browser page on evil.example can POST to 127.0.0.1; pinning Host is
    // what stops hostile web content from driving a local MCP server.
    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        host: "evil.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("stops listening after close", async () => {
    const handle = await serveHttp(toolServer(), { port: EPHEMERAL });
    const { port } = handle;
    await handle.close();
    await expect(
      fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" }),
    ).rejects.toThrow();
  });
});
