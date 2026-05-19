import {
  ArrowDown,
  ArrowUp,
  CalendarRange,
  Check,
  CloudDownload,
  Clipboard,
  Eye,
  EyeOff,
  FileDown,
  FileSpreadsheet,
  ListPlus,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  Trophy,
  X
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  api,
  type ImportSummary,
  type LeaguepediaDiff,
  type LeaguepediaTournamentOption,
  type MatchUpdate,
  type MatchPredictionCell,
  type MatchPredictionRow,
  type Match,
  type Model,
  type ModelStats,
  type ParsedPrediction,
  type ParsedResult,
  type PromptScope,
  type ScoreRow,
  type Tournament
} from "./api";

type Tab = "overview" | "llms" | "schedule" | "prompt" | "predictions" | "results" | "scores" | "export" | "tweets";
type ToastTone = "working" | "success" | "error";

type ActionToast = {
  id: string;
  message: string;
  tone: ToastTone;
};

type Notify = (message: string, tone?: ToastTone) => void;

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "llms", label: "LLMs" },
  { id: "schedule", label: "Schedule" },
  { id: "prompt", label: "Prompt" },
  { id: "predictions", label: "Predictions" },
  { id: "results", label: "Results" },
  { id: "scores", label: "Scores" },
  { id: "export", label: "Export" },
  { id: "tweets", label: "Tweets" }
];

const emptyTournament = {
  name: "",
  league: "LCK",
  season: "2026",
  stage: "",
  roundLabel: "",
  dateStart: "",
  dateEnd: "",
  defaultBestOf: "3"
};

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function actualResultText(match: Match): string {
  if (match.actualWinner && match.actualScore) return `${match.actualWinner} ${match.actualScore}`;
  if (match.actualWinner) return `${match.actualWinner} (score missing)`;
  if (match.actualScore) return `Score ${match.actualScore} (winner missing)`;
  return "-";
}

function hasPartialActual(match: Match): boolean {
  return Boolean(match.actualWinner) !== Boolean(match.actualScore);
}

