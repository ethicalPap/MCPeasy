import { describe, expect, it } from "vitest";
import { toolInputJsonSchema, toolMcpDefinition } from "../src/jsonSchema.js";
import type { ToolNode } from "../src/types.js";

const tool: ToolNode = {
  kind: "tool",
  name: "search_contacts",
  description: "Search contacts. Use when looking people up.",
  inputs: [
    { name: "query", type: "string", description: "Free-text query" },
    { name: "limit", type: "number", required: false },
    { name: "archived", type: "boolean", required: false },
    { name: "sort", type: "enum", enumValues: ["asc", "desc"] },
  ],
  annotations: { readOnly: true },
  entry: null,
};

describe("toolInputJsonSchema", () => {
  it("projects the exact wire shape the model sees", () => {
    expect(toolInputJsonSchema(tool)).toEqual({
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query" },
        limit: { type: "number" },
        archived: { type: "boolean" },
        sort: { type: "string", enum: ["asc", "desc"] },
      },
      required: ["query", "sort"],
      additionalProperties: false,
    });
  });

  it("required omits only fields explicitly marked optional", () => {
    const schema = toolInputJsonSchema(tool);
    expect(schema.required).not.toContain("limit");
    expect(schema.required).toContain("query");
  });

  it("empty inputs yield an empty object schema", () => {
    const empty = toolInputJsonSchema({ ...tool, inputs: [] });
    expect(empty).toEqual({ type: "object", properties: {}, required: [], additionalProperties: false });
  });

  it("projects the official MCP tool definition from editor-friendly inputs", () => {
    expect(toolMcpDefinition(tool)).toEqual({
      name: "search_contacts",
      description: "Search contacts. Use when looking people up.",
      inputSchema: toolInputJsonSchema(tool),
    });
  });
});
