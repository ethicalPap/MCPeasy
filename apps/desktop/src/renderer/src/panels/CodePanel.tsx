import { useMemo, useRef, useState } from "react";
import { serializeDocText } from "../graph";
import { generateTypescript } from "../codegen";
import { tokenizeJson, tokenizeTs, type Token } from "../highlight";
import { useEditor } from "../store";

// Advanced mode (user call: "make workflows straight from code"). Two tabs:
//   Graph JSON — the doc itself, editable; Apply round-trips it through the
//     store's text loader (same migrate → shape-parse path as File → Open),
//     so canvas, lint and badges update exactly as if the file were opened.
//   TypeScript — a generated MCP-SDK skeleton of the current graph to copy
//     out; read-only because JSON is the single source of truth (the
//     phase-4 compiler owns real TS emit; this is the teaching preview).
// Both views are syntax-highlighted with VS Code's default token palette
// (see styles.css .tok-* rules and highlight.ts).

/** Tokens → spans. Token text concatenation equals the source text exactly
 *  (highlight.ts invariant), which the JSON overlay depends on. */
function TokenSpans({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((t, i) =>
        t.kind === "plain" ? t.text : (
          <span key={i} className={`tok-${t.kind}`}>
            {t.text}
          </span>
        ),
      )}
    </>
  );
}

export function CodePanel({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const docId = useEditor((s) => s.docId);
  const applyDocText = useEditor((s) => s.applyDocText);
  const [tab, setTab] = useState<"json" | "ts">("json");
  // Buffer keyed by doc identity: reseeded when another doc is opened, but
  // NOT on every canvas edit while the user is typing here.
  const [buffer, setBuffer] = useState(() => serializeDocText(doc));
  const [seededFor, setSeededFor] = useState(docId);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const highlightRef = useRef<HTMLPreElement>(null);
  if (seededFor !== docId) {
    setSeededFor(docId);
    setBuffer(serializeDocText(doc));
    setError(null);
  }

  const ts = useMemo(() => (tab === "ts" ? generateTypescript(doc) : ""), [tab, doc]);
  const tsTokens = useMemo(() => (tab === "ts" ? tokenizeTs(ts) : []), [tab, ts]);
  const jsonTokens = useMemo(() => (tab === "json" ? tokenizeJson(buffer) : []), [tab, buffer]);

  const apply = () => {
    const result = applyDocText(buffer);
    setError(result.ok ? null : result.error);
  };

  const refresh = () => {
    setBuffer(serializeDocText(doc));
    setError(null);
  };

  const copyTs = () => {
    void navigator.clipboard.writeText(ts).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  // The colored layer sits behind the transparent-text textarea and must
  // mirror its scroll position every frame, or colors drift off the glyphs.
  const syncScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const hl = highlightRef.current;
    if (hl) {
      hl.scrollTop = e.currentTarget.scrollTop;
      hl.scrollLeft = e.currentTarget.scrollLeft;
    }
  };

  return (
    <div className="code-panel">
      <div className="code-panel__header">
        <div className="code-panel__tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "json"}
            className={tab === "json" ? "code-tab code-tab--active" : "code-tab"}
            onClick={() => setTab("json")}
          >
            Graph JSON
          </button>
          <button
            role="tab"
            aria-selected={tab === "ts"}
            className={tab === "ts" ? "code-tab code-tab--active" : "code-tab"}
            onClick={() => setTab("ts")}
          >
            TypeScript (SDK example)
          </button>
        </div>
        <div className="code-panel__actions">
          {tab === "json" ? (
            <>
              <button onClick={refresh} title="Replace the editor content with the current canvas state">
                Load from canvas
              </button>
              <button className="primary" onClick={apply}>
                Apply to canvas
              </button>
            </>
          ) : (
            <button onClick={copyTs}>{copied ? "Copied ✓" : "Copy code"}</button>
          )}
          <button className="panel-icon-btn" onClick={onClose} title="Close code view" aria-label="Close code view">
            ✕
          </button>
        </div>
      </div>
      {tab === "json" ? (
        <>
          {error !== null && <div className="problem problem-error code-panel__error">{error}</div>}
          <div className="code-panel__editor-wrap">
            {/* aria-hidden: purely decorative color layer; the textarea is
                the real, accessible editing surface. */}
            <pre ref={highlightRef} className="code-panel__highlight" aria-hidden="true">
              <TokenSpans tokens={jsonTokens} />
              {/* Trailing newline so the layer keeps scroll parity with the
                  textarea when the caret sits on a final empty line. */}
              {"\n"}
            </pre>
            <textarea
              className="code-panel__editor"
              spellCheck={false}
              value={buffer}
              onChange={(e) => setBuffer(e.target.value)}
              onScroll={syncScroll}
              aria-label="Graph JSON source"
            />
          </div>
        </>
      ) : (
        <pre className="code-panel__preview" aria-label="Generated TypeScript example">
          <TokenSpans tokens={tsTokens} />
        </pre>
      )}
    </div>
  );
}
