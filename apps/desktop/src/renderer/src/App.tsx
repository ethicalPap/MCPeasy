import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import type { ThemePreference } from "../../shared/ipc";
import { lintErrorCount } from "@mcpeasy/schema";
import { getApi } from "./browser/api";
import { Canvas } from "./canvas/Canvas";
import { MCP_ROOT_NODE_ID } from "./graph";
import { IntegrationsPage } from "./IntegrationsPage";
import { PlaceholderPage, Sidebar, pageById, type PageId } from "./nav";
import { CodePanel } from "./panels/CodePanel";
import { ConsolePanel } from "./panels/ConsolePanel";
import { NodePanel } from "./panels/NodePanel";
import { ProjectsPage } from "./ProjectsPage";
import { ProjectStartPage, type ProjectStartStep } from "./ProjectStartPage";
import { SecretsPage } from "./SecretsPage";
import { ServerMenu } from "./ServerMenu";
import { resolveStartupLanding } from "./shared/startupLanding";
import { ServerPanel } from "./panels/ServerPanel";
import { SearchBar } from "./SearchBar";
import { HelpDialog, TitlebarMenus, type HelpView } from "./TitlebarMenus";
import type { ExportLanguage } from "./export/types";
import { applyThemePreference, readThemePreference } from "./theme";
import { useEditor } from "./store";

