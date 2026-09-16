// Golden-test result normalization (requirement N3). The design doc demands
// "identical results" between engine and every future export target; without
// a canonical form, key order and timing noise make parity flake. This module
// IS the definition of "identical": engine output and compiler output are
// both passed through normalizeResult before comparison.

export interface GoldenResult {
  isError: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}

/** Recursively sort object keys so JSON.stringify is order-stable. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Text content that parses as JSON is compared as sorted JSON — exported
 * FastMCP code will not match our 2-space indentation, and MUST NOT have to.
 * Non-JSON text compares byte-for-byte.
 */
function normalizeText(text: string): string {
  try {
    return JSON.stringify(sortKeys(JSON.parse(text)));
  } catch {
    return text;
  }
}

export function normalizeResult(result: {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
}): GoldenResult {
  const content = Array.isArray(result.content) ? result.content : [];
  return {
    isError: result.isError === true,
    content: content.map((item: { type: string; text?: string }) => ({
      type: item.type,
      ...(item.text !== undefined ? { text: normalizeText(item.text) } : {}),
    })),
    ...(result.structuredContent !== undefined
      ? { structuredContent: sortKeys(result.structuredContent) }
      : {}),
  };
}
