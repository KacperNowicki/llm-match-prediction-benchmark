import { getDb } from "../db/connection";
import { mapMatch } from "./mappers";
import { parseResultLines, type ParsedResult } from "../parsers/resultParser";
import { saveParsedResults } from "./matches";

export function parseResults(tournamentId: string, rawInput: string): ParsedResult[] {
  const db = getDb();
  const matches = db
    .prepare("SELECT * FROM matches WHERE tournament_id = ? ORDER BY match_order ASC")
    .all(tournamentId)
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
  return parseResultLines(rawInput, matches);
}

export async function saveResults(rows: ParsedResult[]): Promise<{ saved: number }> {
  return saveParsedResults(rows);
}

