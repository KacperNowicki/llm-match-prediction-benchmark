import { getDb } from "../db/connection";
import { CONSENSUS_MODEL_ID, CONSENSUS_MODEL_NAME } from "../lib/modelNames";
import { sameTeam } from "../lib/teamAliases";
import { getConsensusPredictionsForMatchesFromDb } from "./consensus";
import { listModels } from "./models";
import { listMatchesFromDb } from "./matches";
import type { MatchPredictionCell, MatchPredictionRow, PredictionCellOutcome } from "./types";

function outcomeFor(
  predictedWinner: string | null,
  predictedScore: string | null,
  actualWinner: string | null,
  actualScore: string | null
): PredictionCellOutcome {
  if (!predictedWinner || !predictedScore) return "missing";
  if (!actualWinner || !actualScore) return "pending";
  if (sameTeam(predictedWinner, actualWinner) && predictedScore === actualScore) return "exact";
  if (sameTeam(predictedWinner, actualWinner)) return "score-miss";
  return "wrong-winner";
}

export function getPredictionGrid(tournamentId: string): MatchPredictionRow[] {
  const db = getDb();
  const models = listModels(false);
  const matches = listMatchesFromDb(db, tournamentId);
  const predictionRows = db
    .prepare(
      `SELECT p.*
       FROM model_predictions p
       JOIN matches m ON m.id = p.match_id
       WHERE m.tournament_id = ?`
    )
    .all(tournamentId) as Array<Record<string, unknown>>;
  const byMatchModel = new Map<string, Record<string, unknown>>();
  predictionRows.forEach((row) => byMatchModel.set(`${row.match_id}:${row.model_id}`, row));

  const consensusByMatch = getConsensusPredictionsForMatchesFromDb(db, tournamentId, matches);

  return matches.map((match) => {
    const realPredictions = models.map((model): MatchPredictionCell => {
      const row = byMatchModel.get(`${match.id}:${model.id}`);
      const predictedWinner = row?.predicted_winner ? String(row.predicted_winner) : null;
      const predictedScore = row?.predicted_score ? String(row.predicted_score) : null;
      return {
        modelId: model.id,
        modelName: model.displayName,
        predictedWinner,
        predictedScore,
        rawLine: row?.raw_line ? String(row.raw_line) : null,
        parseStatus: row?.parse_status ? String(row.parse_status) : null,
        outcome: outcomeFor(predictedWinner, predictedScore, match.actualWinner, match.actualScore)
      };
    });
    const consensus = consensusByMatch.get(match.id);
    return {
      match,
      predictions: [
        ...realPredictions,
        {
          modelId: consensus?.modelId ?? CONSENSUS_MODEL_ID,
          modelName: consensus?.modelName ?? CONSENSUS_MODEL_NAME,
          isDerived: true,
          predictedWinner: consensus?.predictedWinner ?? null,
          predictedScore: consensus?.predictedScore ?? null,
          rawLine: consensus?.rawLine ?? null,
          parseStatus: consensus?.parseStatus ?? null,
          outcome: outcomeFor(consensus?.predictedWinner ?? null, consensus?.predictedScore ?? null, match.actualWinner, match.actualScore)
        }
      ]
    };
  });
}
