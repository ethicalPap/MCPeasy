import { useCallback, useEffect, useMemo, useState } from "react";
import type { McpClientInfo, McpClientState, McpClientStatus } from "../../shared/ipc";
import { getApi } from "./browser/api";
import { useEditor } from "./store";
import { useClaudeCodeSections } from "./integrations/ClaudeCodePanel";
import { PanelFacts, SidePanel, type SidePanelSection } from "./integrations/SidePanel";
import { ConnectConfirmDialog } from "./integrations/ConnectConfirmDialog";
import { ConnectServerDialog } from "./integrations/ConnectServerDialog";
import { connectConfirmTarget } from "../../shared/connectConfirm";
import { candidateDisplayName, readCandidateFacts, type ConnectCandidate } from "../../shared/connectTarget";

// The Integrations catalog: every MCP client MCPeasy can register the open
// server with. Structure follows the reference implementation
// (PyroTrace-Cloud app/(dashboard)/settings/integrations/page.tsx): a searchable
// catalog grouped by category, status-badged tiles, and a detail panel for the
// selected client. Class naming follows SecretsPage.tsx.
//
// HONESTY RULE (mirrors the badge rule in nav.tsx): this page reports what was
// WRITTEN to a client's config. It never claims a connection was verified,
// because MCPeasy does not start these clients and cannot observe the
// handshake. Status is derived from the local filesystem only — see
// inspectClient in main/mcpClients.ts.

const STATUS_LABEL: Record<McpClientStatus, string> = {
  connected: "Connected",
  detected: "Installed",
  warning: "Needs attention",
  needs_setup: "Not found",
  unsupported: "Unsupported",
};

function StatusBadge({ status }: { status: McpClientStatus }) {
  return <span className={`integrations__badge integrations__badge--${status}`}>{STATUS_LABEL[status]}</span>;
}

interface Row {
  client: McpClientInfo;
  state: McpClientState;
}

