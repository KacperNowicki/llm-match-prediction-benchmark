export type Tournament = {
  id: string;
  name: string;
  league: string;
  season: number | null;
  stage: string | null;
  roundLabel: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  defaultBestOf: number;
  status: string;
  matchCount: number;
  completedCount: number;
};

export type Model = {
  id: string;
  name: string;
  displayName: string;
  isActive: boolean;
  sortOrder: number;
};

export type ModelStats = {
  modelId: string;
  totalPredictions: number;
  completedMatches: number;
  dataQualityIssueCount: number;
  wrongWinnerCount: number;
  exactMissCount: number;
  missingCompletedCount: number;
};

export type Match = {
  id: string;
  tournamentId: string;
  matchOrder: number;
  externalMatchId: string | null;
  dateTimeUtc: string | null;
  stage: string | null;
  roundLabel: string | null;
  bestOf: number;
  team1: string;
  team2: string;
  actualWinner: string | null;
  actualScore: string | null;
  actualSource: string | null;
  manualOverride: boolean;
  predictionCount?: number;
};

export type ParsedPrediction = {
  matchId: string | null;
  matchOrder: number | null;
  tournamentId?: string;
  tournamentName?: string;
  league?: string;
  team1?: string;
  team2?: string;
  bestOf?: number;
  predictedWinner: string | null;
  predictedScore: string | null;
  rawLine: string;
  status: "valid" | "warning" | "error";
  messages: string[];
};

export type ParsedResult = {
  matchId: string | null;
  matchOrder: number | null;
  actualWinner: string | null;
  actualScore: string | null;
  bestOf: number | null;
  rawLine: string;
  status: "valid" | "warning" | "error";
  messages: string[];
};

export type ScoreRow = {
  modelId: string;
  modelName: string;
  totalPoints: number;
  possiblePoints: number;
  winnerCorrect: number;
  exactCorrect: number;
  completedPredictions: number;
  winnerAccuracy: number;
  exactAccuracy: number;
};

export type PredictionCellOutcome = "missing" | "pending" | "exact" | "score-miss" | "wrong-winner";

export type MatchPredictionCell = {
  modelId: string;
  modelName: string;
  isDerived?: boolean;
  predictedWinner: string | null;
  predictedScore: string | null;
  rawLine: string | null;
  parseStatus: string | null;
  outcome: PredictionCellOutcome;
};

export type MatchPredictionRow = {
  match: Match;
  predictions: MatchPredictionCell[];
};

export type PromptScope = "upcoming" | "next7" | "leagueWeek" | "custom";
export type PredictionTargetScope = "nextMissing" | "upcoming" | "all";
export type MatchUpdate = Partial<{
  matchOrder: number;
  externalMatchId: string;
  dateTimeUtc: string;
  stage: string;
  roundLabel: string;
  bestOf: number;
  team1: string;
  team2: string;
  actualWinner: string;
  actualScore: string;
}>;

export type ImportSummary = {
  source: string;
  tournamentsImported: number;
  matchesImported: number;
  predictionsImported: number;
  modelsCreated: number;
  skippedManualResults: number;
  messages: string[];
};

export type LeaguepediaDiff = {
  key: string;
  action: "create" | "update" | "unchanged";
  existingMatchId: string | null;
  incoming: {
    matchOrder: number;
    externalMatchId: string | null;
    leaguepediaMatchId: string | null;
    overviewPage: string | null;
    dateTimeUtc: string | null;
    stage: string | null;
    roundLabel: string | null;
    bestOf: number;
    team1: string;
    team2: string;
    actualWinner: string | null;
    actualScore: string | null;
  };
  changes: Array<{ field: string; before: string | number | null; after: string | number | null; protected?: boolean }>;
};

