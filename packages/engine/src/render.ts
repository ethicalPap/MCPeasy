import { isSingleRef, parseTemplateRefs, type TemplateRef } from "@mcpeasy/schema";

// Runtime resolution of the {{...}} refs parsed by @mcpeasy/schema. Kept
// separate from the parser so the browser lint worker never imports runtime
// code, and so parser/renderer can never disagree on syntax.

export interface RenderScope {
  input: Record<string, unknown>;
  env: Record<string, string>;
  prev: unknown;
}

/** Base class for all expected engine failures; callers map these to MCP tool errors. */
export class EngineError extends Error {}

export class TemplateError extends EngineError {}

function lookup(ref: TemplateRef, scope: RenderScope): unknown {
  let value: unknown;
  switch (ref.root) {
    case "input":
      value = scope.input;
      break;
    case "env":
      value = scope.env;
      break;
    case "prev":
      value = scope.prev;
      break;
  }
  // Traversing INTO a non-object is an authoring error and throws; a missing
  // LEAF renders as "" (predictable when upstream APIs omit optional fields).
  for (const segment of ref.path) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object") {
      throw new TemplateError(`${ref.raw}: cannot read "${segment}" of a ${typeof value}`);
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Render a template to a string. `encode` decides per-ref percent-encoding —
 * URL rendering encodes runtime data (input/prev) so it cannot inject path
 * segments or query parameters, while env refs stay raw because operators
 * legitimately template whole base URLs out of env.
 */
export function renderTemplate(
  template: string,
  scope: RenderScope,
  opts?: { encode?: (ref: TemplateRef) => boolean },
): string {
  const refs = parseTemplateRefs(template);
  let out = "";
  let cursor = 0;
  for (const ref of refs) {
    out += template.slice(cursor, ref.start);
    const text = stringify(lookup(ref, scope));
    out += opts?.encode?.(ref) ? encodeURIComponent(text) : text;
    cursor = ref.end;
  }
  return out + template.slice(cursor);
}

/**
 * Render a template that may pass a VALUE through with its type intact: when
 * the whole template is exactly one {{ref}}, the referenced value is returned
 * unstringified. This is what lets a POST body of "{{prev}}" forward JSON.
 */
export function renderValue(template: string, scope: RenderScope): unknown {
  if (isSingleRef(template)) {
    return lookup(parseTemplateRefs(template)[0]!, scope);
  }
  return renderTemplate(template, scope);
}
