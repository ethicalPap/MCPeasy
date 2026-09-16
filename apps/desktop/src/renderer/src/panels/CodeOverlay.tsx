import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CODE_LANGUAGES, type CodeLanguage, type CodeNode } from "@mcpeasy/schema";
import type { CodeRuntimeReport } from "../../../shared/ipc";
import { tokenizeCode, type Token } from "../highlight";

// The full-size editor for a custom-code block. The node panel's inline field
// is a 340px-wide preview; real code needs room, so this is a modal overlay
// over the whole builder.
//
// WHY A TEXTAREA BEHIND A HIGHLIGHTED <pre> RATHER THAN A CODE EDITOR
// DEPENDENCY: this app ships no editor library (apps/desktop/package.json —
// React, @xyflow/react, zustand only), and the Advanced-mode Graph JSON panel
// already established this exact technique with the same VS Code palette
// (styles.css .code-panel__editor-wrap). Reusing it keeps one editing model in
// the app, adds no megabytes to an Electron bundle, and works offline. The
// trade-off is no autocomplete or error squiggles, which is a real limitation
// of this approach, not an oversight.
//
// INVARIANT shared with the JSON panel: the highlight layer and the textarea
// must keep identical font metrics, padding and wrapping, or the colors drift
// off the glyphs. Both take their metrics from one CSS rule; change together.

/** Tokens → spans. Token text concatenation equals the source exactly
 *  (highlight.ts invariant), which the overlay's alignment depends on. */
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

/** Display names. Separate from the schema's ids because the ids are a wire
 *  format that must never change for presentation reasons. */
export const LANGUAGE_LABEL: Record<CodeLanguage, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  bash: "Bash",
  powershell: "PowerShell",
  ruby: "Ruby",
  php: "PHP",
  go: "Go",
};

/** Per-language contract shown under the editor. These differ in ways the
 *  user cannot guess — a bash block returns what it PRINTS while a Python
 *  block returns what it RETURNS — so the editor states it per language
 *  rather than documenting one rule that is wrong for half of them. */
export const LANGUAGE_HINT: Record<CodeLanguage, string> = {
  javascript: "input, env and prev are in scope. Return a JSON-serializable value.",
  typescript: "input, env and prev are in scope. Return a JSON-serializable value. Types are erased, never checked.",
  python: "input, env and prev are in scope as dicts. Return a JSON-serializable value.",
  bash: "$MCPEASY_INPUT, $MCPEASY_ENV and $MCPEASY_PREV hold JSON. Whatever you print becomes the result.",
  powershell: "$mcp_input, $mcp_env and $mcp_prev are in scope. The last object you emit becomes the result.",
  ruby: "input, env and prev are in scope as hashes. The last expression is the result.",
  php: "$input, $env and $prev are in scope as arrays. Return a JSON-serializable value.",
  go: "input and env are map[string]any, prev is any. Return (any, error). JSON numbers arrive as float64.",
};

/** Starter snippet used when switching a block to a language whose source is
 *  still the untouched default of another. Never overwrites real work — see
 *  the guard in onLanguageChange. */
const STARTERS: Record<CodeLanguage, string> = {
  javascript: "// input, env, and prev are available\nreturn { ok: true };",
  typescript: "// input, env, and prev are available\nconst result: Record<string, unknown> = { ok: true };\nreturn result;",
  python: "# input, env, and prev are available\nreturn {'ok': True}",
  bash: '# $MCPEASY_INPUT holds the tool arguments as JSON\necho "$MCPEASY_INPUT"',
  powershell: "# $mcp_input holds the tool arguments\n@{ ok = $true }",
  ruby: "# input, env, and prev are available\n{ 'ok' => true }",
  php: "// $input, $env, and $prev are available\nreturn ['ok' => true];",
  go: "\t// input, env, and prev are available\n\treturn map[string]any{\"ok\": true}, nil",
};

/** True when the source is one of the untouched starters, i.e. the user has
 *  not written anything worth preserving across a language switch. */
export function isStarterSource(source: string): boolean {
  const trimmed = source.trim();
  if (trimmed === "") return true;
  return Object.values(STARTERS).some((starter) => starter.trim() === trimmed);
}

export function starterFor(language: CodeLanguage): string {
  return STARTERS[language];
}

