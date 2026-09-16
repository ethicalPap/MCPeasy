import { useEffect, useMemo, useRef, useState } from "react";
import { MCP_ROOT_NODE_ID, searchNodes, type NodeHit } from "./graph";
import { KIND_META } from "./canvas/kinds";
import { useFitNodes } from "./canvas/overlays/ZoomControls";
import { useEditor } from "./store";

// Title-bar search (the reference design's "Search Here…" field, fitted to
// the builder): type to find blocks by title/sub/id/kind, pick one to select
// it and fly the canvas to it. The app-level ReactFlowProvider spans both the
// title bar and canvas so fitView drives the same viewport the panels use.

export function SearchBar() {
  const state = useEditor();
  const fitNodes = useFitNodes();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const hits = useMemo<NodeHit[]>(() => {
    const q = query.trim().toLowerCase();
    const rootHit = q !== "" && [state.doc.server.name, state.doc.server.description ?? "", state.doc.server.creator ?? "", "mcp server root"]
      .some((value) => value.toLowerCase().includes(q))
      ? [{ id: MCP_ROOT_NODE_ID, kind: "tool" as const, title: state.doc.server.name || "Unnamed MCP", sub: "MCP server root" }]
      : [];
    return [...rootHit, ...searchNodes(state.doc, query)].slice(0, 8);
  }, [state.doc, query]);

  // Ctrl/Cmd+K focuses search — the shortcut the field's kbd hint advertises.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keep the highlighted row inside the (re-ranked) result list.
  useEffect(() => {
    if (activeIdx >= hits.length) setActiveIdx(0);
  }, [hits.length, activeIdx]);

  const pick = (hit: NodeHit): void => {
    state.select(hit.id);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
    // Same flight the detail panel's ⊙ uses — one "center on node" motion
    // everywhere. (NodePanel.tsx keeps identical options.)
    fitNodes([hit.id]);
  };

  const isMac = navigator.userAgent.includes("Mac");

  return (
    <div className="toolbar-search" role="combobox" aria-expanded={open && query !== ""} aria-haspopup="listbox">
      <svg
        className="toolbar-search__icon"
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.8-3.8" />
      </svg>
      <input
        ref={inputRef}
        className="toolbar-search__input"
        type="text"
        placeholder="Search blocks…"
        aria-label="Search blocks"
        aria-controls="search-results"
        aria-activedescendant={open && hits[activeIdx] ? `search-opt-${activeIdx}` : undefined}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActiveIdx(0);
        }}
        onFocus={() => setOpen(true)}
        // Blur closes the popup; option rows use onMouseDown+preventDefault
        // so a click lands BEFORE this fires and still picks the row.
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIdx((i) => Math.min(i + 1, hits.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            const hit = hits[activeIdx];
            if (hit) pick(hit);
          } else if (e.key === "Escape") {
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
      />
      <kbd className="toolbar-search__kbd" aria-hidden="true">
        {isMac ? "⌘K" : "Ctrl K"}
      </kbd>

      {open && query.trim() !== "" && (
        <div className="search-pop" id="search-results" role="listbox" aria-label="Matching blocks">
          {hits.length === 0 ? (
            <div className="search-empty">No blocks match “{query.trim()}”</div>
          ) : (
            hits.map((hit, idx) => (
              <div
                key={hit.id}
                id={`search-opt-${idx}`}
                role="option"
                aria-selected={idx === activeIdx}
                className={`search-hit${idx === activeIdx ? " search-hit--active" : ""}`}
                // mousedown only keeps the input focused (no blur-close);
                // the pick runs on CLICK while the row is still mounted —
                // picking on mousedown unmounted the popup mid-gesture and
                // the mouseup fell through onto the canvas card below,
                // re-selecting whatever node happened to be under the cursor.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(hit)}
                onMouseEnter={() => setActiveIdx(idx)}
              >
                <span className={`kind-chip ${hit.id === MCP_ROOT_NODE_ID ? "chip-mcpRoot" : `chip-${hit.kind}`}`}>
                  {hit.id === MCP_ROOT_NODE_ID ? "M" : KIND_META[hit.kind].icon}
                </span>
                <span className="search-hit__text">
                  <span className="search-hit__title">{hit.title}</span>
                  <span className="search-hit__sub">{hit.sub}</span>
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
