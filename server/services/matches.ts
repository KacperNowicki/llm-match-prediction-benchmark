import { copyPrimaryToSafety } from "../db/safety";
import { getDb, withTransaction, type AppDatabase } from "../db/connection";
import { HttpError } from "../lib/httpError";
import { createId, nowIso } from "../lib/id";
import { inferBestOfFromScore, isValidScoreForBestOf, normalizeScoreText, toBestOf } from "../lib/scoreValidation";
import { resolveTeamToken } from "../lib/teamAliases";
import { writeAudit } from "./audit";
import { mapMatch } from "./mappers";
import type { Match } from "./types";

type ScheduleInput = {
  externalMatchId?: string | null;
  matchOrder?: number;
  dateTimeUtc?: string | null;
  stage?: string | null;
  roundLabel?: string | null;
  bestOf?: number;
  team1: string;
  team2: string;
};

export type MatchUpdateInput = {
  matchOrder?: number | null;
  externalMatchId?: string | null;
  dateTimeUtc?: string | null;
  stage?: string | null;
  roundLabel?: string | null;
  bestOf?: number | null;
  team1?: string | null;
  team2?: string | null;
  actualWinner?: string | null;
  actualScore?: string | null;
};

const knownHeaders = new Map<string, keyof ScheduleInput>([
  ["match id", "externalMatchId"],
  ["matchid", "externalMatchId"],
  ["id", "externalMatchId"],
  ["order", "matchOrder"],
  ["match order", "matchOrder"],
  ["datetime", "dateTimeUtc"],
  ["date", "dateTimeUtc"],
  ["date/time", "dateTimeUtc"],
  ["stage", "stage"],
  ["round", "roundLabel"],
  ["bo", "bestOf"],
  ["bestof", "bestOf"],
  ["team1", "team1"],
  ["team 1", "team1"],
  ["team2", "team2"],
  ["team 2", "team2"]
]);

function cleanCell(value: unknown): string {
  return String(value ?? "").trim();
}

function cleanLeaguepediaLine(value: string): string {
  return value
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\t+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLeaguepediaDateLine(value: string): boolean {
  return /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}$/i.test(value);
}

