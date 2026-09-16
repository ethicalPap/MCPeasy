import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/**
 * The stdin stream the transport should read.
 *
 * WHY THIS EXISTS AT ALL: in an Electron MAIN process on Windows,
 * `process.stdin` is created but immediately emits "end" -- before the parent
 * has written a single byte. `StdioServerTransport` attaches its "data"
 * listener to that already-ended stream, so no JSON-RPC request is ever
 * delivered. The server boots, logs to stderr, answers nothing, and the client
 * reports a connection timeout. That is indistinguishable, from the user's
 * side, from "the server has no tools".
 *
 * Measured on this machine with a minimal Electron app containing no MCPeasy
 * code (electron 44.3.0, win32): `process.stdin` emitted "end" before the
 * parent wrote, while `createReadStream("", { fd: 0 })` on the SAME process
 * received the data and echoed it back on stdout.
 *
 * Opening fd 0 directly bypasses Electron's wrapper and gets a plain libuv
 * pipe stream. On the CLI path (plain Node) both work identically, so one code
 * path serves both rather than branching on `process.versions.electron` --
 * fewer shapes to keep correct, and the CLI exercises the same code the
 * desktop app ships.
 *
 * `autoClose: false` is deliberate: fd 0 is owned by the process, and letting
 * the stream close it would break any later reader and can surface as EBADF.
 */
function openStdin(): Readable {
  return createReadStream("", { fd: 0, autoClose: false });
}

/**
 * Serve over stdio (CLI `dev`, desktop serve mode, Claude Desktop/Code).
 *
 * INVARIANT: nothing in this process may write to stdout except the transport
 * -- a single stray console.log corrupts the JSON-RPC stream and the client
 * hangs. All engine and CLI logging goes to stderr for exactly this reason.
 *
 * `stdin` is injectable so tests can drive the transport without touching the
 * real descriptor; production callers pass nothing.
 */
export async function serveStdio(server: Server, options: { stdin?: Readable } = {}): Promise<void> {
  const transport = new StdioServerTransport(options.stdin ?? openStdin());

  // The close signal is taken from the SERVER, not the transport.
  //
  // `Protocol.connect` REPLACES `transport.onclose` with its own wrapper
  // (sdk/shared/protocol.js:221) and routes the original through it. Assigning
  // `transport.onclose` after connect therefore discards that wrapper, and
  // assigning it before connect is only honoured because the SDK happens to
  // chain it -- both couple this function to SDK internals.
  //
  // `server.onclose` is the documented, stable seam and fires from the same
  // path. Registering it BEFORE connect also closes a real race: a client that
  // disconnects while `connect` is still awaiting `transport.start()` would
  // otherwise fire close before any handler existed, and this promise would
  // never settle -- a hung, windowless process holding the user's decrypted
  // secrets in memory.
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });

  await server.connect(transport);
  // Keep the process alive until the client closes the pipe.
  await closed;
}