export function IntegrationsPage() {
  const project = useEditor((s) => s.project);
  // The builder's open doc is no longer the connect TARGET — the picker chooses
  // that. These two remain because unsaved changes are a property of the
  // builder, not of any file on disk, so they can only ever block the one
  // candidate that is currently open (see candidateBlockers).
  const filePath = useEditor((s) => s.filePath);
  const dirty = useEditor((s) => s.dirty);

  const [clients, setClients] = useState<McpClientInfo[]>([]);
  const [states, setStates] = useState<McpClientState[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("All");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Which panel section is showing. Reset on open (below) so every client's
  // panel starts on Overview rather than inheriting the last one's section.
  const [panelSection, setPanelSection] = useState("overview");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Secret NAMES only — values never cross the IPC boundary (ipc.ts:96). Held
  // at page level because every candidate in the picker is judged against the
  // same workspace store.
  const [storedSecrets, setStoredSecrets] = useState<string[]>([]);
  // The client awaiting confirmation. Holding the CLIENT ID (not a boolean)
  // means the dialog always describes the row that was actually clicked, even
  // if the catalog refreshes underneath it.
  const [pendingConnectId, setPendingConnectId] = useState<string | null>(null);
  // Which server the user picked for that client. Connect is a TWO-step flow:
  //   pendingConnectId set, pickedServer null -> the picker is showing
  //   both set                                -> the confirmation is showing
  // Keeping them as separate states (rather than one enum) means Cancel on the
  // confirmation can fall back to the picker by clearing only this one.
  const [pickedServer, setPickedServer] = useState<ConnectCandidate | null>(null);
  // Every saved server in this workspace, with the facts needed to judge it.
  // Read once per page refresh rather than per dialog open, so the picker
  // appears instantly; refresh() re-reads after any connect.
  const [candidates, setCandidates] = useState<ConnectCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(true);
  // The exact entry name main would write, per saved server path. Empty until
  // the first list call returns, and in browser mode always — never guessed in
  // the renderer (see ListMcpClientsResponse.entryNames).
  const [entryNames, setEntryNames] = useState<Record<string, string>>({});

  const inElectron = window.mcpeasy !== undefined;

  const refresh = useCallback(async () => {
    if (project === null) return;
    const api = getApi();
    const listed = await api.listMcpClients({ projectId: project.id, serverPath: filePath });
    setClients(listed.clients);
    setStates(listed.states);
    setEntryNames(listed.entryNames);
    setLoading(false);

    // Pre-flight data for the picker. A declared env var with no stored secret
    // would make serve mode exit non-zero at launch, which every client reports
    // only as a generic connection failure — so it is judged HERE, where the
    // message can name the missing value, and per server, because each saved
    // doc declares its own env.
    const names = await api.listProjectSecretNames(project.id);
    setStoredSecrets(names.ok ? names.names : []);

    // Read every saved server in the workspace. listProjects is the same source
    // the workspace home uses, so the picker and that page can never disagree
    // about which servers exist.
    const projects = await api.listProjects();
    const entries = projects.find((p) => p.id === project.id)?.servers ?? [];
    const read = await Promise.all(
      entries.map(async (entry): Promise<ConnectCandidate> => {
        const base = { path: entry.path, fileName: entry.fileName, updatedAt: entry.updatedAt };
        const found = await api.readProjectDoc(entry.path);
        // A listed file that will not read is a real state (deleted mid-read,
        // or permissions), not an impossibility — report it on the row rather
        // than dropping the server silently.
        if (found === null) return { ...base, serverName: "", env: [], listening: false, loadError: "this file could not be read" };
        return { ...base, ...readCandidateFacts(found.text) };
      }),
    );
    setCandidates(read);
    setCandidatesLoading(false);
  }, [project, filePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = useMemo<Row[]>(() => {
    const byId = new Map(states.map((state) => [state.id, state]));
    return clients.map((client) => ({
      client,
      // A client with no reported state is a bug, not an absence — say so
      // rather than rendering a tile that silently looks fine.
      state: byId.get(client.id) ?? {
        id: client.id,
        status: "warning" as const,
        statusReason: "No status was reported for this client.",
        configPath: null,
        configExists: false,
        entries: [],
        error: null,
      },
    }));
  }, [clients, states]);

  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const row of rows) if (!seen.includes(row.client.category)) seen.push(row.client.category);
    return ["All", ...seen];
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (category !== "All" && row.client.category !== category) return false;
      if (q === "") return true;
      return (
        row.client.name.toLowerCase().includes(q) ||
        row.client.category.toLowerCase().includes(q) ||
        row.client.description.toLowerCase().includes(q) ||
        row.client.aliases.some((alias) => alias.toLowerCase().includes(q))
      );
    });
  }, [rows, category, query]);

  // Reasons connecting cannot proceed AT ALL, regardless of which server is
  // chosen. Per-server reasons (unsaved, missing secrets, http transport) moved
  // to candidateBlockers, where they are judged against the picked doc instead
  // of against whatever happens to be open in the builder — see
  // shared/connectTarget.ts. What is left here is genuinely global: the
  // environment, and having nothing to offer.
  const blockers: string[] = [];
  if (!inElectron) blockers.push("connecting a client needs the desktop app");
  else if (!candidatesLoading && candidates.length === 0) {
    blockers.push("no servers are saved in this workspace yet, save one to connect it");
  }

  const selected = rows.find((row) => row.client.id === selectedId) ?? null;
  // Resolved from the live rows rather than captured at click time, so the
  // dialog cannot describe a stale config path after a refresh.
  const pendingConnect = rows.find((row) => row.client.id === pendingConnectId) ?? null;

  // Called unconditionally (rules of hooks) and BEFORE the project === null
  // early return below. It yields sections only for Claude Code, so it is also
  // what stops the CLI being probed while another client's panel is open.
  const claudeSections = useClaudeCodeSections({ clientId: selectedId, busy, onNotice: setNotice });

  // Connecting is split into PICK, ASK and DO. The tile's button only ever
  // opens the picker; the picker only ever opens the confirmation; `connect` is
  // unreachable without a confirmed transcription of the chosen server's name.
  // Keeping them separate means there is exactly one call site that writes to a
  // client's config, which is the thing worth being able to audit at a glance.
  const connect = async (row: Row, server: ConnectCandidate): Promise<void> => {
    if (project === null) return;
    setBusy(true);
    try {
      const result = await getApi().connectMcpClient({
        clientId: row.client.id,
        projectId: project.id,
        // The PICKED server, not the builder's open doc. Main re-resolves this
        // path against the library jail rather than trusting it
        // (index.ts resolveServerRequest), so a stale path fails closed.
        serverPath: server.path,
      });
      if (result.ok) {
        setNotice({
          kind: "ok",
          // Deliberately does NOT say "connected": the entry is written, and
          // the client picks it up on its own schedule.
          text: `Wrote "${result.entryName}" to ${row.client.name}. ${result.activationHint}${
            result.backupPath !== null ? ` A backup of the previous config was saved to ${result.backupPath}.` : ""
          }`,
        });
        await refresh();
      } else {
        setNotice({ kind: "error", text: result.error });
      }
    } finally {
      setBusy(false);
      // Dismissed on both outcomes: on success the work is done, and on failure
      // the reason is in the notice behind the dialog, where the user can read
      // it and fix the cause. Both steps are cleared so a later Connect starts
      // at the picker rather than reopening the confirmation for a stale pick.
      setPendingConnectId(null);
      setPickedServer(null);
    }
  };

  const disconnect = async (row: Row, entryName: string): Promise<void> => {
    if (entryName === "") return;
    if (!window.confirm(`Remove "${entryName}" from ${row.client.name}?`)) return;
    setBusy(true);
    try {
      const result = await getApi().disconnectMcpClient({ clientId: row.client.id, entryName });
      setNotice(
        result.ok
          ? { kind: "ok", text: `Removed "${entryName}" from ${row.client.name}.` }
          : { kind: "error", text: result.error },
      );
      if (result.ok) await refresh();
    } finally {
      setBusy(false);
    }
  };

  /** Opening a panel resets to Overview: keeping the previous section would
   *  land the user on a section the new client may not even have. */
  const openDetails = (row: Row): void => {
    setPanelSection("overview");
    setSelectedId(row.client.id);
  };

  // Panel sections for the selected client: the generic two every client has,
  // plus whatever Claude Code contributed. Built before the early return so the
  // panel can keep rendering its exit animation after selection clears.
  const sections: SidePanelSection[] =
    selected === null
      ? []
      : [
          {
            key: "overview",
            label: "Overview",
            icon: "◎",
            content: (
              <section className="integrations__section">
                <h3>Configuration</h3>
                <PanelFacts
                  rows={[
                    [
                      "Config file",
                      <>
                        <code>{selected.state.configPath ?? "not available on this OS"}</code>
                        {selected.state.configPath !== null && !selected.state.configExists && (
                          <span className="muted"> (will be created on connect)</span>
                        )}
                      </>,
                    ],
                    // Surfaced because it is the difference most likely to
                    // confuse someone comparing two clients' configs by hand:
                    // VS Code uses `servers`, everyone else uses `mcpServers`.
                    ["Server map key", <code>{selected.client.serversKey}</code>],
                    ["After connecting", selected.client.activationHint],
                    ["Docs", <code>{selected.client.docsUrl}</code>],
                    // Only shown when main actually reported a failure, so an
                    // absent row means "no error", not "not checked".
                    ["Error", selected.state.error !== null ? selected.state.error : null],
                  ]}
                />
                <p className="muted">{selected.client.description}</p>
              </section>
            ),
          },
          {
            key: "registered",
            label: "Registered",
            icon: "≡",
            // The count belongs in the rail: it is the one fact a user wants
            // without opening the section.
            badge: String(selected.state.entries.length),
            content: (
              <section className="integrations__section">
                <h3>Registered by MCPeasy</h3>
                {selected.state.entries.length === 0 ? (
                  <p className="muted">Nothing registered with this client yet.</p>
                ) : (
                  <div className="secrets-page__rows">
                    {selected.state.entries.map((entry) => (
                      <div key={entry.name} className="secrets-page__row">
                        <span className="secrets-page__stored-name">{entry.name}</span>
                        <button type="button" onClick={() => void disconnect(selected, entry.name)} disabled={busy}>
                          Disconnect
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ),
          },
          ...claudeSections,
        ];

  if (project === null) return null; // the shell never renders pages without one

  const connectedCount = rows.filter((r) => r.state.status === "connected").length;
  const installedCount = rows.filter((r) => r.state.status === "detected").length;

  return (
    <div className="projects-page integrations-page">
      {/* Title only, matching SecretsPage. The former subtitle explained the
          no-secret-written guarantee, which the connect confirmation dialog now
          states at the moment it actually matters (ConnectConfirmDialog.tsx:126)
          rather than as standing page copy. */}
      <header className="project-home__header">
        <div>
          <h2 className="project-home__name">Integrations</h2>
        </div>
      </header>

      {!inElectron && (
        <div className="problem problem-warning">
          Browser preview: a browser cannot read or write a client's configuration. Use the desktop app to connect a
          server.
        </div>
      )}

      {notice !== null && (
        <p className={`projects-notice${notice.kind === "error" ? " projects-notice--error" : ""}`} role="status">
          {notice.text}
        </p>
      )}

      {blockers.length > 0 && (
        <section className="integrations__section">
          <h3>Before connecting</h3>
          <ul className="integrations__blockers">
            {blockers.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="integrations__toolbar">
        <div className="integrations__filters">
          {categories.map((name) => (
            <button
              key={name}
              type="button"
              className={`integrations__filter${category === name ? " integrations__filter--active" : ""}`}
              onClick={() => setCategory(name)}
            >
              {name}
            </button>
          ))}
        </div>
        <input
          className="integrations__search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search clients…"
          aria-label="Search clients"
          spellCheck={false}
        />
      </div>

      <p className="muted integrations__summary">
        {loading
          ? "Checking this machine…"
          : `${connectedCount} connected · ${installedCount} installed · ${rows.length} known clients`}
      </p>

      {filtered.length === 0 ? (
        <p className="muted">No clients match the current filters.</p>
      ) : (
        <div className="integrations__grid">
          {filtered.map((row) => {
            // The tile ALWAYS offers Connect, even for a client that already
            // holds a MCPeasy server: a client can carry several servers at
            // once (separate keys under its server map), so "connected" is no
            // longer a terminal state for the tile. Removal moved entirely to
            // the Details panel's Registered section, which lists every entry
            // by name — the tile could only ever have guessed at entries[0],
            // which is the wrong one as soon as a second server exists.
            const canConnect = blockers.length === 0 && row.state.status !== "unsupported";
            return (
              <article key={row.client.id} className="integrations__tile">
                <header className="integrations__tile-head">
                  <div className="integrations__tile-id">
                    <h4>{row.client.name}</h4>
                    <span className="integrations__tile-category">{row.client.category}</span>
                  </div>
                  <StatusBadge status={row.state.status} />
                </header>
                <p className="integrations__tile-desc">{row.client.description}</p>
                <p className="integrations__tile-reason" title={row.state.statusReason}>
                  {row.state.statusReason}
                </p>
                <div className="integrations__tile-actions">
                  <button
                    type="button"
                    onClick={() => {
                      // Opens the PICKER, never the write. Cleared first so a
                      // previous session's pick can never skip step one.
                      setPickedServer(null);
                      setPendingConnectId(row.client.id);
                    }}
                    disabled={busy || !canConnect}
                  >
                    {row.state.entries.length > 0 ? "Connect another" : "Connect"}
                  </button>
                  <button type="button" className="integrations__details-btn" onClick={() => openDetails(row)}>
                    Details
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <SidePanel
        open={selected !== null}
        title={selected?.client.name ?? ""}
        eyebrow={selected?.client.category}
        header={
          selected !== null && (
            <>
              <StatusBadge status={selected.state.status} />
              <span className="muted">{selected.state.statusReason}</span>
            </>
          )
        }
        sections={sections}
        active={panelSection}
        onActiveChange={setPanelSection}
        onClose={() => setSelectedId(null)}
      />

      {/* STEP 1 — which server. Shown while a client is pending and nothing has
          been picked for it yet. */}
      {pendingConnect !== null && pickedServer === null && (
        <ConnectServerDialog
          client={pendingConnect.client}
          candidates={candidates}
          loading={candidatesLoading}
          storedSecrets={storedSecrets}
          openFilePath={filePath}
          builderDirty={dirty}
          onPick={setPickedServer}
          onCancel={() => setPendingConnectId(null)}
        />
      )}

      {/* STEP 2 — are you sure. Now describes the PICKED server rather than the
          builder's open doc, so the name that must be typed is the name of the
          thing actually being exposed. */}
      {pendingConnect !== null && pickedServer !== null && (
        <ConnectConfirmDialog
          client={pendingConnect.client}
          state={pendingConnect.state}
          serverName={candidateDisplayName(pickedServer)}
          confirmTarget={connectConfirmTarget(pickedServer.serverName, pickedServer.fileName)}
          // Looked up, never derived: main owns entryNameFor's slugging rules,
          // and an absent key means "not known" rather than a guess.
          entryName={entryNames[pickedServer.path] ?? null}
          busy={busy}
          onConfirm={() => void connect(pendingConnect, pickedServer)}
          // Back to the picker, not out of the flow: cancelling "are you sure"
          // usually means "wrong server", not "never mind".
          onCancel={() => setPickedServer(null)}
        />
      )}
    </div>
  );
}
