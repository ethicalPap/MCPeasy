import type { ActionNode } from "@mcpeasy/schema";
import { EngineError, renderTemplate, renderValue, type RenderScope } from "./render.js";

export class HttpActionError extends EngineError {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface HttpPolicy {
  /**
   * "hosted" additionally blocks private/loopback/link-local destinations.
   * This literal-IP check is NOT a DNS-rebinding defense — hosted deploys get
   * a real egress proxy with re-resolution in phase 5 (design §7). It exists
   * from phase 0 so the flag and its tests are load-bearing before hosting.
   */
  mode: "local" | "hosted";
  timeoutMs: number;
  maxResponseBytes: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

// Defaults straight from requirement N4: 15 s upstream timeout, 1 MB cap.
export const DEFAULT_HTTP_POLICY: HttpPolicy = {
  mode: "local",
  timeoutMs: 15_000,
  maxResponseBytes: 1_048_576,
};

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "metadata.google.internal") return true;
  if (isPrivateIpv4(host)) return true;
  // IPv6: loopback, link-local, unique-local, and v4-mapped forms.
  if (host === "::" || host === "::1") return true;
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  return false;
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

export async function runHttpAction(
  node: ActionNode,
  scope: RenderScope,
  policy: HttpPolicy,
): Promise<unknown> {
  // Encode runtime data (input/prev) into the URL; leave env raw so
  // {{env.BASE_URL}}/x composes. See renderTemplate for the rationale.
  let url = renderTemplate(node.http.url, scope, { encode: (ref) => ref.root !== "env" });
  // Scheme-less URLs default to https ("example.com/x" → "https://example.com/x").
  // The check requires a full "scheme://" prefix on purpose: "localhost:3000/x"
  // and "example.com:8080/x" would otherwise parse as (bogus) schemes, and an
  // explicit "file://"-style scheme must still fall through to the http(s)
  // rejection below rather than be silently rewritten to https.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
    url = "https://" + url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpActionError(`invalid URL after templating: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpActionError(`only http(s) URLs are allowed, got ${parsed.protocol}`);
  }
  if (policy.mode === "hosted" && isBlockedHost(parsed.hostname)) {
    throw new HttpActionError(`destination ${parsed.hostname} is blocked on hosted infrastructure`);
  }

  const headers = new Headers();
  for (const [name, template] of Object.entries(node.http.headers ?? {})) {
    headers.set(name, renderTemplate(template, scope));
  }

  let body: string | undefined;
  if (node.http.body !== undefined && BODY_METHODS.has(node.http.method)) {
    const value = renderValue(node.http.body, scope);
    body = typeof value === "string" ? value : JSON.stringify(value);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }

  const fetchImpl = policy.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(parsed, {
      method: node.http.method,
      headers,
      body,
      signal: AbortSignal.timeout(policy.timeoutMs),
      redirect: "follow",
    });
  } catch (cause) {
    const reason =
      cause instanceof Error && cause.name === "TimeoutError"
        ? `timed out after ${policy.timeoutMs} ms`
        : "network error";
    // Deliberately no cause message: upstream errors can echo request URLs
    // containing rendered secrets (§7 secret-leakage threat).
    throw new HttpActionError(`request to ${parsed.hostname} ${reason}`);
  }

  if (!response.ok) {
    // Status only, never the upstream body (§6.3): error text reaches the
    // model and the upstream body may quote auth headers or secrets.
    throw new HttpActionError(`upstream returned HTTP ${response.status}`, response.status);
  }

  const text = await readCapped(response, policy.maxResponseBytes);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpActionError(`upstream sent invalid JSON`);
    }
  }
  return text;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpActionError(`response exceeded ${maxBytes} byte cap`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
