import type { AppDatabase } from "../db/connection";
import { CONSENSUS_MODEL_ID, CONSENSUS_MODEL_NAME } from "../lib/modelNames";
import { sameTeam } from "../lib/teamAliases";
import { listModelsFromDb } from "./models";
import type { Match } from "./types";

export type ConsensusPrediction = {
  modelId: string;
  modelName: string;
  isDerived: true;
  predictedWinner: string | null;
  predictedScore: string | null;
  rawLine: string | null;
  parseStatus: string | null;
};

type PredictionRow = {
  matchId: string;
  modelId: string;
  predictedWinner: string;
  predictedScore: string;
};

function addWeighted(tally: Map<string, { label: string; weight: number; count: number }>, key: string, label: string, weight: number): void {
  const existing = tally.get(key);
  if (existing) {
    existing.weight += weight;
    existing.count += 1;
  } else {
    tally.set(key, { label, weight, count: 1 });
  }
}

function pickWinner(tally: Map<string, { label: string; weight: number; count: number }>): string | null {
  return [...tally.values()].sort((a, b) => b.weight - a.weight || b.count - a.count || a.label.localeCompare(b.label))[0]?.label ?? null;
}

function scorePrediction(prediction: PredictionRow, match: Match): number {
  if (!match.actualWinner || !match.actualScore) return 0;
  const winnerPoint = sameTeam(prediction.predictedWinner, match.actualWinner) ? 1 : 0;
  const scorePoint = winnerPoint && prediction.predictedScore === match.actualScore ? 1 : 0;
  return winnerPoint + scorePoint;
}

function predictionKey(match: Match, predictedWinner: string): string {
  if (sameTeam(predictedWinner, match.team1)) return match.team1;
  if (sameTeam(predictedWinner, match.team2)) return match.team2;
  return predictedWinner;
}

export function getConsensusPredictionsForMatchesFromDb(
  db: AppDatabase,
  tournamentId: string,
  matches: Match[]
): Map<string, ConsensusPrediction> {
  const models = listModelsFromDb(db, false);
  const modelIds = new Set(models.map((model) => model.id));
  const predictionRows = db
    .prepare(
      `SELECT p.match_id, p.model_id, p.predicted_winner, p.predicted_score
       FROM model_predictions p
       JOIN matches m ON m.id = p.match_id
       WHERE m.tournament_id = ?`
    )
    .all(tournamentId) as Array<Record<string, unknown>>;
  const predictions = predictionRows
    .filter((row) => modelIds.has(String(row.model_id)))
    .map((row): PredictionRow => ({
      matchId: String(row.match_id),
      modelId: String(row.model_id),
      predictedWinner: String(row.predicted_winner),
      predictedScore: String(row.predicted_score)
    }));

  const matchById = new Map(matches.map((match) => [match.id, match]));
  const weights = new Map(models.map((model) => [model.id, 0]));
  for (const prediction of predictions) {
    const match = matchById.get(prediction.matchId);
    if (!match) continue;
    weights.set(prediction.modelId, (weights.get(prediction.modelId) ?? 0) + scorePrediction(prediction, match));
  }
  if ([...weights.values()].every((weight) => weight === 0)) {
    models.forEach((model) => weights.set(model.id, 1));
  }

  const byMatch = new Map<string, PredictionRow[]>();
  for (const prediction of predictions) {
    byMatch.set(prediction.matchId, [...(byMatch.get(prediction.matchId) ?? []), prediction]);
  }

  const consensus = new Map<string, ConsensusPrediction>();
  for (const match of matches) {
    const rows = byMatch.get(match.id) ?? [];
    const winnerTally = new Map<string, { label: string; weight: number; count: number }>();
    for (const row of rows) {
      const winner = predictionKey(match, row.predictedWinner);
      addWeighted(winnerTally, winner.toLowerCase(), winner, weights.get(row.modelId) ?? 0);
    }
    const predictedWinner = pickWinner(winnerTally);
    const scoreTally = new Map<string, { label: string; weight: number; count: number }>();
    if (predictedWinner) {
      for (const row of rows.filter((candidate) => sameTeam(candidate.predictedWinner, predictedWinner))) {
        addWeighted(scoreTally, row.predictedScore, row.predictedScore, weights.get(row.modelId) ?? 0);
      }
    }
    const predictedScore = pickWinner(scoreTally);
    consensus.set(match.id, {
      modelId: CONSENSUS_MODEL_ID,
      modelName: CONSENSUS_MODEL_NAME,
      isDerived: true,
      predictedWinner,
      predictedScore,
      rawLine: predictedWinner && predictedScore ? `${predictedWinner} ${predictedScore}` : null,
      parseStatus: predictedWinner && predictedScore ? "derived" : null
    });
  }

  return consensus;
}
