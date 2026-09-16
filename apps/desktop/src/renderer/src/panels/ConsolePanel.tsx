import { useMemo, useState } from "react";
import { lintErrorCount, localExecutionApprovalForTool, toolInputJsonSchema, type ToolNode } from "@mcpeasy/schema";
import type { ToolRunResult } from "../../../shared/ipc";
import { serializableDoc } from "../graph";
import { useEditor } from "../store";

// The test console: pick a tool, fill its inputs, run it through the REAL
// engine in the main process (same loadGraphDoc → buildServer → MCP client
// path as the CLI), and show the result the model would see.
// Env VALUES are typed here and held in component state only —
// never written into the doc (N5) and gone when the window closes.

interface RunEntry {
  tool: string;
  args: Record<string, unknown>;
  response: { ok: true; result: ToolRunResult } | { ok: false; error: string };
  at: string;
}

function coerceArg(raw: string, type: string): unknown {
  // Inputs arrive as strings from form fields; the wire format wants typed
  // values (schema types string/number/boolean/enum). Empty stays undefined
  // so optional inputs are OMITTED, matching how a model would call.
  if (raw === "") return undefined;
  if (type === "number") {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n; // let the engine complain, visibly
  }
  if (type === "boolean") return raw === "true";
  return raw;
}

function ResultView({ result }: { result: ToolRunResult }) {
  return (
    <div className={`run-result${result.isError ? " run-error" : ""}`}>
      {result.isError && <div className="run-flag">isError: true</div>}
      {result.content.map((c, i) => (
        <pre key={i}>{c.type === "text" ? c.text : JSON.stringify(c, null, 2)}</pre>
      ))}
      {result.structuredContent !== undefined && (
        <details>
          <summary>structuredContent</summary>
          <pre>{JSON.stringify(result.structuredContent, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

export function ConsolePanel() {
  const doc = useEditor((s) => s.doc);
  const lint = useEditor((s) => s.lint);
  const validation = useEditor((s) => s.validation);

  const tools = useMemo(
    () =>
      Object.values(doc.nodes).filter((n): n is ToolNode => n.kind === "tool"),
    [doc],
  );
  const [toolName, setToolName] = useState<string>("");
  const selected = tools.find((t) => t.name === toolName) ?? tools[0];

  const [argText, setArgText] = useState<Record<string, string>>({});
  const [envText, setEnvText] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<RunEntry[]>([]);

  const blockers: string[] = [];
  if (validation.length > 0) blockers.push(`${validation.length} validation issue(s)`);
  const lintErrors = lintErrorCount(lint);
  if (lintErrors > 0) blockers.push(`${lintErrors} lint error(s)`);
  const inElectron = window.mcpeasy !== undefined;
  if (!inElectron) blockers.push("not running inside the desktop app (no engine bridge)");

  const run = async () => {
    if (!selected || !window.mcpeasy) return;
    const args: Record<string, unknown> = {};
    for (const input of selected.inputs) {
      const value = coerceArg(argText[input.name] ?? "", input.type);
      if (value !== undefined) args[input.name] = value;
    }
    const env: Record<string, string> = {};
    for (const name of doc.server.env) env[name] = envText[name] ?? "";
    setRunning(true);
    try {
      const localExecutionApproval = localExecutionApprovalForTool(doc, selected.name);
      const response = await window.mcpeasy.runTool({
        doc: serializableDoc(doc),
        toolName: selected.name,
        args,
        env,
        ...(localExecutionApproval !== null ? { localExecutionApproval } : {}),
      });
      setHistory((h) => [{ tool: selected.name, args, response, at: new Date().toLocaleTimeString() }, ...h]);
    } finally {
      setRunning(false);
    }
  };

  if (tools.length === 0) {
    return (
      <div className="console-body">
        <p className="muted">Add a tool node first, then you can call it here exactly as a model would.</p>
      </div>
    );
  }

  // Bottom-drawer layout: request form on the left, run history on the right,
  // mirroring how the detail panel splits identity (header) from data (body).
  return (
    <div className="console-body console-body--split">
      <div className="console-form">
        {blockers.length > 0 && (
          <div className="problem problem-error">Fix before running: {blockers.join("; ")}</div>
        )}
        <label>
          Tool
          <select value={selected?.name ?? ""} onChange={(e) => setToolName(e.target.value)}>
            {tools.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        {selected && selected.inputs.length > 0 && <h3>Arguments</h3>}
        {selected?.inputs.map((input) => (
          <label key={input.name}>
            {input.name}
            {input.required !== false ? "" : " (optional)"}
            {input.type === "enum" ? (
              <select
                value={argText[input.name] ?? ""}
                onChange={(e) => setArgText((a) => ({ ...a, [input.name]: e.target.value }))}
              >
                <option value="">(none)</option>
                {(input.enumValues ?? []).map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : input.type === "boolean" ? (
              <select
                value={argText[input.name] ?? ""}
                onChange={(e) => setArgText((a) => ({ ...a, [input.name]: e.target.value }))}
              >
                <option value="">(none)</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                value={argText[input.name] ?? ""}
                onChange={(e) => setArgText((a) => ({ ...a, [input.name]: e.target.value }))}
                placeholder={input.description ?? input.type}
              />
            )}
          </label>
        ))}

        {doc.server.env.length > 0 && <h3>Env values (memory only, never saved)</h3>}
        {doc.server.env.map((name) => (
          <label key={name}>
            {name}
            <input
              type="password"
              value={envText[name] ?? ""}
              onChange={(e) => setEnvText((v) => ({ ...v, [name]: e.target.value }))}
              placeholder="value used for this run only"
            />
          </label>
        ))}

        <button className="primary" onClick={() => void run()} disabled={running || blockers.length > 0}>
          {running ? "Running…" : `Run ${selected?.name ?? ""}`}
        </button>

        {selected && (
          <details className="schema-preview">
            <summary>Input schema as the model sees it</summary>
            <pre>{JSON.stringify(toolInputJsonSchema(selected), null, 2)}</pre>
          </details>
        )}
      </div>

      <div className="console-runs">
        {history.length === 0 ? (
          <p className="muted">No runs yet. Results will appear here, exactly as a model would see them.</p>
        ) : (
          history.map((entry, i) => (
            <div key={i} className="run-entry">
              <div className="run-head">
                <code>
                  {entry.tool}({JSON.stringify(entry.args)})
                </code>
                <span className="muted">{entry.at}</span>
              </div>
              {entry.response.ok ? (
                <ResultView result={entry.response.result} />
              ) : (
                <div className="run-result run-error">
                  <pre>{entry.response.error}</pre>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
