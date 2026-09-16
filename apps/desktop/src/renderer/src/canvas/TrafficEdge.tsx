import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, useStore, type Edge, type EdgeProps } from "@xyflow/react";

// Reference-style workflow edges: semantic color, rounded orthogonal corners,
// filled endpoint dots and a centered pill label. MCP meaning still comes from
// the graph; this component only renders that derived presentation.
export type EdgeClass = "normal" | "first-seen" | "risky" | "internet";

export type TrafficEdgeData = {
  edgeClass?: EdgeClass;
  /** Flow-dot budget switch — the canvas disables dots on huge graphs. */
  flowActive?: boolean;
  /** Derived visual copy such as "Run request"; never execution state. */
  label?: string;
};
export type TrafficEdgeType = Edge<TrafficEdgeData>;

const EDGE = {
  width: 2,
  widthSelected: 3,
} as const;

export function TrafficEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps<TrafficEdgeType>) {
  // Counter-scaling keeps endpoint/traffic dots readable at overview zooms.
  const zoom = useStore((state) => state.transform[2]);
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    // The reference uses mostly square elbows with only a tiny corner softening.
    // Large radii read as generic flowchart curves and miss its circuit-like paths.
    borderRadius: 4,
    offset: 24,
  });
  const cls: EdgeClass = data?.edgeClass ?? "normal";
  const color = `var(--runtime-edge-${cls})`;
  const opacity = selected ? "1" : `var(--runtime-edge-${cls}-opacity)`;
  const zoomScale = 1 / Math.max(zoom, 0.25);
  // Keep anchors visually subordinate to the path. The old 5px counter-scaled
  // circles became large bubbles at overview zooms instead of reference dots.
  const endpointRadius = 3.25;
  const dotRadius = 3 * zoomScale;
  const showFlow = data?.flowActive !== false && edgePath.length > 0;
  // Deterministic staggering prevents adjacent workflows from pulsing together.
  const delay = -(((id.charCodeAt(2) || 0) + id.length) % 5) * 0.29;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth: selected ? EDGE.widthSelected : EDGE.width,
          strokeOpacity: opacity,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          transition: "stroke-width 180ms, stroke-opacity 180ms",
        }}
      />
      {/* Filled endpoints make the exact receiver/connection points visible,
          matching the reference and the clickable + receiver on open tails. */}
      <circle cx={sourceX} cy={sourceY} r={endpointRadius} fill={color} pointerEvents="none" />
      <circle cx={targetX} cy={targetY} r={endpointRadius} fill={color} pointerEvents="none" />
      {showFlow && (
        <circle
          className="flow-dot"
          r={dotRadius}
          pointerEvents="none"
          style={{
            fill: "var(--runtime-edge-flow-ring)",
            stroke: color,
            strokeWidth: 1.5 * zoomScale,
            offsetPath: `path("${edgePath}")`,
            animationDelay: `${delay}s`,
          }}
        />
      )}
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            className={`edge-label edge-label--${cls}${selected ? " edge-label--selected" : ""}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** Module-level constant — inline edgeTypes remount every edge on render. */
export const edgeTypes = { traffic: TrafficEdge };
