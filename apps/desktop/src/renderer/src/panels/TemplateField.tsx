import { useRef, useState } from "react";
import { useEditor } from "../store";
import { insertToken, varSuggestionsFor } from "../templateVars";

// The {{var}} helper (user call: "placeholders should be a helper, not raw
// {{ }} typing"). A buffered text field — same rationale as fields.tsx: the
// field owns its raw text and pushes outward, so in-progress typing never
// round-trips through the doc — plus one chip per legal variable underneath.
// Clicking a chip inserts the token AT THE CURSOR and refocuses, so building
// "https://api.example.com/{{input.city}}" is clicks, not syntax.

export function TemplateField({
  nodeId,
  value,
  onValue,
  placeholder,
  rows,
  parseLines = false,
}: {
  nodeId: string;
  value: string;
  onValue: (next: string) => void;
  placeholder?: string;
  /** rows > 0 renders a textarea; omitted renders a single-line input. */
  rows?: number;
  /** Keep one argv item per non-empty line while retaining the same cursor-aware
   * variable helper used by URL/body/stdin fields. */
  parseLines?: boolean;
}) {
  const doc = useEditor((s) => s.doc);
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const suggestions = varSuggestionsFor(doc, nodeId);

  const commit = (next: string) => {
    setText(next);
    onValue(parseLines ? next.split("\n").map((line) => line.trim()).filter(Boolean).join("\n") : next);
  };

  const insert = (token: string) => {
    const el = ref.current;
    const selStart = el?.selectionStart ?? text.length;
    const selEnd = el?.selectionEnd ?? text.length;
    const r = insertToken(text, selStart, selEnd, token);
    commit(r.text);
    // Restore focus + caret after React re-renders the controlled value.
    requestAnimationFrame(() => {
      const node = ref.current;
      if (node) {
        node.focus();
        node.setSelectionRange(r.caretStart, r.caretEnd);
      }
    });
  };

  return (
    <div className="tpl-field">
      {rows !== undefined ? (
        <textarea
          ref={(n) => {
            ref.current = n;
          }}
          rows={rows}
          value={text}
          placeholder={placeholder}
          onChange={(e) => commit(e.target.value)}
        />
      ) : (
        <input
          ref={(n) => {
            ref.current = n;
          }}
          value={text}
          placeholder={placeholder}
          onChange={(e) => commit(e.target.value)}
        />
      )}
      {suggestions.length > 0 && (
        <div className="tpl-chips" aria-label="Insert a variable">
          {suggestions.map((s) => (
            <button
              key={s.token}
              type="button"
              className={`tpl-chip tpl-chip--${s.scope}`}
              title={s.hint}
              onClick={() => insert(s.token)}
            >
              {s.token.replace(/^\{\{|\}\}$/g, "")}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
