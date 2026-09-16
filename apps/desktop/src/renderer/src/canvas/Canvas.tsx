import { useCallback, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Position,
  ReactFlow,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import { useEditor, problemsFor } from "../store";
import {
  MCP_ROOT_NODE_ID,
  MCP_ROOT_NODE_TYPE,
  allowedConnectedKinds,
  builderEdgeLabel,
  deriveBuilderEdges,
  type NodeKind,
} from "../graph";
import { nodeTypes, type CanvasNode } from "./nodes";
import { edgeTypes, type EdgeClass, type TrafficEdgeType } from "./TrafficEdge";
import { FIT_VIEW_MAX_ZOOM, ZoomControls } from "./overlays/ZoomControls";

// First-paint geometry must match CSS exactly or React Flow briefly routes
// edges from stale card centers before ResizeObserver reports real bounds.
const NODE_EST = { width: 232, height: 92 };
const ROOT_EST = { width: 232, height: 76 };
const HANDLE_EST = { x: 112, width: 8, height: 8 };
const ROOT_HANDLE_EST = { x: 112, width: 8, height: 8 };
const FALLBACK_HANDLES: Record<NodeKind, CanvasNode["handles"]> = {
  tool: [
    { ...HANDLE_EST, type: "target", position: Position.Top, y: 0 },
    { ...HANDLE_EST, type: "source", position: Position.Bottom, y: NODE_EST.height },
  ],
  action: [
    { ...HANDLE_EST, type: "target", position: Position.Top, y: 0 },
    { ...HANDLE_EST, type: "source", position: Position.Bottom, y: NODE_EST.height },
  ],
  transform: [
    { ...HANDLE_EST, type: "target", position: Position.Top, y: 0 },
    { ...HANDLE_EST, type: "source", position: Position.Bottom, y: NODE_EST.height },
  ],
  command: [
    { ...HANDLE_EST, type: "target", position: Position.Top, y: 0 },
    { ...HANDLE_EST, type: "source", position: Position.Bottom, y: NODE_EST.height },
  ],
  script: [
    { ...HANDLE_EST, type: "target", position: Position.Top, y: 0 },
    { ...HANDLE_EST, type: "source", position: Position.Bottom, y: NODE_EST.height },
  ],
  code: [
    { ...HANDLE_EST, type: "target", position: Position.Top, y: 0 },
    { ...HANDLE_EST, type: "source", position: Position.Bottom, y: NODE_EST.height },
  ],
  parallel: [
    { ...HANDLE_EST, type: "target", position: Position.Top, y: 0 },
    { ...HANDLE_EST, type: "source", position: Position.Bottom, y: NODE_EST.height },
  ],
  return: [{ ...HANDLE_EST, type: "target", position: Position.Top, y: 0 }],
};

/** Controlled doc-as-store canvas with one derived MCP root. Node creation is
 * deliberately owned by the source connector picker, not by pane drop or a
 * side palette, so an add action cannot leave an unattached node. */
export function Canvas({
  helpOpen,
  onCloseHelp,
  onOpenHelp,
}: {
  helpOpen: boolean;
  onCloseHelp: () => void;
  onOpenHelp: () => void;
}) {
  const state = useEditor();
  const { doc, selectedId } = state;
  const [pickerSourceId, setPickerSourceId] = useState<string | null>(null);

  const togglePicker = useCallback((sourceId: string) => {
    setPickerSourceId((current) => (current === sourceId ? null : sourceId));
  }, []);

  const addFrom = useCallback((sourceId: string, kind: NodeKind) => {
    useEditor.getState().addConnectedNode(sourceId, kind);
    setPickerSourceId(null);
  }, []);

  const nodes = useMemo<CanvasNode[]>(() => {
    const serverProblems = state.lint.server ?? [];
    const root: CanvasNode = {
      id: MCP_ROOT_NODE_ID,
      type: MCP_ROOT_NODE_TYPE,
      position: doc.layout?.[MCP_ROOT_NODE_ID] ?? { x: 80, y: 60 },
      data: {
        variant: "root",
        server: doc.server,
        errors:
          serverProblems.filter((problem) => problem.severity === "error").length +
          state.validation.filter((issue) => issue.path === "server" || issue.path.startsWith("server.")).length,
        pickerOpen: pickerSourceId === MCP_ROOT_NODE_ID,
        allowedKinds: allowedConnectedKinds(doc, MCP_ROOT_NODE_ID),
        onTogglePicker: () => togglePicker(MCP_ROOT_NODE_ID),
        onAdd: (kind) => addFrom(MCP_ROOT_NODE_ID, kind),
      },
      selected: selectedId === MCP_ROOT_NODE_ID,
      ...ROOT_EST,
      handles: [{ ...ROOT_HANDLE_EST, type: "source", position: Position.Bottom, y: ROOT_EST.height }],
      deletable: false,
    };

    const graphNodes = Object.entries(doc.nodes).map<CanvasNode>(([id, graphNode]) => {
      const { errors, warnings } = problemsFor(state, id);
      return {
        id,
        type: graphNode.kind,
        position: doc.layout?.[id] ?? { x: 0, y: 0 },
        data: {
          variant: "graph",
          graphNode,
          errors,
          warnings,
          pickerOpen: pickerSourceId === id,
          allowedKinds: allowedConnectedKinds(doc, id),
          onTogglePicker: () => togglePicker(id),
          onAdd: (kind) => addFrom(id, kind),
        },
        selected: id === selectedId,
        ...NODE_EST,
        handles: FALLBACK_HANDLES[graphNode.kind],
      };
    });
    return [root, ...graphNodes];
  }, [state, doc, selectedId, pickerSourceId, togglePicker, addFrom]);

  const edges = useMemo<TrafficEdgeType[]>(() => {
    const derived = deriveBuilderEdges(doc);
    const flowActive = derived.length <= 60;
    return derived.map((edge) => {
      const src = edge.source === MCP_ROOT_NODE_ID ? { errors: 0, warnings: 0 } : problemsFor(state, edge.source);
      const tgt = problemsFor(state, edge.target);
      let edgeClass: EdgeClass = "normal";
      if (src.errors + tgt.errors > 0) edgeClass = "risky";
      else if (src.warnings + tgt.warnings > 0) edgeClass = "first-seen";
      else if (doc.nodes[edge.source]?.kind === "action") edgeClass = "internet";
      return {
        ...edge,
        type: "traffic" as const,
        data: {
          edgeClass,
          flowActive,
          label: builderEdgeLabel(doc, edge.source, edge.target),
        },
        // Root ownership edges are structural and cannot be deleted; execution
        // edges remain deletable so opened legacy graphs can still be repaired.
        deletable: edge.source !== MCP_ROOT_NODE_ID,
      };
    });
  }, [state, doc]);

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    const editor = useEditor.getState();
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        editor.moveNode(change.id, change.position);
      } else if (change.type === "remove" && change.id !== MCP_ROOT_NODE_ID) {
        editor.deleteNode(change.id);
      } else if (change.type === "select") {
        if (change.selected) editor.select(change.id);
        else if (useEditor.getState().selectedId === change.id) editor.select(null);
      }
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<TrafficEdgeType>[]) => {
    const editor = useEditor.getState();
    for (const change of changes) {
      if (change.type === "remove" && change.id.startsWith("e_")) {
        editor.disconnectFrom(change.id);
      }
    }
  }, []);

  return (
    <div className="canvas-host">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onPaneClick={() => {
          setPickerSourceId(null);
          state.select(null);
        }}
        fitView
        // Bound one-node fitting below the canvas's 4x navigation limit, but
        // keep the root nearer than its former 1x framing for immediate editing.
        fitViewOptions={{ padding: 0.22, maxZoom: FIT_VIEW_MAX_ZOOM }}
        minZoom={0.05}
        maxZoom={4}
        deleteKeyCode={["Delete", "Backspace"]}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <ZoomControls />
      </ReactFlow>
      {helpOpen && (
        <div className="canvas-help" role="dialog" aria-labelledby="canvas-help-title">
          <div className="canvas-help-card">
            <button
              className="panel-icon-btn canvas-help-close"
              type="button"
              onClick={onCloseHelp}
              title="Close getting started"
              aria-label="Close getting started"
            >
              ✕
            </button>
            <h3 id="canvas-help-title">Build your first tool</h3>
            <p>
              Select the MCP root to define its name, description and creator. Then click its <strong>+</strong> connector to add a Tool.
            </p>
            <p className="muted small">Continue each workflow from the + connector on its last card.</p>
          </div>
        </div>
      )}
      {!helpOpen && (
        <button className="canvas-help-button" type="button" onClick={onOpenHelp} aria-label="Open getting started" title="Open getting started">
          ?
        </button>
      )}
    </div>
  );
}
