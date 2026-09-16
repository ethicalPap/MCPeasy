import type { McpeasyApi } from "../../../shared/ipc";
import { MCP_CLIENTS } from "../../../shared/mcpClientCatalog";
import * as library from "./library";
import { buildZipBytes } from "./zip";

// Full-parity McpeasyApi for plain-browser mode (user decision: browser mode
// is a DEV convenience but should not silently no-op). Substitutions:
//   projects -> localStorage library    export -> browser download
//   runTool  -> honest error
// Doc I/O is projects-only in both environments (user decision), so there is
// no file-picker/download pair for loose docs anymore — only the zip export.
// The engine bridge genuinely cannot exist here (Node-only MCP transports),
// so ConsolePanel keeps gating on window.mcpeasy — this module is reached
// only through getApi() below, never installed onto window, which keeps
// "window.mcpeasy exists" meaning exactly "preload/Electron is present".

// Browser-mode secrets are SESSION-MEMORY ONLY (user decision): localStorage
// would mean plaintext secrets on disk, which the desktop app explicitly
// refuses (safeStorage fail-closed), so the dev fallback must not be weaker.
// The Secrets page shows a persistent notice explaining values die on reload.
// Write-once applies here too: this map is module-private and only names ever
// leave it — the dev fallback must not be a covert read channel.
const sessionSecrets = new Map<string, Record<string, string>>();

