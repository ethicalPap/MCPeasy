import { useState, type ReactElement } from "react";
import type { PageId } from "./pages";

// The app shell's left sidebar, matched to the reference design: a full-width
// panel with a brand header + collapse toggle, flat nav list
// of icon+label rows with count badges, and a pinned footer (Integrations,
// Settings, Help & Support). Builder, Secrets and Integrations are live;
// Settings and Help are themed placeholders so the product shape is visible
// now. The titlebar shows the workspace name as a passive indicator, plus a
// home button for the Workspace home page.

export type { PageId } from "./pages";

// Row icons draw at 1em and each context sets font-size (rows 18px, the
// placeholder page hero 30px) — the same sizing idiom as kinds.tsx icons.
const icon = (path: ReactElement): ReactElement => (
  <svg
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);

export interface PageMeta {
  id: PageId;
  name: string;
  icon: ReactElement;
  /** Placeholder blurb — one line about what will live on the page. */
  blurb: string;
  live: boolean;
}

/** Named so consumers have a total fallback (noUncheckedIndexedAccess makes
 * PAGES[0] possibly-undefined; the builder page is the app's home). */
export const BUILDER_PAGE: PageMeta = {
  id: "builder",
  name: "Builder",
  live: true,
  blurb: "Design MCP servers on the canvas.",
  icon: icon(
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <path d="M6.5 10v3.5a2 2 0 0 0 2 2H14" />
    </>,
  ),
};

export const PAGES: PageMeta[] = [
  BUILDER_PAGE,
  {
    id: "secrets",
    name: "Secrets",
    live: true,
    blurb: "Encrypted values for your server's env vars.",
    icon: icon(
      <>
        <circle cx="7.5" cy="16.5" r="4" />
        <path d="m10.5 13.5 9-9" />
        <path d="M16.5 7.5 20 11M14 10l2.5 2.5" />
      </>,
    ),
  },

  {
    id: "integrations",
    name: "Integrations",
    live: true,
    blurb: "Connect the open server to Claude Code.",
    icon: icon(
      <>
        <path d="M9 7V3.5M15 7V3.5" />
        <path d="M7 7h10v4a5 5 0 0 1-5 5 5 5 0 0 1-5-5V7z" />
        <path d="M12 16v4.5" />
      </>,
    ),
  },
  {
    // The workspace home: shows saved servers and lets the user manage the
    // active workspace. Keeps the "repository" PageId for backwards compat
    // (PageId is shared with tests/pages.ts). NOT in NAV_PAGES: this page is
    // reached from the title bar's home button (App.tsx) instead, so it stays
    // in PAGES purely to supply the icon and the toolbar heading.
    id: "repository",
    name: "Workspace home",
    live: true,
    blurb: "Your library of graph docs, versioned and shareable.",
    // A house rather than the former database cylinder: the cylinder read as
    // "storage", but this page is the workspace's root destination and the
    // title bar button needs the universally understood home affordance.
    icon: icon(
      <>
        <path d="M3.5 10.2 12 3.5l8.5 6.7" />
        <path d="M5.5 9v10.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9" />
        <path d="M9.75 20.5v-6h4.5v6" />
      </>,
    ),
  },

  // The Member page is deferred, not cancelled. It was removed from PAGES,
  // from NAV_PAGES and from the PageId union so no unreachable page id can
  // linger in the type. The entry is kept verbatim here because this repo has
  // no commit history yet, so deleting it outright would lose the hand-drawn
  // icon with no way to recover it. To restore: uncomment, re-add "members"
  // to PageId in pages.ts, and re-add it to NAV_PAGES after "secrets".
  //
  // {
  //   // "Member" (singular) — matching the reference design's label verbatim.
  //   id: "members",
  //   name: "Member",
  //   live: false,
  //   blurb: "Invite your team and control who can edit or ship.",
  //   icon: icon(
  //     <>
  //       <circle cx="9" cy="8" r="3.5" />
  //       <path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5" />
  //       <circle cx="17" cy="9" r="2.5" />
  //       <path d="M16.5 15.5c2.5.2 4.4 1.7 5 4.5" />
  //     </>,
  //   ),
  // },

  {
    id: "settings",
    name: "Settings",
    live: false,
    blurb: "App preferences, defaults and integrations config.",
    icon: icon(
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      </>,
    ),
  },
  {
    id: "help",
    name: "Help & Support",
    live: false,
    blurb: "Docs, examples and a way to reach us.",
    icon: icon(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.4-3 4" />
        <path d="M12 17.5h.01" />
      </>,
    ),
  },
];

