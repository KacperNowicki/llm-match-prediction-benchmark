import { copyPrimaryToSafety } from "../db/safety";
import { getDb, withTransaction, type AppDatabase } from "../db/connection";
import { HttpError } from "../lib/httpError";
import { createId, nowIso } from "../lib/id";
import {
  cleanPredictionLines,
  parsePredictionsForMatches,
  type ParsedPrediction,
  type ParserMatch
} from "../parsers/predictionParser";
import { writeAudit } from "./audit";
import { mapMatch, mapTournament } from "./mappers";

export type PredictionTargetScope = "nextMissing" | "upcoming" | "all";

const scorePattern = /\d+\s*-\s*\d+/;

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function splitLeaguePredictionBlocks(rawInput: string): Array<{ header: string | null; rawInput: string }> {
  const blocks: Array<{ header: string | null; lines: string[] }> = [];
  let current: { header: string | null; lines: string[] } = { header: null, lines: [] };
  for (const rawLine of rawInput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("```")) continue;
    const cleaned = line.replace(/^\d+[\).\s-]+/, "").trim();
    if (!scorePattern.test(cleaned)) {
      if (current.lines.length > 0 || current.header) blocks.push(current);
      current = { header: cleaned, lines: [] };
      continue;
    }
    current.lines.push(cleaned);
  }
  if (current.lines.length > 0 || current.header) blocks.push(current);
  return blocks.map((block) => ({ header: block.header, rawInput: block.lines.join("\n") })).filter((block) => block.rawInput);
}

function listActiveTournamentHeadersFromDb(db: AppDatabase): Array<{ id: string; name: string; league: string }> {
  return db
    .prepare(
      `SELECT t.*,
              COUNT(m.id) AS match_count,
              SUM(CASE WHEN m.actual_winner IS NOT NULL AND m.actual_score IS NOT NULL THEN 1 ELSE 0 END) AS completed_count
       FROM tournaments t
       LEFT JOIN matches m ON m.tournament_id = t.id
       WHERE t.status = 'active'
       GROUP BY t.id
       ORDER BY t.updated_at DESC`
    )
    .all()
    .map((row) => {
      const tournament = mapTournament(row as Record<string, unknown>);
      return { id: tournament.id, name: tournament.name, league: tournament.league };
    });
}

function resolveTournamentHeader(
  db: AppDatabase,
  header: string | null,
  fallbackTournamentId?: string
): { id: string; name: string; league: string } | null {
  const tournaments = listActiveTournamentHeadersFromDb(db);
  if (!header) {
    const fallback = tournaments.find((tournament) => tournament.id === fallbackTournamentId);
    return fallback ? { id: fallback.id, name: fallback.name, league: fallback.league } : null;
  }
  const normalized = normalizeHeader(header);
  const byName = tournaments.find((tournament) => normalized.includes(normalizeHeader(tournament.name)));
  if (byName) return { id: byName.id, name: byName.name, league: byName.league };
  const byLeague = tournaments.filter((tournament) => normalized === normalizeHeader(tournament.league) || normalized.startsWith(`${normalizeHeader(tournament.league)} `));
  if (byLeague.length === 1) return { id: byLeague[0].id, name: byLeague[0].name, league: byLeague[0].league };
  return null;
}

export function getPredictionTargetMatchesFromDb(
  db: AppDatabase,
  tournamentId: string,
  input: { rawInput: string; modelId?: string; targetScope?: PredictionTargetScope }
): ParserMatch[] {
  const targetScope = input.targetScope ?? "nextMissing";
  const lineCount = cleanPredictionLines(input.rawInput).length;

  if (targetScope === "nextMissing" && !input.modelId) {
    throw new HttpError(400, "Select an LLM before parsing next missing predictions.");
  }
  const params = targetScope === "nextMissing" ? [input.modelId ?? "", tournamentId] : [tournamentId];

  const rows = db
    .prepare(
      `SELECT m.*
       FROM matches m
       ${targetScope === "nextMissing" ? "LEFT JOIN model_predictions p ON p.match_id = m.id AND p.model_id = ?" : ""}
       WHERE m.tournament_id = ?
         ${targetScope === "all" ? "" : "AND NOT (m.actual_winner IS NOT NULL AND m.actual_score IS NOT NULL)"}
         ${targetScope === "nextMissing" ? "AND p.id IS NULL" : ""}
       ORDER BY m.match_order ASC`
    )
    .all(...params);

  const selectedRows = targetScope === "all" || lineCount === 0 ? rows : rows.slice(0, lineCount);
  return selectedRows
    .map((row) => {
      const match = mapMatch(row as Record<string, unknown>);
      return {
        id: match.id,
        matchOrder: match.matchOrder,
        team1: match.team1,
        team2: match.team2,
        bestOf: match.bestOf
      };
    });
}

export function parsePredictionsFromDb(
  db: AppDatabase,
  tournamentId: string,
  rawInput: string,
  options: { modelId?: string; targetScope?: PredictionTargetScope } = {}
): ParsedPrediction[] {
  const matches = getPredictionTargetMatchesFromDb(db, tournamentId, { rawInput, ...options });
  return parsePredictionsForMatches(rawInput, matches);
}

export function parsePredictions(
  tournamentId: string,
  rawInput: string,
  options: { modelId?: string; targetScope?: PredictionTargetScope } = {}
): ParsedPrediction[] {
  return parsePredictionsFromDb(getDb(), tournamentId, rawInput, options);
}

