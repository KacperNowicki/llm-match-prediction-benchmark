import { copyPrimaryToSafety } from "../db/safety";
import { getDb, withTransaction, type AppDatabase } from "../db/connection";
import { HttpError } from "../lib/httpError";
import { createId, nowIso, stableId } from "../lib/id";
import { isConsensusModelName } from "../lib/modelNames";
import { isValidScoreForBestOf } from "../lib/scoreValidation";
import { sameTeam } from "../lib/teamAliases";
import { writeAudit } from "./audit";
import { mapModel } from "./mappers";
import type { Model, ModelStats } from "./types";

export function listModelsFromDb(db: AppDatabase, includeHidden = true): Model[] {
  const consensusFilter = "lower(name) <> 'consensus' AND lower(display_name) <> 'consensus'";
  const where = includeHidden ? `WHERE ${consensusFilter}` : `WHERE is_active = 1 AND ${consensusFilter}`;
  return db
    .prepare(`SELECT * FROM models ${where} ORDER BY sort_order ASC, display_name ASC`)
    .all()
    .map((row) => mapModel(row as Record<string, unknown>));
}

export function listModels(includeHidden = true): Model[] {
  return listModelsFromDb(getDb(), includeHidden);
}

export function listModelStatsFromDb(db: AppDatabase, includeHidden = true): ModelStats[] {
  const models = listModelsFromDb(db, includeHidden);
  const completedRows = db
    .prepare(
      `SELECT m.id, m.tournament_id, m.actual_winner, m.actual_score
       FROM matches m
       JOIN tournaments t ON t.id = m.tournament_id
       WHERE t.status = 'active'
         AND m.actual_winner IS NOT NULL
         AND m.actual_score IS NOT NULL`
    )
    .all() as Array<Record<string, unknown>>;
  const predictionRows = db
    .prepare(
      `SELECT p.model_id, p.match_id, m.tournament_id, m.best_of, m.team1, m.team2,
              p.predicted_winner, p.predicted_score, p.parse_status
       FROM model_predictions p
       JOIN matches m ON m.id = p.match_id
       JOIN tournaments t ON t.id = m.tournament_id
       WHERE t.status = 'active'`
    )
    .all() as Array<Record<string, unknown>>;

  const completedById = new Map(completedRows.map((row) => [String(row.id), row]));
  const predictionsByModel = new Map<string, Array<Record<string, unknown>>>();
  for (const row of predictionRows) {
    const modelId = String(row.model_id);
    predictionsByModel.set(modelId, [...(predictionsByModel.get(modelId) ?? []), row]);
  }

  return models.map((model) => {
    const rows = predictionsByModel.get(model.id) ?? [];
    const participatedTournamentIds = new Set(rows.map((row) => String(row.tournament_id)));
    const eligibleCompletedRows = completedRows.filter((row) =>
      participatedTournamentIds.has(String(row.tournament_id))
    );
    let wrongWinnerCount = 0;
    let exactMissCount = 0;
    let dataQualityIssueCount = 0;
    let completedPredictionCount = 0;

    for (const row of rows) {
      const predictedWinner = String(row.predicted_winner);
      const predictedScore = String(row.predicted_score);
      const parseStatus = String(row.parse_status);
      const winnerMatchesScheduledTeam = sameTeam(predictedWinner, String(row.team1)) || sameTeam(predictedWinner, String(row.team2));
      if (
        !["valid", "warning"].includes(parseStatus) ||
        !winnerMatchesScheduledTeam ||
        !isValidScoreForBestOf(Number(row.best_of), predictedScore)
      ) {
        dataQualityIssueCount += 1;
      }

      const match = completedById.get(String(row.match_id));
      if (!match) continue;
      completedPredictionCount += 1;
      const actualWinner = String(match.actual_winner);
      const actualScore = String(match.actual_score);
      const winnerCorrect = sameTeam(predictedWinner, actualWinner);
      if (!winnerCorrect) wrongWinnerCount += 1;
      if (!winnerCorrect || predictedScore !== actualScore) exactMissCount += 1;
    }

    return {
      modelId: model.id,
      totalPredictions: rows.length,
      completedMatches: eligibleCompletedRows.length,
      dataQualityIssueCount,
      wrongWinnerCount,
      exactMissCount,
      missingCompletedCount: Math.max(0, eligibleCompletedRows.length - completedPredictionCount)
    };
  });
}

export function listModelStats(includeHidden = true): ModelStats[] {
  return listModelStatsFromDb(getDb(), includeHidden);
}

export async function createModel(input: { name: string }): Promise<Model> {
  const name = input.name.trim();
  if (!name) throw new HttpError(400, "LLM name is required.");
  if (isConsensusModelName(name)) throw new HttpError(400, "Consensus is derived from LLM predictions, not a model.");

  const db = getDb();
  await copyPrimaryToSafety(db, "model add");
  const now = nowIso();
  const nextOrder = Number(
    (db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM models").get() as { next_order: number })
      .next_order
  );
  const id = stableId("model", name);

  try {
    db.prepare(
      `INSERT INTO models (id, name, display_name, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`
    ).run(id, name, name, nextOrder, now, now);
  } catch {
    throw new HttpError(409, `LLM "${name}" already exists.`);
  }

  const model = mapModel(
    db.prepare("SELECT * FROM models WHERE id = ?").get(id) as Record<string, unknown>
  );
  writeAudit({ action: "model.create", entityType: "model", entityId: id, after: model });
  return model;
}

export async function updateModel(
  id: string,
  input: { displayName?: string; isActive?: boolean; sortOrder?: number }
): Promise<Model> {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM models WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!existing) throw new HttpError(404, "LLM not found.");

  await copyPrimaryToSafety(db, "model update");
  const displayName = input.displayName?.trim() || String(existing.display_name);
  if (isConsensusModelName(displayName)) throw new HttpError(400, "Consensus is derived from LLM predictions, not a model.");
  const sortOrder = input.sortOrder ?? Number(existing.sort_order);
  const isActive = input.isActive === undefined ? Number(existing.is_active) : input.isActive ? 1 : 0;

  db.prepare(
    `UPDATE models
     SET display_name = ?, is_active = ?, sort_order = ?, updated_at = ?
     WHERE id = ?`
  ).run(displayName, isActive, sortOrder, nowIso(), id);

  const model = mapModel(
    db.prepare("SELECT * FROM models WHERE id = ?").get(id) as Record<string, unknown>
  );
  writeAudit({ action: "model.update", entityType: "model", entityId: id, before: existing, after: model });
  return model;
}

export async function reorderModels(modelIds: string[]): Promise<Model[]> {
  const db = getDb();
  await copyPrimaryToSafety(db, "model reorder");
  withTransaction(db, () => {
    const update = db.prepare("UPDATE models SET sort_order = ?, updated_at = ? WHERE id = ?");
    const now = nowIso();
    modelIds.forEach((id, index) => update.run(index + 1, now, id));
    writeAudit({ action: "model.reorder", entityType: "model", after: { modelIds } });
  });
  return listModels(true);
}

export function ensureModelId(value: string): string {
  if (!value.trim()) return createId("model");
  return value;
}