export function CodeOverlay({
  node,
  runtimes,
  onChange,
  onClose,
}: {
  node: CodeNode;
  /** Empty map = not probed (browser mode, or detection failed). Treated as
   *  "unknown", never as "missing", so no false warning is shown. */
  runtimes: CodeRuntimeReport;
  onChange: (next: CodeNode) => void;
  onClose: () => void;
}) {
  const language: CodeLanguage = node.language ?? "javascript";
  const highlightRef = useRef<HTMLPreElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [wrap, setWrap] = useState(false);

  const tokens = useMemo(() => tokenizeCode(node.source, language), [node.source, language]);
  const lineCount = useMemo(() => node.source.split(/\r?\n/).length, [node.source]);

  // Escape closes, matching every other dismissible surface in the app
  // (SidePanel, the confirm dialogs). Registered on document because focus
  // is usually inside the textarea, which does not bubble a window handler
  // in every browser/Electron combination.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus the editor on open so the user can type immediately — the whole
  // point of the overlay is writing code, not clicking into a field first.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const syncScroll = (event: React.UIEvent<HTMLTextAreaElement>) => {
    const hl = highlightRef.current;
    if (hl) {
      hl.scrollTop = event.currentTarget.scrollTop;
      hl.scrollLeft = event.currentTarget.scrollLeft;
    }
  };

  // Tab inserts an indent instead of leaving the field. In a code editor the
  // default focus-move behavior is actively wrong, and there is no other way
  // to indent. Shift+Tab is left alone so keyboard users can still escape the
  // field, which keeps the surface navigable without a mouse.
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Tab" || event.shiftKey) return;
    event.preventDefault();
    const target = event.currentTarget;
    const { selectionStart, selectionEnd, value } = target;
    const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
    onChange({ ...node, source: next });
    // Restore the caret after React re-renders with the new value, or it
    // jumps to the end of the document on every Tab.
    requestAnimationFrame(() => {
      target.selectionStart = target.selectionEnd = selectionStart + 2;
    });
  };

  const onLanguageChange = useCallback(
    (nextLanguage: CodeLanguage) => {
      // Replacing the body is only safe while it is still an untouched
      // starter. Overwriting real code on a mis-click would be unrecoverable:
      // this editor has no undo history of its own.
      const source = isStarterSource(node.source) ? starterFor(nextLanguage) : node.source;
      onChange({ ...node, language: nextLanguage, source });
    },
    [node, onChange],
  );

  const status = runtimes[language];
  // Absent from the map = not probed. Only an explicit available:false is a
  // real "missing interpreter" claim.
  const missing = status !== undefined && !status.available;

  return (
    <div
      className="code-overlay-backdrop"
      onClick={(event) => {
        // Only a click on the backdrop itself closes; clicks inside the
        // editor must not dismiss work in progress.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="code-overlay" role="dialog" aria-modal="true" aria-label="Custom code editor">
        <div className="code-overlay__header">
          <div className="code-overlay__titlegroup">
            <span className="code-overlay__title">Custom code</span>
            <label className="code-overlay__language">
              <span className="visually-hidden">Language</span>
              <select
                value={language}
                onChange={(event) => onLanguageChange(event.target.value as CodeLanguage)}
              >
                {CODE_LANGUAGES.map((id) => {
                  const runtime = runtimes[id];
                  // The option itself carries the availability, so the user
                  // sees which languages need an install BEFORE choosing one.
                  const suffix = runtime !== undefined && !runtime.available ? " (not installed)" : "";
                  return (
                    <option key={id} value={id}>
                      {LANGUAGE_LABEL[id]}
                      {suffix}
                    </option>
                  );
                })}
              </select>
            </label>
          </div>
          <div className="code-overlay__actions">
            <span className="code-overlay__meta">
              {lineCount} {lineCount === 1 ? "line" : "lines"}
            </span>
            <button
              className={wrap ? "code-overlay__toggle code-overlay__toggle--on" : "code-overlay__toggle"}
              onClick={() => setWrap((value) => !value)}
              title="Toggle soft wrapping of long lines"
              aria-pressed={wrap}
            >
              Wrap
            </button>
            <button className="panel-icon-btn" onClick={onClose} title="Close editor" aria-label="Close editor">
              ✕
            </button>
          </div>
        </div>

        {missing && (
          <div className="problem problem-warning code-overlay__notice">
            {LANGUAGE_LABEL[language]} is not installed on this machine, so this block will fail when the tool runs.
            Install it and reopen this editor, or choose JavaScript or TypeScript, which always work.
          </div>
        )}

        <div className={wrap ? "code-overlay__editor-wrap code-overlay__editor-wrap--wrap" : "code-overlay__editor-wrap"}>
          {/* aria-hidden: purely decorative color layer; the textarea is the
              real, accessible editing surface. */}
          <pre ref={highlightRef} className="code-overlay__highlight" aria-hidden="true">
            <TokenSpans tokens={tokens} />
            {/* Trailing newline keeps scroll parity when the caret sits on a
                final empty line. */}
            {"\n"}
          </pre>
          <textarea
            ref={textareaRef}
            className="code-overlay__editor"
            spellCheck={false}
            value={node.source}
            onChange={(event) => onChange({ ...node, source: event.target.value })}
            onScroll={syncScroll}
            onKeyDown={onKeyDown}
            aria-label={`${LANGUAGE_LABEL[language]} source`}
          />
        </div>

        <div className="code-overlay__footer">
          <span className="muted small">{LANGUAGE_HINT[language]}</span>
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
