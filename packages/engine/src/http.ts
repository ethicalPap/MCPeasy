import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

// Streamable HTTP transport for a graph doc.
//
// The counterpart to stdio.ts. stdio serves ONE client that spawned this
// process and dies with it; HTTP serves clients that connect over a socket and
// outlive any single session. That difference drives every decision here.
//
// SPEC NOTE: this implements MCP's "Streamable HTTP" transport (one endpoint
// handling POST and GET), not the older HTTP+SSE pair. The SDK's
// StreamableHTTPServerTransport is the same class its own docs use, and it is
// already a dependency -- no new package is introduced.

/** Default port. Chosen in the IANA dynamic/private range (49152-65535) so it
 * cannot collide with a registered service, and fixed rather than random so a
 * client config written once keeps working across restarts. */
export const DEFAULT_HTTP_PORT = 51730;

/** The single MCP endpoint. Streamable HTTP puts POST, GET and DELETE on one
 * path, unlike the legacy SSE transport's two. */
export const MCP_PATH = "/mcp";

export interface ServeHttpOptions {
  port?: number;
  /**
   * Interface to bind.
   *
   * Defaults to loopback. THIS DEFAULT IS A SECURITY BOUNDARY, not a
   * preference: a graph can carry local-execution nodes and upstream
   * credentials, so binding 0.0.0.0 by default would expose them to every host
   * on the user's network the moment they picked "http" in a dropdown.
   * Exposing the server beyond this machine has to be a deliberate act.
   */
  host?: string;
  /**
   * Bearer token required on every request, matching `server.auth.type ===
   * "bearer"`. Omitted for `auth.type === "none"`.
   */
  bearerToken?: string;
  /**
   * Extra Host header values to accept, on top of the loopback defaults.
   * Needed when binding a non-loopback interface behind a known name.
   */
  allowedHosts?: string[];
}

export interface HttpServerHandle {
  /** The port actually bound. Differs from the requested port when 0 was
   * passed to request an ephemeral port, which is what tests do. */
  port: number;
  host: string;
  /** The URL a client should be pointed at, endpoint path included. */
  url: string;
  /** Resolves once the listener and the transport are fully closed. */
  close: () => Promise<void>;
}

/** Constant-time compare so a bearer token cannot be recovered byte-by-byte by
 * timing repeated requests. Length is compared first because timingSafeEqual
 * throws on a length mismatch -- length is not secret, the contents are. */
function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract a bearer token from an Authorization header. Returns null for any
 * malformed value rather than guessing at the caller's intent. */
function bearerFrom(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1]!.trim();
}

/** A JSON-RPC shaped error, so an MCP client surfaces something meaningful
 * rather than an opaque HTTP failure. Codes follow JSON-RPC 2.0: -32600 is an
 * invalid request, which is the closest standard code for a rejected one. */
function reject(res: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message }, id: null });
  res.writeHead(status, {
    "content-type": "application/json",
    // Tells a compliant client HOW to authenticate rather than just refusing.
    ...(status === 401 ? { "www-authenticate": 'Bearer realm="mcpeasy"' } : {}),
  });
  res.end(body);
}

/**
 * Serve `server` over Streamable HTTP until the returned handle is closed.
 *
 * Unlike `serveStdio`, this RESOLVES once the listener is up: an HTTP server
 * has no "client closed the pipe" moment, so the caller decides the lifetime.
 * Returning a handle rather than blocking is also what lets tests bind an
 * ephemeral port and tear it down deterministically.
 */
export async function serveHttp(server: Server, options: ServeHttpOptions = {}): Promise<HttpServerHandle> {
  const port = options.port ?? DEFAULT_HTTP_PORT;
  const host = options.host ?? "127.0.0.1";
  const { bearerToken } = options;

  // ORDERING CONSTRAINT: the Host allowlist must name the port actually bound,
  // and with `port: 0` (an OS-assigned ephemeral port) that is only knowable
  // after listen(). But the request handler needs the transport. So the
  // listener is created first with the transport resolved lazily, bound, and
  // only then is the transport built with the real port. Requests cannot
  // arrive in between: nothing is listening until listen() completes, and the
  // guard below is a belt-and-braces answer for a socket accepted in the same
  // tick as bind.
  let transport: StreamableHTTPServerTransport | undefined;

  const httpServer: HttpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Path check first: everything else on this listener is a 404, so a stray
    // probe never reaches the transport.
    const path = (req.url ?? "/").split("?")[0];
    if (path !== MCP_PATH) {
      reject(res, 404, `not found: MCP is served at ${MCP_PATH}`);
      return;
    }

    // Auth BEFORE handing the request to the transport, so an unauthenticated
    // request can never open a session or reach a tool.
    if (bearerToken !== undefined) {
      const presented = bearerFrom(req.headers.authorization);
      if (presented === null || !tokenMatches(bearerToken, presented)) {
        reject(res, 401, "missing or invalid bearer token");
        return;
      }
    }

    // Only reachable if a socket is accepted between bind and the assignment
    // below. 503 rather than 500: the condition is transient by construction.
    if (transport === undefined) {
      reject(res, 503, "server is still starting");
      return;
    }

    // handleRequest parses the body itself; no body-parser is involved, so no
    // parsedBody is passed. Errors are reported rather than thrown, because an
    // unhandled rejection in a request listener would take the process down.
    void transport.handleRequest(req, res).catch((cause: unknown) => {
      if (!res.headersSent) {
        reject(res, 500, cause instanceof Error ? cause.message : "request failed");
      }
    });
  });

  await new Promise<void>((resolve, reject_) => {
    httpServer.once("error", reject_);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", reject_);
      resolve();
    });
  });

  const address = httpServer.address();
  // A string address means a unix socket, which this never binds; the object
  // form is the only shape TCP produces.
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  // DNS rebinding protection: a browser page on any site can POST to
  // 127.0.0.1, so a local MCP server is reachable from hostile web content
  // unless the Host header is pinned. The SDK marks these options deprecated
  // in favour of external middleware, but this process IS the only middleware
  // -- there is no proxy in front of it -- so using them is correct here.
  //
  // Built from boundPort, never the requested port: see the ordering note above.
  const allowedHosts = [
    `127.0.0.1:${boundPort}`,
    `localhost:${boundPort}`,
    `[::1]:${boundPort}`,
    ...(options.allowedHosts ?? []),
  ];

  transport = new StreamableHTTPServerTransport({
    // Stateful: the session id lets a client resume and lets the server keep
    // per-session streams apart. Stateless mode would break notifications.
    sessionIdGenerator: () => randomUUID(),
    enableDnsRebindingProtection: true,
    allowedHosts,
  });

  try {
    await server.connect(transport);
  } catch (cause) {
    // Never leave a bound listener behind when the transport fails to attach:
    // the port would stay occupied with nothing able to answer on it.
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    throw cause;
  }

  const attached = transport;

  return {
    port: boundPort,
    host,
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${boundPort}${MCP_PATH}`,
    close: async () => {
      // Transport first: closing it ends in-flight SSE streams, so the
      // listener is not left waiting on sockets that will never finish.
      await attached.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
