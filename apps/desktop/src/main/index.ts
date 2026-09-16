import { readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, safeStorage } from "electron";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BuildError, buildServer, loadGraphDoc, serveStdio, serveHttp } from "@mcpeasy/engine";
import {
  localExecutionApprovalForTool,
  localExecutionNodeIdsForTool,
  migrateGraphDoc,
  validateGraphDoc,
} from "@mcpeasy/schema";
import { createProject, deleteProjectDoc, listProjects, readProjectDoc, saveDocToProject } from "./projects";
import {
  clearProjectSecrets,
  deleteProjectSecret,
  listProjectSecretNames,
  readProjectSecrets,
  setProjectSecret,
  type SecretsCipher,
} from "./secrets";
import {
  hasLocalExecutionGrant,
  localExecutionFingerprint,
  parseServeArgs,
  resolveDeclaredEnv,
  usesListeningTransport,
  withLocalExecutionGrant,
  withoutLocalExecutionGrant,
} from "./serveMode";
import {
  buildLaunchCommand,
  detectClaudeCode,
  entryNameFor,
  isMcpeasyEntryName,
  listMcpeasyEntries,
  registerServer,
  unregisterServer,
} from "./claudeCode";
import {
  MCP_CLIENTS,
  clientById,
  entryNameFor as clientEntryNameFor,
  inspectClient,
  isMcpeasyEntryName as isMcpeasyClientEntryName,
  registerWithClient,
  resolveClientConfigPath,
  unregisterFromClient,
} from "./mcpClients";
import { buildZip, validateZipEntries } from "./exportZip";
import { detectCodeRuntimes } from "./codeRuntimes";
import type {
  ClaudeCodeStatus,
  CodeRuntimeReport,
  ConnectMcpClientRequest,
  ConnectMcpClientResponse,
  DisconnectMcpClientRequest,
  DisconnectMcpClientResponse,
  ListMcpClientsRequest,
  ListMcpClientsResponse,
  CreateProjectResponse,
  ExportZipRequest,
  ExportZipResponse,
  ClearProjectSecretsResponse,
  ListClaudeCodeRegistrationsResponse,
  LocalExecutionGrantRequest,
  LocalExecutionGrantResponse,
  LocalExecutionGrantStatusRequest,
  LocalExecutionGrantStatusResponse,
  RegisterWithClaudeCodeRequest,
  RegisterWithClaudeCodeResponse,
  UnregisterFromClaudeCodeRequest,
  UnregisterFromClaudeCodeResponse,
  DeleteProjectDocRequest,
  DeleteProjectDocResponse,
  DeleteProjectSecretRequest,
  DeleteProjectSecretResponse,
  LastWorkspace,
  ListProjectSecretNamesResponse,
  ProjectInfo,
  ReadProjectDocResponse,
  SaveDocToProjectRequest,
  SaveDocToProjectResponse,
  SetProjectSecretRequest,
  SetProjectSecretResponse,
  RunToolRequest,
  RunToolResponse,
  ThemePreference,
  ToolRunResult,
} from "../shared/ipc";

// ── App-state persistence (workspace recall) ────────────────────────────
// A single JSON file in userData stores cross-launch state that is NOT part of
// the project library (lastWorkspace today; theme or window geometry later).
// The file is tiny, written at most once per workspace switch, and read once at
// startup, so synchronous JSON round-tripping is fine. Failures are swallowed:
// a missing/corrupt file just means "show the chooser", never a crash.

/** Path is resolved lazily inside handlers because app.getPath is only
 * reliable after "ready". */
function appStatePath(): string {
  return join(app.getPath("userData"), "app-state.json");
}

function readAppState(): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(appStatePath(), "utf8"));
    if (raw !== null && typeof raw === "object") return raw as Record<string, unknown>;
  } catch {
    // Missing or corrupt — start from empty. Not an error.
  }
  return {};
}

