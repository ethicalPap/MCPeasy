import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

// A right-hand slide-over detail panel, ported from the reference implementation
// (PyroTrace-Cloud components/dashboard/detections/panel-shared.tsx DetailPanel,
// over components/ui/sheet.tsx). Same anatomy: dimmed backdrop, panel pinned to
// the right edge for the full window height, a bordered header carrying an
// eyebrow + title + free-form header slot, a fixed-width nav rail listing the
// sections, and a scrolling body showing the active one.
//
// WHY A HAND-WRITTEN PANEL INSTEAD OF THE REFERENCE'S COMPONENT: the reference
// builds on @radix-ui/react-dialog and Tailwind utility classes. This app has
// neither (see apps/desktop/package.json — the only UI dependencies are React,
// @xyflow/react and zustand) and styles everything with BEM classes over the
// hsl(var(--token)) palette in styles.css. Adding Radix + Tailwind to gain one
// panel would be a large dependency and build change for a single surface, so
// the STRUCTURE and MOTION are copied and the delivery mechanism is local.
//
// What is deliberately reproduced from the reference:
//   - fixed to the right, full height, ~920px wide, capped to the viewport
//   - backdrop that dims and closes on click
//   - header with a bottom border, right-padded so it clears the close control
//   - a left nav rail of sections with an active "pill", body scrolls alone
//   - enter/exit transforms so closing animates out instead of vanishing
//
// What is deliberately NOT reproduced: the reference's close button is detached,
// floating OUTSIDE the panel's left edge, positioned with a ResizeObserver.
// That needs continuous measurement to stay put; in a desktop window where the
// panel touches the right edge, an in-header button is the same click target
// with none of the machinery. The header reserves space for it either way.

/** Matches the CSS exit duration below. If you change one, change both, or the
 *  panel will either unmount mid-animation or linger invisibly. */
const EXIT_MS = 240;

export interface SidePanelSection {
  key: string;
  label: string;
  /** Single glyph shown before the label. Text rather than an icon component:
   *  this app has no icon library, and the nav rows elsewhere (side-link__icon)
   *  use the same approach. */
  icon: string;
  content: ReactNode;
  /** Optional trailing count/dot, mirroring the reference's trailing badge. */
  badge?: string;
}

