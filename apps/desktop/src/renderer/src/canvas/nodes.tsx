import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { GraphNode, ServerConfig } from "@mcpeasy/schema";
import { MCP_ROOT_NODE_ID, nodeSummary, type NodeKind } from "../graph";
import { KIND_META } from "./kinds";

export type CanvasData =
  | {
      variant: "root";
      server: ServerConfig;
      errors: number;
      pickerOpen: boolean;
      allowedKinds: NodeKind[];
      onTogglePicker: () => void;
      onAdd: (kind: NodeKind) => void;
    }
  | {
      variant: "graph";
      graphNode: GraphNode;
      errors: number;
      warnings: number;
      pickerOpen: boolean;
      allowedKinds: NodeKind[];
      onTogglePicker: () => void;
      onAdd: (kind: NodeKind) => void;
    };
export type CanvasNode = Node<CanvasData>;

type VisualKind = NodeKind | "mcpRoot";
type MetricIcon = "braces" | "check" | "code" | "file" | "filter" | "globe" | "key" | "list" | "route" | "split" | "terminal" | "text";
type Metric = {
  label: string;
  value: string | number;
  icon: MetricIcon;
  tone?: "neutral" | "ok" | "warn" | "danger";
};

const serverIcon = (
  <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="3" y="3" width="18" height="7" rx="2" />
    <rect x="3" y="14" width="18" height="7" rx="2" />
    <path d="M7 6.5h.01M7 17.5h.01M16 6.5h2M16 17.5h2" />
  </svg>
);

const dragIcon = (
  <svg viewBox="0 0 12 18" width="12" height="18" fill="currentColor" aria-hidden="true">
    <circle cx="3" cy="3" r="1.25" /><circle cx="9" cy="3" r="1.25" />
    <circle cx="3" cy="9" r="1.25" /><circle cx="9" cy="9" r="1.25" />
    <circle cx="3" cy="15" r="1.25" /><circle cx="9" cy="15" r="1.25" />
  </svg>
);

/** Compact metric glyphs replace generic dots. Distinct shapes keep each
 * value understandable without relying on the status color alone. */
function MetricGlyph({ name }: { name: MetricIcon }) {
  const common = {
    viewBox: "0 0 16 16",
    width: 12,
    height: 12,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "braces": return <svg {...common}><path d="M6 2.5H5A1.5 1.5 0 0 0 3.5 4v2A1.5 1.5 0 0 1 2 7.5 1.5 1.5 0 0 1 3.5 9v2A1.5 1.5 0 0 0 5 12.5h1M10 2.5h1A1.5 1.5 0 0 1 12.5 4v2A1.5 1.5 0 0 0 14 7.5 1.5 1.5 0 0 0 12.5 9v2a1.5 1.5 0 0 1-1.5 1.5h-1" /></svg>;
    case "check": return <svg {...common}><circle cx="8" cy="8" r="5.5" /><path d="m5.5 8 1.6 1.6 3.5-3.5" /></svg>;
    case "code": return <svg {...common}><path d="m5.5 4-3 4 3 4M10.5 4l3 4-3 4M9 2.5l-2 11" /></svg>;
    case "file": return <svg {...common}><path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 8h4M6 10.5h4" /></svg>;
    case "filter": return <svg {...common}><path d="M2 3h12L9.5 8v4l-3 1.5V8z" /></svg>;
    case "globe": return <svg {...common}><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2a9 9 0 0 1 0 12M8 2a9 9 0 0 0 0 12" /></svg>;
    case "key": return <svg {...common}><circle cx="5" cy="8" r="2.5" /><path d="M7.5 8H14M11 8v2M13 8v2" /></svg>;
    case "list": return <svg {...common}><path d="M6 4h7M6 8h7M6 12h7M3 4h.01M3 8h.01M3 12h.01" /></svg>;
    case "route": return <svg {...common}><circle cx="3" cy="3" r="1.5" /><circle cx="13" cy="13" r="1.5" /><path d="M4.5 3H9a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H7a2 2 0 0 0-2 2v1" /></svg>;
    case "split": return <svg {...common}><path d="M8 2v3M3 14v-3a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v3M3 14h.01M8 14h.01M13 14h.01" /></svg>;
    case "terminal": return <svg {...common}><rect x="1.5" y="2.5" width="13" height="11" rx="2" /><path d="m4 6 2 2-2 2M8 10h3" /></svg>;
    case "text": return <svg {...common}><path d="M3 3h10M8 3v10M5.5 13h5" /></svg>;
  }
}