function writeAppState(state: Record<string, unknown>): void {
  try {
    writeFileSync(appStatePath(), JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Disk-full or permission issue; swallow — losing the last-workspace
    // recall is annoying, never destructive.
  }
}

// electron-vite sets ELECTRON_RENDERER_URL only in dev; its presence is the
// canonical dev/prod switch per the electron-vite HMR guide.
const devRendererUrl = process.env.ELECTRON_RENDERER_URL;

// out/main/ at runtime. fileURLToPath instead of import.meta.dirname keeps us
// off Node-version-specific ImportMeta typings (dirname needs Node >= 20.11
// AND matching @types; the URL form types identically everywhere).
const mainDir = fileURLToPath(new URL(".", import.meta.url));

// Mirrors the renderer's dirty flag (pushed over "doc:dirty"). Main cannot
// read renderer state synchronously inside a close event, so the guard works
// off this shadow copy instead.
let hasUnsavedChanges = false;
// Session-only approvals: closing MCPeasy forgets them, and changing any local
// node id set yields a new fingerprint that must be confirmed again.
const approvedLocalRuns = new Set<string>();

/** Windows/Linux caption-control (minimize/maximize/close) colors. These are
 * hex mirrors of the renderer's CSS tokens (styles.css) because the overlay
 * is native chrome that cannot read CSS variables: dark = Midnight
 * --background 0 0% 7% (#121212) / --foreground 0 0% 94% (#f0f0f0); light =
 * --background white / a NEUTRAL near-black ink. Both palettes are kept
 * deliberately achromatic — the caption strip must never carry a hue the
 * theme tokens don't (user decision). Keep in sync when tokens change. */
function captionOverlay(): { color: string; symbolColor: string; height: number } {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: dark ? "#121212" : "#ffffff",
    symbolColor: dark ? "#f0f0f0" : "#404040",
    height: 40,
  };
}

/** Re-paint the caption overlay on every open window. Called from the
 * app:set-theme handler AND from nativeTheme "updated": the latter is what
 * keeps the native chrome correct when the OS flips light/dark while the
 * preference is "system" — the renderer's matchMedia listener also fires
 * then, but native chrome must not depend on a renderer round-trip that a
 * suspended/minimized window may delay. */
function syncCaptionOverlays(): void {
  if (process.platform === "darwin") return; // macOS traffic lights are OS-drawn
  for (const win of BrowserWindow.getAllWindows()) {
    win.setTitleBarOverlay(captionOverlay());
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    show: false,
    // Keep the operating system's real minimize/maximize/close controls, but
    // let the renderer use the rest of that row for File, Help, and block
    // search. Rebuilding
    // those controls in HTML would also mean rebuilding platform behavior,
    // accessibility, and maximize state for no product benefit.
    titleBarStyle: "hidden",
    // Created with the palette-matching colors immediately (not fixed white):
    // booting into Midnight must not flash bright caption buttons before the
    // renderer's first app:set-theme round-trip lands.
    ...(process.platform !== "darwin"
      ? { titleBarOverlay: captionOverlay() }
      : {}),
    webPreferences: {
      // contextIsolation and sandbox stay at their secure defaults (both
      // true). The preload is deliberately bundled to CommonJS (see
      // electron.vite.config.ts) because that is what lets the sandbox stay
      // on — flipping sandbox:false here would silently undo that choice.
      preload: join(mainDir, "../preload/index.cjs"),
    },
  });
  // Avoid a white flash on slow first paint; standard Electron pattern.
  win.on("ready-to-show", () => win.show());
  // Losing unsaved edits is the one irreversible action in this app, so it
  // gets friction: closing dirty asks first, and "keep editing" is the
  // default (safe path is the default, dangerous one is deliberate).
  win.on("close", (event) => {
    if (!hasUnsavedChanges) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Discard changes and close", "Keep editing"],
      defaultId: 1,
      cancelId: 1,
      message: "You have unsaved changes",
      detail: "Closing now will discard everything since the last save.",
    });
    if (choice === 1) event.preventDefault();
  });
  // The app renders only local content; any window.open / external
  // navigation attempt is a bug or an injection — refuse both.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = devRendererUrl && url.startsWith(devRendererUrl);
    if (!allowed) event.preventDefault();
  });
  if (devRendererUrl) void win.loadURL(devRendererUrl);
  else void win.loadFile(join(mainDir, "../renderer/index.html"));
}

/** Renderer payloads are untrusted; keep only plain string→string entries. */
function sanitizeEnv(raw: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  if (raw !== null && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string") env[key] = value;
    }
  }
  return env;
}

