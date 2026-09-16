import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useReactFlow } from "@xyflow/react";
import { useEditor } from "../../store";
import type { LayoutDirection } from "../../graph";

/**
 * PyroTrace chrome: bottom-left square zoom buttons (+ / − / ⊙), a layout
 * picker, and a small legend of the semantic edge colors — same palette
 * and meaning as the runtime map, fitted to MCP chains. Must render inside
 * the ReactFlowProvider (uses the flow instance for zoom/fit).
 */
const LEGEND: Array<{ cls: string; label: string }> = [
  { cls: "normal", label: "Wired, clean" },
  { cls: "first-seen", label: "Has warnings" },
  { cls: "risky", label: "Has errors" },
  { cls: "internet", label: "HTTP data" },
];

// A 232px card at this scale lands near the reference's ~325px visual width.
// Keeping one ceiling for first paint and manual Fit prevents the two controls
// from presenting noticeably different canvas scales.
export const FIT_VIEW_MAX_ZOOM = 1.4;

/**
 * Directly compute node bounds and fly the viewport to fit them.
 * React Flow v12's `fitView()` routes through a batch queue that silently
 * fails in controlled-node mode (the queue handler skips `setNodes` when
 * `hasDefaultNodes` is false, so the `fitViewQueued` flag never resolves).
 * `fitBounds` bypasses the queue and calls `panZoom.setViewport` directly.
 */
function useFitAll() {
  const { getNodes, getNodesBounds, fitBounds } = useReactFlow();
  return (padding: number, _maxZoom: number, duration: number) => {
    const nodes = getNodes();
    if (nodes.length === 0) return;
    const bounds = getNodesBounds(nodes);
    // eslint-disable-next-line no-console
    console.log('[fitAll] nodes:', nodes.length, 'bounds:', JSON.stringify(bounds));
    fitBounds(bounds, { padding, duration }).then((ok) => {
      // eslint-disable-next-line no-console
      console.log('[fitAll] fitBounds resolved:', ok);
    });
  };
}

/**
 * Fly the viewport to center a single node or a set of specific nodes.
 * Same direct approach as `useFitAll` — avoids the broken batch queue.
 */
export function useFitNodes() {
  const { getNodesBounds, fitBounds } = useReactFlow();
  return (nodeIds: string[], opts: { padding?: number; duration?: number } = {}) => {
    // getNodesBounds accepts node IDS directly (its parameter is
    // (string | Node | InternalNode)[]). Passing `{ id }` stubs instead fails
    // to typecheck, because a bare {id} is not a Node.
    const bounds = getNodesBounds(nodeIds);
    void fitBounds(bounds, { padding: opts.padding ?? 0.3, duration: opts.duration ?? 600 });
  };
}

/** The fixed layout choices and their labels/icons. */
const LAYOUTS: Array<{ direction: LayoutDirection; label: string; icon: ReactElement }> = [
  {
    direction: "vertical",
    label: "Vertical (top → down)",
    // Downward-pointing tree icon: a vertical trunk with two branches.
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3v18" />
        <path d="M5 10l7-7 7 7" />
        <path d="M5 17h14" />
      </svg>
    ),
  },
  {
    direction: "horizontal",
    label: "Horizontal (left → right)",
    // Right-pointing flow icon.
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 12h18" />
        <path d="M14 5l7 7-7 7" />
        <path d="M7 5v14" />
      </svg>
    ),
  },
  {
    direction: "grid",
    label: "Grid",
    // 2×2 grid icon.
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
  },
];

export function ZoomControls() {
  const { zoomIn, zoomOut } = useReactFlow();
  const fitAll = useFitAll();
  const [layoutOpen, setLayoutOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close the popover when clicking outside of it.
  useEffect(() => {
    if (!layoutOpen) return;
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setLayoutOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [layoutOpen]);

  const onLayoutPick = useCallback((direction: LayoutDirection) => {
    useEditor.getState().applyLayout(direction);
    setLayoutOpen(false);
    // Re-fit after the layout change takes effect on the next render.
    requestAnimationFrame(() => fitAll(0.15, FIT_VIEW_MAX_ZOOM, 400));
  }, [fitAll]);

  return (
    <div className="zoom-controls">
      <button
        className="zoom-btn"
        onClick={() => void zoomIn({ duration: 250 })}
        title="Zoom in"
        aria-label="Zoom in"
      >
        +
      </button>
      <button
        className="zoom-btn"
        onClick={() => void zoomOut({ duration: 250 })}
        title="Zoom out"
        aria-label="Zoom out"
      >
        −
      </button>
      <button
        className="zoom-btn"
        // Fit should reveal a large workflow while keeping a lone root close
        // enough to edit without immediately reaching for Zoom In.
        onClick={() => fitAll(0.15, FIT_VIEW_MAX_ZOOM, 400)}
        title="Fit view"
        aria-label="Fit view"
      >
        {/* Fit-to-view corners glyph — clearer than the old ⊙, and an inline
            stroke SVG like the other toolbar icons so it follows currentColor. */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 9V5a1 1 0 0 1 1-1h4" />
          <path d="M15 4h4a1 1 0 0 1 1 1v4" />
          <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
          <path d="M9 20H5a1 1 0 0 1-1-1v-4" />
        </svg>
      </button>

      {/* Layout picker — a button that toggles a small popover of layout
          choices. Placed between fit-view and the legend so the controls
          stay grouped by purpose: zoom → fit → layout → legend. */}
      <div className="layout-picker-wrap" ref={popoverRef}>
        <button
          className={layoutOpen ? "zoom-btn active" : "zoom-btn"}
          onClick={() => setLayoutOpen((v) => !v)}
          title="Change layout"
          aria-label="Change layout"
          aria-expanded={layoutOpen}
        >
          {/* 3-row horizontal-lines "layout" glyph */}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 6h16" />
            <path d="M4 12h10" />
            <path d="M4 18h14" />
          </svg>
        </button>
        {layoutOpen && (
          <div className="layout-popover" role="listbox" aria-label="Layout options">
            {LAYOUTS.map(({ direction, label, icon }) => (
              <button
                key={direction}
                className="layout-option"
                role="option"
                onClick={() => onLayoutPick(direction)}
                title={label}
              >
                {icon}
                <span>{label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="legend-card" aria-label="Edge colors">
        {LEGEND.map(({ cls, label }) => (
          <div key={cls} className="legend-row" title={label}>
            <span className="legend-line" style={{ background: `var(--runtime-edge-${cls})` }} />
          </div>
        ))}
      </div>
    </div>
  );
}
