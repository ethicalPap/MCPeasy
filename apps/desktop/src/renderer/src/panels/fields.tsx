import { useState } from "react";

// Buffered list editors. A naive controlled textarea whose value is DERIVED
// from the doc ("split, trim, filter, join") eats the user's in-progress
// typing: a trailing newline or a header line without ":" parses to nothing,
// the doc round-trips without it, and the keystroke visibly vanishes. So the
// textarea owns its raw text locally and pushes the PARSED form outward on
// every change. Parents remount per node (key={id}) so switching selection
// reloads the buffer from the doc.

export function ListTextarea({
  initial,
  rows,
  placeholder,
  onLines,
}: {
  initial: string[];
  rows: number;
  placeholder?: string;
  onLines: (lines: string[]) => void;
}) {
  const [text, setText] = useState(initial.join("\n"));
  return (
    <textarea
      rows={rows}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onLines(e.target.value.split("\n").map((s) => s.trim()).filter((s) => s.length > 0));
      }}
    />
  );
}

export function CommaListInput({
  initial,
  placeholder,
  onValues,
}: {
  initial: string[];
  placeholder?: string;
  onValues: (values: string[]) => void;
}) {
  const [text, setText] = useState(initial.join(", "));
  return (
    <input
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onValues(e.target.value.split(",").map((s) => s.trim()).filter((s) => s.length > 0));
      }}
    />
  );
}

export function HeaderTextarea({
  initial,
  placeholder,
  onHeaders,
}: {
  initial: Record<string, string>;
  placeholder?: string;
  onHeaders: (headers: Record<string, string> | undefined) => void;
}) {
  const [text, setText] = useState(
    Object.entries(initial)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
  );
  return (
    <textarea
      rows={3}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        const headers: Record<string, string> = {};
        for (const line of e.target.value.split("\n")) {
          const idx = line.indexOf(":");
          if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
        onHeaders(Object.keys(headers).length > 0 ? headers : undefined);
      }}
    />
  );
}