export function SidePanel({
  open,
  title,
  eyebrow,
  header,
  sections,
  active,
  onActiveChange,
  onClose,
}: {
  open: boolean;
  title: string;
  eyebrow?: ReactNode;
  /** Rendered under the title: badges, status line, action bar. */
  header?: ReactNode;
  sections: SidePanelSection[];
  active: string;
  onActiveChange: (key: string) => void;
  onClose: () => void;
}) {
  // `open` is the caller's intent; `present` is what the DOM holds. They differ
  // only while closing: the reference keeps the Radix node mounted for its exit
  // animation, and this does the same by hand. Without it, setting open=false
  // would unmount instantly and the exit animation would never be seen.
  const [present, setPresent] = useState(open);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Callers derive title/sections from the SELECTED item, so the moment the
  // selection clears those go empty — while this panel is still on screen
  // playing its exit. Rendering that directly would blank the panel and then
  // slide an empty sheet away. Keeping the last open frame makes the content
  // slide out with the panel.
  //
  // This deliberately DIVERGES from the reference, which renders
  // `{open ? <>…</> : null}` inside its SheetContent and therefore does show an
  // empty sheet on the way out (panel-shared.tsx:52-54). Copying that would be
  // copying a flaw.
  const lastFrame = useRef({ title, eyebrow, header, sections, active });
  if (open) lastFrame.current = { title, eyebrow, header, sections, active };
  const frame = open ? { title, eyebrow, header, sections, active } : lastFrame.current;

  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    const timer = window.setTimeout(() => setPresent(false), EXIT_MS);
    // Clearing on re-open matters: re-opening within the exit window would
    // otherwise let a stale timer unmount the freshly opened panel.
    return () => window.clearTimeout(timer);
  }, [open, present]);

  // Escape closes, and Tab is confined to the panel. Both come free from Radix
  // in the reference; here they are explicit.
  //
  // The focus trap is what makes aria-modal="true" below TRUTHFUL: that
  // attribute tells assistive technology everything outside is inert, so
  // letting Tab walk out into the catalog behind would be a lie a screen-reader
  // user would notice immediately.
  //
  // Bound to the document rather than the panel because focus may legitimately
  // sit on the backdrop, or nowhere at all, when the key is pressed.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (panel === null) return;

      // Queried on each Tab rather than cached: the panel's contents change as
      // sections switch and as async status arrives, so a cached list would go
      // stale and trap focus on a removed element.
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeEl = document.activeElement;

      // Wrapping only at the ends lets the browser handle every step between,
      // which keeps the panel's natural DOM order intact.
      if (event.shiftKey && (activeEl === first || activeEl === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeEl === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Move focus into the panel when it opens so keyboard users land inside it
  // rather than continuing from wherever the Details button was, and put focus
  // back where it came from on close. Without the restore, dismissing the panel
  // would drop a keyboard user at the top of the document and make them tab all
  // the way back to the tile they were on.
  const restoreTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      // isConnected guards the case where the trigger itself was removed while
      // the panel was open (for example the catalog refreshed underneath it);
      // focusing a detached node silently sends focus to <body>.
      const target = restoreTo.current;
      if (target !== null && target.isConnected) target.focus();
    };
  }, [open]);

  // Dismissal is driven by `click`, and vetoed by a press that STARTED inside
  // the panel. Phrasing the guard as a veto (rather than requiring a press on
  // the backdrop) means the common case — a plain click on the backdrop —
  // closes even when no mousedown was observed, while dragging a text selection
  // out of the panel and releasing over the backdrop still does not.
  //
  // HelpDialog closes on mousedown alone (TitlebarMenus.tsx:159). That is fine
  // for a small centred dialog, but this panel is wide enough to select text
  // across, so the release must not be what dismisses it.
  const pressedInside = useRef(false);

  const onBackdropDown = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    pressedInside.current = event.target !== event.currentTarget;
  }, []);

  const onBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      const veto = pressedInside.current;
      pressedInside.current = false;
      if (!veto && event.target === event.currentTarget) onClose();
    },
    [onClose],
  );

  if (!present) return null;

  // Falling back to the first section keeps the body populated when a caller
  // passes a key that no longer exists (for example after the section list
  // changes because a client's state changed underneath the open panel).
  const current = frame.sections.find((section) => section.key === frame.active) ?? frame.sections[0] ?? null;

  return (
    <div
      className={`side-panel__backdrop${open ? "" : " side-panel__backdrop--closing"}`}
      role="presentation"
      onMouseDown={onBackdropDown}
      onClick={onBackdropClick}
    >
      <aside
        ref={panelRef}
        className={`side-panel${open ? "" : " side-panel--closing"}`}
        role="dialog"
        aria-modal="true"
        aria-label={frame.title}
        tabIndex={-1}
      >
        <header className="side-panel__header">
          <div className="side-panel__heading">
            {frame.eyebrow !== undefined && <div className="side-panel__eyebrow">{frame.eyebrow}</div>}
            <h2 className="side-panel__title">{frame.title}</h2>
          </div>
          <button
            type="button"
            className="panel-icon-btn side-panel__close"
            onClick={onClose}
            aria-label={`Close ${frame.title}`}
            title="Close"
          >
            ✕
          </button>
          {frame.header !== undefined && <div className="side-panel__header-extra">{frame.header}</div>}
        </header>

        <div className="side-panel__body">
          {/* One section needs no rail — the reference shows the nav because its
              panels always have several. Hiding it here avoids a 210px column
              of dead space next to a single-section client. */}
          {frame.sections.length > 1 && (
            <nav className="side-panel__nav" aria-label={`${frame.title} sections`}>
              {frame.sections.map((section) => (
                <button
                  key={section.key}
                  type="button"
                  className={`side-panel__nav-item${
                    section.key === current?.key ? " side-panel__nav-item--active" : ""
                  }`}
                  aria-current={section.key === current?.key}
                  onClick={() => onActiveChange(section.key)}
                >
                  <span className="side-panel__nav-icon" aria-hidden="true">
                    {section.icon}
                  </span>
                  <span className="side-panel__nav-label">{section.label}</span>
                  {section.badge !== undefined && <span className="side-link__badge">{section.badge}</span>}
                </button>
              ))}
            </nav>
          )}
          <main className="side-panel__main">{current?.content}</main>
        </div>
      </aside>
    </div>
  );
}

/** Label/value grid for panel bodies — the reference's KvGrid, expressed with
 *  the fact-list class the Integrations page already uses. Rows whose value is
 *  null are dropped rather than rendered blank, so an unknown fact never reads
 *  as an empty one.
 *
 *  dt/dd are emitted as DIRECT children of the dl: .integrations__facts is a
 *  two-column CSS grid, so wrapping each pair in a div (as the reference's
 *  Tailwind version does) would make every row a single grid cell and collapse
 *  the label column. */
export function PanelFacts({ rows }: { rows: [string, ReactNode | null][] }) {
  const shown = rows.filter((row): row is [string, ReactNode] => row[1] !== null);
  if (shown.length === 0) return null;
  return (
    <dl className="integrations__facts">
      {shown.map(([label, value]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