function splitWinnerScore(value: string): { actualWinner: string; actualScore: string } {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return { actualWinner: "", actualScore: "" };
  const match = trimmed.match(/^(.*?)\s+(\d+\s*-\s*\d+)$/);
  if (!match) throw new Error("Use Winner 2-0, or clear the cell.");
  return { actualWinner: match[1].trim(), actualScore: match[2].replace(/\s+/g, "") };
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

function summarizeImport(summary: ImportSummary | null): string {
  if (!summary) return "";
  return `${summary.tournamentsImported} tournaments, ${summary.matchesImported} matches, ${summary.predictionsImported} predictions, ${summary.modelsCreated} new LLMs`;
}

function compactActionLabel(label: string): string {
  return label.replace(/\.\.\.$/, "").trim();
}

export function App() {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [modelStats, setModelStats] = useState<ModelStats[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTournament, setSelectedTournament] = useState<Tournament | null>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [scores, setScores] = useState<ScoreRow[]>([]);
  const [predictionRows, setPredictionRows] = useState<MatchPredictionRow[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [status, setStatus] = useState("Loading workspace...");
  const [error, setError] = useState<string | null>(null);
  const [newTournament, setNewTournament] = useState(emptyTournament);
  const [newModelName, setNewModelName] = useState("");
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  const [removeModalOpen, setRemoveModalOpen] = useState(false);
  const [toasts, setToasts] = useState<ActionToast[]>([]);

  const activeModels = useMemo(() => models.filter((model) => model.isActive), [models]);
  const modelStatsById = useMemo(() => new Map(modelStats.map((stats) => [stats.modelId, stats])), [modelStats]);

  useEffect(() => {
    setModelDrafts((current) =>
      Object.fromEntries(models.map((model) => [model.id, current[model.id] ?? model.displayName]))
    );
  }, [models]);

  async function loadBootstrap() {
    const payload = await api.bootstrap();
    setTournaments(payload.tournaments);
    setModels(payload.models);
    setModelStats(payload.modelStats);
    if (!selectedId && payload.tournaments[0]) setSelectedId(payload.tournaments[0].id);
    setStatus("Ready");
  }

  async function loadTournament(id: string) {
    const payload = await api.getTournament(id);
    setSelectedTournament(payload.tournament);
    setMatches(payload.matches);
    setScores(payload.scores);
    setPredictionRows(payload.predictionRows ?? []);
  }

  function notify(message: string, tone: ToastTone = "success") {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((current) => [...current.slice(-3), { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, tone === "working" ? 2600 : 4400);
  }

  async function run(label: string, work: () => Promise<void>, options: { success?: string; toast?: boolean } = {}) {
    const showToast = options.toast !== false;
    setError(null);
    setStatus(label);
    if (showToast) notify(compactActionLabel(label), "working");
    try {
      await work();
      setStatus("Saved");
      if (showToast) notify(options.success ?? `Done: ${compactActionLabel(label)}`, "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatus("Needs attention");
      if (showToast) notify(message, "error");
    }
  }

  useEffect(() => {
    run("Loading workspace...", loadBootstrap, { toast: false });
  }, []);

  useEffect(() => {
    if (selectedId) {
      run("Loading tournament...", () => loadTournament(selectedId), { toast: false });
    } else {
      setSelectedTournament(null);
      setMatches([]);
      setScores([]);
      setPredictionRows([]);
    }
  }, [selectedId]);

  async function refreshAll() {
    await loadBootstrap();
    if (selectedId) await loadTournament(selectedId);
  }

  async function addTournament() {
    await run("Creating tournament...", async () => {
      const payload = await api.createTournament({
        ...newTournament,
        season: Number(newTournament.season) || null,
        defaultBestOf: Number(newTournament.defaultBestOf) || 3
      });
      const bootstrap = await api.bootstrap();
      setTournaments(bootstrap.tournaments);
      setModels(bootstrap.models);
      setModelStats(bootstrap.modelStats);
      setNewTournament(emptyTournament);
      setSelectedId(payload.tournament.id);
      setActiveTab("schedule");
      await loadTournament(payload.tournament.id);
    });
  }

  async function addModel() {
    await run("Adding LLM...", async () => {
      if (!newModelName.trim()) return;
      await api.createModel(newModelName);
      setNewModelName("");
      await refreshAll();
    });
  }

  async function toggleModel(model: Model) {
    await run("Updating LLM...", async () => {
      await api.updateModel(model.id, { isActive: !model.isActive });
      await refreshAll();
    });
  }

  async function renameModel(model: Model) {
    await run("Renaming LLM...", async () => {
      await api.updateModel(model.id, { displayName: modelDrafts[model.id] ?? model.displayName });
      await refreshAll();
    });
  }

  async function moveModel(model: Model, direction: -1 | 1) {
    await run("Reordering LLMs...", async () => {
      const index = models.findIndex((candidate) => candidate.id === model.id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= models.length) return;
      const next = [...models];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      const payload = await api.reorderModels(next.map((candidate) => candidate.id));
      setModels(payload.models);
    });
  }

  async function removeSelectedTournament() {
    if (!selectedTournament) return;
    const removedId = selectedTournament.id;
    await run("Removing tournament...", async () => {
      await api.removeTournament(removedId);
      const payload = await api.bootstrap();
      const nextTournament = payload.tournaments[0] ?? null;
      setTournaments(payload.tournaments);
      setModels(payload.models);
      setModelStats(payload.modelStats);
      setRemoveModalOpen(false);
      setActiveTab("overview");
      setSelectedId(nextTournament?.id ?? null);
      if (nextTournament) await loadTournament(nextTournament.id);
      else {
        setSelectedTournament(null);
        setMatches([]);
        setScores([]);
        setPredictionRows([]);
      }
    });
  }

  async function saveMatchEdit(matchId: string, payload: MatchUpdate) {
    await run("Updating match...", async () => {
      await api.updateMatch(matchId, payload);
      await refreshAll();
    });
  }

  async function savePredictionEdit(matchId: string, modelId: string, rawValue: string) {
    await run("Updating prediction...", async () => {
      await api.updatePredictionCell(matchId, modelId, rawValue);
      await refreshAll();
    });
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Trophy aria-hidden="true" />
          <div>
            <h1>LLM Match Prediction Benchmark</h1>
            <p>local esports benchmark console</p>
          </div>
        </div>

        <section className="panel tight">
          <div className="section-title">
            <h2>Tournaments</h2>
            <span>{tournaments.length}</span>
          </div>
          <div className="tournament-list">
            {tournaments.map((tournament) => (
              <button
                className={`tournament-card ${selectedId === tournament.id ? "active" : ""}`}
                key={tournament.id}
                aria-pressed={selectedId === tournament.id}
                onClick={() => {
                  setSelectedId(tournament.id);
                  notify(`Opened ${tournament.name}`);
                }}
              >
                <strong>{tournament.name}</strong>
                <span>
                  {tournament.league} | {tournament.matchCount} matches | {tournament.completedCount} done
                </span>
              </button>
            ))}
            {tournaments.length === 0 && <p className="empty">No tournaments yet.</p>}
          </div>
        </section>

        <section className="panel tight">
          <div className="section-title">
            <h2>Add Tournament</h2>
            <Plus aria-hidden="true" />
          </div>
          <LeaguepediaTournamentPicker
            onPick={async (option) => {
              await run("Adding Leaguepedia tournament...", async () => {
                const payload = await api.addLeaguepediaTournament(option);
                const bootstrap = await api.bootstrap();
                setTournaments(bootstrap.tournaments);
                setModels(bootstrap.models);
                setModelStats(bootstrap.modelStats);
                setSelectedId(payload.tournament.id);
                setActiveTab("schedule");
                await loadTournament(payload.tournament.id);
                const message = payload.schedule.message ?? `Added ${payload.schedule.applied} Leaguepedia matches`;
                setStatus(message);
              }, { toast: false });
            }}
            notify={notify}
          />
          <div className="form-grid single">
            <input aria-label="Tournament name" placeholder="Tournament name" value={newTournament.name} onChange={(event) => setNewTournament({ ...newTournament, name: event.target.value })} />
            <div className="split">
              <input aria-label="League" placeholder="League" value={newTournament.league} onChange={(event) => setNewTournament({ ...newTournament, league: event.target.value })} />
              <input aria-label="Season" placeholder="Season" value={newTournament.season} onChange={(event) => setNewTournament({ ...newTournament, season: event.target.value })} />
            </div>
            <div className="split">
              <input aria-label="Stage" placeholder="Stage" value={newTournament.stage} onChange={(event) => setNewTournament({ ...newTournament, stage: event.target.value })} />
              <input aria-label="Round label" placeholder="Round" value={newTournament.roundLabel} onChange={(event) => setNewTournament({ ...newTournament, roundLabel: event.target.value })} />
            </div>
            <select aria-label="Default best of" value={newTournament.defaultBestOf} onChange={(event) => setNewTournament({ ...newTournament, defaultBestOf: event.target.value })}>
              <option value="1">BO1</option>
              <option value="3">BO3</option>
              <option value="5">BO5</option>
            </select>
            <button className="primary" onClick={addTournament}>
              <Plus size={16} /> Add Tournament
            </button>
          </div>
        </section>

        <section className="panel tight">
          <div className="section-title">
            <h2>LLMs</h2>
            <span>{activeModels.length} active</span>
          </div>
          <div className="inline-form">
            <input aria-label="New LLM name" placeholder="Add LLM" value={newModelName} onChange={(event) => setNewModelName(event.target.value)} />
            <button aria-label="Add LLM" onClick={addModel}>
              <ListPlus size={16} />
            </button>
          </div>
          <div className="model-list">
            {models.map((model, index) => {
              const stats = modelStatsById.get(model.id);
              return (
                <div className={model.isActive ? "model-row" : "model-row muted"} key={model.id}>
                  <div className="model-editor">
                    <input
                      aria-label={`Rename ${model.displayName}`}
                      value={modelDrafts[model.id] ?? model.displayName}
                      onChange={(event) => setModelDrafts({ ...modelDrafts, [model.id]: event.target.value })}
                      onBlur={() => renameModel(model)}
                    />
                    <span className={stats?.dataQualityIssueCount ? "mistake-counter has-mistakes" : "mistake-counter"}>
                      mistakes {stats?.dataQualityIssueCount ?? 0} | missing {stats?.missingCompletedCount ?? 0}
                    </span>
                  </div>
                  <button aria-label={`Move ${model.displayName} up`} disabled={index === 0} onClick={() => moveModel(model, -1)}>
                    <ArrowUp size={15} />
                  </button>
                  <button aria-label={`Move ${model.displayName} down`} disabled={index === models.length - 1} onClick={() => moveModel(model, 1)}>
                    <ArrowDown size={15} />
                  </button>
                  <button aria-label={model.isActive ? `Hide ${model.displayName}` : `Show ${model.displayName}`} onClick={() => toggleModel(model)}>
                    {model.isActive ? <Eye size={15} /> : <EyeOff size={15} />}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Two-database local mode</p>
            <h2>{selectedTournament?.name ?? "Create a tournament to start"}</h2>
          </div>
          <div className="status-strip">
            <span className="safe"><ShieldCheck size={15} /> safety copy enforced</span>
            <span>{status}</span>
            {selectedTournament && (
              <button className="danger-button" aria-label="Remove tournament" onClick={() => {
                setRemoveModalOpen(true);
                notify("Confirm tournament removal");
              }}>
                <Trash2 size={16} />
              </button>
            )}
            <button aria-label="Refresh" onClick={() => run("Refreshing...", refreshAll)}>
              <RefreshCw size={16} />
            </button>
          </div>
        </header>

        {error && <div className="error">{error}</div>}

        {selectedTournament ? (
          <>
            <nav className="tabs" aria-label="Tournament sections">
              {tabs.map((tab) => (
                <button
                  className={activeTab === tab.id ? "active" : ""}
                  key={tab.id}
                  aria-current={activeTab === tab.id ? "page" : undefined}
                  aria-pressed={activeTab === tab.id}
                  onClick={() => {
                    setActiveTab(tab.id);
                    notify(`${tab.label} tab`);
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
            <div className="content">
              {activeTab === "overview" && (
                <Overview tournament={selectedTournament} matches={matches} scores={scores} models={activeModels} onMatchSave={saveMatchEdit} />
              )}
              {activeTab === "llms" && (
                <ModelPredictionMatrix rows={predictionRows} onMatchSave={saveMatchEdit} onPredictionSave={savePredictionEdit} />
              )}
              {activeTab === "schedule" && (
                <SchedulePanel tournament={selectedTournament} matches={matches} onChange={() => run("Refreshing schedule...", () => loadTournament(selectedTournament.id), { toast: false })} setStatus={setStatus} setError={setError} notify={notify} />
              )}
              {activeTab === "prompt" && <PromptPanel tournament={selectedTournament} tournaments={tournaments} matches={matches} notify={notify} />}
              {activeTab === "predictions" && (
                <PredictionsPanel tournament={selectedTournament} models={activeModels} onSaved={() => run("Refreshing scores...", () => loadTournament(selectedTournament.id), { toast: false })} notify={notify} />
              )}
              {activeTab === "results" && (
                <ResultsPanel tournament={selectedTournament} matches={matches} onSaved={() => run("Refreshing results...", () => loadTournament(selectedTournament.id), { toast: false })} notify={notify} />
              )}
              {activeTab === "scores" && <ScoresPanel scores={scores} />}
              {activeTab === "export" && <ExportPanel tournament={selectedTournament} notify={notify} />}
              {activeTab === "tweets" && <TweetsPanel tournament={selectedTournament} tournaments={tournaments} notify={notify} />}
            </div>
          </>
        ) : (
          <div className="panel hero-panel">
            <h2>No tournament selected</h2>
            <p>Add a tournament from the left rail. The workspace opens here.</p>
          </div>
        )}
      </section>
      {selectedTournament && removeModalOpen && (
        <ConfirmRemoveTournamentModal
          tournament={selectedTournament}
          onCancel={() => setRemoveModalOpen(false)}
          onConfirm={removeSelectedTournament}
        />
      )}
      <ActionToastStack toasts={toasts} />
    </main>
  );
}

function ActionToastStack({ toasts }: { toasts: ActionToast[] }) {
  return (
    <div className="action-toasts" role="status" aria-live="polite" aria-label="Action confirmations">
      {toasts.map((toast) => (
        <div className={`action-toast ${toast.tone}`} key={toast.id}>
          <span aria-hidden="true" />
          <strong>{toast.tone === "working" ? "Working" : toast.tone === "error" ? "Issue" : "Done"}</strong>
          <p>{toast.message}</p>
        </div>
      ))}
    </div>
  );
}

function ConfirmRemoveTournamentModal({
  tournament,
  onCancel,
  onConfirm
}: {
  tournament: Tournament;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="remove-tournament-title">
        <div className="modal-icon">
          <Trash2 aria-hidden="true" />
        </div>
        <h2 id="remove-tournament-title">Remove tournament?</h2>
        <p>
          {tournament.name} will be removed from the active tournament menu. Its matches and predictions stay in SQLite.
        </p>
        <div className="button-row flush right">
          <button onClick={onCancel}>Cancel</button>
          <button className="danger-button strong" onClick={onConfirm}>
            <Trash2 size={16} /> Remove Tournament
          </button>
        </div>
      </section>
    </div>
  );
}

function overviewPageFromInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/^\/wiki\/(.+)$/);
    if (match) return decodeURIComponent(match[1]).replace(/_/g, " ");
  } catch {
    // Plain OverviewPage input is fine.
  }
  return trimmed.replace(/^\/wiki\//, "").replace(/_/g, " ");
}

function optionFromOverviewInput(value: string): LeaguepediaTournamentOption | null {
  const overviewPage = overviewPageFromInput(value);
  if (!overviewPage) return null;
  const parts = overviewPage.split("/").filter(Boolean);
  const league = parts[0] ?? null;
  const year = overviewPage.match(/\b(20\d{2})\b/)?.[1] ?? null;
  const title = parts.at(-1)?.replace(/_/g, " ") ?? overviewPage;
  const name = [league, year, title].filter(Boolean).join(" ");
  return {
    name,
    overviewPage,
    dateStart: null,
    dateEnd: null,
    league,
    region: null,
    tournamentLevel: null,
    isOfficial: true,
    year
  };
}

function LeaguepediaTournamentPicker({
  onPick,
  notify
}: {
  onPick: (option: LeaguepediaTournamentOption) => Promise<void>;
  notify: Notify;
}) {
  const [query, setQuery] = useState("LCK");
  const [year, setYear] = useState("2026");
  const [directPage, setDirectPage] = useState("");
  const [results, setResults] = useState<LeaguepediaTournamentOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Search Leaguepedia tournaments.");

  async function search() {
    setBusy(true);
    setMessage("Searching Leaguepedia. Live requests may wait for the one-minute API cooldown.");
    notify("Searching Leaguepedia", "working");
    try {
      const payload = await api.searchLeaguepediaTournaments(query, { year, limit: 12 });
      setResults(payload.tournaments);
      setMessage(payload.tournaments.length ? `${payload.tournaments.length} found` : "No tournaments found.");
      notify(payload.tournaments.length ? `${payload.tournaments.length} Leaguepedia results` : "No Leaguepedia results");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMessage(message);
      notify(message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function addDirectPage() {
    const option = optionFromOverviewInput(directPage);
    if (!option) {
      setMessage("Paste a Leaguepedia page URL or OverviewPage.");
      notify("Paste a Leaguepedia page URL or OverviewPage.", "error");
      return;
    }
    await pick(option);
  }

  async function pick(option: LeaguepediaTournamentOption) {
    setBusy(true);
    setMessage(`Adding ${option.name}. Schedule import may wait for the Leaguepedia cooldown.`);
    notify(`Adding ${option.name}`, "working");
    try {
      await onPick(option);
      setMessage(`Added ${option.name}`);
      notify(`Added ${option.name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMessage(message);
      notify(message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="leaguepedia-picker">
      <div className="inline-form tournament-search">
        <input aria-label="Leaguepedia tournament search" placeholder="Search Leaguepedia" value={query} onChange={(event) => setQuery(event.target.value)} />
        <input aria-label="Leaguepedia season" placeholder="Year" value={year} onChange={(event) => setYear(event.target.value)} />
        <button aria-label="Search Leaguepedia tournaments" onClick={search} disabled={busy}>
          <Search size={16} />
        </button>
      </div>
      <div className="inline-form tournament-search">
        <input
          aria-label="Leaguepedia page URL"
          placeholder="Leaguepedia page or OverviewPage"
          value={directPage}
          onChange={(event) => setDirectPage(event.target.value)}
        />
        <button aria-label="Add Leaguepedia page" onClick={addDirectPage} disabled={busy}>
          <Plus size={16} />
        </button>
      </div>
      <p className="empty">{message}</p>
      {results.length > 0 && (
        <div className="leaguepedia-results">
          {results.map((option) => (
            <button
              className="leaguepedia-option"
              key={option.overviewPage}
              onClick={() => pick(option)}
              disabled={busy}
            >
              <strong>{option.name}</strong>
              <span>{option.dateStart ?? "?"} to {option.dateEnd ?? "?"}</span>
              <small>{option.league ?? option.region ?? "Leaguepedia"} | {option.overviewPage}</small>
            </button>
          ))}
        </div>
      )}
      <div className="manual-divider">manual fallback</div>
    </div>
  );
}

function Overview({
  tournament,
  matches,
  scores,
  models,
  onMatchSave
}: {
  tournament: Tournament;
  matches: Match[];
  scores: ScoreRow[];
  models: Model[];
  onMatchSave: (matchId: string, payload: MatchUpdate) => Promise<void>;
}) {
  const completed = matches.filter((match) => match.actualWinner && match.actualScore).length;
  const leader = scores.find((score) => score.completedPredictions > 0);
  return (
    <section className="overview-grid">
      <Metric label="Matches" value={String(matches.length)} detail={`${completed} with results`} />
      <Metric label="Active LLMs" value={String(models.length)} detail="normalized models table" />
      <Metric label="Default BO" value={`BO${tournament.defaultBestOf}`} detail={tournament.league} />
      <Metric label="Leader" value={leader?.modelName ?? "-"} detail={leader ? `${leader.totalPoints}/${leader.possiblePoints}` : "no scores yet"} />
      <div className="panel span">
        <h3>Current match list</h3>
        <MatchTable matches={matches} onMatchSave={onMatchSave} />
      </div>
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function toggleId(list: string[], id: string, checked: boolean): string[] {
  if (checked) return list.includes(id) ? list : [...list, id];
  return list.filter((item) => item !== id);
}

function TournamentChecklist({
  label,
  tournaments,
  selectedIds,
  onChange
}: {
  label: string;
  tournaments: Tournament[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="tournament-checklist">
      <legend>{label}</legend>
      <div>
        {tournaments.map((item) => (
          <label className="check" key={item.id}>
            <input
              type="checkbox"
              checked={selectedIds.includes(item.id)}
              onChange={(event) => onChange(toggleId(selectedIds, item.id, event.target.checked))}
            />
            {item.league} | {item.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function EditableCell({
  value,
  display,
  onSave
}: {
  value: string;
  display?: ReactNode;
  onSave: (value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  async function commit() {
    setSaveError(null);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!editing) {
    return (
      <button className="editable-cell" type="button" onClick={() => {
        setDraft(value);
        setEditing(true);
      }}>
        {display ?? (value || "-")}
      </button>
    );
  }

  return (
    <span className="inline-editor">
      <input
        aria-label="Editable cell value"
        value={draft}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setEditing(false);
          if (event.key === "Enter") void commit();
        }}
      />
      <button aria-label="Accept edit" type="button" onClick={commit}>
        <Check size={14} />
      </button>
      <button aria-label="Cancel edit" type="button" onClick={() => {
        setDraft(value);
        setSaveError(null);
        setEditing(false);
      }}>
        <X size={14} />
      </button>
      {saveError && <span className="inline-editor-error">{saveError}</span>}
    </span>
  );
}

function TeamPairEditor({
  match,
  onMatchSave
}: {
  match: Match;
  onMatchSave: (matchId: string, payload: MatchUpdate) => Promise<void>;
}) {
  return (
    <span className="team-pair-editor">
      <EditableCell value={match.team1} onSave={(value) => onMatchSave(match.id, { team1: value })} />
      <span className="muted-text">vs</span>
      <EditableCell value={match.team2} onSave={(value) => onMatchSave(match.id, { team2: value })} />
    </span>
  );
}

function ModelPredictionMatrix({
  rows,
  onMatchSave,
  onPredictionSave
}: {
  rows: MatchPredictionRow[];
  onMatchSave: (matchId: string, payload: MatchUpdate) => Promise<void>;
  onPredictionSave: (matchId: string, modelId: string, rawValue: string) => Promise<void>;
}) {
  const cells = rows.flatMap((row) => row.predictions);
  const columns = rows[0]?.predictions.map((cell) => ({ modelId: cell.modelId, modelName: cell.modelName, isDerived: cell.isDerived })) ?? [];
  const wrong = cells.filter((cell) => cell.outcome === "wrong-winner").length;
  const scoreMiss = cells.filter((cell) => cell.outcome === "score-miss").length;
  const missing = cells.filter((cell) => cell.outcome === "missing").length;

  if (!rows.length) return <p className="empty">No matches to review yet.</p>;

  return (
    <section className="panel">
      <div className="section-title">
        <h3>LLM Match Predictions</h3>
        <span>{rows.length} matches</span>
      </div>
      <div className="matrix-summary" aria-label="Prediction review summary">
        <span className="prediction-pill wrong-winner">wrong winners {wrong}</span>
        <span className="prediction-pill score-miss">score misses {scoreMiss}</span>
        <span className="prediction-pill missing">missing {missing}</span>
      </div>
      <div className="table-wrap prediction-matrix">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Match</th>
              <th>Actual</th>
              {columns.map((column) => (
                <th key={column.modelId}>{column.modelName}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const cellsByModel = new Map(row.predictions.map((cell) => [cell.modelId, cell]));
              return (
                <tr key={row.match.id}>
                  <td>
                    <EditableCell
                      value={String(row.match.matchOrder)}
                      onSave={(value) => onMatchSave(row.match.id, { matchOrder: Number(value) })}
                    />
                  </td>
                  <td>
                    <TeamPairEditor match={row.match} onMatchSave={onMatchSave} />
                    <small>{row.match.roundLabel ?? row.match.stage ?? `BO${row.match.bestOf}`}</small>
                  </td>
                  <td className={hasPartialActual(row.match) ? "actual-warning" : undefined}>
                    <EditableCell
                      value={row.match.actualWinner && row.match.actualScore ? `${row.match.actualWinner} ${row.match.actualScore}` : ""}
                      display={actualResultText(row.match)}
                      onSave={(value) => onMatchSave(row.match.id, splitWinnerScore(value))}
                    />
                  </td>
                  {columns.map((column) => (
                    <td key={`${row.match.id}-${column.modelId}`}>
                      <PredictionCell
                        cell={cellsByModel.get(column.modelId) ?? {
                          modelId: column.modelId,
                          modelName: column.modelName,
                          isDerived: column.isDerived,
                          predictedWinner: null,
                          predictedScore: null,
                          rawLine: null,
                          parseStatus: null,
                          outcome: "missing"
                        }}
                        onSave={column.isDerived ? undefined : (value) => onPredictionSave(row.match.id, column.modelId, value)}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PredictionCell({ cell, onSave }: { cell: MatchPredictionCell; onSave?: (value: string) => Promise<void> }) {
  const text = cell.predictedWinner && cell.predictedScore ? `${cell.predictedWinner} ${cell.predictedScore}` : "missing";
  const label =
    cell.outcome === "exact"
      ? "exact"
      : cell.outcome === "score-miss"
        ? "score off"
        : cell.outcome === "wrong-winner"
          ? "wrong"
          : cell.outcome === "pending"
            ? "pending"
            : "missing";

  return (
    onSave ? <EditableCell
      value={cell.predictedWinner && cell.predictedScore ? `${cell.predictedWinner} ${cell.predictedScore}` : ""}
      display={(
        <span className={`prediction-pill ${cell.outcome}`} title={cell.rawLine ?? label}>
          <strong>{text}</strong>
          <small>{label}</small>
        </span>
      )}
      onSave={onSave}
    /> : (
      <span className={`prediction-pill ${cell.outcome} derived`} title={cell.rawLine ?? label}>
        <strong>{text}</strong>
        <small>{label}</small>
      </span>
    )
  );
}

function SchedulePanel({
  tournament,
  matches,
  onChange,
  setError,
  setStatus,
  notify
}: {
  tournament: Tournament;
  matches: Match[];
  onChange: () => Promise<void>;
  setError: (value: string | null) => void;
  setStatus: (value: string) => void;
  notify: Notify;
}) {
  const [manual, setManual] = useState({ externalMatchId: "", stage: tournament.stage ?? "", roundLabel: tournament.roundLabel ?? "", bestOf: String(tournament.defaultBestOf), team1: "", team2: "" });
  const [rawSchedule, setRawSchedule] = useState("");

  async function execute(label: string, work: () => Promise<void>) {
    setError(null);
    setStatus(label);
    notify(compactActionLabel(label), "working");
    try {
      await work();
      setStatus("Saved");
      notify(`Done: ${compactActionLabel(label)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatus("Needs attention");
      notify(message, "error");
    }
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="section-title">
          <h3>Manual Match</h3>
          <Plus aria-hidden="true" />
        </div>
        <div className="form-grid six">
          <input aria-label="External match id" placeholder="Match ID" value={manual.externalMatchId} onChange={(event) => setManual({ ...manual, externalMatchId: event.target.value })} />
          <input aria-label="Match stage" placeholder="Stage" value={manual.stage} onChange={(event) => setManual({ ...manual, stage: event.target.value })} />
          <input aria-label="Match round" placeholder="Round" value={manual.roundLabel} onChange={(event) => setManual({ ...manual, roundLabel: event.target.value })} />
          <select aria-label="Match best of" value={manual.bestOf} onChange={(event) => setManual({ ...manual, bestOf: event.target.value })}>
            <option value="1">BO1</option>
            <option value="3">BO3</option>
            <option value="5">BO5</option>
          </select>
          <input aria-label="Team 1" placeholder="Team1" value={manual.team1} onChange={(event) => setManual({ ...manual, team1: event.target.value })} />
          <input aria-label="Team 2" placeholder="Team2" value={manual.team2} onChange={(event) => setManual({ ...manual, team2: event.target.value })} />
        </div>
        <button className="primary" onClick={() => execute("Adding match...", async () => {
          await api.addMatch(tournament.id, { ...manual, bestOf: Number(manual.bestOf) });
          setManual({ ...manual, externalMatchId: "", team1: "", team2: "" });
          await onChange();
        })}>
          <Plus size={16} /> Add Match
        </button>
      </section>

      <section className="panel">
        <div className="section-title">
          <h3>Paste Schedule</h3>
          <span>{matches.length} saved</span>
        </div>
        <textarea aria-label="Schedule TSV" value={rawSchedule} onChange={(event) => setRawSchedule(event.target.value)} />
        <button className="primary" onClick={() => execute("Importing schedule...", async () => {
          await api.pasteSchedule(tournament.id, rawSchedule, tournament.defaultBestOf);
          await onChange();
        })}>
          <Save size={16} /> Import / Update Schedule
        </button>
      </section>

      <LegacyImportPanel tournament={tournament} onImported={onChange} setStatus={setStatus} setError={setError} notify={notify} />
      <LeaguepediaPanel tournament={tournament} onApplied={onChange} setStatus={setStatus} setError={setError} notify={notify} />

      <section className="panel">
        <h3>Saved Schedule</h3>
        <MatchTable matches={matches} />
      </section>
    </div>
  );
}

function LegacyImportPanel({
  tournament,
  onImported,
  setError,
  setStatus,
  notify
}: {
  tournament: Tournament;
  onImported: () => Promise<void>;
  setError: (value: string | null) => void;
  setStatus: (value: string) => void;
  notify: Notify;
}) {
  const [rawInput, setRawInput] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  async function importRows() {
    setError(null);
    setStatus("Importing legacy sheet rows...");
    notify("Importing legacy sheet rows", "working");
    try {
      const payload = await api.importLegacyTsv(tournament.id, rawInput, tournament.defaultBestOf);
      setSummary(payload.result);
      await onImported();
      setStatus("Saved");
      notify(summarizeImport(payload.result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatus("Needs attention");
      notify(message, "error");
    }
  }

  return (
    <section className="panel">
      <div className="section-title">
        <h3>Legacy Sheet Import</h3>
        <span>schedule + results + model columns</span>
      </div>
      <textarea aria-label="Legacy TSV import" value={rawInput} onChange={(event) => setRawInput(event.target.value)} />
      <button className="primary" onClick={importRows}>
        <FileSpreadsheet size={16} /> Import Legacy TSV
      </button>
      {summary && <p className="empty">{summarizeImport(summary)}</p>}
    </section>
  );
}

function LeaguepediaPanel({
  tournament,
  onApplied,
  setError,
  setStatus,
  notify
}: {
  tournament: Tournament;
  onApplied: () => Promise<void>;
  setError: (value: string | null) => void;
  setStatus: (value: string) => void;
  notify: Notify;
}) {
  const [overviewPage, setOverviewPage] = useState(tournament.name);
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  const [allowManualOverwrite, setAllowManualOverwrite] = useState(false);
  const [diffs, setDiffs] = useState<LeaguepediaDiff[]>([]);
  const actionable = diffs.filter((diff) => diff.action !== "unchanged");

  async function preview() {
    setError(null);
    setStatus("Fetching Leaguepedia diff...");
    notify("Fetching Leaguepedia diff", "working");
    try {
      const payload = await api.previewLeaguepedia(tournament.id, { overviewPage, dateStart, dateEnd });
      setDiffs(payload.result.changes);
      setStatus(`Fetched ${payload.result.fetched} Leaguepedia rows`);
      notify(`Fetched ${payload.result.fetched} Leaguepedia rows`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatus("Needs attention");
      notify(message, "error");
    }
  }

  async function apply() {
    setError(null);
    setStatus("Applying Leaguepedia changes...");
    notify("Applying Leaguepedia changes", "working");
    try {
      await api.applyLeaguepedia(tournament.id, actionable, allowManualOverwrite);
      await onApplied();
      setStatus("Saved");
      notify(`Applied ${actionable.length} Leaguepedia changes`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatus("Needs attention");
      notify(message, "error");
    }
  }

  return (
    <section className="panel">
      <div className="section-title">
        <h3>Leaguepedia Review</h3>
        <CloudDownload aria-hidden="true" />
      </div>
      <div className="form-grid four">
        <input aria-label="Leaguepedia overview page" placeholder="OverviewPage" value={overviewPage} onChange={(event) => setOverviewPage(event.target.value)} />
        <input aria-label="Leaguepedia date start" type="date" value={dateStart} onChange={(event) => setDateStart(event.target.value)} />
        <input aria-label="Leaguepedia date end" type="date" value={dateEnd} onChange={(event) => setDateEnd(event.target.value)} />
        <label className="check">
          <input type="checkbox" checked={allowManualOverwrite} onChange={(event) => setAllowManualOverwrite(event.target.checked)} />
          overwrite manual results
        </label>
      </div>
      <div className="button-row">
        <button onClick={preview}>
          <RefreshCw size={16} /> Preview Diff
        </button>
        <button className="primary" disabled={actionable.length === 0} onClick={apply}>
          <Save size={16} /> Apply {actionable.length}
        </button>
      </div>
      {diffs.length > 0 && <LeaguepediaDiffTable diffs={diffs} />}
    </section>
  );
}

function LeaguepediaDiffTable({ diffs }: { diffs: LeaguepediaDiff[] }) {
  return (
    <div className="table-wrap compact-table">
      <table>
        <thead>
          <tr>
            <th>Action</th>
            <th>Match</th>
            <th>When</th>
            <th>Changes</th>
          </tr>
        </thead>
        <tbody>
          {diffs.map((diff) => (
            <tr key={diff.key} className={diff.action === "unchanged" ? "" : "warning"}>
              <td>{diff.action}</td>
              <td>{diff.incoming.team1} vs {diff.incoming.team2}</td>
              <td>{diff.incoming.dateTimeUtc ?? "-"}</td>
              <td>
                {diff.changes.length === 0
                  ? "-"
                  : diff.changes.map((change) => `${change.field}: ${change.before ?? "-"} -> ${change.after ?? "-"}${change.protected ? " (manual)" : ""}`).join("; ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PromptPanel({
  tournament,
  tournaments,
  matches,
  notify
}: {
  tournament: Tournament;
  tournaments: Tournament[];
  matches: Match[];
  notify: Notify;
}) {
  const [prompt, setPrompt] = useState("");
  const [copied, setCopied] = useState(false);
  const [scope, setScope] = useState<PromptScope>("upcoming");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [includeTbd, setIncludeTbd] = useState(false);
  const [selectedTournamentIds, setSelectedTournamentIds] = useState<string[]>([tournament.id]);
  const [matchCount, setMatchCount] = useState(matches.length);
  const [tournamentCount, setTournamentCount] = useState(1);

  useEffect(() => {
    setSelectedTournamentIds([tournament.id]);
  }, [tournament.id]);

  useEffect(() => {
    const ids = selectedTournamentIds.length > 0 ? selectedTournamentIds : [tournament.id];
    api
      .getPrompt(tournament.id, { scope, from, to, includeTbd, tournamentIds: ids })
      .then((payload) => {
        setPrompt(payload.prompt);
        setMatchCount(payload.range.matchCount);
        setTournamentCount(payload.range.tournamentCount ?? 1);
      })
      .catch((error) => setPrompt(error.message));
  }, [tournament.id, selectedTournamentIds, tournaments.length, matches.length, scope, from, to, includeTbd]);

  return (
    <section className="panel tall">
      <div className="section-title">
        <h3>Strict Prompt</h3>
        <button onClick={async () => { await copyText(prompt); setCopied(true); notify("Prompt copied"); }}>
          <Clipboard size={16} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="prompt-controls">
        <CalendarRange aria-hidden="true" />
        <select aria-label="Prompt date scope" value={scope} onChange={(event) => setScope(event.target.value as PromptScope)}>
          <option value="upcoming">All upcoming</option>
          <option value="next7">Next 7 days</option>
          <option value="leagueWeek">Tuesday-Monday week</option>
          <option value="custom">Custom range</option>
        </select>
        <input aria-label="Prompt from date" type="date" value={from} onChange={(event) => setFrom(event.target.value)} disabled={scope !== "custom"} />
        <input aria-label="Prompt to date" type="date" value={to} onChange={(event) => setTo(event.target.value)} disabled={scope !== "custom"} />
        <label className="check">
          <input type="checkbox" checked={includeTbd} onChange={(event) => setIncludeTbd(event.target.checked)} />
          include placeholders
        </label>
        <span className="muted-text">{matchCount} matches / {tournamentCount} tournaments</span>
      </div>
      <TournamentChecklist
        label="Prompt tournaments"
        tournaments={tournaments}
        selectedIds={selectedTournamentIds}
        onChange={setSelectedTournamentIds}
      />
      <textarea className="prompt-box" aria-label="Generated prompt" value={prompt} readOnly />
    </section>
  );
}

function PredictionsPanel({
  tournament,
  models,
  onSaved,
  notify
}: {
  tournament: Tournament;
  models: Model[];
  onSaved: () => Promise<void>;
  notify: Notify;
}) {
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const [rawInput, setRawInput] = useState("");
  const [rows, setRows] = useState<ParsedPrediction[]>([]);
  const [leagueBlob, setLeagueBlob] = useState(false);
  const hasErrors = rows.some((row) => row.status === "error");

  useEffect(() => {
    if (!modelId && models[0]) setModelId(models[0].id);
  }, [models, modelId]);

  return (
    <section className="panel tall">
      <div className="section-title">
        <h3>Prediction Paste Review</h3>
        <select aria-label="Prediction model" value={modelId} onChange={(event) => {
          setModelId(event.target.value);
          setRows([]);
        }}>
          {models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
        </select>
      </div>
      <textarea aria-label="Raw predictions" value={rawInput} onChange={(event) => setRawInput(event.target.value)} />
      <div className="button-row">
        <label className="check">
          <input type="checkbox" checked={leagueBlob} onChange={(event) => {
            setLeagueBlob(event.target.checked);
            setRows([]);
          }} />
          league-headed blob
        </label>
        <button disabled={!modelId} onClick={async () => {
          notify("Parsing predictions", "working");
          try {
            const payload = await api.parsePredictions(tournament.id, rawInput, modelId, "nextMissing", leagueBlob);
            setRows(payload.rows);
            notify(`Parsed ${payload.rows.length} predictions`);
          } catch (err) {
            notify(err instanceof Error ? err.message : String(err), "error");
          }
        }}>
          <RefreshCw size={16} /> Parse
        </button>
        <button className="primary" disabled={!rows.length || hasErrors || !modelId} onClick={async () => {
          notify("Saving reviewed predictions", "working");
          try {
            await api.savePredictions(tournament.id, modelId, rawInput, rows);
            await onSaved();
            notify(`Saved ${rows.length} reviewed predictions`);
          } catch (err) {
            notify(err instanceof Error ? err.message : String(err), "error");
          }
        }}>
          <Save size={16} /> Save Reviewed
        </button>
      </div>
      <ReviewTable rows={rows} />
    </section>
  );
}

function ResultsPanel({ tournament, matches, onSaved, notify }: { tournament: Tournament; matches: Match[]; onSaved: () => Promise<void>; notify: Notify }) {
  const [rawInput, setRawInput] = useState("");
  const [rows, setRows] = useState<ParsedResult[]>([]);
  const hasErrors = rows.some((row) => row.status === "error");

  return (
    <section className="panel tall">
      <div className="section-title">
        <h3>Actual Results</h3>
        <span>{matches.filter((match) => match.actualWinner && match.actualScore).length}/{matches.length}</span>
      </div>
      <textarea aria-label="Raw results" value={rawInput} onChange={(event) => setRawInput(event.target.value)} />
      <div className="button-row">
        <button onClick={async () => {
          notify("Parsing results", "working");
          try {
            const payload = await api.parseResults(tournament.id, rawInput);
            setRows(payload.rows);
            notify(`Parsed ${payload.rows.length} results`);
          } catch (err) {
            notify(err instanceof Error ? err.message : String(err), "error");
          }
        }}>
          <RefreshCw size={16} /> Parse
        </button>
        <button className="primary" disabled={!rows.length || hasErrors} onClick={async () => {
          notify("Saving results", "working");
          try {
            await api.saveResults(tournament.id, rows);
            await onSaved();
            notify(`Saved ${rows.length} results`);
          } catch (err) {
            notify(err instanceof Error ? err.message : String(err), "error");
          }
        }}>
          <Save size={16} /> Save Results
        </button>
      </div>
      <ResultReview rows={rows} />
      <MatchTable matches={matches} />
    </section>
  );
}

function ScoresPanel({ scores }: { scores: ScoreRow[] }) {
  return (
    <section className="panel">
      <h3>Scoring Dashboard</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>Entry</th>
              <th>Points</th>
              <th>Winner</th>
              <th>Exact</th>
              <th>Done</th>
            </tr>
          </thead>
          <tbody>
            {scores.map((row, index) => (
              <tr key={row.modelId}>
                <td>{index + 1}</td>
                <td>{row.modelName}</td>
                <td><strong>{row.totalPoints}/{row.possiblePoints}</strong></td>
                <td>{row.winnerCorrect} | {pct(row.winnerAccuracy)}</td>
                <td>{row.exactCorrect} | {pct(row.exactAccuracy)}</td>
                <td>{row.completedPredictions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ExportPanel({ tournament, notify }: { tournament: Tournament; notify: Notify }) {
  const [mode, setMode] = useState<"legacy" | "extended">("legacy");
  const [tsv, setTsv] = useState("");

  return (
    <section className="panel tall">
      <div className="section-title">
        <h3>TSV Export</h3>
        <select aria-label="Export mode" value={mode} onChange={(event) => setMode(event.target.value as "legacy" | "extended")}>
          <option value="legacy">Legacy default columns</option>
          <option value="extended">Extended active models</option>
        </select>
      </div>
      <div className="button-row">
        <button onClick={async () => {
          notify("Generating TSV", "working");
          try {
            const next = await api.getExport(tournament.id, mode);
            setTsv(next);
            notify("TSV generated");
          } catch (err) {
            notify(err instanceof Error ? err.message : String(err), "error");
          }
        }}>
          <FileDown size={16} /> Generate TSV
        </button>
        <button disabled={!tsv} onClick={async () => { await copyText(tsv); notify("TSV copied"); }}>
          <Clipboard size={16} /> Copy TSV
        </button>
      </div>
      <textarea className="export-box" aria-label="TSV export" value={tsv} readOnly />
    </section>
  );
}

function TweetsPanel({ tournament, tournaments, notify }: { tournament: Tournament; tournaments: Tournament[]; notify: Notify }) {
  const [draft, setDraft] = useState("");
  const [type, setType] = useState("preweek");
  const [selectedTournamentIds, setSelectedTournamentIds] = useState<string[]>([tournament.id]);

  useEffect(() => {
    setSelectedTournamentIds([tournament.id]);
  }, [tournament.id]);

  useEffect(() => {
    const ids = selectedTournamentIds.length > 0 ? selectedTournamentIds : [tournament.id];
    api.getTweet(tournament.id, type, ids).then((payload) => setDraft(payload.draft)).catch((error) => setDraft(error.message));
  }, [tournament.id, type, selectedTournamentIds]);

  return (
    <section className="panel tall">
      <div className="section-title">
        <h3>Editable Draft</h3>
        <div className="button-row flush">
          <select aria-label="Tweet draft type" value={type} onChange={(event) => setType(event.target.value)}>
            <option value="leaderboard">Leaderboard</option>
            <option value="preweek">Pre-week</option>
            <option value="recap">Post-week recap</option>
            <option value="league">League recap</option>
          </select>
          <button onClick={async () => { await copyText(draft); notify("Tweet draft copied"); }}>
            <Clipboard size={16} /> Copy
          </button>
        </div>
      </div>
      <TournamentChecklist
        label="Tweet tournaments"
        tournaments={tournaments}
        selectedIds={selectedTournamentIds}
        onChange={setSelectedTournamentIds}
      />
      <textarea aria-label="Tweet draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
    </section>
  );
}

function MatchTable({ matches, onMatchSave }: { matches: Match[]; onMatchSave?: (matchId: string, payload: MatchUpdate) => Promise<void> }) {
  const editable = Boolean(onMatchSave);
  const save = onMatchSave ?? (async () => undefined);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Match ID</th>
            <th>Stage</th>
            <th>Round</th>
            <th>BO</th>
            <th>Teams</th>
            <th>Actual</th>
            <th>Preds</th>
          </tr>
        </thead>
        <tbody>
          {matches.map((match) => (
            <tr key={match.id}>
              <td>{editable ? <EditableCell value={String(match.matchOrder)} onSave={(value) => save(match.id, { matchOrder: Number(value) })} /> : match.matchOrder}</td>
              <td>{editable ? <EditableCell value={match.externalMatchId ?? ""} display={match.externalMatchId ?? `M${match.matchOrder}`} onSave={(value) => save(match.id, { externalMatchId: value })} /> : match.externalMatchId ?? `M${match.matchOrder}`}</td>
              <td>{editable ? <EditableCell value={match.stage ?? ""} display={match.stage ?? "-"} onSave={(value) => save(match.id, { stage: value })} /> : match.stage ?? "-"}</td>
              <td>{editable ? <EditableCell value={match.roundLabel ?? ""} display={match.roundLabel ?? "-"} onSave={(value) => save(match.id, { roundLabel: value })} /> : match.roundLabel ?? "-"}</td>
              <td>{editable ? <EditableCell value={String(match.bestOf)} display={`BO${match.bestOf}`} onSave={(value) => save(match.id, { bestOf: Number(value) })} /> : `BO${match.bestOf}`}</td>
              <td>{editable ? <TeamPairEditor match={match} onMatchSave={save} /> : `${match.team1} vs ${match.team2}`}</td>
              <td className={hasPartialActual(match) ? "actual-warning" : undefined}>{editable ? <EditableCell value={match.actualWinner && match.actualScore ? `${match.actualWinner} ${match.actualScore}` : ""} display={actualResultText(match)} onSave={(value) => save(match.id, splitWinnerScore(value))} /> : actualResultText(match)}</td>
              <td>{match.predictionCount ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReviewTable({ rows }: { rows: ParsedPrediction[] }) {
  if (!rows.length) return <p className="empty">Parse pasted predictions to review normalized rows.</p>;
  const showTournament = rows.some((row) => row.tournamentName || row.league);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            {showTournament && <th>Tournament</th>}
            <th>Match</th>
            <th>Raw</th>
            <th>Winner</th>
            <th>Score</th>
            <th>BO</th>
            <th>Status</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.matchId ?? "error"}-${index}`} className={row.status}>
              <td>{row.matchOrder ?? "-"}</td>
              {showTournament && <td>{row.tournamentName ?? row.league ?? "-"}</td>}
              <td>{row.team1 && row.team2 ? `${row.team1} vs ${row.team2}` : "-"}</td>
              <td>{row.rawLine || "-"}</td>
              <td>{row.predictedWinner ?? "-"}</td>
              <td>{row.predictedScore ?? "-"}</td>
              <td>{row.bestOf ? `BO${row.bestOf}` : "-"}</td>
              <td>{row.status}</td>
              <td>{row.messages.join(" ") || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultReview({ rows }: { rows: ParsedResult[] }) {
  if (!rows.length) return <p className="empty">Parse result lines to review before saving.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Raw</th>
            <th>Winner</th>
            <th>Score</th>
            <th>Status</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.matchId ?? "error"}-${index}`} className={row.status}>
              <td>{row.matchOrder ?? "-"}</td>
              <td>{row.rawLine || "-"}</td>
              <td>{row.actualWinner ?? "-"}</td>
              <td>{row.actualScore ?? "-"}</td>
              <td>{row.bestOf ? `BO${row.bestOf}` : "-"}</td>
              <td>{row.status}</td>
              <td>{row.messages.join(" ") || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