function registerIpc(): void {
  ipcMain.handle("app:info", () => ({ version: app.getVersion(), updateChannelConfigured: false }));

  ipcMain.handle("app:set-theme", (_event, rawTheme: unknown): void => {
    const theme: ThemePreference | null =
      rawTheme === "system" || rawTheme === "light" || rawTheme === "dark" ? rawTheme : null;
    if (theme === null) throw new Error("invalid theme preference");
    nativeTheme.themeSource = theme;
    // CSS owns the renderer colors, but Windows/Linux caption controls are
    // outside the DOM. Update their overlay too so a dark preference never
    // leaves a bright strip around minimize/maximize/close.
    syncCaptionOverlays();
  });

  ipcMain.on("doc:dirty", (_event, dirty: unknown) => {
    hasUnsavedChanges = dirty === true;
  });

  // Last-workspace recall: a single cross-launch reference so the app can
  // skip the startup chooser when a known workspace exists. Stored in the
  // top-level app-state file, NOT inside the project, so it survives project
  // deletion and works even if the project folder is empty.
  ipcMain.handle("app:get-last-workspace", (): LastWorkspace | null => {
    const state = readAppState();
    const ws = state.lastWorkspace;
    if (ws !== null && typeof ws === "object" && typeof (ws as { id?: unknown }).id === "string" && typeof (ws as { name?: unknown }).name === "string") {
      const result: LastWorkspace = { id: (ws as { id: string }).id, name: (ws as { name: string }).name };
      // Restore the last-open server path so the app reopens to the same doc.
      const sp = (ws as { serverPath?: unknown }).serverPath;
      if (typeof sp === "string") result.serverPath = sp;
      return result;
    }
    return null;
  });

  ipcMain.handle("app:set-last-workspace", (_event, ws: unknown): void => {
    const state = readAppState();
    if (ws === null) {
      delete state.lastWorkspace;
    } else if (typeof ws === "object" && ws !== null && typeof (ws as { id?: unknown }).id === "string" && typeof (ws as { name?: unknown }).name === "string") {
      const entry: Record<string, unknown> = { id: (ws as { id: string }).id, name: (ws as { name: string }).name };
      // Persist the last-open server path alongside the workspace reference.
      const sp = (ws as { serverPath?: unknown }).serverPath;
      if (typeof sp === "string") entry.serverPath = sp;
      state.lastWorkspace = entry;
    }
    writeAppState(state);
  });

  // Loose-file doc:open / doc:save were removed with the projects-only model
  // (user decision): servers persist exclusively in the project library below
  // and leave the app via export:zip. Re-adding an OS file dialog for docs
  // would create a second source of truth the startup chooser cannot see.

  // Project library: app-managed under userData, so these handlers do plain
  // fs work with no dialogs. userData is resolved lazily (inside handlers)
  // because app.getPath is only reliable after "ready".
  const projectsRoot = (): string => join(app.getPath("userData"), "projects");

  ipcMain.handle("project:list", (): Promise<ProjectInfo[]> => listProjects(projectsRoot()));

  ipcMain.handle("project:create", (_event, name: unknown): Promise<CreateProjectResponse> =>
    createProject(projectsRoot(), name));

  ipcMain.handle(
    "project:save-doc",
    (_event, req: SaveDocToProjectRequest): Promise<SaveDocToProjectResponse> =>
      saveDocToProject(projectsRoot(), req?.projectId, req?.serverName, req?.text),
  );

  ipcMain.handle("project:read-doc", (_event, path: unknown): Promise<ReadProjectDocResponse> =>
    readProjectDoc(projectsRoot(), path));

  ipcMain.handle(
    "project:delete-doc",
    (_event, req: DeleteProjectDocRequest): Promise<DeleteProjectDocResponse> =>
      deleteProjectDoc(projectsRoot(), req?.projectId, req?.serverPath),
  );

  // Project secrets: encrypted at rest via OS safeStorage. The cipher adapter
  // narrows Electron's API to the injected interface secrets.ts tests against
  // with a fake — main is the only place the real safeStorage is touched.
  const cipher: SecretsCipher = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  };

  // Write-once surface (user decision): names out, values in — no handler
  // ever returns a stored secret value to the renderer.
  ipcMain.handle("project:secrets-list-names", (_event, projectId: unknown): Promise<ListProjectSecretNamesResponse> =>
    listProjectSecretNames(projectsRoot(), cipher, projectId));

  ipcMain.handle(
    "project:secrets-set-one",
    (_event, req: SetProjectSecretRequest): Promise<SetProjectSecretResponse> =>
      setProjectSecret(projectsRoot(), cipher, req?.projectId, req?.name, req?.value),
  );

  ipcMain.handle(
    "project:secrets-delete-one",
    (_event, req: DeleteProjectSecretRequest): Promise<DeleteProjectSecretResponse> =>
      deleteProjectSecret(projectsRoot(), cipher, req?.projectId, req?.name),
  );

  ipcMain.handle("project:secrets-clear", (_event, projectId: unknown): Promise<ClearProjectSecretsResponse> =>
    clearProjectSecrets(projectsRoot(), projectId));

  // ── Claude Code integration ───────────────────────────────────────────
  // The renderer never supplies the launch command: it names a project and a
  // saved server, and main derives everything else. That keeps the registered
  // command trustworthy even though the renderer is untrusted input.

  /** Manual executable override lives in app-state.json (an app-level
   * setting, like lastWorkspace) rather than in any project. */
  const executableOverride = (): string | null => {
    const value = readAppState().claudeCodeExecutablePath;
    return typeof value === "string" && value.trim() !== "" ? value : null;
  };

  ipcMain.handle("claude:status", async (): Promise<ClaudeCodeStatus> => {
    const override = executableOverride();
    const detected = await detectClaudeCode({ executableOverride: override });
    return { ...detected, executableOverride: override };
  });

  ipcMain.handle("claude:set-executable-path", (_event, path: unknown): void => {
    const state = readAppState();
    if (typeof path === "string" && path.trim() !== "") state.claudeCodeExecutablePath = path.trim();
    else delete state.claudeCodeExecutablePath;
    writeAppState(state);
  });

  /** Re-derive and re-validate the project id and server path from the
   * renderer's request. Never trust the renderer's copy of either: the same
   * discipline projects.ts applies to save/delete. */
  const resolveServerRequest = async (
    projectId: unknown,
    serverPath: unknown,
  ): Promise<{ ok: true; projectId: string; serverPath: string; fileName: string } | { ok: false; error: string }> => {
    if (typeof projectId !== "string" || typeof serverPath !== "string") {
      return { ok: false, error: "invalid request" };
    }
    // readProjectDoc enforces the library path jail and proves the doc exists
    // on disk — required, because the launch command references a file path,
    // so an unsaved buffer cannot be registered.
    const doc = await readProjectDoc(projectsRoot(), serverPath);
    if (doc === null) {
      return { ok: false, error: "save this server to your workspace before connecting it" };
    }

    // TRANSPORT MISMATCH GUARD — see usesListeningTransport for why a http
    // graph cannot be registered as a stdio client entry.
    try {
      if (usesListeningTransport(JSON.parse(doc.text))) {
        return {
          ok: false,
          error:
            "this server uses the http transport, which listens on a port instead of being started by the client. " +
            "Switch its Transport to stdio in the builder to connect it here.",
        };
      }
    } catch {
      // A doc that will not parse fails later with a better message from the
      // engine; this guard only ever adds a refusal, never a success.
    }

    const fileName = doc.path.replace(/^.*[\\/]/, "");
    return { ok: true, projectId, serverPath: doc.path, fileName };
  };

  ipcMain.handle(
    "claude:register",
    async (_event, req: RegisterWithClaudeCodeRequest): Promise<RegisterWithClaudeCodeResponse> => {
      if (req === null || typeof req !== "object") return { ok: false, error: "invalid request" };
      const resolved = await resolveServerRequest(req.projectId, req.serverPath);
      if (!resolved.ok) return resolved;
      const detected = await detectClaudeCode({ executableOverride: executableOverride() });
      const launch = buildLaunchCommand({
        execPath: process.execPath,
        appPath: app.getAppPath(),
        isPackaged: app.isPackaged,
        projectId: resolved.projectId,
        serverPath: resolved.serverPath,
      });
      return registerServer(
        detected.configPath,
        { name: entryNameFor(resolved.projectId, resolved.fileName), ...launch },
        { replace: req.replace === true },
      );
    },
  );

  ipcMain.handle(
    "claude:unregister",
    async (_event, req: UnregisterFromClaudeCodeRequest): Promise<UnregisterFromClaudeCodeResponse> => {
      if (req === null || typeof req !== "object" || typeof req.entryName !== "string") {
        return { ok: false, error: "invalid request" };
      }
      // Only MCPeasy's own entries are removable through this channel; the
      // renderer must not be able to delete another tool's server.
      if (!isMcpeasyEntryName(req.entryName)) return { ok: false, error: "not a MCPeasy entry" };
      const detected = await detectClaudeCode({ executableOverride: executableOverride() });
      return unregisterServer(detected.configPath, req.entryName);
    },
  );

  ipcMain.handle("claude:list", async (): Promise<ListClaudeCodeRegistrationsResponse> => {
    const detected = await detectClaudeCode({ executableOverride: executableOverride() });
    const listed = await listMcpeasyEntries(detected.configPath);
    if (!listed.ok) return listed;
    return {
      ok: true,
      entries: listed.entries.map((entry) => ({ entryName: entry.name, command: entry.command, args: entry.args })),
    };
  });

  // ── Multi-client integrations ─────────────────────────────────────────
  // The generalized surface. Same boundary rule as the Claude Code handlers
  // above: the renderer names a client, a project and a saved server; main
  // resolves every path and derives the launch command itself.

  ipcMain.handle("clients:list", async (_event, req: ListMcpClientsRequest): Promise<ListMcpClientsResponse> => {
    const projectId = typeof req?.projectId === "string" ? req.projectId : null;
    const serverPath = typeof req?.serverPath === "string" ? req.serverPath : null;

    // The entry name MCPeasy *would* write for the open server. Computed once
    // here so every client is judged against the same identity; without it a
    // client can never report "connected".
    let expectedEntryName: string | null = null;
    if (projectId !== null && serverPath !== null) {
      const doc = await readProjectDoc(projectsRoot(), serverPath);
      if (doc !== null) {
        expectedEntryName = clientEntryNameFor(projectId, doc.path.replace(/^.*[\\/]/, ""));
      }
    }

    // The same derivation for every saved server, so the connect picker's
    // confirmation can name the key for whichever one the user chooses. Derived
    // HERE rather than in the renderer for the reason ListMcpClientsResponse
    // gives: entryNameFor's slugging rules must have exactly one home, or the
    // dialog could promise a key that clients:connect does not write.
    const entryNames: Record<string, string> = {};
    if (projectId !== null) {
      const project = (await listProjects(projectsRoot())).find((p) => p.id === projectId);
      for (const server of project?.servers ?? []) {
        entryNames[server.path] = clientEntryNameFor(projectId, server.fileName);
      }
    }

    const states = await Promise.all(
      MCP_CLIENTS.map((client) => inspectClient(client, { expectedEntryName })),
    );
    return {
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
      states,
      // Returned so the renderer's confirmation dialog can show the exact key
      // that clients:connect will write — see ListMcpClientsResponse.
      expectedEntryName,
      entryNames,
    };
  });

  ipcMain.handle("clients:connect", async (_event, req: ConnectMcpClientRequest): Promise<ConnectMcpClientResponse> => {
    if (req === null || typeof req !== "object") return { ok: false, error: "invalid request" };
    const client = clientById(String(req.clientId));
    if (client === undefined) return { ok: false, error: "unknown client" };

    const configPath = resolveClientConfigPath(client);
    if (configPath === null) {
      return { ok: false, error: `${client.name} is not available on this operating system` };
    }

    const resolved = await resolveServerRequest(req.projectId, req.serverPath);
    if (!resolved.ok) return resolved;

    // Identical launch command for every client: they all spawn a stdio
    // process, and serve mode is what keeps declared env values encrypted.
    const launch = buildLaunchCommand({
      execPath: process.execPath,
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      projectId: resolved.projectId,
      serverPath: resolved.serverPath,
    });
    const result = await registerWithClient(
      configPath,
      client,
      { name: clientEntryNameFor(resolved.projectId, resolved.fileName), ...launch },
      { replace: req.replace === true },
    );
    if (!result.ok) return result;
    // The hint travels with the success so the UI never has to hard-code
    // per-client restart wording.
    return { ...result, activationHint: client.activationHint };
  });

  ipcMain.handle(
    "clients:disconnect",
    async (_event, req: DisconnectMcpClientRequest): Promise<DisconnectMcpClientResponse> => {
      if (req === null || typeof req !== "object" || typeof req.entryName !== "string") {
        return { ok: false, error: "invalid request" };
      }
      const client = clientById(String(req.clientId));
      if (client === undefined) return { ok: false, error: "unknown client" };
      // Only MCPeasy's own entries are removable through this channel; the
      // renderer must not be able to delete another tool's server.
      if (!isMcpeasyClientEntryName(req.entryName)) return { ok: false, error: "not a MCPeasy entry" };
      const configPath = resolveClientConfigPath(client);
      if (configPath === null) return { ok: false, error: `${client.name} is not available on this operating system` };
      return unregisterFromClient(configPath, client, req.entryName);
    },
  );

  /** Recompute the fingerprint from the doc ON DISK. The renderer's value is
   * only ever compared, never stored — mirroring how console:run recomputes
   * localExecutionApprovalForTool instead of trusting the request. */
  const fingerprintOnDisk = async (
    serverPath: string,
  ): Promise<{ ok: true; fingerprint: string | null } | { ok: false; error: string }> => {
    const doc = await readProjectDoc(projectsRoot(), serverPath);
    if (doc === null) return { ok: false, error: "server not found in this workspace" };
    try {
      const parsed = validateGraphDoc(migrateGraphDoc(JSON.parse(doc.text)));
      if (!parsed.ok) return { ok: false, error: "this server has validation errors" };
      return { ok: true, fingerprint: localExecutionFingerprint(parsed.doc) };
    } catch {
      return { ok: false, error: "this server could not be read" };
    }
  };

  ipcMain.handle(
    "claude:grant-status",
    async (_event, req: LocalExecutionGrantStatusRequest): Promise<LocalExecutionGrantStatusResponse> => {
      if (req === null || typeof req !== "object" || typeof req.projectId !== "string") {
        return { ok: false, error: "invalid request" };
      }
      const computed = await fingerprintOnDisk(req.serverPath);
      if (!computed.ok) return computed;
      return {
        ok: true,
        fingerprint: computed.fingerprint,
        granted: hasLocalExecutionGrant(
          readAppState().localExecutionGrants,
          req.projectId,
          req.serverPath,
          computed.fingerprint,
        ),
      };
    },
  );

  ipcMain.handle(
    "claude:grant-local",
    async (_event, req: LocalExecutionGrantRequest): Promise<LocalExecutionGrantResponse> => {
      if (req === null || typeof req !== "object" || typeof req.projectId !== "string") {
        return { ok: false, error: "invalid request" };
      }
      const computed = await fingerprintOnDisk(req.serverPath);
      if (!computed.ok) return computed;
      if (computed.fingerprint === null) return { ok: false, error: "this server has no local execution steps" };
      // A mismatch means the renderer approved a graph that is no longer the
      // one on disk — refuse rather than grant the stale approval.
      if (computed.fingerprint !== req.fingerprint) {
        return { ok: false, error: "this server changed since the approval was shown; review it again" };
      }
      const state = readAppState();
      state.localExecutionGrants = withLocalExecutionGrant(
        state.localExecutionGrants,
        req.projectId,
        req.serverPath,
        computed.fingerprint,
      );
      writeAppState(state);
      return { ok: true };
    },
  );

  ipcMain.handle(
    "claude:revoke-local",
    (_event, req: LocalExecutionGrantStatusRequest): LocalExecutionGrantResponse => {
      if (req === null || typeof req !== "object" || typeof req.projectId !== "string" || typeof req.serverPath !== "string") {
        return { ok: false, error: "invalid request" };
      }
      const state = readAppState();
      state.localExecutionGrants = withoutLocalExecutionGrant(
        state.localExecutionGrants,
        req.projectId,
        req.serverPath,
      );
      writeAppState(state);
      return { ok: true };
    },
  );

  // Export as language: the renderer generates the project files (pure
  // schema-only exporters — see renderer/src/export/); main only validates
  // the untrusted path list (zip-slip guard), builds the archive with Node's
  // zlib, and writes it where the user's save dialog pointed.
  ipcMain.handle("export:zip", async (_event, req: ExportZipRequest): Promise<ExportZipResponse> => {
    if (req === null || typeof req !== "object") return { ok: false, error: "invalid export request" };
    const entries = validateZipEntries(req.files);
    if ("error" in entries) return { ok: false, error: entries.error };
    const suggested =
      typeof req.suggestedName === "string" && /^[A-Za-z0-9._ -]{1,120}\.zip$/.test(req.suggestedName)
        ? req.suggestedName
        : "mcp-server.zip";
    const res = await dialog.showSaveDialog({
      filters: [{ name: "zip archive", extensions: ["zip"] }],
      defaultPath: suggested,
    });
    if (res.canceled || !res.filePath) return null; // cancelled — not an error
    try {
      await writeFile(res.filePath, buildZip(entries));
      return { ok: true, path: res.filePath };
    } catch (cause) {
      // Disk-full / permission problems are the user's actionable feedback.
      return { ok: false, error: cause instanceof Error ? cause.message : "failed to write archive" };
    }
  });

  // Probes PATH for the custom-code interpreters. Not cached: a user who
  // installs Python to fix the warning this produces must be able to see it
  // clear without restarting the app, and the probe is a handful of stat
  // calls.
  ipcMain.handle("code:runtimes", async (): Promise<CodeRuntimeReport> => {
    try {
      return await detectCodeRuntimes();
    } catch {
      // Detection is advisory. A failure here must not break the editor, so
      // report an empty map, which the renderer reads as "unknown" rather
      // than "unavailable" and shows no false warning.
      return {};
    }
  });

  // The test console's whole point is fidelity: the SAME loadGraphDoc →
  // buildServer → MCP client round trip the CLI uses, so what the console
  // shows is byte-for-byte what Claude would see. Running
  // it in the main process (not the renderer) is also what makes upstream
  // HTTP actions work without any CORS proxy.
  ipcMain.handle("console:run", async (_event, req: RunToolRequest): Promise<RunToolResponse> => {
    try {
      if (req === null || typeof req !== "object" || typeof req.toolName !== "string") {
        return { ok: false, error: "invalid run request" };
      }
      const env = sanitizeEnv(req.env);
      const doc = loadGraphDoc(req.doc, env);
      const localIds = localExecutionNodeIdsForTool(doc, req.toolName);
      const expectedApproval = localExecutionApprovalForTool(doc, req.toolName);
      let localApproved = localIds.length === 0;
      if (expectedApproval !== null) {
        if (req.localExecutionApproval !== expectedApproval) {
          return { ok: false, error: "local execution approval does not match this tool" };
        }
        const approvalKey = `${doc.server.name}\u0000${req.toolName}\u0000${expectedApproval}`;
        localApproved = approvedLocalRuns.has(approvalKey);
        if (!localApproved) {
          const win = BrowserWindow.fromWebContents(_event.sender);
          const prompt = {
            type: "warning" as const,
            buttons: ["Cancel", "Run trusted code"],
            defaultId: 0,
            cancelId: 0,
            message: `Allow ${req.toolName} to run local code?`,
            detail: `This tool can execute ${localIds.length} local command/script/custom-code block(s) with your user permissions. Only continue if you trust this graph.`,
          };
          const choice = win
            ? await dialog.showMessageBox(win, prompt)
            : await dialog.showMessageBox(prompt);
          localApproved = choice.response === 1;
          if (!localApproved) return { ok: false, error: "local execution was not approved" };
          approvedLocalRuns.add(approvalKey);
        }
      }
      const server = buildServer(doc, env, {
        localExecutionPolicy: { enabled: localApproved },
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "mcpeasy-console", version: "0.1.0" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const args = req.args !== null && typeof req.args === "object" ? req.args : {};
        const result = await client.callTool({ name: req.toolName, arguments: args });
        return { ok: true, result: result as unknown as ToolRunResult };
      } finally {
        await client.close();
      }
    } catch (cause) {
      // BuildError messages (validation, lint, missing env) are the user's
      // actionable feedback; SDK McpError covers unknown tool / bad args.
      // This is a local dev tool showing the user their own doc's failure —
      // full messages help here, unlike the engine's model-facing errors.
      const message = cause instanceof BuildError || cause instanceof Error ? cause.message : "run failed";
      return { ok: false, error: message };
    }
  });
}

