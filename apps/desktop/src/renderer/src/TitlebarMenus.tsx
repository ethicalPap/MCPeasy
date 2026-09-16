import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ThemePreference } from "../../shared/ipc";
import type { ExportLanguage } from "./export/types";

export type HelpView = "about" | "documentation" | "preferences" | "updates" | null;

type MenuName = "file" | "help" | null;

interface MenuItemProps {
  children: ReactNode;
  shortcut?: string;
  onSelect: () => void;
}

function MenuItem({ children, shortcut, onSelect }: MenuItemProps) {
  return (
    <button className="app-menu__item" role="menuitem" type="button" onClick={onSelect}>
      <span>{children}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}

/** Visible menus belong in the HTML title bar rather than Electron's native
 * bar: the custom search and native window controls already share this row,
 * and an Alt-only second menu bar would create two competing chromes. */
export function TitlebarMenus({
  projectName,
  onNew,
  onOpen,
  onSave,
  onSwitchProject,
  onExport,
  onHelp,
}: {
  /** Active workspace (the shell only renders inside one) — shown in the menu
   * so "Save" visibly has a destination. */
  projectName: string;
  /** New server on the canvas (within the active workspace). */
  onNew: () => void;
  /** Navigates to the workspace home (which owns the server tiles) — the menu
   * itself never loads; choosing WHICH server stays one concern. */
  onOpen: () => void;
  /** Save into the active workspace (workspace-only I/O; no OS dialog). */
  onSave: () => void;
  /** Back to the startup chooser (create new / open existing workspace). */
  onSwitchProject: () => void;
  /** Export the current server as a runnable project (zip via save dialog). */
  onExport: (language: ExportLanguage) => void;
  onHelp: (view: Exclude<HelpView, null>) => void;
}) {
  const [open, setOpen] = useState<MenuName>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const ctrl = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+";

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const choose = (action: () => void): void => {
    setOpen(null);
    action();
  };

  return (
    <div className="titlebar-menus" ref={rootRef}>
      <div className="app-menu">
        <button
          className={`app-menu__trigger${open === "file" ? " app-menu__trigger--open" : ""}`}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open === "file"}
          onClick={() => setOpen((current) => (current === "file" ? null : "file"))}
        >
          File
        </button>
        {open === "file" && (
          <div className="app-menu__popup" role="menu" aria-label="File">
            <MenuItem shortcut={`${ctrl}N`} onSelect={() => choose(onNew)}>New server</MenuItem>
            <MenuItem onSelect={() => choose(onOpen)}>Open server…</MenuItem>
            <div className="app-menu__separator" role="separator" />
            {/* Workspace-only I/O: Save writes into the active workspace —
                the label names the destination so there is no dialog surprise. */}
            <MenuItem shortcut={`${ctrl}S`} onSelect={() => choose(onSave)}>{`Save to "${projectName}"`}</MenuItem>
            <MenuItem onSelect={() => choose(onSwitchProject)}>Switch workspace…</MenuItem>
            <div className="app-menu__separator" role="separator" />
            {/* Flat entries instead of a nested submenu: two languages do not
                earn hover-submenu complexity; revisit when "more" arrive. */}
            <MenuItem onSelect={() => choose(() => onExport("typescript"))}>Export as TypeScript…</MenuItem>
            <MenuItem onSelect={() => choose(() => onExport("python"))}>Export as Python…</MenuItem>
          </div>
        )}
      </div>

      <div className="app-menu">
        <button
          className={`app-menu__trigger${open === "help" ? " app-menu__trigger--open" : ""}`}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open === "help"}
          onClick={() => setOpen((current) => (current === "help" ? null : "help"))}
        >
          Help
        </button>
        {open === "help" && (
          <div className="app-menu__popup" role="menu" aria-label="Help">
            <MenuItem onSelect={() => choose(() => onHelp("about"))}>About MCPeasy</MenuItem>
            <MenuItem onSelect={() => choose(() => onHelp("documentation"))}>Documentation</MenuItem>
            <MenuItem onSelect={() => choose(() => onHelp("preferences"))}>Preferences…</MenuItem>
            <div className="app-menu__separator" role="separator" />
            <MenuItem onSelect={() => choose(() => onHelp("updates"))}>Check for updates…</MenuItem>
          </div>
        )}
      </div>
    </div>
  );
}

