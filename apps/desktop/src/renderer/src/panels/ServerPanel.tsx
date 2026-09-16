import type { ServerConfig } from "@mcpeasy/schema";
import { MCP_ROOT_NODE_ID } from "../graph";
import { useEditor } from "../store";
import { useFitNodes } from "../canvas/overlays/ZoomControls";
import { ListTextarea } from "./fields";

/** Properties for the derived MCP root. Name, version and description are
 * MCP serverInfo; creator remains project metadata because MCP has no creator
 * field in its implementation identity. */
export function ServerPanel() {
  const server = useEditor((state) => state.doc.server);
  const updateServer = useEditor((state) => state.updateServer);
  const select = useEditor((state) => state.select);
  const serverProblems = useEditor((state) => state.lint.server) ?? [];
  const serverValidation = useEditor((state) => state.validation).filter(
    (issue) => issue.path === "server" || issue.path.startsWith("server."),
  );
  const fitNodes = useFitNodes();
  const patch = (change: Partial<ServerConfig>) => updateServer({ ...server, ...change });

  return (
    <div className="detail-panel">
      <div className="detail-panel__header">
        <div className="detail-panel__title">
          <span className="detail-panel__icon detail-panel__icon--server">
            <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="3" width="20" height="7" rx="2" />
              <rect x="2" y="14" width="20" height="7" rx="2" />
              <path d="M6 6.5h.01M6 17.5h.01" />
            </svg>
          </span>
          <span className="detail-panel__titletext">{server.name || "MCP server"} <span className="muted">root</span></span>
        </div>
        <div className="detail-panel__actions">
          <button className="panel-icon-btn" onClick={() => fitNodes([MCP_ROOT_NODE_ID])} title="Center on MCP root" aria-label="Center on MCP root">⊙</button>
          <button className="panel-icon-btn" onClick={() => select(null)} title="Close" aria-label="Close">✕</button>
        </div>
      </div>
      <div className="detail-panel__body">
        {serverProblems.map((problem, index) => (
          <div key={`lint-${index}`} className={`problem problem-${problem.severity}`}>{problem.message}</div>
        ))}
        {serverValidation.map((issue, index) => (
          <div key={`validation-${index}`} className="problem problem-error">{issue.message}</div>
        ))}
        <label>
          MCP name
          <input value={server.name} onChange={(event) => patch({ name: event.target.value })} placeholder="customer-support" />
        </label>
        <label>
          Description
          <textarea rows={3} value={server.description ?? ""} onChange={(event) => patch({ description: event.target.value })} placeholder="Customer support tools for orders and accounts." />
        </label>
        <label>
          Creator
          <input value={server.creator ?? ""} onChange={(event) => patch({ creator: event.target.value })} placeholder="Your name or organization" />
        </label>
        <h3>Runtime</h3>
        <label>
          Version
          <input value={server.version} onChange={(event) => patch({ version: event.target.value })} />
        </label>
        <label>
          Transport
          <select value={server.transport} onChange={(event) => patch({ transport: event.target.value as ServerConfig["transport"] })}>
            <option value="stdio">stdio (the client starts this server)</option>
            <option value="http">http (this server listens on a port)</option>
          </select>
        </label>
        {/* The choice changes how the server is reached, and http additionally
            binds a socket, so each option states its consequence rather than
            leaving the user to discover it after connecting. */}
        {server.transport === "http" ? (
          <p className="muted small">
            Listens on 127.0.0.1 port 51730. Only this machine can reach it. Bearer auth reads a secret named
            MCPEASY_BEARER_TOKEN.
          </p>
        ) : (
          <p className="muted small">The MCP client launches this server and talks to it over its own pipe. Best for Claude Desktop, Claude Code, Cursor and VS Code.</p>
        )}
        <label className="check">
          <input type="checkbox" checked={server.execution?.allowLocal === true} onChange={(event) => patch({ execution: { allowLocal: event.target.checked } })} />
          Allow local commands, scripts, and custom code in this graph
        </label>
        <p className="muted small">The desktop app still asks before the first trusted-code run. CLI users must also pass --allow-local-execution.</p>
        <label>
          Env var names (one per line, names only, never secret values)
          <ListTextarea initial={server.env} rows={3} onLines={(env) => patch({ env })} placeholder={"API_TOKEN\nBASE_URL"} />
        </label>
      </div>
      {/* No footer: the console shortcut it held is redundant now that the
          test console is a permanent drawer. */}
    </div>
  );
}
