import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "../../server/db/connection";
import { CONSENSUS_MODEL_ID } from "../../server/lib/modelNames";
import { getConsensusPredictionsForMatchesFromDb } from "../../server/services/consensus";
import { mapMatch } from "../../server/services/mappers";
import { listMatchesFromDb } from "../../server/services/matches";
import { listModelStatsFromDb } from "../../server/services/models";
import { parseLeagueBlobPredictionsFromDb, parsePredictionsFromDb } from "../../server/services/predictions";
import { getTournamentScoresFromDb } from "../../server/services/scoring";

let db: AppDatabase | null = null;
let root: string | null = null;

function testDb(): AppDatabase {
  root = mkdtempSync(path.join(os.tmpdir(), "lph-score-"));
  db = openDatabase(path.join(root, "test.sqlite"));
  db.exec(readFileSync(path.join(process.cwd(), "server", "db", "schema.sql"), "utf8"));
  return db;
}

afterEach(() => {
  db?.close();
  db = null;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("tournament score query", () => {
  it("uses the same completed-match denominator for every model", () => {
    const database = testDb();
    const now = "2026-05-19T00:00:00.000Z";
    database
      .prepare(
        `INSERT INTO tournaments (id, name, league, default_best_of, status, created_at, updated_at)
         VALUES ('t1', 'Test Cup', 'LCK', 3, 'active', ?, ?)`
      )
      .run(now, now);
    database
      .prepare(
        `INSERT INTO models (id, name, display_name, is_active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`
      )
      .run("m1", "Model A", "Model A", 1, now, now);
    database
      .prepare(
        `INSERT INTO models (id, name, display_name, is_active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`
      )
      .run("m2", "Model B", "Model B", 2, now, now);
    const insertMatch = database.prepare(
      `INSERT INTO matches (
        id, tournament_id, match_order, best_of, team1, team2,
        actual_winner, actual_score, created_at, updated_at
       ) VALUES (?, 't1', ?, 3, ?, ?, ?, ?, ?, ?)`
    );
    insertMatch.run("match1", 1, "T1", "DK", "T1", "2-0", now, now);
    insertMatch.run("match2", 2, "GEN", "HLE", "GEN", "2-1", now, now);
    const insertPrediction = database.prepare(
      `INSERT INTO model_predictions (
        id, match_id, model_id, predicted_winner, predicted_score, parse_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'valid', ?, ?)`
    );
    insertPrediction.run("p1", "match1", "m1", "T1", "2-0", now, now);
    insertPrediction.run("p2", "match2", "m1", "GEN", "2-0", now, now);
    insertPrediction.run("p3", "match1", "m2", "T1", "2-1", now, now);

    const rows = getTournamentScoresFromDb(database, "t1");

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelName: "Model A", totalPoints: 3, possiblePoints: 4, completedPredictions: 2 }),
        expect.objectContaining({ modelName: "Model B", totalPoints: 1, possiblePoints: 4, completedPredictions: 2 }),
        expect.objectContaining({ modelId: CONSENSUS_MODEL_ID, modelName: "Consensus", totalPoints: 3, possiblePoints: 4, completedPredictions: 2 })
      ])
    );
    expect(rows).toHaveLength(3);
  });

  it("derives consensus from weighted real LLM scores and ignores stored Consensus rows", () => {
    const database = testDb();
    const now = "2026-05-19T00:00:00.000Z";
    database
      .prepare(
        `INSERT INTO tournaments (id, name, league, default_best_of, status, created_at, updated_at)
         VALUES ('t1', 'Test Cup', 'LCK', 3, 'active', ?, ?)`
      )
      .run(now, now);
    const insertModel = database.prepare(
      `INSERT INTO models (id, name, display_name, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`
    );
    insertModel.run("m1", "Model A", "Model A", 1, now, now);
    insertModel.run("m2", "Model B", "Model B", 2, now, now);
    insertModel.run("legacy-consensus", "Consensus", "Consensus", 3, now, now);
    const insertMatch = database.prepare(
      `INSERT INTO matches (
        id, tournament_id, match_order, best_of, team1, team2,
        actual_winner, actual_score, created_at, updated_at
       ) VALUES (?, 't1', ?, 3, ?, ?, ?, ?, ?, ?)`
    );
    insertMatch.run("completed", 1, "GEN", "HLE", "GEN", "2-0", now, now);
    insertMatch.run("future", 2, "T1", "DK", null, null, now, now);
    const insertPrediction = database.prepare(
      `INSERT INTO model_predictions (
        id, match_id, model_id, predicted_winner, predicted_score, parse_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'valid', ?, ?)`
    );
    insertPrediction.run("p1", "completed", "m1", "GEN", "2-0", now, now);
    insertPrediction.run("p2", "completed", "m2", "HLE", "2-1", now, now);
    insertPrediction.run("p3", "future", "m1", "T1", "2-0", now, now);
    insertPrediction.run("p4", "future", "m2", "DK", "2-1", now, now);
    insertPrediction.run("p5", "future", "legacy-consensus", "DK", "2-0", now, now);

    const matches = database
      .prepare("SELECT * FROM matches WHERE tournament_id = 't1' ORDER BY match_order ASC")
      .all()
      .map((row) => mapMatch(row as Record<string, unknown>));
    const consensus = getConsensusPredictionsForMatchesFromDb(database, "t1", matches);
    const rows = getTournamentScoresFromDb(database, "t1");

    expect(consensus.get("future")).toMatchObject({
      modelId: CONSENSUS_MODEL_ID,
      predictedWinner: "T1",
      predictedScore: "2-0"
    });
    expect(rows.map((row) => row.modelName)).toEqual(expect.arrayContaining(["Model A", "Model B", "Consensus"]));
    expect(rows.some((row) => row.modelId === "legacy-consensus")).toBe(false);
  });

  it("reports global mistake and missing counters per model", () => {
    const database = testDb();
    const now = "2026-05-19T00:00:00.000Z";
    database
      .prepare(
        `INSERT INTO tournaments (id, name, league, default_best_of, status, created_at, updated_at)
         VALUES ('t1', 'Test Cup', 'LCK', 3, 'active', ?, ?)`
      )
      .run(now, now);
    database
      .prepare(
        `INSERT INTO models (id, name, display_name, is_active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`
      )
      .run("m1", "Model A", "Model A", 1, now, now);
    database
      .prepare(
        `INSERT INTO models (id, name, display_name, is_active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`
      )
      .run("m2", "Model B", "Model B", 2, now, now);
    database
      .prepare(
        `INSERT INTO models (id, name, display_name, is_active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`
      )
      .run("m3", "Late Model", "Late Model", 3, now, now);
    const insertMatch = database.prepare(
      `INSERT INTO matches (
        id, tournament_id, match_order, best_of, team1, team2,
        actual_winner, actual_score, created_at, updated_at
       ) VALUES (?, 't1', ?, 3, ?, ?, ?, ?, ?, ?)`
    );
    insertMatch.run("match1", 1, "T1", "DK", "T1", "2-0", now, now);
    insertMatch.run("match2", 2, "GEN", "HLE", "GEN", "2-1", now, now);
    database
      .prepare(
        `INSERT INTO tournaments (id, name, league, default_best_of, status, created_at, updated_at)
         VALUES ('t2', 'Future Cup', 'LEC', 3, 'active', ?, ?)`
      )
      .run(now, now);
    database
      .prepare(
        `INSERT INTO matches (
          id, tournament_id, match_order, best_of, team1, team2, date_time_utc, created_at, updated_at
        ) VALUES ('future1', 't2', 1, 3, 'G2', 'KC', '2026-05-30T17:00:00.000Z', ?, ?)`
      )
      .run(now, now);
    const insertPrediction = database.prepare(
      `INSERT INTO model_predictions (
        id, match_id, model_id, predicted_winner, predicted_score, parse_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'valid', ?, ?)`
    );
    insertPrediction.run("p1", "match1", "m1", "T1", "2-0", now, now);
    insertPrediction.run("p2", "match2", "m1", "HLE", "2-1", now, now);
    insertPrediction.run("p3", "match1", "m2", "T1", "2-0", now, now);
    insertPrediction.run("p4", "future1", "m3", "MAD", "2-0", now, now);

    const rows = listModelStatsFromDb(database);

    expect(rows).toEqual([
      expect.objectContaining({ modelId: "m1", dataQualityIssueCount: 0, wrongWinnerCount: 1, exactMissCount: 1, missingCompletedCount: 0 }),
      expect.objectContaining({ modelId: "m2", dataQualityIssueCount: 0, wrongWinnerCount: 0, exactMissCount: 0, missingCompletedCount: 1 }),
      expect.objectContaining({ modelId: "m3", completedMatches: 0, dataQualityIssueCount: 1, wrongWinnerCount: 0, exactMissCount: 0, missingCompletedCount: 0 })
    ]);
  });
});

