import { useCallback, useEffect, useState } from "react";
import { getApi } from "./browser/api";
import { secretNameError } from "../../shared/secretName";
import { useEditor } from "./store";

// Project secrets page under WRITE-ONCE semantics (user decision: API-key
// behavior, unlike env vars): a value is visible only while being typed into
// the entry form. Once saved it never comes back to the renderer — the IPC
// surface returns stored NAMES only, so there is nothing to reveal even in
// devtools. Stored rows therefore show a static mask (not the value), and the
// only operations are Replace (type a brand-new value) and Delete.
// Values still feed the test console's env fields from MAIN's side and never
// enter the graph doc, exports, or generated code (N5).

const trashIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6.5h16M9.5 6.5V4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 6.5 7.5 20a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9l1-13.5" />
    <path d="M10 10.5v6M14 10.5v6" />
  </svg>
);

export function SecretsPage() {
  const project = useEditor((s) => s.project);
  const declaredEnv = useEditor((s) => s.doc.server.env);
  // window.mcpeasy is the canonical "preload/Electron present" signal
  // (browser/api.ts): without it, secrets live in session memory only.
  const inElectron = window.mcpeasy !== undefined;

  const [names, setNames] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  // Entry form — the ONE place a secret value exists in renderer state, and
  // only until save. Cleared (not preserved) on success so the value's
  // lifetime in memory is as short as the flow allows.
  const [draftName, setDraftName] = useState("");
  const [draftValue, setDraftValue] = useState("");

  // Replace flow: the stored name whose value is being re-entered. The old
  // value is unknown to this page by design — replacing means typing anew.
  const [replacing, setReplacing] = useState<string | null>(null);
  const [replaceValue, setReplaceValue] = useState("");

  const load = useCallback(async () => {
    if (project === null) return;
    const res = await getApi().listProjectSecretNames(project.id);
    if (res.ok) {
      setNames(res.names);
      setLoadError(null);
    } else {
      setNames(null);
      setLoadError(res.error);
    }
  }, [project]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveDraft = async (): Promise<void> => {
    if (project === null) return;
    const name = draftName.trim();
    if (secretNameError(name) !== null || draftValue === "") return; // button is disabled; Enter path lands here too
    const res = await getApi().setProjectSecret({ projectId: project.id, name, value: draftValue });
    if (res.ok) {
      setDraftName("");
      setDraftValue("");
      setWriteError(null);
      await load();
    } else {
      setWriteError(res.error);
    }
  };

  const saveReplace = async (): Promise<void> => {
    if (project === null || replacing === null || replaceValue === "") return;
    const res = await getApi().setProjectSecret({ projectId: project.id, name: replacing, value: replaceValue });
    if (res.ok) {
      setReplacing(null);
      setReplaceValue("");
      setWriteError(null);
    } else {
      setWriteError(res.error);
    }
  };

  const deleteName = async (name: string): Promise<void> => {
    if (project === null) return;
    // Same friction as deleteNode: destroying stored data asks first — and
    // under write-once there is no way to see the value before losing it.
    if (!window.confirm(`Delete secret "${name}"? The stored value cannot be recovered.`)) return;
    const res = await getApi().deleteProjectSecret({ projectId: project.id, name });
    if (res.ok) {
      if (replacing === name) setReplacing(null);
      setWriteError(null);
      await load();
    } else {
      setWriteError(res.error);
    }
  };

  const clearAll = async (): Promise<void> => {
    if (project === null) return;
    if (!window.confirm("Clear ALL stored secrets for this project? The values cannot be recovered.")) return;
    const res = await getApi().clearProjectSecrets(project.id);
    if (res.ok) await load();
    else setWriteError(res.error);
  };

  if (project === null) return null; // shell never renders pages without one

  const draftNameTrimmed = draftName.trim();
  const draftNameProblem = draftNameTrimmed === "" ? null : secretNameError(draftNameTrimmed);
  // Saving an already-stored name is allowed (it IS the replace operation),
  // but it must never happen silently — the user may not have noticed.
  const willReplace = draftNameProblem === null && names !== null && names.includes(draftNameTrimmed);
  const canSave = draftNameTrimmed !== "" && draftNameProblem === null && draftValue !== "";

  const missingDeclared = declaredEnv.filter((name) => names !== null && !names.includes(name));

  return (
    <div className="projects-page secrets-page">
      <header className="project-home__header">
        <div>
          <h2 className="project-home__name">Secrets</h2>
        </div>
      </header>

      {!inElectron && (
        <div className="problem problem-warning">
          Browser preview: there is no OS encryption here, so secrets live in memory for this
          session only and are gone on reload. Use the desktop app to store them.
        </div>
      )}

      {loadError !== null && (
        <div className="problem problem-error secrets-page__recover">
          <span>{loadError}</span>
          <button type="button" onClick={() => void clearAll()}>
            Clear stored secrets
          </button>
        </div>
      )}

      {writeError !== null && <div className="problem problem-error">{writeError}</div>}

      {names !== null && (
        <>
          {missingDeclared.length > 0 && (
            <p className="muted secrets-page__hint">
              Declared on the open server but with no value saved:{" "}
              {missingDeclared.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="secrets-page__chip"
                  onClick={() => setDraftName(name)}
                  title={`Add a value for ${name}`}
                >
                  {name}
                </button>
              ))}
            </p>
          )}

          <div className="secrets-page__rows">
            {names.map((name) => (
              <div key={name} className="secrets-page__row">
                <span className="secrets-page__stored-name">{name}</span>
                {replacing === name ? (
                  <>
                    <input
                      className="secrets-page__value"
                      type="password"
                      value={replaceValue}
                      onChange={(e) => setReplaceValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveReplace();
                        if (e.key === "Escape") setReplacing(null);
                      }}
                      placeholder="new value"
                      aria-label={`New value for ${name}`}
                      autoFocus
                    />
                    <button type="button" onClick={() => void saveReplace()} disabled={replaceValue === ""}>
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setReplacing(null);
                        setReplaceValue("");
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    {/* Static mask — deliberately NOT the value (write-once:
                        the renderer does not have it and cannot get it). */}
                    <span className="secrets-page__mask" aria-hidden="true">
                      ••••••••••••
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setReplacing(name);
                        setReplaceValue("");
                      }}
                      title="Enter a new value (the current one stays hidden)"
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      className="panel-icon-btn"
                      onClick={() => void deleteName(name)}
                      title="Delete secret"
                      aria-label={`Delete ${name}`}
                    >
                      {trashIcon}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>

          <div className="secrets-page__add">
            <div className="secrets-page__row">
              <input
                className={draftNameProblem !== null ? "secrets-page__name secrets-page__name--bad" : "secrets-page__name"}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value.toUpperCase())}
                placeholder="API_KEY"
                aria-label="Secret name"
                spellCheck={false}
              />
              <input
                className="secrets-page__value"
                type="password"
                value={draftValue}
                onChange={(e) => setDraftValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && canSave && void saveDraft()}
                placeholder="value (visible only now, hidden once saved)"
                aria-label={`Value for ${draftNameTrimmed || "new secret"}`}
              />
              <button type="button" onClick={() => void saveDraft()} disabled={!canSave}>
                Save secret
              </button>
            </div>
            {draftNameProblem !== null && <p className="secrets-page__error">{draftNameProblem}</p>}
            {willReplace && (
              <p className="muted secrets-page__error-note">
                “{draftNameTrimmed}” is already stored. Saving will replace its value.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
