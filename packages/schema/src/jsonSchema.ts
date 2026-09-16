import type { InputField, ToolNode } from "./types.js";

// The "as the model sees it" projection (requirement F3). This is ALSO the
// contract the compiler must reproduce in exported code, so it lives in
// schema — not the engine — where both can import it without depending on
// each other.

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: false;
}

function fieldSchema(field: InputField): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  switch (field.type) {
    case "string":
      out.type = "string";
      break;
    case "number":
      out.type = "number";
      break;
    case "boolean":
      out.type = "boolean";
      break;
    case "enum":
      // JSON Schema enums carry no separate type; values are all strings in
      // v1 (enumValues is string[]), so type:string keeps clients honest.
      out.type = "string";
      out.enum = [...(field.enumValues ?? [])];
      break;
  }
  if (field.description) out.description = field.description;
  return out;
}

export function toolInputJsonSchema(tool: ToolNode): JsonSchemaObject {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const field of tool.inputs) {
    properties[field.name] = fieldSchema(field);
    if (field.required !== false) required.push(field.name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

/** One authoritative MCP projection for the engine, console preview and UI.
 * Keeping this beside toolInputJsonSchema prevents those three surfaces from
 * drifting into subtly different tool definitions. */
export function toolMcpDefinition(tool: ToolNode): McpToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: toolInputJsonSchema(tool),
  };
}