export function parseLeagueBlobPredictionsFromDb(
  db: AppDatabase,
  rawInput: string,
  options: { modelId: string; fallbackTournamentId?: string; targetScope?: PredictionTargetScope }
): ParsedPrediction[] {
  const blocks = splitLeaguePredictionBlocks(rawInput);
  if (blocks.length === 0) return parsePredictionsForMatches(rawInput, []);
  return blocks.flatMap((block): ParsedPrediction[] => {
    const tournament = resolveTournamentHeader(db, block.header, options.fallbackTournamentId);
    if (!tournament) {
      return [{
        matchId: null,
        matchOrder: null,
        predictedWinner: null,
        predictedScore: null,
        rawLine: block.header ?? "",
        status: "error" as const,
        messages: [`Could not match header "${block.header ?? "missing"}" to one active tournament.`]
      }];
    }
    return parsePredictionsFromDb(db, tournament.id, block.rawInput, {
      modelId: options.modelId,
      targetScope: options.targetScope ?? "nextMissing"
    }).map((row) => ({
      ...row,
      tournamentId: tournament.id,
      tournamentName: tournament.name,
      league: tournament.league
    }));
  });
}

export function parseLeagueBlobPredictions(
  rawInput: string,
  options: { modelId: string; fallbackTournamentId?: string; targetScope?: PredictionTargetScope }
): ParsedPrediction[] {
  return parseLeagueBlobPredictionsFromDb(getDb(), rawInput, options);
}

export async function updatePredictionCell(input: {
  matchId: string;
  modelId: string;
  rawValue: string;
}): Promise<{ saved: true }> {
  const rawValue = input.rawValue.trim();
  if (!rawValue) throw new HttpError(400, "Prediction cell needs winner and score.");

  const db = getDb();
  const matchRow = db.prepare("SELECT * FROM matches WHERE id = ?").get(input.matchId) as Record<string, unknown> | undefined;
  if (!matchRow) throw new HttpError(404, "Match not found.");
  const model = db.prepare("SELECT id FROM models WHERE id = ?").get(input.modelId);
  if (!model) throw new HttpError(404, "LLM not found.");

  const match = mapMatch(matchRow);
  const parsed = parsePredictionsForMatches(rawValue, [{
    id: match.id,
    matchOrder: match.matchOrder,
    team1: match.team1,
    team2: match.team2,
    bestOf: match.bestOf
  }])[0];
  if (!parsed || parsed.status === "error" || !parsed.predictedWinner || !parsed.predictedScore) {
    throw new HttpError(400, parsed?.messages.join(" ") || "Could not parse prediction.");
  }

  await copyPrimaryToSafety(db, "prediction inline edit");
  const now = nowIso();
  db.prepare(
    `INSERT INTO model_predictions (
      id, match_id, model_id, predicted_winner, predicted_score, raw_input, raw_line,
      parse_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(match_id, model_id) DO UPDATE SET
       predicted_winner = excluded.predicted_winner,
       predicted_score = excluded.predicted_score,
       raw_input = excluded.raw_input,
       raw_line = excluded.raw_line,
       parse_status = excluded.parse_status,
       updated_at = excluded.updated_at`
  ).run(
    createId("prediction"),
    match.id,
    input.modelId,
    parsed.predictedWinner,
    parsed.predictedScore,
    rawValue,
    rawValue,
    parsed.status,
    now,
    now
  );
  writeAudit({
    action: "prediction.inline.update",
    entityType: "prediction",
    entityId: `${match.id}:${input.modelId}`,
    after: { matchId: match.id, modelId: input.modelId, rawValue }
  });
  return { saved: true };
}

export async function savePredictions(input: {
  modelId: string;
  rawInput: string;
  rows: ParsedPrediction[];
}): Promise<{ saved: number }> {
  const db = getDb();
  const model = db.prepare("SELECT id FROM models WHERE id = ?").get(input.modelId);
  if (!model) throw new HttpError(404, "LLM not found.");

  const validRows = input.rows.filter(
    (row) =>
      row.matchId &&
      row.predictedWinner &&
      row.predictedScore &&
      (row.status === "valid" || row.status === "warning")
  );
  if (validRows.length === 0) throw new HttpError(400, "No valid predictions to save.");

  await copyPrimaryToSafety(db, "prediction save");
  withTransaction(db, () => {
    const upsert = db.prepare(
      `INSERT INTO model_predictions (
        id, match_id, model_id, predicted_winner, predicted_score, raw_input, raw_line,
        parse_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(match_id, model_id) DO UPDATE SET
         predicted_winner = excluded.predicted_winner,
         predicted_score = excluded.predicted_score,
         raw_input = excluded.raw_input,
         raw_line = excluded.raw_line,
         parse_status = excluded.parse_status,
         updated_at = excluded.updated_at`
    );
    const now = nowIso();
    validRows.forEach((row) => {
      upsert.run(
        createId("prediction"),
        row.matchId,
        input.modelId,
        row.predictedWinner,
        row.predictedScore,
        input.rawInput,
        row.rawLine,
        row.status,
        now,
        now
      );
    });
    writeAudit({
      action: "predictions.save",
      entityType: "model",
      entityId: input.modelId,
      after: { saved: validRows.length }
    });
  });

  return { saved: validRows.length };
}