export type LeaguepediaTournamentOption = {
  name: string;
  overviewPage: string;
  dateStart: string | null;
  dateEnd: string | null;
  league: string | null;
  region: string | null;
  tournamentLevel: string | null;
  isOfficial: boolean;
  year: string | null;
};

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  bootstrap: () => requestJson<{ tournaments: Tournament[]; models: Model[]; modelStats: ModelStats[] }>("/api/bootstrap"),
  createTournament: (payload: Record<string, unknown>) =>
    requestJson<{ tournament: Tournament }>("/api/tournaments", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  searchLeaguepediaTournaments: (
    query: string,
    options: { year?: string; includeUnofficial?: boolean; limit?: number } = {}
  ) => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (options.year) params.set("year", options.year);
    if (options.includeUnofficial) params.set("includeUnofficial", "true");
    if (options.limit) params.set("limit", String(options.limit));
    return requestJson<{ tournaments: LeaguepediaTournamentOption[] }>(
      `/api/leaguepedia/tournaments?${params.toString()}`
    );
  },
  addLeaguepediaTournament: (option: LeaguepediaTournamentOption) =>
    requestJson<{ tournament: Tournament; schedule: { applied: number; skippedManualResults: number; message?: string } }>(
      "/api/leaguepedia/tournaments/add",
      { method: "POST", body: JSON.stringify({ option }) }
    ),
  getTournament: (id: string) =>
    requestJson<{ tournament: Tournament; matches: Match[]; scores: ScoreRow[]; predictionRows?: MatchPredictionRow[] }>(
      `/api/tournaments/${id}`
    ),
  getPredictionGrid: (id: string) =>
    requestJson<{ rows: MatchPredictionRow[] }>(`/api/tournaments/${id}/prediction-grid`),
  removeTournament: (id: string) =>
    requestJson<{ result: { removed: true; tournament: Tournament } }>(`/api/tournaments/${id}`, {
      method: "DELETE"
    }),
  createModel: (name: string) =>
    requestJson<{ model: Model }>("/api/models", { method: "POST", body: JSON.stringify({ name }) }),
  updateModel: (id: string, payload: Partial<Model>) =>
    requestJson<{ model: Model }>(`/api/models/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  reorderModels: (modelIds: string[]) =>
    requestJson<{ models: Model[] }>("/api/models/reorder", { method: "POST", body: JSON.stringify({ modelIds }) }),
  addMatch: (tournamentId: string, payload: Record<string, unknown>) =>
    requestJson<{ match: Match }>(`/api/tournaments/${tournamentId}/matches`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateMatch: (matchId: string, payload: MatchUpdate) =>
    requestJson<{ match: Match }>(`/api/matches/${matchId}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  pasteSchedule: (tournamentId: string, rawInput: string, defaultBestOf: number) =>
    requestJson<{ result: { imported: number; matches: Match[] } }>(`/api/tournaments/${tournamentId}/schedule/paste`, {
      method: "POST",
      body: JSON.stringify({ rawInput, defaultBestOf })
    }),
  getPrompt: (
    tournamentId: string,
    options: { scope?: PromptScope; from?: string; to?: string; includeTbd?: boolean; tournamentIds?: string[] } = {}
  ) => {
    const params = new URLSearchParams();
    if (options.scope) params.set("scope", options.scope);
    if (options.from) params.set("from", options.from);
    if (options.to) params.set("to", options.to);
    if (options.includeTbd !== undefined) params.set("includeTbd", String(options.includeTbd));
    if (options.tournamentIds?.length) params.set("tournamentIds", options.tournamentIds.join(","));
    const query = params.toString();
    return requestJson<{ prompt: string; range: { scope: string; start: string | null; end: string | null; matchCount: number; tournamentCount?: number } }>(
      `/api/tournaments/${tournamentId}/prompt${query ? `?${query}` : ""}`
    );
  },
  importLegacyTsv: (tournamentId: string, rawInput: string, defaultBestOf: number) =>
    requestJson<{ result: ImportSummary }>(`/api/tournaments/${tournamentId}/import/legacy-tsv`, {
      method: "POST",
      body: JSON.stringify({ rawInput, defaultBestOf })
    }),
  importWorkbook: (filename: string, base64: string) =>
    requestJson<{ result: ImportSummary }>("/api/import/workbook", {
      method: "POST",
      body: JSON.stringify({ filename, base64 })
    }),
  previewLeaguepedia: (
    tournamentId: string,
    payload: { overviewPage?: string; dateStart?: string; dateEnd?: string }
  ) =>
    requestJson<{ result: { changes: LeaguepediaDiff[]; fetched: number; queryHash: string } }>(
      `/api/tournaments/${tournamentId}/leaguepedia/preview`,
      { method: "POST", body: JSON.stringify(payload) }
    ),
  applyLeaguepedia: (tournamentId: string, changes: LeaguepediaDiff[], allowManualOverwrite: boolean) =>
    requestJson<{ result: { applied: number; skippedManualResults: number } }>(
      `/api/tournaments/${tournamentId}/leaguepedia/apply`,
      { method: "POST", body: JSON.stringify({ changes, allowManualOverwrite }) }
    ),
  parsePredictions: (tournamentId: string, rawInput: string, modelId: string, targetScope: PredictionTargetScope, leagueBlob = false) =>
    requestJson<{ rows: ParsedPrediction[] }>(`/api/tournaments/${tournamentId}/predictions/parse`, {
      method: "POST",
      body: JSON.stringify({ rawInput, modelId, targetScope, leagueBlob })
    }),
  savePredictions: (tournamentId: string, modelId: string, rawInput: string, rows: ParsedPrediction[]) =>
    requestJson<{ result: { saved: number } }>(`/api/tournaments/${tournamentId}/predictions/save`, {
      method: "POST",
      body: JSON.stringify({ modelId, rawInput, rows })
    }),
  updatePredictionCell: (matchId: string, modelId: string, rawValue: string) =>
    requestJson<{ result: { saved: true } }>(`/api/matches/${matchId}/predictions/${modelId}`, {
      method: "PATCH",
      body: JSON.stringify({ rawValue })
    }),
  parseResults: (tournamentId: string, rawInput: string) =>
    requestJson<{ rows: ParsedResult[] }>(`/api/tournaments/${tournamentId}/results/parse`, {
      method: "POST",
      body: JSON.stringify({ rawInput })
    }),
  saveResults: (tournamentId: string, rows: ParsedResult[]) =>
    requestJson<{ result: { saved: number } }>(`/api/tournaments/${tournamentId}/results/save`, {
      method: "POST",
      body: JSON.stringify({ rows })
    }),
  getExport: async (tournamentId: string, mode: "legacy" | "extended") => {
    const response = await fetch(`/api/tournaments/${tournamentId}/export?mode=${mode}`);
    if (!response.ok) throw new Error("Export failed.");
    return response.text();
  },
  getTweet: (tournamentId: string, type = "leaderboard", tournamentIds: string[] = [tournamentId]) => {
    const params = new URLSearchParams();
    params.set("type", type);
    if (tournamentIds.length) params.set("tournamentIds", tournamentIds.join(","));
    return requestJson<{ draft: string }>(`/api/tournaments/${tournamentId}/tweet?${params.toString()}`);
  }
};
