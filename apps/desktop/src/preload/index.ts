import { contextBridge, ipcRenderer } from "electron";
import type {
  ConnectMcpClientRequest,
  DeleteProjectDocRequest,
  DeleteProjectSecretRequest,
  DisconnectMcpClientRequest,
  ExportZipRequest,
  LastWorkspace,
  ListMcpClientsRequest,
  LocalExecutionGrantRequest,
  LocalExecutionGrantStatusRequest,
  McpeasyApi,
  RegisterWithClaudeCodeRequest,
  RunToolRequest,
  SaveDocToProjectRequest,
  SetProjectSecretRequest,
  ThemePreference,
  UnregisterFromClaudeCodeRequest,
} from "../shared/ipc";

// Narrow wrappers only, never the raw ipcRenderer: exposing ipcRenderer would
// hand any compromised renderer code the full IPC surface of the app.
// This preload is bundled as CommonJS so the Chromium sandbox can stay ON
// (ESM preloads require sandbox:false per Electron's ESM limitations).
const api: McpeasyApi = {
  listProjects: () => ipcRenderer.invoke("project:list"),
  createProject: (name: string) => ipcRenderer.invoke("project:create", name),
  saveDocToProject: (req: SaveDocToProjectRequest) => ipcRenderer.invoke("project:save-doc", req),
  readProjectDoc: (path: string) => ipcRenderer.invoke("project:read-doc", path),
  deleteProjectDoc: (req: DeleteProjectDocRequest) => ipcRenderer.invoke("project:delete-doc", req),
  listProjectSecretNames: (projectId: string) => ipcRenderer.invoke("project:secrets-list-names", projectId),
  setProjectSecret: (req: SetProjectSecretRequest) => ipcRenderer.invoke("project:secrets-set-one", req),
  deleteProjectSecret: (req: DeleteProjectSecretRequest) => ipcRenderer.invoke("project:secrets-delete-one", req),
  clearProjectSecrets: (projectId: string) => ipcRenderer.invoke("project:secrets-clear", projectId),
  exportZip: (req: ExportZipRequest) => ipcRenderer.invoke("export:zip", req),
  getClaudeCodeStatus: () => ipcRenderer.invoke("claude:status"),
  registerWithClaudeCode: (req: RegisterWithClaudeCodeRequest) => ipcRenderer.invoke("claude:register", req),
  unregisterFromClaudeCode: (req: UnregisterFromClaudeCodeRequest) => ipcRenderer.invoke("claude:unregister", req),
  listClaudeCodeRegistrations: () => ipcRenderer.invoke("claude:list"),
  setClaudeCodeExecutablePath: (path: string | null) => ipcRenderer.invoke("claude:set-executable-path", path),
  listMcpClients: (req: ListMcpClientsRequest) => ipcRenderer.invoke("clients:list", req),
  connectMcpClient: (req: ConnectMcpClientRequest) => ipcRenderer.invoke("clients:connect", req),
  disconnectMcpClient: (req: DisconnectMcpClientRequest) => ipcRenderer.invoke("clients:disconnect", req),
  getLocalExecutionGrant: (req: LocalExecutionGrantStatusRequest) => ipcRenderer.invoke("claude:grant-status", req),
  grantLocalExecution: (req: LocalExecutionGrantRequest) => ipcRenderer.invoke("claude:grant-local", req),
  revokeLocalExecution: (req: LocalExecutionGrantStatusRequest) => ipcRenderer.invoke("claude:revoke-local", req),
  detectCodeRuntimes: () => ipcRenderer.invoke("code:runtimes"),
  runTool: (req: RunToolRequest) => ipcRenderer.invoke("console:run", req),
  setTheme: (theme: ThemePreference) => ipcRenderer.invoke("app:set-theme", theme),
  getAppInfo: () => ipcRenderer.invoke("app:info"),
  setDirty: (dirty: boolean) => ipcRenderer.send("doc:dirty", dirty === true),
  getLastWorkspace: () => ipcRenderer.invoke("app:get-last-workspace"),
  setLastWorkspace: (ws: LastWorkspace | null) => ipcRenderer.invoke("app:set-last-workspace", ws),
};

contextBridge.exposeInMainWorld("mcpeasy", api);
