import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import type { ProjectInfo } from "../../shared/ipc";
import { getApi } from "./browser/api";

// The startup workspace chooser: workspaces DRIVE the tool (user decision),
// so the app opens here — not on the canvas — and the editor shell only
// renders once a workspace is chosen. Layout follows the provided tile
// reference (stepper → centred title → section head → tile grid) but
// re-expressed in MCPeasy's own tokens; importing the reference's literal
// palette would break Light/Midnight theming.
//
// Two steps, mirroring "create new OR open existing":
//   choose → [create: name entry] | [open: saved-workspace tiles]

/** Exported so callers can NAME the step they want instead of passing a
 *  boolean that only this file knows how to interpret: File offers both "New
 *  workspace…" and "Open workspace…", which are two different steps, and a
 *  second flag would have made an impossible "both" state representable. */
export type ProjectStartStep = "choose" | "create" | "open";

type Step = ProjectStartStep;

// This page deliberately does NOT decide where the App lands afterwards. It
// used to (create => builder, open => home), which made it a second opinion
// alongside the launch-restore path in App.tsx, and its "create => builder"
// answer was exactly how a blank unsaved server reached the screen. The one
// rule now lives in shared/startupLanding.ts and App applies it to whichever
// workspace this page hands back. The full ProjectInfo travels with that
// hand-off so App can resolve the landing without re-reading the library.

const tileIcon = (path: ReactElement): ReactElement => (
  <svg
    viewBox="0 0 24 24"
    width="56"
    height="56"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);

const NEW_ICON = tileIcon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <path d="M12 8v8M8 12h8" />
  </>,
);

const OPEN_ICON = tileIcon(
  <>
    <path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7z" />
  </>,
);

// Database glyph for a saved workspace. Deliberately NOT the same mark as the
// title bar's home button (nav.tsx now draws a house): these tiles pick WHICH
// workspace to open, whereas the home button navigates inside the one already
// open, and reusing one glyph for both would blur that distinction.
const PROJECT_ICON = tileIcon(
  <>
    <ellipse cx="12" cy="5.5" rx="8" ry="3" />
    <path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    <path d="M4 11.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
  </>,
);

export function ProjectStartPage({
  onOpened,
  initialStep = "choose",
}: {
  /** Hands back the whole ProjectInfo, not just id+name: App needs the
   *  workspace's saved-server list to resolve the landing, and the freshly
   *  created/selected record already carries it. */
  onOpened: (project: ProjectInfo) => void;
  /** File's workspace entries name their own step — "New workspace…" opens
   * "create", "Open workspace…" opens "open" — because the user already
   * answered "create or open?" by choosing the menu item, and re-asking is
   * noise. Back still reaches "choose", so either entry can reach the other.
   * Defaults to "choose" for a fresh launch, where nothing has been asked. */
  initialStep?: Step;
}) {
  const [step, setStep] = useState<Step>(initialStep);
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Loaded up front (not on entering "open") so the choose tile can show a
    // truthful workspace count; both backends answer fast local reads.
    void getApi().listProjects().then(setProjects);
  }, []);

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const res = await getApi().createProject(newName);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // A brand-new workspace has no servers, so the landing rule sends it to the
    // workspace home (user decision) rather than opening a blank unsaved server
    // on the canvas. res.project.servers is [] here, which is exactly what
    // resolveStartupLanding needs to reach that conclusion.
    onOpened(res.project);
  };

  const count = projects?.length ?? 0;

  return (
    <div className="start-page">
      <div className="start-page__panel">
        {/* Two-segment stepper (reference shows progress segments): choose,
            then name/select. */}
        <div className="start-stepper" aria-hidden="true">
          <div className={`start-stepper__seg${step === "choose" ? " start-stepper__seg--active" : ""}`} />
          <div className={`start-stepper__seg${step !== "choose" ? " start-stepper__seg--active" : ""}`} />
        </div>

        <h1 className="start-page__title heading-gradient">Welcome to MCPeasy</h1>

        {step === "choose" && (
          <>
            <div className="start-section-head">
              <h2>Choose a workspace</h2>
            </div>
            <p className="start-page__subtitle">
              Everything you build lives in a workspace. Create a new one, or continue where you left off.
            </p>
            <div className="start-tiles">
              <button type="button" className="start-tile" onClick={() => setStep("create")}>
                <span className="start-tile__logo start-tile__logo--primary">{NEW_ICON}</span>
                <span className="start-tile__label">Create new<br />workspace</span>
              </button>
              <button
                type="button"
                className="start-tile"
                onClick={() => setStep("open")}
                // Grayed out until there is something to open (user decision).
                // Also disabled while the count is still loading, so the tile
                // can't flash clickable and then turn gray a frame later.
                disabled={count === 0}
                title={projects !== null && count === 0 ? "No saved workspaces yet" : undefined}
              >
                <span className="start-tile__logo">{OPEN_ICON}</span>
                <span className="start-tile__label">
                  Open existing<br />workspace
                  <small className="start-tile__hint">
                    {projects === null ? "…" : `${count} saved`}
                  </small>
                </span>
              </button>
            </div>
          </>
        )}

        {step === "create" && (
          <>
            <div className="start-section-head">
              <h2>Name your workspace</h2>
            </div>
            <p className="start-page__subtitle">You can save several servers into one workspace.</p>
            <form className="start-create" onSubmit={(event) => void create(event)}>
              <input
                autoFocus
                value={newName}
                onChange={(event) => {
                  setNewName(event.target.value);
                  setError(null);
                }}
                placeholder="Workspace name"
                aria-label="Workspace name"
              />
              <button type="submit" className="start-create__btn" disabled={newName.trim().length === 0}>
                Create workspace
              </button>
            </form>
            {error !== null && <p className="start-page__error" role="alert">{error}</p>}
            <button type="button" className="start-back" onClick={() => setStep("choose")}>
              ← Back
            </button>
          </>
        )}

        {step === "open" && (
          <>
            <div className="start-section-head">
              <h2>Open a workspace</h2>
            </div>
            <p className="start-page__subtitle">Pick one of your saved workspaces.</p>
            {projects !== null && projects.length === 0 ? (
              <p className="start-page__empty">No saved workspaces yet. Go back and create your first one.</p>
            ) : (
              <div className="start-tiles">
                {(projects ?? []).map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className="start-tile"
                    onClick={() => onOpened(project)}
                    title={project.name}
                  >
                    <span className="start-tile__logo">{PROJECT_ICON}</span>
                    <span className="start-tile__label">
                      {project.name}
                      <small className="start-tile__hint">
                        {project.servers.length} server{project.servers.length === 1 ? "" : "s"}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="start-back" onClick={() => setStep("choose")}>
              ← Back
            </button>
          </>
        )}
      </div>
    </div>
  );
}