function download(fileName: string, bytes: Uint8Array | string, mime: string): void {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  // Revoke on a delay: revoking synchronously can abort the download in
  // some browsers because the click is processed asynchronously.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const browserApi: McpeasyApi = {
  listProjects() {
    return Promise.resolve(library.listProjects(window.localStorage));
  },

  createProject(name) {
    return Promise.resolve(library.createProject(window.localStorage, name));
  },

  saveDocToProject(req) {
    return Promise.resolve(
      library.saveDocToProject(window.localStorage, req.projectId, req.serverName, req.text),
    );
  },

  readProjectDoc(path) {
    return Promise.resolve(library.readProjectDoc(window.localStorage, path));
  },

  deleteProjectDoc(req) {
    return Promise.resolve(library.deleteProjectDoc(window.localStorage, req.projectId, req.serverPath));
  },

  listProjectSecretNames(projectId) {
    return Promise.resolve({
      ok: true as const,
      names: Object.keys(sessionSecrets.get(projectId) ?? {}).sort(),
    });
  },

  setProjectSecret(req) {
    const map = sessionSecrets.get(req.projectId) ?? {};
    map[req.name] = req.value;
    sessionSecrets.set(req.projectId, map);
    return Promise.resolve({ ok: true as const });
  },

  deleteProjectSecret(req) {
    const map = sessionSecrets.get(req.projectId);
    if (map !== undefined) delete map[req.name];
    return Promise.resolve({ ok: true as const });
  },

  clearProjectSecrets(projectId) {
    sessionSecrets.delete(projectId);
    return Promise.resolve({ ok: true as const });
  },

  exportZip(req) {
    download(req.suggestedName, buildZipBytes(req.files), "application/zip");
    return Promise.resolve({ ok: true, path: req.suggestedName });
  },

  runTool() {
    // Unreachable through the UI (ConsolePanel gates on window.mcpeasy), but
    // the contract demands an answer and it must be honest.
    return Promise.resolve({
      ok: false,
      error: "running tools needs the desktop app (the engine bridge does not exist in a browser)",
    });
  },

  detectCodeRuntimes() {
    // An EMPTY map, not a map of unavailable entries. The renderer reads a
    // missing language as "not checked" and shows no warning; claiming every
    // interpreter is absent would be a false statement about the machine,
    // which is the same rule listMcpClients follows below.
    return Promise.resolve({});
  },

  // Claude Code integration genuinely cannot work here: a browser cannot read
  // the user's home directory or spawn a CLI. These report that plainly rather
  // than silently no-opping, matching the runTool fallback above — the
  // Integrations page renders the unavailable notice from this state.
  getClaudeCodeStatus() {
    return Promise.resolve({
      cliFound: false,
      version: null,
      configPath: "",
      executablePath: null,
      // "unknown", not "unauthenticated": we did not check and must not imply
      // the user is signed out.
      authState: "unknown" as const,
      executableOverride: null,
    });
  },

  registerWithClaudeCode() {
    return Promise.resolve({
      ok: false as const,
      error: "connecting to Claude Code needs the desktop app (a browser cannot read its configuration)",
    });
  },

  unregisterFromClaudeCode() {
    return Promise.resolve({
      ok: false as const,
      error: "disconnecting from Claude Code needs the desktop app",
    });
  },

  listClaudeCodeRegistrations() {
    return Promise.resolve({ ok: true as const, entries: [] });
  },

  setClaudeCodeExecutablePath() {
    return Promise.resolve();
  },

  // The catalog itself is static data, so browser mode can still render the
  // full list — it just cannot inspect the filesystem. Every client is reported
  // as "warning" with the reason stated, rather than "needs_setup", which would
  // assert something about the machine that was never checked.
  listMcpClients() {
    return Promise.resolve({
      clients: MCP_CLIENTS.map((client) => ({
        id: client.id,
        name: client.name,
        shortName: client.shortName,
        category: client.category,
        description: client.description,
        serversKey: client.serversKey,
        activationHint: client.activationHint,
        docsUrl: client.docsUrl,
        aliases: client.aliases,
      })),
      states: MCP_CLIENTS.map((client) => ({
        id: client.id,
        status: "warning" as const,
        statusReason: "A browser cannot read this client's configuration. Use the desktop app.",
        configPath: null,
        configExists: false,
        entries: [],
        error: null,
      })),
      // A browser cannot read the saved doc, so the entry name is genuinely
      // unknown here. null (not a guess) keeps the confirmation dialog honest:
      // it shows "unavailable" rather than a key that may never be written.
      expectedEntryName: null,
      // Same reasoning per server: an empty map means "not known", and the
      // dialog omits the key rather than inventing one. Connecting is refused
      // in browser mode anyway (connectMcpClient below), so no key from here
      // could ever be written.
      entryNames: {},
    });
  },

  connectMcpClient() {
    return Promise.resolve({
      ok: false as const,
      error: "connecting a client needs the desktop app (a browser cannot write its configuration)",
    });
  },

  disconnectMcpClient() {
    return Promise.resolve({
      ok: false as const,
      error: "disconnecting a client needs the desktop app",
    });
  },

  getLocalExecutionGrant() {
    return Promise.resolve({ ok: true as const, granted: false, fingerprint: null });
  },

  grantLocalExecution() {
    return Promise.resolve({
      ok: false as const,
      error: "granting local execution needs the desktop app",
    });
  },

  revokeLocalExecution() {
    return Promise.resolve({ ok: true as const });
  },

  setTheme() {
    return Promise.resolve(); // App already persists the theme in localStorage
  },

  getLastWorkspace() {
    try {
      const raw = window.localStorage.getItem("mcpeasy.lastWorkspace");
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object" && typeof (parsed as { id?: unknown }).id === "string" && typeof (parsed as { name?: unknown }).name === "string") {
          // serverPath is carried through (it used to be silently dropped
          // here and in setLastWorkspace below). Without it browser mode could
          // never restore the last server, so the startup landing always fell
          // through to the workspace home — masking the desktop behaviour it
          // is supposed to mirror. Anything non-string normalises to null so a
          // hand-edited localStorage entry cannot inject a bad path.
          const sp = (parsed as { serverPath?: unknown }).serverPath;
          return Promise.resolve({
            id: (parsed as { id: string }).id,
            name: (parsed as { name: string }).name,
            serverPath: typeof sp === "string" ? sp : null,
          });
        }
      }
    } catch {
      // Corrupt entry — clear and fall through.
      window.localStorage.removeItem("mcpeasy.lastWorkspace");
    }
    return Promise.resolve(null);
  },

  setLastWorkspace(ws) {
    if (ws === null) {
      window.localStorage.removeItem("mcpeasy.lastWorkspace");
    } else {
      // serverPath is persisted so the next launch can reopen the same doc;
      // see getLastWorkspace above for why dropping it was a bug.
      window.localStorage.setItem(
        "mcpeasy.lastWorkspace",
        JSON.stringify({ id: ws.id, name: ws.name, serverPath: ws.serverPath ?? null }),
      );
    }
    return Promise.resolve();
  },

  getAppInfo() {
    return Promise.resolve({ version: "dev (browser)", updateChannelConfigured: false });
  },

  setDirty() {
    // No close-guard to inform; the browser's own beforeunload is out of
    // scope for a dev convenience.
  },
};

/** The one place that picks between preload and the browser fallback. */
export function getApi(): McpeasyApi {
  return window.mcpeasy ?? browserApi;
}