describe("prediction target selection", () => {
  it("counts only active real LLM predictions for match coverage", () => {
    const database = testDb();
    const now = "2026-05-19T00:00:00.000Z";
    database
      .prepare(
        `INSERT INTO tournaments (id, name, league, default_best_of, status, created_at, updated_at)
         VALUES ('t1', 'Test Cup', 'LCK', 3, 'active', ?, ?)`
      )
      .run(now, now);
    const insertModel = database.prepare(
      `INSERT INTO models (id, name, display_name, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    insertModel.run("m1", "Model A", "Model A", 1, 1, now, now);
    insertModel.run("m2", "Model B", "Model B", 1, 2, now, now);
    insertModel.run("consensus", "Consensus", "Consensus", 1, 3, now, now);
    insertModel.run("hidden", "Hidden", "Hidden", 0, 4, now, now);
    database
      .prepare(
        `INSERT INTO matches (
          id, tournament_id, match_order, best_of, team1, team2, created_at, updated_at
         ) VALUES ('match1', 't1', 1, 3, 'T1', 'DK', ?, ?)`
      )
      .run(now, now);
    const insertPrediction = database.prepare(
      `INSERT INTO model_predictions (
        id, match_id, model_id, predicted_winner, predicted_score, parse_status, created_at, updated_at
       ) VALUES (?, 'match1', ?, 'T1', '2-0', 'valid', ?, ?)`
    );
    insertPrediction.run("p1", "m1", now, now);
    insertPrediction.run("p2", "m2", now, now);
    insertPrediction.run("p3", "consensus", now, now);
    insertPrediction.run("p4", "hidden", now, now);

    const rows = listMatchesFromDb(database, "t1");

    expect(rows[0]).toMatchObject({ id: "match1", predictionCount: 2 });
  });

  it("parses weekly pastes against the next missing incomplete matches for the selected model", () => {
    const database = testDb();
    const now = "2026-05-19T00:00:00.000Z";
    database
      .prepare(
        `INSERT INTO tournaments (id, name, league, default_best_of, status, created_at, updated_at)
         VALUES ('t1', 'Test Cup', 'LCK', 3, 'active', ?, ?)`
      )
      .run(now, now);
    database
      .prepare(
        `INSERT INTO models (id, name, display_name, is_active, sort_order, created_at, updated_at)
         VALUES ('glm', 'GLM', 'GLM', 1, 1, ?, ?)`
      )
      .run(now, now);
    const insertMatch = database.prepare(
      `INSERT INTO matches (
        id, tournament_id, match_order, best_of, team1, team2,
        actual_winner, actual_score, created_at, updated_at
       ) VALUES (?, 't1', ?, 3, ?, ?, ?, ?, ?, ?)`
    );
    insertMatch.run("past", 1, "HLE", "BRO", "HLE", "2-0", now, now);
    insertMatch.run("already", 2, "T1", "KT", null, null, now, now);
    insertMatch.run("next1", 3, "T1", "KRX", null, null, now, now);
    insertMatch.run("next2", 4, "KT", "HLE", null, null, now, now);
    database
      .prepare(
        `INSERT INTO model_predictions (
          id, match_id, model_id, predicted_winner, predicted_score, parse_status, created_at, updated_at
         ) VALUES ('p1', 'already', 'glm', 'T1', '2-0', 'valid', ?, ?)`
      )
      .run(now, now);

    const rows = parsePredictionsFromDb(database, "t1", "T1 2-0\nKT 2-1", {
      modelId: "glm",
      targetScope: "nextMissing"
    });

    expect(rows).toEqual([
      expect.objectContaining({ matchId: "next1", predictedWinner: "T1", predictedScore: "2-0", status: "valid" }),
      expect.objectContaining({ matchId: "next2", predictedWinner: "KT", predictedScore: "2-1", status: "valid" })
    ]);
  });

  it("routes league-headed prediction blobs to active tournaments", () => {
    const database = testDb();
    const now = "2026-05-19T00:00:00.000Z";
    const insertTournament = database.prepare(
      `INSERT INTO tournaments (id, name, league, default_best_of, status, created_at, updated_at)
       VALUES (?, ?, ?, 3, 'active', ?, ?)`
    );
    insertTournament.run("lck", "LCK 2026 Road to MSI", "LCK", now, now);
    insertTournament.run("lec", "LEC 2026 Spring Playoffs", "LEC", now, now);
    database
      .prepare(
        `INSERT INTO models (id, name, display_name, is_active, sort_order, created_at, updated_at)
         VALUES ('glm', 'GLM', 'GLM', 1, 1, ?, ?)`
      )
      .run(now, now);
    const insertMatch = database.prepare(
      `INSERT INTO matches (
        id, tournament_id, match_order, best_of, team1, team2, created_at, updated_at
       ) VALUES (?, ?, ?, 3, ?, ?, ?, ?)`
    );
    insertMatch.run("lck1", "lck", 1, "T1", "DK", now, now);
    insertMatch.run("lec1", "lec", 1, "G2", "MKOI", now, now);

    const rows = parseLeagueBlobPredictionsFromDb(
      database,
      "LCK - LCK 2026 Road to MSI\nT1 2-0\n\nLEC - LEC 2026 Spring Playoffs\nMKOI 2-1",
      { modelId: "glm" }
    );

    expect(rows).toEqual([
      expect.objectContaining({ matchId: "lck1", tournamentName: "LCK 2026 Road to MSI", predictedWinner: "T1", predictedScore: "2-0", status: "valid" }),
      expect.objectContaining({ matchId: "lec1", tournamentName: "LEC 2026 Spring Playoffs", predictedWinner: "MKOI", predictedScore: "2-1", status: "valid" })
    ]);
  });
});
