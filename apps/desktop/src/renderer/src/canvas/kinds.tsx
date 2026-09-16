import type { ReactElement } from "react";
import { KIND_TEXT, type NodeKind } from "../graph";

// Single source for how each node kind PRESENTS (icon, edge color, label, blurb).
// Behaviour lives in schema/store; this file is shared vocabulary for canvas
// cards, connection pickers, search, edges, legend and panels.

// Inline stroke icons (lucide-style, drawn here) — inline SVG keeps the app
// fully offline and dependency-free; meaning is never icon-only because every
// use site also renders the label text. Sized 1em so each context scales the
// glyph via font-size (card chip 16px, picker/search 15px, panel header 15px).
const icon = (path: ReactElement): ReactElement => (
  <svg
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);

// Labels/blurbs come from graph.ts KIND_TEXT (pure, shared with search);
// this module only adds the JSX icons on top.
export const KIND_META: Record<NodeKind, { label: string; blurb: string; icon: ReactElement }> = {
  tool: {
    ...KIND_TEXT.tool,
    icon: icon(<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />),
  },
  action: {
    ...KIND_TEXT.action,
    icon: icon(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a14.5 14.5 0 0 1 0 18M12 3a14.5 14.5 0 0 0 0 18" />
      </>,
    ),
  },
  command: {
    ...KIND_TEXT.command,
    icon: icon(<path d="m5 7 4 5-4 5M11 17h8" />),
  },
  script: {
    ...KIND_TEXT.script,
    icon: icon(<path d="M6 2h9l4 4v16H6zM14 2v5h5M9 12h6M9 16h6" />),
  },
  code: {
    ...KIND_TEXT.code,
    icon: icon(<path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" />),
  },
  parallel: {
    ...KIND_TEXT.parallel,
    icon: icon(<path d="M12 4v4M5 20v-5a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v5M5 20h.01M12 20h.01M19 20h.01" />),
  },
  transform: {
    ...KIND_TEXT.transform,
    icon: icon(<path d="M4 6h16M7 12h10M10 18h4" />),
  },
  return: {
    ...KIND_TEXT.return,
    icon: icon(
      <>
        <path d="m9 14-5-5 5-5" />
        <path d="M4 9h10a6 6 0 0 1 6 6v5" />
      </>,
    ),
  },
};