export function App() {
  const state = useEditor();
  const [page, setPage] = useState<PageId>("builder");
  // True while the initial workspace-restore check is in flight. Prevents
  // flashing the startup chooser for the common case where a persisted
  // workspace exists and will be opened immediately.
  const [restoring, setRestoring] = useState(true);
  // The test console is a permanent fixture of the builder: it starts open and
  // can only be minimized to the bottom bar, never fully closed. `false` means
  // "minimized", not "gone".
  const [consoleOpen, setConsoleOpen] = useState(true);
  // Drag-to-resize height for the console drawer. Session-local like the
  // open/minimized flag; survives minimize/restore because minimizing only
  // flips `consoleOpen`, it never resets the height.
  const [consoleHeight, setConsoleHeight] = useState(300);

  // Top-edge drag handle for the console drawer. Pointer capture keeps the
  // drag alive even when the cursor leaves the thin handle strip mid-drag
  // (which it always does), so no document-level listeners are needed.
  const startConsoleResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startY = event.clientY;
    const startHeight = consoleHeight;
    handle.setPointerCapture(event.pointerId);
    const onMove = (ev: PointerEvent): void => {
      // Dragging up (smaller clientY) grows the bottom-docked drawer.
      const next = startHeight + (startY - ev.clientY);
      // Clamp: never below a usable header+row, never swallowing the canvas.
      const max = Math.round(window.innerHeight * 0.8);
      setConsoleHeight(Math.min(max, Math.max(160, next)));
    };
    const onUp = (): void => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };
  const [codeOpen, setCodeOpen] = useState(false);
  const [helpView, setHelpView] = useState<HelpView>(null);
  const [theme, setTheme] = useState<ThemePreference>(() => readThemePreference());
  const [appVersion, setAppVersion] = useState("0.1.0");
  // Keep the builder unobstructed until the user explicitly asks for guidance;
  // creating a new document must not turn onboarding back into a startup modal.
  const [helpOpen, setHelpOpen] = useState(false);
  // Transient action feedback (save/export); dialogs already block, so a
  // toast (not a modal) is enough for "written / failed". Cancel shows nothing.
  const [exportNotice, setExportNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const showNotice = (notice: { kind: "ok" | "error"; text: string }): void => {
    setExportNotice(notice);
    window.setTimeout(() => setExportNotice(null), 6000);
  };

  const runExport = async (language: ExportLanguage): Promise<void> => {
    const res = await state.exportProject(language);
    if (res === null) return; // user cancelled the save dialog
    showNotice(res.ok ? { kind: "ok", text: `Exported to ${res.path}` } : { kind: "error", text: res.error });
  };

  // The only doc save in the app (projects-only model): Ctrl+S and File →
  // Save both land in the active project with no OS dialog.
  const runSave = async (): Promise<void> => {
    const res = await state.saveToProject();
    showNotice(res.ok ? { kind: "ok", text: `Saved to ${state.project?.name ?? "workspace"}` } : { kind: "error", text: res.error });
  };

  // Which step the startup chooser opens on. File's two workspace entries each
  // name a destination, so the chooser skips "create or open?" — the user
  // already answered it by picking the menu item. null means "not asked", i.e.
  // a fresh launch, which still starts on "choose". Reset to null when a
  // workspace opens so a later launch is unaffected by this session's choice.
  const [startStep, setStartStep] = useState<ProjectStartStep | null>(null);

  // Leaving a workspace discards the in-memory doc, so a dirty one gets the
  // same friction as closing the window: confirm, default to staying.
  // Both File → New workspace… and File → Open workspace… land here; they
  // differ only in which chooser step they request, so the unsaved-work guard
  // can never be bypassed by picking the other one.
  const leaveProject = (step: ProjectStartStep): void => {
    if (state.dirty && !window.confirm("You have unsaved changes. Leave this workspace and discard them?")) return;
    setStartStep(step);
    state.closeProject();
    setPage("builder");
  };

  const selectedNode = state.selectedId !== null ? state.doc.nodes[state.selectedId] : undefined;
  const rootSelected = state.selectedId === MCP_ROOT_NODE_ID;
  const errorCount = lintErrorCount(state.lint) + state.validation.length;
  // The open server's label moved into ServerMenu's trigger (currentServerLabel
  // in shared/serverSwitch.ts), which keeps the same rule: an unsaved doc is
  // named by doc.server.name rather than "Untitled", because after reopening a
  // workspace the canvas holds real work and "Untitled" read as data loss.

  useEffect(() => {
    void getApi().getAppInfo().then((info) => setAppVersion(info.version)).catch(() => undefined);
  }, []);

  // ── Workspace + server restore on launch ─────────────────────────────
  // If a previous workspace was persisted, verify it still exists in the
  // project library and reopen it automatically. WHICH server (if any) then
  // loads, and which page is shown, is decided by resolveStartupLanding — the
  // same rule the startup chooser uses below, so launch and manual entry can
  // never disagree. The app never lands on a blank new server: it opens the
  // remembered saved doc, or shows the workspace home. If the workspace was
  // deleted externally, the stale reference is cleared gracefully.
  // The `restoring` flag suppresses the chooser UI while the async check
  // runs so the user never sees it flash.
  useEffect(() => {
    // Only attempt restore when no workspace is already open (initial mount).
    if (state.project !== null) { setRestoring(false); return; }
    const api = getApi();
    void (async () => {
      try {
        const last = await api.getLastWorkspace();
        if (last === null) { setRestoring(false); return; }
        // Validate the workspace still exists in the library.
        const projects = await api.listProjects();
        const match = projects.find((p) => p.id === last.id);
        if (match) {
          state.openProject({ id: match.id, name: match.name });
          // match.servers is the same listing the workspace home renders, so
          // the landing is decided against exactly what the user would see
          // there — no second, possibly staler, read.
          const landing = resolveStartupLanding(match.servers, last.serverPath ?? null);
          if (landing.openServerPath !== null) {
            try {
              await state.openProjectDoc(landing.openServerPath);
            } catch {
              // The file vanished between the listing and this read. Fall back
              // to the home page rather than stranding the user on the blank
              // canvas openProject just reset — that blank doc is precisely
              // what this landing rule exists to avoid showing.
              setPage("repository");
              return;
            }
          }
          setPage(landing.page);
        } else {
          // Workspace was deleted externally; clear the stale reference.
          void api.setLastWorkspace(null).catch(() => undefined);
        }
      } catch {
        // IPC failure — fall through to the chooser.
      } finally {
        setRestoring(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — mount-only

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      applyThemePreference(theme, document.documentElement, media.matches);
      void getApi().setTheme(theme).catch(() => undefined);
    };
    apply();
    window.localStorage.setItem("mcpeasy.theme", theme);
    if (theme === "system") media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    // No shortcuts before a workspace exists: Ctrl+S would have nowhere to
    // save, and Ctrl+N would ask to leave a workspace that is not open — the
    // chooser it navigates to is already on screen.
    if (state.project === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        // Shift+S (old Save As) intentionally folds into the same project
        // save: with projects-only I/O there is no second destination.
        event.preventDefault();
        void runSave();
      } else if (key === "n") {
        event.preventDefault();
        // Ctrl+N follows File's New workspace… rather than creating a server:
        // the shortcut and the menu item it is printed on must not diverge.
        // leaveProject carries the unsaved-changes confirm, so the shortcut is
        // no more destructive than the menu route.
        leaveProject("create");
      }
      // Ctrl+O (loose-file open) was removed with the projects-only model.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  useEffect(() => {
    if (Object.keys(state.doc.nodes).length > 0) setHelpOpen(false);
  }, [state.doc.nodes]);

  const meta = pageById(page);
  const blockCount = Object.keys(state.doc.nodes).length;

  // Workspaces drive the tool: until one is chosen (create new / open
  // existing), the startup chooser IS the app — no sidebar, no menus that
  // could act on a doc that has no home yet. While restoring a persisted
  // workspace, show a minimal shell to avoid flashing the chooser.
  if (state.project === null) {
    if (restoring) {
      // Minimal shell while the async restore check runs — intentionally
      // blank so neither the chooser nor the builder flashes on startup.
      return (
        <div className="app">
          <header className="titlebar">
            <div className="titlebar__safe-area">
              <div className="titlebar__left">
                <span className="titlebar__identity">MCPeasy</span>
              </div>
            </div>
          </header>
        </div>
      );
    }
    return (
      <div className="app">
        <header className="titlebar">
          <div className="titlebar__safe-area">
            <div className="titlebar__left">
              <span className="titlebar__identity">MCPeasy</span>
            </div>
          </div>
        </header>
        <ProjectStartPage
          initialStep={startStep ?? "choose"}
          onOpened={(project) => {
            setStartStep(null);
            state.openProject({ id: project.id, name: project.name });
            // Same rule as the launch restore above. Entering a workspace by
            // hand has no remembered server (openProject just cleared the
            // persisted path), so this resolves to the workspace home — the
            // user picks a saved server there instead of being dropped onto a
            // blank canvas they did not ask for.
            setPage(resolveStartupLanding(project.servers, null).page);
          }}
        />
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div className="app">
        <header className="titlebar">
          {/* The search is a direct child of .titlebar (not the safe area) so
              it can center on the FULL window width: the safe area excludes
              the Windows caption controls, and centering inside it reads as
              off-center to the eye. */}
          {page === "builder" && <div className="titlebar__search"><SearchBar /></div>}
          {/* Current workspace — a passive indicator, NOT a button (user
              decision): changing workspaces goes through File → Open
              workspace…, and the workspace home through the home button to the
              left. Anchored just left of the centered search via CSS. */}
          <div className="titlebar__project" title={`Current workspace: ${state.project.name}`}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5v-9z" />
              <path d="M12 12v9M3.5 7.5 12 12l8.5-4.5" />
            </svg>
            <span className="titlebar__project-name">{state.project.name}</span>
          </div>
          <div className="titlebar__safe-area">
            <div className="titlebar__left">
              <span className="titlebar__identity">MCPeasy</span>
              {/* Workspace home, promoted out of the sidebar into the title bar
                  (user decision). It sits between the brand and File because it
                  is the app's root destination, and the File menu's "Open
                  server…" already lands on the same page — grouping the two
                  navigation entry points together. The glyph is read from
                  pageById so this button and the page heading can never name
                  different things. .titlebar__home opts back out of the window
                  drag region; without that the click would be swallowed. */}
              <button
                className="titlebar__home"
                onClick={() => setPage("repository")}
                title={pageById("repository").name}
                aria-label={pageById("repository").name}
                aria-current={page === "repository" ? "page" : undefined}
              >
                {pageById("repository").icon}
              </button>
              <TitlebarMenus
                projectName={state.project.name}
                onNewWorkspace={() => leaveProject("create")}
                onOpenWorkspace={() => leaveProject("open")}
                onSave={() => void runSave()}
                onExport={(language) => void runExport(language)}
                onHelp={setHelpView}
              />
            </div>
          </div>
        </header>
        <div className="app-shell">
          <Sidebar page={page} onNavigate={setPage} badges={{ builder: blockCount }} />
          <div className="app-main">
            <header className="toolbar">
              <span className="toolbar-page">{meta.name}</span>
              {page === "builder" && (
                <>
                  {/* Which server the canvas is editing, and the switcher for
                      it. Sits beside the page heading because that is the
                      question the heading leaves open: "Builder" — of what?
                      It is also now the ONLY place the server is named; the
                      right-hand group below kept just the dirty dot and Save,
                      so the name is not printed twice in one 64px row. */}
                  <ServerMenu
                    onNewServer={() => state.newDoc()}
                    onOpenHome={() => setPage("repository")}
                  />
                  {/* Unsaved indicator, now label-less: the dot pairs with the
                      Save button beside it, and the server it refers to is
                      named by the dropdown on the left. */}
                  <span className="file-status" title={state.filePath ?? "not saved yet"}>
                    {state.dirty && <span className="dirty-dot" title="unsaved changes" />}
                  </span>
                  {/* Save icon: visually pairs with the file-status; disabled
                      state uses opacity so the icon stays recognisable but
                      clearly non-interactive when there's nothing to save. */}
                  <button
                    className="code-toggle save-btn"
                    onClick={() => void runSave()}
                    disabled={!state.dirty}
                    title={state.dirty ? "Save (Ctrl+S)" : "No unsaved changes"}
                    aria-label="Save"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                      <polyline points="17 21 17 13 7 13 7 21" />
                      <polyline points="7 3 7 8 15 8" />
                    </svg>
                  </button>
                  {/* Shortcut to the Integrations page, sitting beside Save
                      because connecting a client is the usual next step after
                      saving. The glyph is read from pageById rather than
                      re-drawn here so the toolbar and the sidebar row can never
                      drift apart; its 1em sizing and 1.6 stroke are normalised
                      to the toolbar's 16px/1.8 by .toolbar-nav-btn. Never
                      disabled: the page itself explains what is missing, which
                      is more useful than an inert button. */}
                  <button
                    className="code-toggle toolbar-nav-btn"
                    onClick={() => setPage("integrations")}
                    title="Integrations: connect this server to a client"
                    aria-label="Integrations"
                  >
                    {pageById("integrations").icon}
                  </button>
                  {/* Icon-only (user decision): the "</> Code" rectangle read
                      as a labelled control; the tooltip + aria-label carry the
                      wording instead. console-toggle keeps the active tint. */}
                  <button
                    className={codeOpen ? "console-toggle code-toggle active" : "console-toggle code-toggle"}
                    onClick={() => setCodeOpen((value) => !value)}
                    title="Advanced mode: edit the graph as code"
                    aria-label="Toggle code view"
                    aria-pressed={codeOpen}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m8.5 6.5-5 5.5 5 5.5M15.5 6.5l5 5.5-5 5.5" />
                    </svg>
                  </button>
                  {errorCount > 0 && <span className="health health-bad" title={`${errorCount} problem(s) block serving`}>{errorCount} issue{errorCount > 1 ? "s" : ""}</span>}
                </>
              )}
            </header>

            {page === "repository" ? (
              // Opening a server from the project home lands the user on the
              // canvas so the click visibly loads it (errors show as the
              // builder's load banner, which only renders there).
              <ProjectsPage onOpenServer={() => setPage("builder")} onSwitchProject={() => leaveProject("open")} />
            ) : page === "secrets" ? (
              // Keyed on the project id so switching projects remounts the
              // editor with a fresh load (same idiom as docId-keyed panels).
              <SecretsPage key={state.project.id} />
            ) : page === "integrations" ? (
              // Same project-id keying: registration state and the stored
              // secret pre-flight are both per workspace.
              <IntegrationsPage key={state.project.id} />
            ) : page !== "builder" ? (
              <PlaceholderPage meta={meta} />
            ) : (
              <>
                {state.loadError !== null && <div className="load-error"><pre>{state.loadError}</pre><button onClick={() => state.dismissLoadError()}>Dismiss</button></div>}
                <div className="body">
                  <main className="canvas-wrap">
                    <Canvas helpOpen={helpOpen} onCloseHelp={() => setHelpOpen(false)} onOpenHelp={() => setHelpOpen(true)} />
                    {codeOpen && <CodePanel onClose={() => setCodeOpen(false)} />}
                  </main>
                  {rootSelected && <ServerPanel key={state.docId} />}
                  {state.selectedId !== null && selectedNode !== undefined && (
                    <NodePanel key={`${state.docId}:${state.selectedId}`} id={state.selectedId} node={selectedNode} />
                  )}
                </div>
                {consoleOpen ? (
                  <div className="console-drawer" style={{ height: consoleHeight }}>
                    {/* Grab strip along the drawer's top edge; sits above the
                        header border so the whole edge is a resize target. */}
                    <div
                      className="console-drawer__resize"
                      role="separator"
                      aria-orientation="horizontal"
                      aria-label="Resize console"
                      onPointerDown={startConsoleResize}
                    />
                    <div className="console-drawer__header">
                      <span className="console-drawer__title">Test console</span>
                      {/* Collapse, never close: the console is a permanent part
                          of the builder, so the only affordance is collapsing
                          it into the bottom bar below. Chevron points down to
                          match the direction the drawer collapses. */}
                      <button className="panel-icon-btn" onClick={() => setConsoleOpen(false)} title="Collapse console" aria-label="Collapse console">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                    </div>
                    <ConsolePanel />
                  </div>
                ) : (
                  // Minimized state: a slim bottom bar that restores the drawer.
                  // The whole bar is the button so the target is easy to hit.
                  <button className="console-minibar" onClick={() => setConsoleOpen(true)} title="Open test console" aria-label="Open test console">
                    <span className="console-minibar__icon">▣</span>
                    <span>Test console</span>
                    <span className="console-minibar__chevron">▴</span>
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        {exportNotice !== null && (
          <div className={exportNotice.kind === "ok" ? "export-toast" : "export-toast export-toast--error"} role="status">
            {exportNotice.text}
          </div>
        )}
        {helpView !== null && <HelpDialog view={helpView} theme={theme} version={appVersion} onTheme={setTheme} onClose={() => setHelpView(null)} />}
      </div>
    </ReactFlowProvider>
  );
}