function leaguepediaDate(value: string): string | null {
  return value.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

function isLeaguepediaTimeLine(value: string): boolean {
  return /^\d{1,2}:\d{2}$/.test(value);
}

function isLeaguepediaRoundLine(value: string): boolean {
  return /^(round\s+\d+|finals?|semifinals?|quarterfinals?)$/i.test(value);
}

function isLeaguepediaTeamToken(value: string): boolean {
  if (!value || value.length > 18) return false;
  if (/logo\s*std/i.test(value)) return false;
  if (/^\[?hide\]?$/i.test(value)) return false;
  if (isLeaguepediaDateLine(value) || isLeaguepediaTimeLine(value) || isLeaguepediaRoundLine(value)) return false;
  return /^[A-Za-z0-9 .#'_-]+$/.test(value);
}

function findLeaguepediaTeam(lines: string[], start: number, direction: -1 | 1): string | null {
  for (let index = start; index >= 0 && index < lines.length; index += direction) {
    if (isLeaguepediaTeamToken(lines[index])) return lines[index];
  }
  return null;
}

export function parseLeaguepediaScheduleCopy(rawInput: string, defaultBestOf = 3): ScheduleInput[] {
  const lines = rawInput
    .split(/\r?\n/)
    .map(cleanLeaguepediaLine)
    .filter(Boolean)
    .filter((line) => !/^\[?hide\]?$/i.test(line));
  if (!lines.some(isLeaguepediaDateLine) || !lines.some(isLeaguepediaTimeLine)) return [];

  const bestOf = defaultBestOf;
  let currentRound: string | null = null;
  let currentDate: string | null = null;
  const matches: ScheduleInput[] = [];

  lines.forEach((line, index) => {
    if (isLeaguepediaRoundLine(line)) {
      currentRound = line;
      return;
    }
    if (isLeaguepediaDateLine(line)) {
      currentDate = leaguepediaDate(line);
      return;
    }
    if (!isLeaguepediaTimeLine(line) || !currentDate) return;

    const team1 = findLeaguepediaTeam(lines, index - 1, -1);
    const team2 = findLeaguepediaTeam(lines, index + 1, 1);
    if (!team1 || !team2) return;
    const matchOrder = matches.length + 1;
    matches.push({
      externalMatchId: `LP-P${String(matchOrder).padStart(3, "0")}`,
      matchOrder,
      dateTimeUtc: `${currentDate} ${line}:00`,
      stage: currentRound ? "Leaguepedia paste" : null,
      roundLabel: currentRound,
      bestOf,
      team1,
      team2
    });
  });

  return matches;
}

function parseBestOf(value: string | number | undefined, fallback = 3): number {
  if (value === undefined || value === null || value === "") return fallback;
  const match = String(value).match(/\d+/);
  return toBestOf(match ? Number(match[0]) : fallback);
}

function optionalText(value: string | null | undefined): string | null {
  const trimmed = cleanCell(value);
  return trimmed || null;
}

export function listMatchesFromDb(db: AppDatabase, tournamentId: string): Match[] {
  return db
    .prepare(
      `SELECT m.*,
              COUNT(
                CASE
                  WHEN p.id IS NOT NULL
                    AND mo.is_active = 1
                    AND lower(mo.name) <> 'consensus'
                    AND lower(mo.display_name) <> 'consensus'
                  THEN 1
                END
              ) AS prediction_count
       FROM matches m
       LEFT JOIN model_predictions p ON p.match_id = m.id
       LEFT JOIN models mo ON mo.id = p.model_id
       WHERE m.tournament_id = ?
       GROUP BY m.id
       ORDER BY m.match_order ASC`
    )
    .all(tournamentId)
    .map((row) => mapMatch(row as Record<string, unknown>));
}

export function listMatches(tournamentId: string): Match[] {
  return listMatchesFromDb(getDb(), tournamentId);
}

export async function addMatch(tournamentId: string, input: ScheduleInput): Promise<Match> {
  const db = getDb();
  await copyPrimaryToSafety(db, "manual match add");

  const now = nowIso();
  const nextOrder =
    input.matchOrder ??
    Number(
      (db.prepare("SELECT COALESCE(MAX(match_order), 0) + 1 AS next_order FROM matches WHERE tournament_id = ?").get(
        tournamentId
      ) as { next_order: number }).next_order
    );
  const id = createId("match");
  db.prepare(
    `INSERT INTO matches (
      id, tournament_id, match_order, external_match_id, date_time_utc, stage, round_label,
      best_of, team1, team2, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    tournamentId,
    nextOrder,
    input.externalMatchId?.trim() || null,
    input.dateTimeUtc?.trim() || null,
    input.stage?.trim() || null,
    input.roundLabel?.trim() || null,
    parseBestOf(input.bestOf, 3),
    input.team1.trim(),
    input.team2.trim(),
    now,
    now
  );
  touchTournament(tournamentId);
  const match = mapMatch(db.prepare("SELECT * FROM matches WHERE id = ?").get(id) as Record<string, unknown>);
  writeAudit({ action: "match.create", entityType: "match", entityId: id, after: match });
  return match;
}

export function parseScheduleTsv(rawInput: string, defaultBestOf = 3): ScheduleInput[] {
  const leaguepediaRows = parseLeaguepediaScheduleCopy(rawInput, defaultBestOf);
  if (leaguepediaRows.length > 0) return leaguepediaRows;

  const rows = rawInput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t").map(cleanCell));

  if (rows.length === 0) return [];

  const first = rows[0].map((cell) => cell.toLowerCase());
  const hasHeader = first.some((cell) => knownHeaders.has(cell));
  const headers = hasHeader ? first : [];
  const dataRows = hasHeader ? rows.slice(1) : rows;

  return dataRows
    .map((cells, rowIndex): ScheduleInput | null => {
      if (cells.every((cell) => !cell)) return null;
      if (hasHeader) {
        const value: Partial<ScheduleInput> = {};
        headers.forEach((header, columnIndex) => {
          const key = knownHeaders.get(header);
          if (!key) return;
          const cell = cells[columnIndex];
          if (!cell) return;
          if (key === "bestOf") value.bestOf = parseBestOf(cell, defaultBestOf);
          else if (key === "matchOrder") value.matchOrder = Number(cell);
          else value[key] = cell as never;
        });
        if (!value.team1 || !value.team2) return null;
        return {
          externalMatchId: value.externalMatchId ?? null,
          matchOrder: value.matchOrder,
          dateTimeUtc: value.dateTimeUtc ?? null,
          stage: value.stage ?? null,
          roundLabel: value.roundLabel ?? null,
          bestOf: value.bestOf ?? defaultBestOf,
          team1: value.team1,
          team2: value.team2
        };
      }

      if (cells.length >= 6) {
        return {
          externalMatchId: cells[0] || null,
          stage: cells[1] || null,
          roundLabel: cells[2] || null,
          bestOf: parseBestOf(cells[3], defaultBestOf),
          team1: cells[4],
          team2: cells[5],
          matchOrder: rowIndex + 1
        };
      }

      return {
        team1: cells[0],
        team2: cells[1],
        bestOf: parseBestOf(cells[2], defaultBestOf),
        matchOrder: rowIndex + 1
      };
    })
    .filter((row): row is ScheduleInput => Boolean(row && row.team1 && row.team2));
}

export async function upsertScheduleFromTsv(
  tournamentId: string,
  rawInput: string,
  defaultBestOf = 3
): Promise<{ imported: number; matches: Match[] }> {
  const rows = parseScheduleTsv(rawInput, defaultBestOf);
  const db = getDb();
  await copyPrimaryToSafety(db, "schedule paste import");

  withTransaction(db, () => {
    const existing = db.prepare("SELECT id FROM matches WHERE tournament_id = ? AND match_order = ?");
    const insert = db.prepare(
      `INSERT INTO matches (
        id, tournament_id, match_order, external_match_id, date_time_utc, stage, round_label,
        best_of, team1, team2, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const update = db.prepare(
      `UPDATE matches
       SET external_match_id = ?, date_time_utc = ?, stage = ?, round_label = ?,
           best_of = ?, team1 = ?, team2 = ?, updated_at = ?
       WHERE tournament_id = ? AND match_order = ?`
    );

    const now = nowIso();
    rows.forEach((row, index) => {
      const order = row.matchOrder && Number.isFinite(row.matchOrder) ? row.matchOrder : index + 1;
      const existingRow = existing.get(tournamentId, order) as { id: string } | undefined;
      if (existingRow) {
        update.run(
          row.externalMatchId?.trim() || null,
          row.dateTimeUtc?.trim() || null,
          row.stage?.trim() || null,
          row.roundLabel?.trim() || null,
          parseBestOf(row.bestOf, defaultBestOf),
          row.team1.trim(),
          row.team2.trim(),
          now,
          tournamentId,
          order
        );
      } else {
        insert.run(
          createId("match"),
          tournamentId,
          order,
          row.externalMatchId?.trim() || null,
          row.dateTimeUtc?.trim() || null,
          row.stage?.trim() || null,
          row.roundLabel?.trim() || null,
          parseBestOf(row.bestOf, defaultBestOf),
          row.team1.trim(),
          row.team2.trim(),
          now,
          now
        );
      }
    });
    touchTournament(tournamentId);
    writeAudit({
      action: "schedule.tsv.upsert",
      entityType: "tournament",
      entityId: tournamentId,
      after: { imported: rows.length }
    });
  });

  return { imported: rows.length, matches: listMatches(tournamentId) };
}

export async function updateMatchResult(input: {
  matchId: string;
  actualWinner: string;
  actualScore: string;
  source?: string;
}): Promise<Match> {
  const db = getDb();
  await copyPrimaryToSafety(db, "manual result update");
  const now = nowIso();
  db.prepare(
    `UPDATE matches
     SET actual_winner = ?, actual_score = ?, actual_source = ?, manual_override = 1, updated_at = ?
     WHERE id = ?`
  ).run(input.actualWinner, input.actualScore, input.source ?? "manual", now, input.matchId);

  const row = db.prepare("SELECT * FROM matches WHERE id = ?").get(input.matchId) as Record<string, unknown>;
  touchTournament(String(row.tournament_id));
  const match = mapMatch(row);
  writeAudit({ action: "match.result.update", entityType: "match", entityId: input.matchId, after: match });
  return match;
}

export async function updateMatch(input: { matchId: string; updates: MatchUpdateInput }): Promise<Match> {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM matches WHERE id = ?").get(input.matchId) as Record<string, unknown> | undefined;
  if (!existing) throw new HttpError(404, "Match not found.");

  await copyPrimaryToSafety(db, "match inline edit");

  const hasActualWinner = Object.prototype.hasOwnProperty.call(input.updates, "actualWinner");
  const hasActualScore = Object.prototype.hasOwnProperty.call(input.updates, "actualScore");
  const team1 = input.updates.team1?.trim() || String(existing.team1);
  const team2 = input.updates.team2?.trim() || String(existing.team2);
  let bestOf = input.updates.bestOf ? toBestOf(input.updates.bestOf) : Number(existing.best_of);
  let actualWinner = hasActualWinner ? optionalText(input.updates.actualWinner) : optionalText(String(existing.actual_winner ?? ""));
  let actualScore = hasActualScore ? optionalText(input.updates.actualScore) : optionalText(String(existing.actual_score ?? ""));
  let actualSource = String(existing.actual_source ?? "") || null;
  let manualOverride = Number(existing.manual_override);

  if (hasActualWinner || hasActualScore) {
    if (!actualWinner && !actualScore) {
      actualSource = null;
      manualOverride = 0;
    } else if (!actualWinner || !actualScore) {
      throw new HttpError(400, "Actual result needs both winner and score, or clear both.");
    } else {
      const winner = resolveTeamToken(actualWinner, team1, team2);
      if (winner.status !== "matched") throw new HttpError(400, winner.message);
      const normalized = normalizeScoreText(actualScore);
      if (!normalized) throw new HttpError(400, `Actual score "${actualScore}" is not a score.`);
      const inferredBestOf = inferBestOfFromScore(normalized);
      if (!isValidScoreForBestOf(bestOf, normalized) && inferredBestOf && isValidScoreForBestOf(inferredBestOf, normalized)) {
        bestOf = inferredBestOf;
      }
      if (!isValidScoreForBestOf(bestOf, normalized)) throw new HttpError(400, `Score ${normalized} is illegal for BO${bestOf}.`);
      actualWinner = winner.team;
      actualScore = normalized;
      actualSource = "manual";
      manualOverride = 1;
    }
  }

  const now = nowIso();
  try {
    db.prepare(
      `UPDATE matches
       SET match_order = ?, external_match_id = ?, date_time_utc = ?, stage = ?, round_label = ?,
           best_of = ?, team1 = ?, team2 = ?, actual_winner = ?, actual_score = ?,
           actual_source = ?, manual_override = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      input.updates.matchOrder ?? Number(existing.match_order),
      Object.prototype.hasOwnProperty.call(input.updates, "externalMatchId") ? optionalText(input.updates.externalMatchId) : optionalText(String(existing.external_match_id ?? "")),
      Object.prototype.hasOwnProperty.call(input.updates, "dateTimeUtc") ? optionalText(input.updates.dateTimeUtc) : optionalText(String(existing.date_time_utc ?? "")),
      Object.prototype.hasOwnProperty.call(input.updates, "stage") ? optionalText(input.updates.stage) : optionalText(String(existing.stage ?? "")),
      Object.prototype.hasOwnProperty.call(input.updates, "roundLabel") ? optionalText(input.updates.roundLabel) : optionalText(String(existing.round_label ?? "")),
      bestOf,
      team1,
      team2,
      actualWinner,
      actualScore,
      actualSource,
      manualOverride,
      now,
      input.matchId
    );
  } catch {
    throw new HttpError(409, "Could not save match edit. Check for duplicate match order.");
  }

  const row = db.prepare("SELECT * FROM matches WHERE id = ?").get(input.matchId) as Record<string, unknown>;
  touchTournament(String(row.tournament_id));
  const match = mapMatch(row);
  writeAudit({ action: "match.inline.update", entityType: "match", entityId: input.matchId, before: existing, after: match });
  return match;
}

export async function saveParsedResults(
  rows: Array<{ matchId: string | null; actualWinner: string | null; actualScore: string | null; bestOf?: number | null }>
): Promise<{ saved: number }> {
  const valid = rows.filter((row) => row.matchId && row.actualWinner && row.actualScore);
  const db = getDb();
  await copyPrimaryToSafety(db, "bulk result save");
  withTransaction(db, () => {
    const update = db.prepare(
      `UPDATE matches
       SET actual_winner = ?, actual_score = ?, best_of = COALESCE(?, best_of),
           actual_source = 'manual', manual_override = 1, updated_at = ?
       WHERE id = ?`
    );
    const now = nowIso();
    valid.forEach((row) => update.run(row.actualWinner, row.actualScore, row.bestOf ?? null, now, row.matchId));
    writeAudit({ action: "results.bulk.save", entityType: "match", after: { saved: valid.length } });
  });
  return { saved: valid.length };
}

function touchTournament(tournamentId: string): void {
  getDb().prepare("UPDATE tournaments SET updated_at = ? WHERE id = ?").run(nowIso(), tournamentId);
}
