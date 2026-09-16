import { describe, expect, it } from "vitest";
import { HttpActionError, runHttpAction } from "../src/httpAction.js";
import type { ActionNode } from "@mcpeasy/schema";
import type { RenderScope } from "../src/render.js";

function node(partial: Partial<ActionNode["http"]>): ActionNode {
  return { kind: "action", http: { method: "GET", url: "https://api.example.com/x", ...partial }, next: null };
}

function scope(overrides?: Partial<RenderScope>): RenderScope {
  return { input: {}, env: {}, prev: undefined, ...overrides };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const policy = (fetchImpl: typeof fetch, mode: "local" | "hosted" = "local") => ({
  mode,
  timeoutMs: 1000,
  maxResponseBytes: 1024,
  fetchImpl,
});

describe("runHttpAction", () => {
  it("parses JSON responses", async () => {
    const result = await runHttpAction(node({}), scope(), policy(async () => jsonResponse({ ok: 1 })));
    expect(result).toEqual({ ok: 1 });
  });

  it("returns text for non-JSON content types", async () => {
    const result = await runHttpAction(
      node({}),
      scope(),
      policy(async () => new Response("plain", { headers: { "content-type": "text/plain" } })),
    );
    expect(result).toBe("plain");
  });

  it("percent-encodes input refs in URLs but not env refs", async () => {
    let seen = "";
    const impl: typeof fetch = async (url) => {
      seen = String(url);
      return jsonResponse({});
    };
    await runHttpAction(
      node({ url: "{{env.BASE}}/q?text={{input.q}}" }),
      scope({ env: { BASE: "https://api.example.com" }, input: { q: "a b&c" } }),
      policy(impl),
    );
    expect(seen).toBe("https://api.example.com/q?text=a%20b%26c");
  });

  it("sends JSON bodies for single-ref templates and sets content-type", async () => {
    let seenBody: unknown;
    let seenType: string | null = null;
    const impl: typeof fetch = async (_url, init) => {
      seenBody = init?.body;
      seenType = new Headers(init?.headers).get("content-type");
      return jsonResponse({});
    };
    await runHttpAction(
      node({ method: "POST", body: "{{prev}}" }),
      scope({ prev: { a: 1 } }),
      policy(impl),
    );
    expect(seenBody).toBe('{"a":1}');
    expect(seenType).toBe("application/json");
  });

  it("ignores body for GET", async () => {
    let seenBody: unknown = "sentinel";
    const impl: typeof fetch = async (_url, init) => {
      seenBody = init?.body;
      return jsonResponse({});
    };
    await runHttpAction(node({ body: "{{prev}}" }), scope({ prev: { a: 1 } }), policy(impl));
    expect(seenBody).toBeUndefined();
  });

  it("renders templated headers", async () => {
    let auth: string | null = null;
    const impl: typeof fetch = async (_url, init) => {
      auth = new Headers(init?.headers).get("authorization");
      return jsonResponse({});
    };
    await runHttpAction(
      node({ headers: { Authorization: "Bearer {{env.TOKEN}}" } }),
      scope({ env: { TOKEN: "sekrit" } }),
      policy(impl),
    );
    expect(auth).toBe("Bearer sekrit");
  });

  it("maps non-2xx to a status-only error without the upstream body", async () => {
    const impl: typeof fetch = async () =>
      new Response("secret-laden upstream body", { status: 403 });
    await expect(runHttpAction(node({}), scope(), policy(impl))).rejects.toSatisfy((e: unknown) => {
      return (
        e instanceof HttpActionError &&
        e.status === 403 &&
        e.message === "upstream returned HTTP 403" &&
        !e.message.includes("secret")
      );
    });
  });

  it("enforces the response size cap", async () => {
    const impl: typeof fetch = async () =>
      new Response("x".repeat(4096), { headers: { "content-type": "text/plain" } });
    await expect(runHttpAction(node({}), scope(), policy(impl))).rejects.toThrow(/byte cap/);
  });

  it("defaults scheme-less URLs to https", async () => {
    let seen = "";
    const impl: typeof fetch = async (url) => {
      seen = String(url);
      return jsonResponse({});
    };
    await runHttpAction(node({ url: "example.com/items" }), scope(), policy(impl));
    expect(seen).toBe("https://example.com/items");
  });

  it("does not mistake a host:port for a scheme", async () => {
    let seen = "";
    const impl: typeof fetch = async (url) => {
      seen = String(url);
      return jsonResponse({});
    };
    await runHttpAction(node({ url: "localhost:3000/x" }), scope(), policy(impl));
    expect(seen).toBe("https://localhost:3000/x");
  });

  it("leaves explicit http URLs alone", async () => {
    let seen = "";
    const impl: typeof fetch = async (url) => {
      seen = String(url);
      return jsonResponse({});
    };
    await runHttpAction(node({ url: "http://example.com/x" }), scope(), policy(impl));
    expect(seen).toBe("http://example.com/x");
  });

  it("rejects non-http protocols after templating", async () => {
    await expect(
      runHttpAction(node({ url: "file:///etc/passwd" }), scope(), policy(async () => jsonResponse({}))),
    ).rejects.toThrow(/only http/);
  });

  it("blocks private ranges in hosted mode only", async () => {
    const ok = async () => jsonResponse({});
    for (const host of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "172.16.0.9", "169.254.169.254", "localhost", "[::1]"]) {
      await expect(
        runHttpAction(node({ url: `http://${host}/x` }), scope(), policy(ok, "hosted")),
        `expected ${host} to be blocked`,
      ).rejects.toThrow(/blocked/);
    }
    // Same destination is fine locally (CLI dev loop hits localhost APIs).
    await expect(
      runHttpAction(node({ url: "http://127.0.0.1/x" }), scope(), policy(ok, "local")),
    ).resolves.toEqual({});
  });

  it("wraps network failures without leaking the cause message", async () => {
    const impl: typeof fetch = async () => {
      throw new Error("connect ECONNREFUSED with-secret-in-url");
    };
    await expect(runHttpAction(node({}), scope(), policy(impl))).rejects.toSatisfy((e: unknown) => {
      return e instanceof HttpActionError && !e.message.includes("secret");
    });
  });
});
