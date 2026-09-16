import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BuildError, buildServer, loadGraphDoc } from "../src/buildServer.js";
import type { GraphDoc } from "@mcpeasy/schema";

// This file is ALSO the phase-2 spike (plan step 4): if buildServer works
// over InMemoryTransport here, the browser test console architecture holds.

function echoDoc(): GraphDoc {
  return {
    version: 1,
    server: { name: "echo-server", version: "0.1.0", transport: "stdio", auth: { type: "none" }, env: [] },
    nodes: {
      tool_echo: {
        kind: "tool",
        name: "echo_message",
        description: "Echo a message back verbatim. Use when you need to test the round trip.",
        inputs: [
          { name: "message", type: "string", description: "Text to echo" },
          { name: "shout", type: "boolean", required: false },
        ],
        annotations: { readOnly: true },
        entry: "t_shape",
      },
      t_shape: { kind: "transform", op: "template", template: "{{input.message}}", next: "r_out" },
      r_out: { kind: "return", format: "text", template: "echo: {{prev}}" },
    },
  };
}

async function connectedClient(
  doc: GraphDoc,
  env: Record<string, string> = {},
  options?: Parameters<typeof buildServer>[2],
) {
  const server = buildServer(doc, env, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("loadGraphDoc", () => {
  it("loads a valid doc", () => {
    expect(() => loadGraphDoc(echoDoc(), {})).not.toThrow();
  });

  it("rejects invalid docs with issue detail", () => {
    expect(() => loadGraphDoc({ version: 1 }, {})).toThrow(BuildError);
  });

  it("rejects missing env vars at startup", () => {
    const doc = echoDoc();
    doc.server.env = ["API_TOKEN"];
    expect(() => loadGraphDoc(doc, {})).toThrow(/missing required env vars: API_TOKEN/);
  });

  it("rejects docs with lint errors, listing them", () => {
    const doc = echoDoc();
    (doc.nodes.tool_echo as { name: string }).name = "bad name";
    expect(() => loadGraphDoc(doc, {})).toThrow(/tool-name-pattern/);
  });

  it("allows docs with only lint warnings", () => {
    const doc = echoDoc();
    (doc.nodes.tool_echo as { description: string }).description = "short";
    expect(() => loadGraphDoc(doc, {})).not.toThrow();
  });

  it("allows an incomplete tool chain so failure is isolated to invocation", () => {
    const doc = echoDoc();
    (doc.nodes.tool_echo as { entry: null }).entry = null;
    expect(() => loadGraphDoc(doc, {})).not.toThrow();
  });
});

describe("buildServer over InMemoryTransport", () => {
  it("publishes the root description in the MCP server identity", async () => {
    const doc = echoDoc();
    doc.server.description = "Echo tools for local testing";
    doc.server.creator = "MCPeasy test suite";
    const client = await connectedClient(doc);
    expect(client.getServerVersion()).toMatchObject({
      name: "echo-server",
      version: "0.1.0",
      description: "Echo tools for local testing",
    });
    expect(client.getServerVersion()).not.toHaveProperty("creator");
    await client.close();
  });

  it("lists tools with schema and annotations as the model sees them", async () => {
    const client = await connectedClient(echoDoc());
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(1);
    const tool = tools.tools[0]!;
    expect(tool.name).toBe("echo_message");
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    });
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    await client.close();
  });

  it("round-trips a tool call through the chain", async () => {
    const client = await connectedClient(echoDoc());
    const result = await client.callTool({
      name: "echo_message",
      arguments: { message: "hello world" },
    });
    expect(result.content).toEqual([{ type: "text", text: "echo: hello world" }]);
    await client.close();
  });

  it("absent optional inputs render as empty string, not 'undefined'", async () => {
    const doc = echoDoc();
    (doc.nodes.t_shape as { template: string }).template = "{{input.message}}/{{input.shout}}";
    const client = await connectedClient(doc);
    const result = await client.callTool({ name: "echo_message", arguments: { message: "x" } });
    expect(result.content).toEqual([{ type: "text", text: "echo: x/" }]);
    await client.close();
  });

  it("chain failures surface as isError tool results, not protocol errors", async () => {
    const doc = echoDoc();
    // Break the chain at runtime: traverse into a primitive.
    (doc.nodes.t_shape as { template: string }).template = "{{input.message.deep}}";
    const client = await connectedClient(doc);
    const result = await client.callTool({ name: "echo_message", arguments: { message: "x" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("reports a missing return only when the incomplete tool is called", async () => {
    const doc = echoDoc();
    (doc.nodes.tool_echo as { entry: null }).entry = null;
    const client = await connectedClient(loadGraphDoc(doc, {}));
    const result = await client.callTool({
      name: "echo_message",
      arguments: { message: "hello" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "chain never reaches a return node" }]);
    await client.close();
  });

  it("requires both graph intent and host permission for local operations", async () => {
    const doc = echoDoc();
    doc.server.execution = { allowLocal: true };
    const tool = doc.nodes.tool_echo!;
    if (tool.kind !== "tool") throw new Error("fixture tool missing");
    doc.nodes.tool_echo = { ...tool, entry: "local" };
    doc.nodes.local = {
      kind: "command",
      command: { executable: process.execPath, args: ["--version"], output: "text" },
      next: "r_out",
    };
    const deniedClient = await connectedClient(doc, {}, { localExecutionPolicy: { enabled: false } });
    const denied = await deniedClient.callTool({ name: "echo_message", arguments: { message: "x" } });
    expect(denied.isError).toBe(true);
    await deniedClient.close();

    const allowedClient = await connectedClient(doc, {}, { localExecutionPolicy: { enabled: true } });
    const allowed = await allowedClient.callTool({ name: "echo_message", arguments: { message: "x" } });
    expect(allowed.isError).not.toBe(true);
    await allowedClient.close();
  });

  it("handles simultaneous calls without sharing request scope", async () => {
    const client = await connectedClient(echoDoc());
    const [first, second] = await Promise.all([
      client.callTool({ name: "echo_message", arguments: { message: "first" } }),
      client.callTool({ name: "echo_message", arguments: { message: "second" } }),
    ]);
    expect(first.content).toEqual([{ type: "text", text: "echo: first" }]);
    expect(second.content).toEqual([{ type: "text", text: "echo: second" }]);
    await client.close();
  });

  it("multiple tools register independently", async () => {
    const doc = echoDoc();
    doc.nodes.tool_two = {
      kind: "tool",
      name: "get_constant",
      description: "Return a constant. Use when you need a fixed value.",
      inputs: [],
      annotations: { readOnly: true },
      entry: "r_const",
    };
    doc.nodes.r_const = { kind: "return", format: "text", template: "42" };
    const client = await connectedClient(doc);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["echo_message", "get_constant"]);
    const result = await client.callTool({ name: "get_constant", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "42" }]);
    await client.close();
  });

  it("env flows from buildServer into templates", async () => {
    const doc = echoDoc();
    doc.server.env = ["GREETING"];
    (doc.nodes.r_out as { template: string }).template = "{{env.GREETING}}: {{prev}}";
    const client = await connectedClient(doc, { GREETING: "hi" });
    const result = await client.callTool({ name: "echo_message", arguments: { message: "x" } });
    expect(result.content).toEqual([{ type: "text", text: "hi: x" }]);
    await client.close();
  });
});