// ── Headless MCP serve mode ─────────────────────────────────────────────
// Claude Code launches this app with --mcp-serve to run ONE saved graph doc as
// a stdio MCP server. See docs/integrations-claude-code.md §4 for why the
// launcher must be this app rather than the plain-Node CLI: safeStorage can
// only decrypt inside an Electron process, so this is the only way the server
// starts with real env values while the client config stays free of secrets.

/** STDOUT IS SACRED in serve mode (engine/src/stdio.ts): it belongs to the
 * JSON-RPC transport alone. Every human-readable message goes to stderr — a
 * stray console.log here corrupts the stream and looks like a hang, not an
 * error. Claude Code surfaces these lines when a server fails to start. */
function serveLog(message: string): void {
  process.stderr.write(`mcpeasy: ${message}\n`);
}

/** Exit non-zero so Claude Code reports a failed server rather than an empty
 * one. Errors are values up to this point; this is the single exit path. */
function serveFailed(message: string): never {
  serveLog(`error: ${message}`);
  process.exit(1);
}

async function runServeMode(projectId: string, serverPath: string): Promise<void> {
  const projectsRoot = join(app.getPath("userData"), "projects");

  // Reuse the projects path jail: the renderer is not involved here, but argv
  // is equally untrusted (the config file is user-editable), so a path outside
  // the library must not be readable through this channel.
  const docFile = await readProjectDoc(projectsRoot, serverPath);
  if (docFile === null) {
    serveFailed(`cannot read a saved server at ${serverPath} (is it inside this project library?)`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(docFile.text);
  } catch {
    serveFailed(`${serverPath} is not valid JSON`);
  }

  const cipher: SecretsCipher = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  };
  // readProjectSecrets is main-internal by contract (secrets.ts): this is the
  // "future run-time env resolution" consumer it was reserved for. The values
  // never leave this process — they go straight into buildServer.
  const stored = await readProjectSecrets(projectsRoot, cipher, projectId);
  if (!stored.ok) serveFailed(stored.error);

  // Peek at the declared env names BEFORE the real load, exactly as the CLI's
  // `dev` command does (apps/cli/src/main.ts): loadGraphDoc throws a generic
  // "missing required env vars" error, and this peek is what lets the failure
  // name the specific secrets the user still has to add.
  const peek = validateGraphDoc(migrateGraphDoc(raw));
  const env = resolveDeclaredEnv(peek.ok ? peek.doc.server.env : [], stored.secrets);
  if (!env.ok) {
    serveFailed(
      `no stored secret for declared env var(s): ${env.missing.join(", ")}, add them on the Secrets page in MCPeasy`,
    );
  }

  let loaded;
  try {
    loaded = loadGraphDoc(raw, env.env);
  } catch (cause) {
    // BuildError covers an invalid shape and lint errors; both are the user's
    // actionable feedback and are safe to print (no secret values involved).
    serveFailed(cause instanceof Error ? cause.message : "graph doc could not be loaded");
  }

  // Local execution needs a grant made in the app: a headless process has no
  // window, so the per-call dialog used by console:run cannot be shown here.
  // A changed graph yields a different fingerprint and the grant lapses.
  const fingerprint = localExecutionFingerprint(loaded);
  const granted = hasLocalExecutionGrant(readAppState().localExecutionGrants, projectId, serverPath, fingerprint);
  if (fingerprint !== null && !granted) {
    // Serve anyway with local execution OFF so the graph's non-local tools
    // still work; a failing local tool reports the reason at call time.
    serveLog(
      "local execution is not approved for this server; local command/script/code tools will fail until you grant it on the Integrations page",
    );
  }

  const server = buildServer(loaded, env.env, { localExecutionPolicy: { enabled: granted } });

  // The doc chooses the transport. An http graph launched by a stdio client
  // entry would answer nothing on the pipe -- the exact failure mode that made
  // Claude Desktop show no tools -- so the mismatch is reported instead.
  if (loaded.server.transport === "http") {
    // Bearer tokens live in the project's encrypted secrets, like every other
    // sensitive value: MCPEASY_BEARER_TOKEN is read from the decrypted set,
    // never from the client config or argv.
    const bearerToken = loaded.server.auth.type === "bearer" ? stored.secrets.MCPEASY_BEARER_TOKEN : undefined;
    if (loaded.server.auth.type === "bearer" && bearerToken === undefined) {
      serveFailed(
        "this server declares bearer auth; add a secret named MCPEASY_BEARER_TOKEN on the Secrets page in MCPeasy",
      );
    }
    const handle = await serveHttp(server, { bearerToken });
    serveLog(`serving "${loaded.server.name}" at ${handle.url}`);
    // Unlike stdio there is no pipe whose close ends the process, so this
    // stays up until the client entry's process is killed.
    await new Promise<void>(() => {});
    return;
  }

  serveLog(`serving "${loaded.server.name}" over stdio`);
  await serveStdio(server);
  // serveStdio resolves when the client closes the pipe; exiting keeps a
  // windowless process from lingering after Claude Code disconnects.
  app.quit();
}

