import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openDatabase } from "../server/db/connection";
import { sameTeam } from "../server/lib/teamAliases";
import { listModelsFromDb } from "../server/services/models";

type PredictionExport = {
  generatedAt: string;
  summary: {
    tournaments: number;
    matches: number;
    completedMatches: number;
    predictions: number;
  };
  models: string[];
  tournaments: Array<{
    league: string;
    name: string;
    matchCount: number;
    completedCount: number;
    predictionCount: number;
    matches: Array<{
      matchOrder: number;
      dateTimeUtc: string | null;
      stage: string | null;
      round: string | null;
      bestOf: number;
      team1: string;
      team2: string;
      actual: string | null;
      status: "completed" | "pending";
      predictions: Array<{
        model: string;
        pick: string | null;
        outcome: "exact" | "score-miss" | "wrong-winner" | "pending" | "missing";
      }>;
    }>;
  }>;
};

function pickOutcome(
  winner: string | null,
  score: string | null,
  actualWinner: string | null,
  actualScore: string | null
): "exact" | "score-miss" | "wrong-winner" | "pending" | "missing" {
  if (!winner || !score) return "missing";
  if (!actualWinner || !actualScore) return "pending";
  if (sameTeam(winner, actualWinner) && score === actualScore) return "exact";
  if (sameTeam(winner, actualWinner)) return "score-miss";
  return "wrong-winner";
}

const db = openDatabase("data/predictions.sqlite");

try {
  const models = listModelsFromDb(db, false);
  const tournaments = db
    .prepare(
      `SELECT t.*,
              (SELECT COUNT(*) FROM matches m WHERE m.tournament_id = t.id) AS match_count,
              (SELECT COUNT(*) FROM matches m WHERE m.tournament_id = t.id AND m.actual_winner IS NOT NULL AND m.actual_score IS NOT NULL) AS completed_count,
              (SELECT COUNT(*)
               FROM model_predictions p
               JOIN matches m ON m.id = p.match_id
               WHERE m.tournament_id = t.id) AS prediction_count,
              (SELECT COUNT(*) FROM matches m WHERE m.tournament_id = t.id AND (m.actual_winner IS NULL OR m.actual_score IS NULL)) AS pending_count
       FROM tournaments t
       WHERE t.status = 'active'
       ORDER BY
         CASE
           WHEN (SELECT COUNT(*) FROM matches m WHERE m.tournament_id = t.id AND (m.actual_winner IS NULL OR m.actual_score IS NULL)) > 0
            AND (SELECT COUNT(*)
                 FROM model_predictions p
                 JOIN matches m ON m.id = p.match_id
                 WHERE m.tournament_id = t.id) > 0 THEN 0
           WHEN (SELECT COUNT(*) FROM matches m WHERE m.tournament_id = t.id AND (m.actual_winner IS NULL OR m.actual_score IS NULL)) > 0 THEN 1
           ELSE 2
         END,
         t.league ASC,
         t.name ASC`
    )
    .all() as Array<Record<string, unknown>>;

  const matchRows = db
    .prepare(
      `SELECT m.*, t.name AS tournament_name, t.league
       FROM matches m
       JOIN tournaments t ON t.id = m.tournament_id
       WHERE t.status = 'active'
       ORDER BY t.league ASC, t.name ASC, m.match_order ASC`
    )
    .all() as Array<Record<string, unknown>>;

  const predictionRows = db
    .prepare(
      `SELECT p.match_id, p.model_id, p.predicted_winner, p.predicted_score
       FROM model_predictions p
       JOIN matches m ON m.id = p.match_id
       JOIN tournaments t ON t.id = m.tournament_id
       WHERE t.status = 'active'`
    )
    .all() as Array<Record<string, unknown>>;

  const matchesByTournament = new Map<string, Array<Record<string, unknown>>>();
  for (const row of matchRows) {
    const tournamentId = String(row.tournament_id);
    matchesByTournament.set(tournamentId, [...(matchesByTournament.get(tournamentId) ?? []), row]);
  }

  const predictionsByMatchModel = new Map<string, Record<string, unknown>>();
  for (const row of predictionRows) {
    predictionsByMatchModel.set(`${row.match_id}:${row.model_id}`, row);
  }

  const payload: PredictionExport = {
    generatedAt: new Date().toISOString(),
    summary: {
      tournaments: tournaments.length,
      matches: matchRows.length,
      completedMatches: matchRows.filter((row) => row.actual_winner && row.actual_score).length,
      predictions: predictionRows.length
    },
    models: models.map((model) => model.displayName),
    tournaments: tournaments.map((tournament) => {
      const tournamentId = String(tournament.id);
      const rows = matchesByTournament.get(tournamentId) ?? [];
      return {
        league: String(tournament.league),
        name: String(tournament.name),
        matchCount: Number(tournament.match_count ?? 0),
        completedCount: Number(tournament.completed_count ?? 0),
        predictionCount: Number(tournament.prediction_count ?? 0),
        matches: rows.map((row) => {
          const actualWinner = row.actual_winner ? String(row.actual_winner) : null;
          const actualScore = row.actual_score ? String(row.actual_score) : null;
          return {
            matchOrder: Number(row.match_order),
            dateTimeUtc: row.date_time_utc ? String(row.date_time_utc) : null,
            stage: row.stage ? String(row.stage) : null,
            round: row.round_label ? String(row.round_label) : null,
            bestOf: Number(row.best_of),
            team1: String(row.team1),
            team2: String(row.team2),
            actual: actualWinner && actualScore ? `${actualWinner} ${actualScore}` : null,
            status: actualWinner && actualScore ? "completed" : "pending",
            predictions: models.map((model) => {
              const prediction = predictionsByMatchModel.get(`${row.id}:${model.id}`);
              const winner = prediction?.predicted_winner ? String(prediction.predicted_winner) : null;
              const score = prediction?.predicted_score ? String(prediction.predicted_score) : null;
              return {
                model: model.displayName,
                pick: winner && score ? `${winner} ${score}` : null,
                outcome: pickOutcome(winner, score, actualWinner, actualScore)
              };
            })
          };
        })
      };
    })
  };

  const outputPath = path.join("docs", "predictions.json");
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Exported ${payload.summary.predictions} predictions across ${payload.summary.matches} matches to ${outputPath}.`);
} finally {
  db.close();
}
