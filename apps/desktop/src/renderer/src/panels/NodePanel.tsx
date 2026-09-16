import { useEffect, useState } from "react";
import { CODE_LANGUAGES, toolMcpDefinition } from "@mcpeasy/schema";
import type {
  ActionNode,
  CodeLanguage,
  CodeNode,
  CommandNode,
  GraphNode,
  HttpMethod,
  InputField,
  InputType,
  ParallelNode,
  ReturnNode,
  ScriptNode,
  ToolNode,
  TransformNode,
} from "@mcpeasy/schema";
import type { CodeRuntimeReport } from "../../../shared/ipc";
import { useEditor } from "../store";
import { KIND_META } from "../canvas/kinds";
import { useFitNodes } from "../canvas/overlays/ZoomControls";
import { CommaListInput, HeaderTextarea, ListTextarea } from "./fields";
import { TemplateField } from "./TemplateField";
import { CodeOverlay, LANGUAGE_HINT, LANGUAGE_LABEL, isStarterSource, starterFor } from "./CodeOverlay";

// One editor section per node kind. Every control writes the WHOLE node back
// through updateNode so a single code path recomputes lint/validation.

function ToolEditor({ id, node }: { id: string; node: ToolNode }) {
  const updateNode = useEditor((s) => s.updateNode);
  const patch = (p: Partial<ToolNode>) => updateNode(id, { ...node, ...p });

  const patchInput = (index: number, p: Partial<InputField>) => {
    const inputs = node.inputs.map((input, i) => (i === index ? { ...input, ...p } : input));
    patch({ inputs });
  };

  return (
    <>
      <label>
        Tool name
        <input
          value={node.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="get_weather"
        />
      </label>
      <label>
        Description
        <textarea
          rows={3}
          value={node.description}
          onChange={(e) => patch({ description: e.target.value })}
          placeholder="Fetch the current weather for a city. Use when the user asks about weather."
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={node.annotations.readOnly}
          onChange={(e) => patch({ annotations: { ...node.annotations, readOnly: e.target.checked } })}
        />
        Read-only (never modifies anything)
      </label>
      <label>
        Destructive
        <select
          value={node.annotations.destructive === undefined ? "unset" : String(node.annotations.destructive)}
          onChange={(e) => {
            // Tri-state on purpose (schema comment): "unset" must stay
            // expressible, it is what the destructive-unset lint rule keys on.
            const v = e.target.value;
            const annotations = { ...node.annotations };
            if (v === "unset") delete annotations.destructive;
            else annotations.destructive = v === "true";
            patch({ annotations });
          }}
        >
          <option value="unset">(not set)</option>
          <option value="false">no (safe to retry)</option>
          <option value="true">yes (irreversible)</option>
        </select>
      </label>

      <h3>Input schema</h3>
      {node.inputs.map((input, i) => (
        <div key={i} className="input-row">
          <div className="input-row-head">
            <input
              value={input.name}
              onChange={(e) => patchInput(i, { name: e.target.value })}
              placeholder="name"
            />
            <select
              value={input.type}
              onChange={(e) => {
                const type = e.target.value as InputType;
                // enumValues only legal on enum inputs (validation rule) —
                // strip it on type change instead of leaving an invalid doc.
                const next: InputField = { ...input, type };
                if (type !== "enum") delete next.enumValues;
                else next.enumValues = next.enumValues ?? [];
                patchInput(i, next);
              }}
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
              <option value="enum">enum</option>
            </select>
            <label className="check">
              <input
                type="checkbox"
                checked={input.required !== false}
                onChange={(e) => patchInput(i, { required: e.target.checked ? undefined : false })}
              />
              required
            </label>
            <button
              className="panel-icon-btn danger"
              onClick={() => patch({ inputs: node.inputs.filter((_, j) => j !== i) })}
              title="Remove input"
              aria-label="Remove input"
            >
              ✕
            </button>
          </div>
          <input
            value={input.description ?? ""}
            onChange={(e) => patchInput(i, { description: e.target.value || undefined })}
            placeholder="description shown to the model"
          />
          {input.type === "enum" && (
            <CommaListInput
              initial={input.enumValues ?? []}
              onValues={(enumValues) => patchInput(i, { enumValues })}
              placeholder="allowed values, comma separated"
            />
          )}
        </div>
      ))}
      <button
        onClick={() => patch({ inputs: [...node.inputs, { name: `arg${node.inputs.length + 1}`, type: "string" }] })}
      >
        + Add input
      </button>
      <details className="schema-preview mcp-tool-preview">
        <summary>Official MCP tool format</summary>
        <pre>{JSON.stringify(toolMcpDefinition(node), null, 2)}</pre>
      </details>
    </>
  );
}

function ActionEditor({ id, node }: { id: string; node: ActionNode }) {
  const updateNode = useEditor((s) => s.updateNode);
  const patch = (p: Partial<ActionNode["http"]>) => updateNode(id, { ...node, http: { ...node.http, ...p } });

  return (
    <>
      <label>
        Method
        <select value={node.http.method} onChange={(e) => patch({ method: e.target.value as HttpMethod })}>
          {(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <label>
        URL
        <TemplateField
          nodeId={id}
          value={node.http.url}
          onValue={(url) => patch({ url })}
          placeholder="api.example.com/items/… (https assumed)"
        />
      </label>
      <label>
        Headers (one per line, "Name: value")
        <HeaderTextarea
          initial={node.http.headers ?? {}}
          onHeaders={(headers) => patch({ headers })}
          placeholder={"Authorization: Bearer {{env.API_TOKEN}}"}
        />
      </label>
      {node.http.method !== "GET" && node.http.method !== "DELETE" && (
        <label>
          Body (chips insert variables at the cursor)
          <TemplateField
            nodeId={id}
            rows={4}
            value={node.http.body ?? ""}
            onValue={(body) => patch({ body: body || undefined })}
            placeholder={'{"name": "…"}'}
          />
        </label>
      )}
    </>
  );
}

function CommandEditor({ id, node }: { id: string; node: CommandNode }) {
  const updateNode = useEditor((state) => state.updateNode);
  const patch = (change: Partial<CommandNode["command"]>) => updateNode(id, { ...node, command: { ...node.command, ...change } });
  return (
    <>
      <div className="problem problem-warning">Runs a local executable with your user permissions. Arguments are passed directly without a shell.</div>
      <label>Executable<input value={node.command.executable} onChange={(event) => patch({ executable: event.target.value })} placeholder="node" /></label>
      <label>Arguments (one per line; use a chip to insert a variable)
        <TemplateField
          nodeId={id}
          rows={4}
          parseLines
          value={node.command.args.join("\n")}
          onValue={(value) => patch({ args: value === "" ? [] : value.split("\n") })}
          placeholder={"--format=json\n/path/from/input"}
        />
      </label>
      <label>Stdin
        <TemplateField nodeId={id} rows={3} value={node.command.stdin ?? ""} onValue={(stdin) => patch({ stdin: stdin || undefined })} placeholder="Optional input sent to the process" />
      </label>
      <label>Working directory<input value={node.command.cwd ?? ""} onChange={(event) => patch({ cwd: event.target.value || undefined })} placeholder="Optional" /></label>
      <label>Read stdout as<select value={node.command.output} onChange={(event) => patch({ output: event.target.value as CommandNode["command"]["output"] })}><option value="text">text</option><option value="json">JSON</option></select></label>
    </>
  );
}

function ScriptEditor({ id, node }: { id: string; node: ScriptNode }) {
  const updateNode = useEditor((state) => state.updateNode);
  const patch = (change: Partial<ScriptNode["script"]>) => updateNode(id, { ...node, script: { ...node.script, ...change } });
  return (
    <>
      <div className="problem problem-warning">Runs a trusted local script with your user permissions.</div>
      <label>Runtime<select value={node.script.runtime} onChange={(event) => patch({ runtime: event.target.value as ScriptNode["script"]["runtime"] })}><option value="node">Node.js</option><option value="python">Python</option><option value="powershell">PowerShell</option><option value="bash">Bash</option></select></label>
      <label>Script path<input value={node.script.path} onChange={(event) => patch({ path: event.target.value })} placeholder="scripts/tool.mjs" /></label>
      <label>Arguments (one per line; use a chip to insert a variable)
        <TemplateField
          nodeId={id}
          rows={3}
          parseLines
          value={node.script.args.join("\n")}
          onValue={(value) => patch({ args: value === "" ? [] : value.split("\n") })}
        />
      </label>
      <label>Stdin<TemplateField nodeId={id} rows={3} value={node.script.stdin ?? ""} onValue={(stdin) => patch({ stdin: stdin || undefined })} /></label>
      <label>Working directory<input value={node.script.cwd ?? ""} onChange={(event) => patch({ cwd: event.target.value || undefined })} placeholder="Optional" /></label>
      <label>Read stdout as<select value={node.script.output} onChange={(event) => patch({ output: event.target.value as ScriptNode["script"]["output"] })}><option value="text">text</option><option value="json">JSON</option></select></label>
    </>
  );
}

function CodeEditor({ id, node }: { id: string; node: CodeNode }) {
  const updateNode = useEditor((state) => state.updateNode);
  const [open, setOpen] = useState(false);
  const [runtimes, setRuntimes] = useState<CodeRuntimeReport>({});
  const language: CodeLanguage = node.language ?? "javascript";

  // Probed once per mount rather than on every keystroke: the answer only
  // changes when the user installs something, and each probe stats every PATH
  // entry. Failures resolve to {} in main, which reads as "unknown".
  useEffect(() => {
    let cancelled = false;
    void window.mcpeasy?.detectCodeRuntimes().then((report) => {
      if (!cancelled) setRuntimes(report);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const status = runtimes[language];
  const missing = status !== undefined && !status.available;
  // Preview only: the full editor is the overlay. Enough lines to recognize
  // the block without turning the 340px panel into a cramped code window.
  const preview = node.source.split(/\r?\n/).slice(0, 6).join("\n");
  const hiddenLines = node.source.split(/\r?\n/).length - 6;

  return (
    <>
      <div className="problem problem-warning">Trusted code. It runs in a separate process with a timeout, but this is not a security sandbox.</div>
      <label>
        Language
        <select
          value={language}
          onChange={(event) => {
            const next = event.target.value as CodeLanguage;
            // Same guard as the overlay: only replace an untouched starter.
            const source = isStarterSource(node.source) ? starterFor(next) : node.source;
            updateNode(id, { ...node, language: next, source });
          }}
        >
          {CODE_LANGUAGES.map((value) => {
            const runtime = runtimes[value];
            return (
              <option key={value} value={value}>
                {LANGUAGE_LABEL[value]}
                {runtime !== undefined && !runtime.available ? " (not installed)" : ""}
              </option>
            );
          })}
        </select>
      </label>
      {missing && (
        <div className="problem problem-warning">
          {LANGUAGE_LABEL[language]} is not installed on this machine, so this block will fail when the tool runs.
        </div>
      )}
      <label>
        Code
        <button className="code-open-btn" onClick={() => setOpen(true)}>
          <span className="code-open-btn__label">Open editor</span>
          <span className="code-open-btn__hint">{LANGUAGE_LABEL[language]}</span>
        </button>
      </label>
      <pre className="code-preview" onClick={() => setOpen(true)} title="Open the full editor">
        {preview || "(empty)"}
        {hiddenLines > 0 ? `\n… ${hiddenLines} more ${hiddenLines === 1 ? "line" : "lines"}` : ""}
      </pre>
      <p className="muted small">{LANGUAGE_HINT[language]}</p>
      {open && (
        <CodeOverlay
          node={node}
          runtimes={runtimes}
          onChange={(next) => updateNode(id, next)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

const PARALLEL_BRANCH_KINDS = ["action", "command", "script", "code", "parallel", "transform"] as const;

function ParallelEditor({ id, node }: { id: string; node: ParallelNode }) {
  const updateNode = useEditor((state) => state.updateNode);
  const addBranch = useEditor((state) => state.addParallelBranch);
  const patchBranch = (index: number, name: string) => updateNode(id, {
    ...node,
    branches: node.branches.map((branch, branchIndex) => branchIndex === index ? { ...branch, name } : branch),
  });
  return (
    <>
      <p className="muted small">Every named branch starts together. Results join into an object keyed by these names before the next node runs.</p>
      {node.branches.map((branch, index) => (
        <label key={`${index}:${branch.entry}`}>Branch {index + 1}<input value={branch.name} onChange={(event) => patchBranch(index, event.target.value)} placeholder={`request_${index + 1}`} /></label>
      ))}
      <div className="parallel-add-grid">
        {PARALLEL_BRANCH_KINDS.map((kind) => <button key={kind} type="button" onClick={() => addBranch(id, kind)}>+ {KIND_META[kind].label}</button>)}
      </div>
    </>
  );
}

function TransformEditor({ id, node }: { id: string; node: TransformNode }) {
  const updateNode = useEditor((s) => s.updateNode);
  return (
    <>
      <label>
        Operation
        <select
          value={node.op}
          onChange={(e) => {
            const op = e.target.value as TransformNode["op"];
            // Keep both fields when switching so no typing is lost; lint and
            // the engine only read the field matching `op`.
            updateNode(id, { ...node, op });
          }}
        >
          <option value="pick">pick (keep selected fields)</option>
          <option value="template">template (build a new value)</option>
        </select>
      </label>
      {node.op === "pick" ? (
        <label>
          Fields to keep (dot paths, one per line; last segment becomes the key)
          <ListTextarea
            initial={node.pick ?? []}
            rows={3}
            onLines={(pick) => updateNode(id, { ...node, pick })}
            placeholder={"id\ntitle\naddress.city"}
          />
        </label>
      ) : (
        <label>
          Template (chips insert variables at the cursor)
          <TemplateField
            nodeId={id}
            rows={3}
            value={node.template ?? ""}
            onValue={(template) => updateNode(id, { ...node, template: template || undefined })}
            placeholder="…builds a new text value from the fields below"
          />
        </label>
      )}
    </>
  );
}

function ReturnEditor({ id, node }: { id: string; node: ReturnNode }) {
  const updateNode = useEditor((s) => s.updateNode);
  return (
    <>
      <label>
        Format
        <select
          value={node.format}
          onChange={(e) => updateNode(id, { ...node, format: e.target.value as ReturnNode["format"] })}
        >
          <option value="json">json (structured result)</option>
          <option value="text">text (rendered template)</option>
        </select>
      </label>
      <label>
        Template {node.format === "json" ? "(unused for json)" : "(falls back to prev if empty)"}
        <TemplateField
          nodeId={id}
          rows={3}
          value={node.template ?? ""}
          onValue={(template) => updateNode(id, { ...node, template: template || undefined })}
          placeholder="The answer is …"
        />
      </label>
    </>
  );
}

/**
 * Floating right-side detail card (runtime-map style): header = neutral object
 * icon + title + icon actions (⊙ center, ✕ close), body = problems +
 * kind editor, footer = full-width action buttons.
 */
export function NodePanel({ id, node }: { id: string; node: GraphNode }) {
  const state = useEditor();
  const deleteNode = useEditor((s) => s.deleteNode);
  const select = useEditor((s) => s.select);
  const fitNodes = useFitNodes();
  const problems = [
    ...(state.lint[id] ?? []),
    ...state.validation
      .filter((v) => v.path === id || v.path.startsWith(`${id}.`))
      .map((v) => ({ severity: "error" as const, message: v.message })),
  ];
  const title = node.kind === "tool" ? node.name || "(unnamed)" : KIND_META[node.kind].label;

  return (
    <div className="detail-panel">
      <div className="detail-panel__header">
        <div className="detail-panel__title">
          <span className="detail-panel__icon">
            {KIND_META[node.kind].icon}
          </span>
          <span className="detail-panel__titletext">
            {title} <span className="muted">{id}</span>
          </span>
        </div>
        <div className="detail-panel__actions">
          <button
            className="panel-icon-btn"
            onClick={() => fitNodes([id])}
            title="Center on node"
            aria-label="Center on node"
          >
            ⊙
          </button>
          <button
            className="panel-icon-btn"
            onClick={() => select(null)}
            title="Close"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="detail-panel__body">
        {problems.map((p, i) => (
          <div key={i} className={`problem problem-${p.severity}`}>
            {p.message}
          </div>
        ))}
        {node.kind === "tool" && <ToolEditor id={id} node={node} />}
        {node.kind === "action" && <ActionEditor id={id} node={node} />}
        {node.kind === "command" && <CommandEditor id={id} node={node} />}
        {node.kind === "script" && <ScriptEditor id={id} node={node} />}
        {node.kind === "code" && <CodeEditor id={id} node={node} />}
        {node.kind === "parallel" && <ParallelEditor id={id} node={node} />}
        {node.kind === "transform" && <TransformEditor id={id} node={node} />}
        {node.kind === "return" && <ReturnEditor id={id} node={node} />}
      </div>
      <div className="detail-panel__footer">
        {/* No console shortcut here: the test console is a permanent drawer now. */}
        <button className="panel-action-btn panel-action-btn--danger" onClick={() => deleteNode(id)}>
          Delete block
        </button>
      </div>
    </div>
  );
}
