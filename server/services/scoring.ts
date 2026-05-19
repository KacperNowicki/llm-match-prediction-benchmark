import { getDb, type AppDatabase } from "../db/connection";
import { CONSENSUS_MODEL_ID, CONSENSUS_MODEL_NAME } from "../lib/modelNames";
import { sameTeam } from "../lib/teamAliases";
import { getConsensusPredictionsForMatchesFromDb } from "./consensus";
import { mapMatch, mapScoreRow } from "./mappers";
import type { ScoreRow } from "./types";

export function getTournamentScoresFromDb(db: AppDatabase, tournamentId: string): ScoreRow[] {
  const realRows = db
    .prepare(
      `SELECT
        mo.id AS model_id,
        mo.display_name AS model_name,
        COALESCE(SUM(
          CASE
            WHEN m.id IS NOT NULL AND p.id IS NOT NULL
              THEN CASE WHEN p.predicted_winner = m.actual_winner THEN 1 ELSE 0 END
            ELSE 0
          END
        ), 0) AS winner_correct,
        COALESCE(SUM(
          CASE
            WHEN m.id IS NOT NULL AND p.id IS NOT NULL
              THEN CASE WHEN p.predicted_winner = m.actual_winner AND p.predicted_score = m.actual_score THEN 1 ELSE 0 END
            ELSE 0
          END
        ), 0) AS exact_correct,
        COALESCE(SUM(
          CASE
            WHEN m.id IS NOT NULL AND p.id IS NOT NULL
              THEN CASE WHEN p.predicted_winner = m.actual_winner THEN 1 ELSE 0 END
                   + CASE WHEN p.predicted_winner = m.actual_winner AND p.predicted_score = m.actual_score THEN 1 ELSE 0 END
            ELSE 0
          END
        ), 0) AS total_points,
        COALESCE(SUM(
          CASE
            WHEN m.id IS NOT NULL THEN 2
            ELSE 0
          END
        ), 0) AS possible_points,
        COALESCE(SUM(
          CASE
            WHEN m.id IS NOT NULL THEN 1
            ELSE 0
          END
        ), 0) AS completed_predictions
       FROM models mo
       LEFT JOIN matches m ON m.tournament_id = ?
         AND m.actual_winner IS NOT NULL
         AND m.actual_score IS NOT NULL
       LEFT JOIN model_predictions p ON p.model_id = mo.id AND p.match_id = m.id
       WHERE mo.is_active = 1 AND lower(mo.name) <> 'consensus' AND lower(mo.display_name) <> 'consensus'
       GROUP BY mo.id
       ORDER BY total_points DESC, exact_correct DESC, winner_correct DESC, mo.sort_order ASC`
    )
    .all(tournamentId)
    .map((row) => mapScoreRow(row as Record<string, unknown>));
  const matches = db
    .prepare("SELECT * FROM matches WHERE tournament_id = ? ORDER BY match_order ASC")
    .all(tournamentId)
    .map((row) => mapMatch(row as Record<string, unknown>));
  const consensus = getConsensusPredictionsForMatchesFromDb(db, tournamentId, matches);
  const completed = matches.filter((match) => match.actualWinner && match.actualScore);
  let winnerCorrect = 0;
  let exactCorrect = 0;
  for (const match of completed) {
    const prediction = consensus.get(match.id);
    if (!prediction?.predictedWinner || !prediction.predictedScore || !match.actualWinner || !match.actualScore) continue;
    const winnerPoint = sameTeam(prediction.predictedWinner, match.actualWinner) ? 1 : 0;
    winnerCorrect += winnerPoint;
    if (winnerPoint && prediction.predictedScore === match.actualScore) exactCorrect += 1;
  }
  const consensusRow: ScoreRow = {
    modelId: CONSENSUS_MODEL_ID,
    modelName: CONSENSUS_MODEL_NAME,
    totalPoints: winnerCorrect + exactCorrect,
    possiblePoints: completed.length * 2,
    winnerCorrect,
    exactCorrect,
    completedPredictions: completed.length,
    winnerAccuracy: completed.length ? winnerCorrect / completed.length : 0,
    exactAccuracy: completed.length ? exactCorrect / completed.length : 0
  };
  return [...realRows, consensusRow].sort(
    (a, b) => b.totalPoints - a.totalPoints || b.exactCorrect - a.exactCorrect || b.winnerCorrect - a.winnerCorrect
  );
}

export function getTournamentScores(tournamentId: string): ScoreRow[] {
  return getTournamentScoresFromDb(getDb(), tournamentId);
}
