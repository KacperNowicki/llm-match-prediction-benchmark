import { getDb } from "../db/connection";
import { copyPrimaryToSafety } from "../db/safety";
import { HttpError } from "../lib/httpError";
import { createId, nowIso } from "../lib/id";
import { toBestOf } from "../lib/scoreValidation";
import { writeAudit } from "./audit";
import { mapTournament } from "./mappers";
import type { Tournament } from "./types";

export function listTournaments(): Tournament[] {
  const db = getDb();
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
    .map((row) => mapTournament(row as Record<string, unknown>));
}

export function getTournament(id: string): Tournament {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT t.*,
              COUNT(m.id) AS match_count,
              SUM(CASE WHEN m.actual_winner IS NOT NULL AND m.actual_score IS NOT NULL THEN 1 ELSE 0 END) AS completed_count
       FROM tournaments t
       LEFT JOIN matches m ON m.tournament_id = t.id
       WHERE t.id = ?
       GROUP BY t.id`
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) throw new HttpError(404, "Tournament not found.");
  return mapTournament(row);
}

export async function createTournament(input: {
  name: string;
  league: string;
  season?: number | null;
  stage?: string | null;
  roundLabel?: string | null;
  dateStart?: string | null;
  dateEnd?: string | null;
  defaultBestOf?: number;
  leaguepediaOverviewPage?: string | null;
}): Promise<Tournament> {
  const name = input.name.trim();
  const league = input.league.trim() || "Custom";
  if (!name) throw new HttpError(400, "Tournament name is required.");

  const now = nowIso();
  const id = createId("tournament");
  const db = getDb();
  await copyPrimaryToSafety(db, "tournament create");
  db.prepare(
    `INSERT INTO tournaments (
      id, name, league, season, stage, round_label, date_start, date_end,
      default_best_of, leaguepedia_overview_page, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(
    id,
    name,
    league,
    input.season ?? null,
    input.stage?.trim() || null,
    input.roundLabel?.trim() || null,
    input.dateStart || null,
    input.dateEnd || null,
    toBestOf(input.defaultBestOf ?? 3),
    input.leaguepediaOverviewPage?.trim() || null,
    now,
    now
  );

  const tournament = getTournament(id);
  writeAudit({ action: "tournament.create", entityType: "tournament", entityId: id, after: tournament });
  return tournament;
}

export async function removeTournament(id: string): Promise<{ removed: true; tournament: Tournament }> {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM tournaments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!existing) throw new HttpError(404, "Tournament not found.");
  if (String(existing.status) !== "active") {
    return { removed: true, tournament: getTournament(id) };
  }

  await copyPrimaryToSafety(db, "tournament remove");
  db.prepare("UPDATE tournaments SET status = 'removed', updated_at = ? WHERE id = ?").run(nowIso(), id);

  const tournament = getTournament(id);
  writeAudit({
    action: "tournament.remove",
    entityType: "tournament",
    entityId: id,
    before: existing,
    after: tournament
  });
  return { removed: true, tournament };
}
