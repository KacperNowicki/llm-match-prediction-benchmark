import type { Match, Model, ScoreRow, Tournament } from "./types";

type Row = Record<string, unknown>;

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

export function mapTournament(row: Row): Tournament {
  return {
    id: String(row.id),
    name: String(row.name),
    league: String(row.league),
    season: numberOrNull(row.season),
    stage: textOrNull(row.stage),
    roundLabel: textOrNull(row.round_label),
    dateStart: textOrNull(row.date_start),
    dateEnd: textOrNull(row.date_end),
    defaultBestOf: Number(row.default_best_of ?? 3),
    leaguepediaOverviewPage: textOrNull(row.leaguepedia_overview_page),
    status: String(row.status ?? "active"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    matchCount: Number(row.match_count ?? 0),
    completedCount: Number(row.completed_count ?? 0)
  };
}

export function mapModel(row: Row): Model {
  return {
    id: String(row.id),
    name: String(row.name),
    displayName: String(row.display_name),
    isActive: Number(row.is_active) === 1,
    sortOrder: Number(row.sort_order),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function mapMatch(row: Row): Match {
  return {
    id: String(row.id),
    tournamentId: String(row.tournament_id),
    matchOrder: Number(row.match_order),
    externalMatchId: textOrNull(row.external_match_id),
    dateTimeUtc: textOrNull(row.date_time_utc),
    stage: textOrNull(row.stage),
    roundLabel: textOrNull(row.round_label),
    bestOf: Number(row.best_of),
    team1: String(row.team1),
    team2: String(row.team2),
    actualWinner: textOrNull(row.actual_winner),
    actualScore: textOrNull(row.actual_score),
    actualSource: textOrNull(row.actual_source),
    manualOverride: Number(row.manual_override) === 1,
    predictionCount: row.prediction_count === undefined ? undefined : Number(row.prediction_count)
  };
}

export function mapScoreRow(row: Row): ScoreRow {
  const completedPredictions = Number(row.completed_predictions ?? 0);
  return {
    modelId: String(row.model_id),
    modelName: String(row.model_name),
    totalPoints: Number(row.total_points ?? 0),
    possiblePoints: Number(row.possible_points ?? 0),
    winnerCorrect: Number(row.winner_correct ?? 0),
    exactCorrect: Number(row.exact_correct ?? 0),
    completedPredictions,
    winnerAccuracy: completedPredictions ? Number(row.winner_correct ?? 0) / completedPredictions : 0,
    exactAccuracy: completedPredictions ? Number(row.exact_correct ?? 0) / completedPredictions : 0
  };
}

