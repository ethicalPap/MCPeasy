// Single source of truth for the {{...}} template syntax. The engine's
// renderer and the linter's undeclared-env rule both parse through here, so
// the syntax can never drift between "what lint accepts" and "what runs"
// (design decision #5: templating is the ONLY dynamic surface in v1).

export type TemplateRoot = "input" | "env" | "prev";

export interface TemplateRef {
  root: TemplateRoot;
  /** Path segments after the root; empty for bare {{prev}}. */
  path: string[];
  /** The full matched text including braces, for error messages. */
  raw: string;
  start: number;
  end: number;
}

// Roots are a closed set on purpose: anything else ({{secrets.x}}, {{fn(x)}})
// must fail parsing rather than silently pass through to an HTTP request.
// Segment charset allows dashes because JSON keys from real APIs have them.
const REF_RE = /\{\{\s*(input|env|prev)((?:\.[A-Za-z0-9_$-]+)*)\s*\}\}/g;

export function parseTemplateRefs(template: string): TemplateRef[] {
  const refs: TemplateRef[] = [];
  for (const m of template.matchAll(REF_RE)) {
    const root = m[1] as TemplateRoot;
    const rawPath = m[2] ?? "";
    refs.push({
      root,
      path: rawPath === "" ? [] : rawPath.slice(1).split("."),
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return refs;
}

/**
 * True when the whole template is exactly one reference (ignoring whitespace
 * padding outside the braces is deliberately NOT allowed: " {{prev}}" is a
 * string template, "{{prev}}" is a value passthrough). The engine uses this
 * to decide whether a POST body of "{{prev}}" forwards JSON instead of a
 * quoted string.
 */
export function isSingleRef(template: string): boolean {
  const refs = parseTemplateRefs(template);
  return refs.length === 1 && refs[0]!.start === 0 && refs[0]!.end === template.length;
}

/** All env var names referenced anywhere in the given template. */
export function envRefsIn(template: string): string[] {
  return parseTemplateRefs(template)
    .filter((r) => r.root === "env")
    .map((r) => r.path[0] ?? "")
    .filter((n) => n.length > 0);
}