function AddConnector({
  sourceId,
  pickerOpen,
  allowedKinds,
  onTogglePicker,
  onAdd,
}: {
  sourceId: string;
  pickerOpen: boolean;
  allowedKinds: NodeKind[];
  onTogglePicker: () => void;
  onAdd: (kind: NodeKind) => void;
}) {
  if (allowedKinds.length === 0) return null;
  const label = sourceId === MCP_ROOT_NODE_ID ? "Add an MCP tool" : "Add the next step";
  return (
    <>
      {/* Keep routing geometry on the card edge, while the add action sits at
          the end of its own short stem. Using one circular Handle for both jobs
          made the plus look off-centre and unlike the reference workflow. */}
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="node-source-anchor"
      />
      <button
        type="button"
        className="node-add-trigger nodrag nopan"
        onClick={(event) => {
          event.stopPropagation();
          onTogglePicker();
        }}
        aria-label={label}
        aria-expanded={pickerOpen}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 4v12M4 10h12" />
        </svg>
      </button>
      {pickerOpen && (
        <div className="node-picker nodrag nopan" role="menu" aria-label={label} onClick={(event) => event.stopPropagation()}>
          <div className="node-picker__heading">{label}</div>
          {allowedKinds.map((kind) => (
            <button key={kind} type="button" role="menuitem" className={`node-picker__option card-${kind}`} onClick={() => onAdd(kind)}>
              <span className={`kind-chip chip-${kind}`}>{KIND_META[kind].icon}</span>
              <span>
                <strong>{KIND_META[kind].label}</strong>
                <small>{KIND_META[kind].blurb}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function CardNode({
  kind,
  title,
  sub,
  meta,
  metrics,
  errors,
  warnings = 0,
  selected,
  hasTarget,
  sourceId,
  pickerOpen,
  allowedKinds,
  onTogglePicker,
  onAdd,
}: {
  kind: VisualKind;
  title: string;
  sub?: string;
  meta?: string;
  metrics: Metric[];
  errors: number;
  warnings?: number;
  selected: boolean;
  hasTarget: boolean;
  sourceId: string;
  pickerOpen: boolean;
  allowedKinds: NodeKind[];
  onTogglePicker: () => void;
  onAdd: (kind: NodeKind) => void;
}) {
  const icon = kind === "mcpRoot" ? serverIcon : KIND_META[kind].icon;
  return (
    <div className={`block-card block-card--${kind}${selected ? " block-card--selected" : ""}`}>
      {hasTarget && <Handle type="target" position={Position.Top} isConnectable={false} />}
      <div className="block-card__header">
        <span className={`block-card__chip chip-${kind}`}>{icon}</span>
        <span className="block-card__text">
          <span className="block-card__title">{title}</span>
          {sub && <span className="block-card__sub">{sub}</span>}
          {meta && <span className="block-card__meta">{meta}</span>}
        </span>
        <span className="block-card__drag" title="Drag node">{dragIcon}</span>
      </div>
      {metrics.length > 0 && (
        <div className="block-card__metrics" aria-label="Node details">
          {metrics.map((metric) => (
            <span
              key={metric.label}
              className={`block-card__metric block-card__metric--${metric.tone ?? "neutral"}`}
              title={`${metric.label}: ${metric.value}`}
              aria-label={`${metric.label}: ${metric.value}`}
            >
              <MetricGlyph name={metric.icon} />
              <strong>{metric.value}</strong>
            </span>
          ))}
        </div>
      )}
      {errors > 0 ? (
        <span className="block-card__badge block-card__badge--error" title={`${errors} error${errors > 1 ? "s" : ""}`}>{errors}</span>
      ) : warnings > 0 ? (
        <span className="block-card__badge block-card__badge--warn" title={`${warnings} warning${warnings > 1 ? "s" : ""}`}>{warnings}</span>
      ) : null}
      <AddConnector
        sourceId={sourceId}
        pickerOpen={pickerOpen}
        allowedKinds={allowedKinds}
        onTogglePicker={onTogglePicker}
        onAdd={onAdd}
      />
    </div>
  );
}

function RootView({ data, selected }: NodeProps<CanvasNode>) {
  if (data.variant !== "root") return null;
  return (
    <CardNode
      kind="mcpRoot"
      title={data.server.name || "Unnamed MCP"}
      metrics={[]}
      errors={data.errors}
      selected={selected}
      hasTarget={false}
      sourceId={MCP_ROOT_NODE_ID}
      pickerOpen={data.pickerOpen}
      allowedKinds={data.allowedKinds}
      onTogglePicker={data.onTogglePicker}
      onAdd={data.onAdd}
    />
  );
}

/** Abbreviations for the custom-code card badge, which has room for a few
 *  characters only. Anything missing falls through to the raw language id. */
const CODE_LANGUAGE_BADGE: Record<string, string> = {
  javascript: "JS",
  typescript: "TS",
  python: "Py",
  bash: "Bash",
  powershell: "PS",
  ruby: "Ruby",
  php: "PHP",
  go: "Go",
};

function graphMetrics(node: GraphNode, errors: number, warnings: number): Metric[] {
  const health: Metric = errors > 0
    ? { label: "errors", value: errors, icon: "check", tone: "danger" }
    : warnings > 0
      ? { label: "warnings", value: warnings, icon: "check", tone: "warn" }
      : { label: "status", value: "Ready", icon: "check", tone: "ok" };
  switch (node.kind) {
    case "tool":
      return [{ label: "inputs", value: node.inputs.length, icon: "braces" }, { label: "access", value: node.annotations.readOnly ? "Read" : "Write", icon: "key" }, health];
    case "action":
      return [{ label: "method", value: node.http.method, icon: "globe" }, { label: "target", value: node.http.url ? "Set" : "Missing", icon: "route", tone: node.http.url ? "neutral" : "warn" }, health];
    case "command":
      return [{ label: "output", value: node.command.output, icon: "terminal" }, { label: "args", value: node.command.args.length, icon: "list" }, health];
    case "script":
      return [{ label: "runtime", value: node.script.runtime, icon: "file" }, { label: "output", value: node.script.output, icon: "text" }, health];
    case "code":
      // Short codes so the badge stays inside the card's fixed width; the
      // full name is available in the panel. Falls back to the language id
      // for anything not abbreviated here rather than showing a stale "JS".
      return [{ label: "language", value: CODE_LANGUAGE_BADGE[node.language] ?? node.language, icon: "code" }, { label: "lines", value: node.source.split(/\r?\n/).length, icon: "list" }, health];
    case "parallel":
      return [{ label: "branches", value: node.branches.length, icon: "split" }, { label: "mode", value: "Concurrent", icon: "route" }, health];
    case "transform":
      return [{ label: "operation", value: node.op, icon: "filter" }, { label: "fields", value: node.op === "pick" ? (node.pick ?? []).length : "Template", icon: "braces" }, health];
    case "return":
      return [{ label: "format", value: node.format.toUpperCase(), icon: node.format === "json" ? "braces" : "text" }, health];
  }
}

function GraphCardView({ id, data, selected, expectedKind }: NodeProps<CanvasNode> & { expectedKind: NodeKind }) {
  if (data.variant !== "graph" || data.graphNode.kind !== expectedKind) return null;
  const { title, sub } = nodeSummary(data.graphNode);
  const description = data.graphNode.kind === "tool" ? data.graphNode.description.trim() : "";
  return (
    <CardNode
      kind={data.graphNode.kind}
      title={title}
      sub={description || sub || KIND_META[data.graphNode.kind].blurb}
      metrics={graphMetrics(data.graphNode, data.errors, data.warnings)}
      errors={data.errors}
      warnings={data.warnings}
      selected={selected}
      hasTarget
      sourceId={id}
      pickerOpen={data.pickerOpen}
      allowedKinds={data.allowedKinds}
      onTogglePicker={data.onTogglePicker}
      onAdd={data.onAdd}
    />
  );
}

function ToolView(props: NodeProps<CanvasNode>) { return <GraphCardView {...props} expectedKind="tool" />; }
function ActionView(props: NodeProps<CanvasNode>) { return <GraphCardView {...props} expectedKind="action" />; }
function CommandView(props: NodeProps<CanvasNode>) { return <GraphCardView {...props} expectedKind="command" />; }
function ScriptView(props: NodeProps<CanvasNode>) { return <GraphCardView {...props} expectedKind="script" />; }
function CodeView(props: NodeProps<CanvasNode>) { return <GraphCardView {...props} expectedKind="code" />; }
function ParallelView(props: NodeProps<CanvasNode>) { return <GraphCardView {...props} expectedKind="parallel" />; }
function TransformView(props: NodeProps<CanvasNode>) { return <GraphCardView {...props} expectedKind="transform" />; }
function ReturnView(props: NodeProps<CanvasNode>) { return <GraphCardView {...props} expectedKind="return" />; }

/** Module-level constant prevents React Flow from remounting every card. */
export const nodeTypes = {
  mcpRoot: RootView,
  tool: ToolView,
  action: ActionView,
  command: CommandView,
  script: ScriptView,
  code: CodeView,
  parallel: ParallelView,
  transform: TransformView,
  return: ReturnView,
};