export function HelpDialog({
  view,
  theme,
  version,
  onTheme,
  onClose,
}: {
  view: Exclude<HelpView, null>;
  theme: ThemePreference;
  version: string;
  onTheme: (theme: ThemePreference) => void;
  onClose: () => void;
}) {
  const chooseTheme = (next: ThemePreference): void => {
    // Persistence belongs to app preferences, not a graph doc: changing the
    // theme must never mark a server dirty or leak into its exported JSON.
    onTheme(next);
  };

  const title =
    view === "about"
      ? "About MCPeasy"
      : view === "documentation"
        ? "Documentation"
        : view === "preferences"
          ? "Preferences"
          : "Updates";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-dialog-title">
        <header className="help-dialog__header">
          <h2 id="help-dialog-title">{title}</h2>
          <button className="panel-icon-btn" type="button" onClick={onClose} aria-label={`Close ${title}`} title="Close">✕</button>
        </header>
        <div className="help-dialog__body">
          {view === "about" && (
            <div className="about-content">
              <span className="about-content__logo" aria-hidden="true">M</span>
              <div>
                <h3>MCPeasy</h3>
                <p>Version {version}</p>
                <p className="muted">Build and test Model Context Protocol servers visually or from code.</p>
              </div>
            </div>
          )}
          {view === "documentation" && (
            <div className="documentation-content">
              <p>Start from the MCP root, then build outward through its connectors:</p>
              <ol>
                <li><strong>MCP root</strong>: define the server name, description and creator.</li>
                <li><strong>Tool</strong>: define the official MCP tool name, description and input schema.</li>
                <li><strong>Operations</strong>: call HTTP APIs, run reviewed local executables or script files, use trusted custom code in your language of choice, and reshape results.</li>
                <li><strong>Concurrent requests</strong>: run named branches together and join their results before continuing.</li>
                <li><strong>Return</strong>: send JSON or text back to the model.</li>
              </ol>
              <p>Click a card's <strong>+</strong> connector to choose and attach its next node, then use <strong>Test console</strong> before saving.</p>
              <p className="muted">Keyboard: Ctrl/Cmd+K searches blocks. Everything lives in a workspace: File provides New server, Open server, Save to your workspace, Switch workspace, and Export as TypeScript or Python (a runnable project as a .zip). Workspace home is your workspace's central page, reachable from the home button beside the MCPeasy name.</p>
            </div>
          )}
          {view === "preferences" && (
            <fieldset className="theme-options">
              <legend>Theme</legend>
              {(["system", "light", "dark"] as const).map((value) => (
                <label className="theme-option" key={value}>
                  <input type="radio" name="theme" checked={theme === value} onChange={() => chooseTheme(value)} />
                  <span>
                    {/* "dark" stays the persisted value (stored prefs keep working)
                        but is presented as the Midnight theme it now renders. */}
                    <strong>{value === "system" ? "Use system setting" : value === "dark" ? "Midnight" : "Light"}</strong>
                    <small>{value === "system" ? "Follow Windows or macOS automatically." : `Always use the ${value === "dark" ? "Midnight" : "light"} MCPeasy theme.`}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {view === "updates" && (
            <div className="update-status">
              <span className="update-status__icon" aria-hidden="true">i</span>
              <div>
                <strong>MCPeasy {version}</strong>
                <p>This development build has no update channel configured yet.</p>
                <p className="muted">Automatic checks will become available with signed desktop releases.</p>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