// Windows identifies an app by its AppUserModelID, not its executable path. It
// must match the `appId` in electron-builder.yml, or the taskbar treats a
// running MCPeasy as unrelated to its own pinned shortcut (two icons) and
// notifications lose the app icon. electron-builder's NSIS docs call for
// setting this in main before any BrowserWindow is created — hence here, above
// every whenReady handler, and outside the serve/normal branch so the headless
// serve process claims the same identity.
app.setAppUserModelId("com.mcpeasy.desktop");

const serveRequest = parseServeArgs(process.argv);

// A malformed serve invocation must fail loudly rather than opening a window:
// Claude Code would otherwise wait on a process that never speaks JSON-RPC.
if (serveRequest.mode === "invalid") {
  app.whenReady().then(() => serveFailed(serveRequest.error));
} else if (serveRequest.mode === "serve") {
  // No window, no menu, no dock icon — this process exists only to serve.
  app.whenReady().then(async () => {
    if (process.platform !== "darwin") Menu.setApplicationMenu(null);
    app.dock?.hide();
    try {
      await runServeMode(serveRequest.args.projectId, serveRequest.args.serverPath);
    } catch (cause) {
      serveFailed(cause instanceof Error ? cause.message : "serve mode failed");
    }
  });
  // window-all-closed must not quit here: there is no window to close, and
  // the handler below is registered for the normal app path only.
} else {
app.whenReady().then(() => {
  // The visible File/Help menus live in the custom title bar. null removes the
  // second, default File/Edit/View bar on Windows/Linux — autoHideMenuBar would
  // only hide it until Alt. Accepted side effect: its default accelerators
  // (Ctrl+R, F12) go with it; app shortcuts live in the renderer. macOS is excluded
  // because there the application menu hosts the Edit roles that make
  // clipboard shortcuts work, and it sits in the system bar, not the window.
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  // With preference "system", an OS light/dark flip changes
  // shouldUseDarkColors without any renderer IPC — repaint the native
  // caption controls here or they keep the previous palette.
  nativeTheme.on("updated", syncCaptionOverlays);
  registerIpc();
  createWindow();
  app.on("activate", () => {
    // macOS convention: re-create the window on dock click.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
}
