import { legacyModelColumns } from "../config";
import { getDb } from "../db/connection";
import { CONSENSUS_MODEL_NAME } from "../lib/modelNames";
import { getConsensusPredictionsForMatchesFromDb } from "./consensus";
import { mapMatch, mapModel } from "./mappers";
import type { Model } from "./types";

type ExportMode = "legacy" | "extended";

function cell(value: unknown): string {
  const text = String(value ?? "");
  return text.replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

export function exportTournamentTsv(tournamentId: string, mode: ExportMode = "legacy"): string {
  const db = getDb();
  const matches = db
    .prepare("SELECT * FROM matches WHERE tournament_id = ? ORDER BY match_order ASC")
    .all(tournamentId) as Array<Record<string, unknown>>;
  const mappedMatches = matches.map((row) => mapMatch(row));
  const consensus = getConsensusPredictionsForMatchesFromDb(db, tournamentId, mappedMatches);

  const allModels = db
    .prepare("SELECT * FROM models WHERE is_active = 1 AND lower(name) <> 'consensus' AND lower(display_name) <> 'consensus' ORDER BY sort_order ASC, display_name ASC")
    .all()
    .map((row) => mapModel(row as Record<string, unknown>));

  const models =
    mode === "legacy"
      ? legacyModelColumns.map((name) =>
          allModels.find((model) => model.name === name || model.displayName === name)
        ).filter((model): model is Model => Boolean(model))
      : allModels;

  const predictionRows = db
    .prepare(
      `SELECT p.match_id, p.model_id, p.predicted_winner, p.predicted_score
       FROM model_predictions p
       JOIN matches m ON m.id = p.match_id
       WHERE m.tournament_id = ?`
    )
    .all(tournamentId) as Array<Record<string, unknown>>;

  const predictionMap = new Map<string, string>();
  for (const prediction of predictionRows) {
    predictionMap.set(
      `${prediction.match_id}:${prediction.model_id}`,
      `${prediction.predicted_winner} ${prediction.predicted_score}`
    );
  }

  const header = [
    "Match ID",
    "Stage",
    "Round",
    "BO",
    "Team1",
    "Team2",
    "Actual Winner",
    "Actual Score",
    CONSENSUS_MODEL_NAME,
    ...models.map((model) => model.displayName)
  ];

  const lines = [
    header.join("\t"),
    ...matches.map((match) => {
      const consensusPrediction = consensus.get(String(match.id));
      return [
        match.external_match_id || `M${match.match_order}`,
        match.stage,
        match.round_label,
        match.best_of,
        match.team1,
        match.team2,
        match.actual_winner,
        match.actual_score,
        consensusPrediction?.predictedWinner && consensusPrediction.predictedScore
          ? `${consensusPrediction.predictedWinner} ${consensusPrediction.predictedScore}`
          : "",
        ...models.map((model) => predictionMap.get(`${match.id}:${model.id}`) ?? "")
      ]
        .map(cell)
        .join("\t");
    })
  ];

  return lines.join("\n");
}