export function pageById(id: PageId): PageMeta {
  return PAGES.find((p) => p.id === id) ?? BUILDER_PAGE;
}

// Flat nav list, no section grouping. Integrations, Settings and Help live in
// the pinned footer. "repository" (Workspace home) is deliberately absent: it
// moved to the title bar's home button, and leaving the row here too would
// give one page two competing entry points with two active states.
const NAV_PAGES: PageId[] = [
  "builder",
  "secrets",
];

// Rendered into .sidebar__footer, which is flex:none and therefore pinned to
// the bottom of the rail while .sidebar__body absorbs the slack. Integrations
// is FIRST so it sits directly above Settings: appending it to NAV_PAGES
// instead would park it just under Secrets at the top, with the body's empty
// space between it and Settings. Order here is the rendered order.
const FOOTER_PAGES: PageId[] = ["integrations", "settings", "help"];

function SideLink({
  meta,
  active,
  badge,
  collapsed,
  onNavigate,
}: {
  meta: PageMeta;
  active: boolean;
  badge: number | undefined;
  collapsed: boolean;
  onNavigate: (id: PageId) => void;
}) {
  return (
    <button
      className={`side-link${active ? " side-link--active" : ""}`}
      onClick={() => onNavigate(meta.id)}
      aria-current={active ? "page" : undefined}
      // Collapsed rows are icon-only; the title keeps them identifiable.
      title={collapsed ? meta.name : undefined}
    >
      <span className="side-link__icon">{meta.icon}</span>
      {!collapsed && <span className="side-link__label">{meta.name}</span>}
      {!collapsed && badge !== undefined && badge > 0 && (
        <span className="side-link__badge">{badge}</span>
      )}
    </button>
  );
}

/**
 * Reference-style sidebar. `badges` carries REAL counts only (today: the
 * builder's block count) — the reference shows numeric badges on several
 * rows, but inventing numbers for placeholder pages would be showing false
 * data, so rows without live data simply have no badge yet.
 */
export function Sidebar({
  page,
  onNavigate,
  badges = {},
}: {
  page: PageId;
  onNavigate: (id: PageId) => void;
  badges?: Partial<Record<PageId, number>>;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`} aria-label="Pages">
      <div className="sidebar__header">
        <span className="sidebar__logo" aria-hidden="true">
          {/* Brand mark: rounded square + wired dots, in the brand purple. */}
          <svg viewBox="0 0 24 24" width="28" height="28">
            <rect x="2" y="2" width="20" height="20" rx="6" fill="hsl(273 63% 36%)" />
            <circle cx="12" cy="7.5" r="2" fill="#fff" />
            <circle cx="12" cy="16.5" r="2" fill="#fff" />
            <path d="M12 9.5v5" stroke="#fff" strokeWidth="1.6" />
          </svg>
        </span>
        {!collapsed && <span className="sidebar__brand">MCPeasy</span>}
        <button
          className="panel-icon-btn sidebar__collapse"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          <svg
            viewBox="0 0 24 24"
            width="17"
            height="17"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
            {collapsed ? <path d="m13 10 2 2-2 2" /> : <path d="m16 10-2 2 2 2" />}
          </svg>
        </button>
      </div>

      <nav className="sidebar__body">
        {NAV_PAGES.map((id) => {
          const meta = pageById(id);
          return (
            <SideLink
              key={id}
              meta={meta}
              active={page === id}
              badge={badges[id]}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          );
        })}
      </nav>

      <div className="sidebar__footer">
        {FOOTER_PAGES.map((id) => {
          const meta = pageById(id);
          return (
            <SideLink
              key={id}
              meta={meta}
              active={page === id}
              // Reads the same map as the body rows. This was hardcoded to
              // undefined while the footer held only placeholder pages; now
              // that a live page sits here, hardcoding would silently discard
              // a caller's count for it.
              badge={badges[id]}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          );
        })}
      </div>
    </aside>
  );
}

/** Themed placeholder for pages that are not built yet. */
export function PlaceholderPage({ meta }: { meta: PageMeta }) {
  return (
    <div className="page-placeholder">
      <div className="page-placeholder__card">
        <span className="page-placeholder__icon">{meta.icon}</span>
        <h2 className="heading-gradient">{meta.name}</h2>
        <p>{meta.blurb}</p>
        <span className="page-placeholder__soon">Coming soon</span>
      </div>
    </div>
  );
}
