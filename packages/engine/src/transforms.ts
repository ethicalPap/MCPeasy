import type { TransformNode } from "@mcpeasy/schema";
import { EngineError, renderValue, type RenderScope } from "./render.js";

export class TransformError extends EngineError {}

function pickInto(source: unknown, path: string): { key: string; value: unknown } {
  const segments = path.split(".");
  // Last segment names the output key: picking "address.city" yields { city }.
  const key = segments[segments.length - 1]!;
  let value: unknown = source;
  for (const segment of segments) {
    if (value === null || typeof value !== "object") return { key, value: undefined };
    value = (value as Record<string, unknown>)[segment];
  }
  return { key, value };
}

function pickObject(source: unknown, paths: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const { key, value } = pickInto(source, path);
    // Missing paths are skipped, not errors: picking optional API fields is
    // the primary use case. Colliding output keys: last path wins.
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function applyTransform(node: TransformNode, scope: RenderScope): unknown {
  switch (node.op) {
    case "pick": {
      const paths = node.pick ?? [];
      // Arrays map element-wise so "pick three fields from a list endpoint"
      // (the design doc's key journey, §4) needs no separate map op.
      if (Array.isArray(scope.prev)) return scope.prev.map((el) => pickObject(el, paths));
      return pickObject(scope.prev, paths);
    }
    case "template": {
      if (node.template === undefined) {
        throw new TransformError(`transform op "template" requires a template string`);
      }
      return renderValue(node.template, scope);
    }
  }
}
