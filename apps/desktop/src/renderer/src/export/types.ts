// Shared surface of the language exporters. Exporters are PURE functions of
// the graph doc (schema-only imports, no Node/Electron), so they can live in
// the renderer beside codegen.ts, stay unit-testable, and never drag runtime
// code into the browser bundle.

import type { GraphDoc } from "@mcpeasy/schema";

/** One file of an exported project; path is zip-relative with forward slashes. */
export interface ExportFile {
  path: string;
  content: string;
}

/** Languages the export menu offers. Adding one = new generator + menu item. */
export type ExportLanguage = "typescript" | "python";

/**
 * Package/file-name slug. Deliberately stricter than main's project slugify:
 * npm package names and Python distribution names both want lowercase
 * [a-z0-9-], so the strictest consumer wins here too.
 */
/**
 * Custom-code languages in this doc that the EXPORTED runtimes cannot run.
 *
 * Both generated stacks implement a subset of what MCPeasy's desktop engine
 * does — embedding eight language runners in every export would be a large
 * amount of generated code for a rare graph. The gap is surfaced in each
 * README instead of being discovered at runtime.
 *
 * `supported` differs per exporter: the Python runtime runs Python blocks
 * in-process, the TypeScript one cannot.
 */
export function unsupportedCodeLanguages(
  doc: GraphDoc,
  supported: readonly string[] = ["javascript", "typescript"],
): string[] {
  const seen = new Set<string>();
  for (const node of Object.values(doc.nodes)) {
    if (node.kind !== "code") continue;
    const language = node.language ?? "javascript";
    if (!supported.includes(language)) seen.add(language);
  }
  // Sorted so the README text is deterministic; a set's iteration order is
  // insertion order, which would change with unrelated canvas edits.
  return [...seen].sort();
}

export function exportSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "mcp-server";
}
