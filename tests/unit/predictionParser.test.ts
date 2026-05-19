import { describe, expect, it } from "vitest";
import { getLeagueWeekRange, isIsoDateInRange } from "../../server/lib/dateWeeks";
import { isValidScoreForBestOf } from "../../server/lib/scoreValidation";
import { scorePrediction } from "../../server/lib/scoring";
import { parsePredictionLine, parsePredictionsForMatches, type ParserMatch } from "../../server/parsers/predictionParser";
import { parseResultLines } from "../../server/parsers/resultParser";
import { parseLegacyTsv } from "../../server/services/imports";
import { parseLeaguepediaScheduleCopy } from "../../server/services/matches";

const bo3Match: ParserMatch = {
  id: "match_1",
  matchOrder: 1,
  team1: "T1",
  team2: "DK",
  bestOf: 3
};

const bo5Match: ParserMatch = {
  id: "match_2",
  matchOrder: 2,
  team1: "DNS",
  team2: "DK",
  bestOf: 5
};

describe("score validation", () => {
  it("accepts BO3 scores", () => {
    expect(isValidScoreForBestOf(3, "2-0")).toBe(true);
    expect(isValidScoreForBestOf(3, "2-1")).toBe(true);
    expect(isValidScoreForBestOf(3, "3-0")).toBe(false);
  });

  it("accepts BO5 scores", () => {
    expect(isValidScoreForBestOf(5, "3-0")).toBe(true);
    expect(isValidScoreForBestOf(5, "3-1")).toBe(true);
    expect(isValidScoreForBestOf(5, "3-2")).toBe(true);
    expect(isValidScoreForBestOf(5, "2-1")).toBe(false);
  });
});

describe("prediction parser", () => {
  it("parses a simple BO3 prediction", () => {
    const row = parsePredictionLine("T1 2-0", bo3Match);
    expect(row.status).toBe("valid");
    expect(row.predictedWinner).toBe("T1");
    expect(row.predictedScore).toBe("2-0");
  });

  it("normalizes reversed score lines from winner perspective", () => {
    const row = parsePredictionLine("DNS 1-3 DK", bo5Match);
    expect(row.status).toBe("valid");
    expect(row.predictedWinner).toBe("DK");
    expect(row.predictedScore).toBe("3-1");
  });

  it("normalizes Grok and GLM TSV-style score columns", () => {
    const row = parsePredictionLine("GEN\t1 - 2\tKT", {
      id: "match_grok_glm",
      matchOrder: 5,
      team1: "GEN",
      team2: "KT",
      bestOf: 3
    });

    expect(row.status).toBe("valid");
    expect(row.predictedWinner).toBe("KT");
    expect(row.predictedScore).toBe("2-1");
  });

  it("skips simple TSV headers before matching prediction rows", () => {
    const rows = parsePredictionsForMatches("Team 1\tScore\tTeam 2\nGEN\t1 - 2\tKT", [
      {
        id: "match_tsv_header",
        matchOrder: 6,
        team1: "GEN",
        team2: "KT",
        bestOf: 3
      }
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "valid",
      predictedWinner: "KT",
      predictedScore: "2-1"
    });
  });

  it("handles accidental text prefixes as a warning", () => {
    const row = parsePredictionLine("textTL 2-1", {
      id: "match_3",
      matchOrder: 3,
      team1: "TL",
      team2: "C9",
      bestOf: 3
    });
    expect(row.status).toBe("warning");
    expect(row.predictedWinner).toBe("TL");
    expect(row.predictedScore).toBe("2-1");
  });

  it("prefers exact team aliases over fuzzy suffix matches", () => {
    const row = parsePredictionLine("DNS 2-1", {
      id: "match_4",
      matchOrder: 4,
      team1: "NS",
      team2: "DNS",
      bestOf: 3
    });
    expect(row.status).toBe("valid");
    expect(row.predictedWinner).toBe("DNS");
    expect(row.predictedScore).toBe("2-1");
  });

  it("rejects winners that are not in the match", () => {
    const row = parsePredictionLine("GEN 2-0", bo3Match);
    expect(row.status).toBe("error");
    expect(row.messages.join(" ")).toContain("is not T1 or DK");
  });

  it("emits prediction count mismatch", () => {
    const rows = parsePredictionsForMatches("T1 2-0", [bo3Match, bo5Match]);
    expect(rows.some((row) => row.messages.join(" ").includes("Prediction count mismatch"))).toBe(true);
  });
});

describe("result parser", () => {
  it("parses actual-result paste lines", () => {
    const rows = parseResultLines("T1\t2-1", [bo3Match]);
    expect(rows[0]).toMatchObject({
      status: "valid",
      actualWinner: "T1",
      actualScore: "2-1",
      bestOf: 3
    });
  });

  it("infers BO5 from a saved 3-x score when schedule BO is wrong", () => {
    const rows = parseResultLines("DNS\t3-2", [{ ...bo5Match, bestOf: 3 }]);
    expect(rows[0]).toMatchObject({
      status: "warning",
      actualWinner: "DNS",
      actualScore: "3-2",
      bestOf: 5
    });
    expect(rows[0].messages.join(" ")).toContain("Adjusted match to BO5");
  });
});

describe("scoring", () => {
  it("scores exact predictions as two points", () => {
    expect(scorePrediction({ predictedWinner: "T1", predictedScore: "2-0", actualWinner: "T1", actualScore: "2-0" })).toEqual({
      winnerPoint: 1,
      scorePoint: 1,
      total: 2
    });
  });

  it("scores correct winner with wrong score as one point", () => {
    expect(scorePrediction({ predictedWinner: "T1", predictedScore: "2-1", actualWinner: "T1", actualScore: "2-0" })).toEqual({
      winnerPoint: 1,
      scorePoint: 0,
      total: 1
    });
  });

  it("scores wrong winner as zero", () => {
    expect(scorePrediction({ predictedWinner: "DK", predictedScore: "2-1", actualWinner: "T1", actualScore: "2-0" }).total).toBe(0);
  });
});

describe("legacy sheet import parser", () => {
  it("reads current workbook-shaped TSV including model columns", () => {
    const parsed = parseLegacyTsv(
      "Match ID\tStage\tRound\tBO\tTeam1\tTeam2\tActual Winner\tActual Score\tGPT\tGrok\n" +
        "M1\tSpring\tW1D1\t3\tT1\tDK\tT1\t2-0\tT1 2-0\tDK 2-1"
    );

    expect(parsed.modelNames).toEqual(["GPT", "Grok"]);
    expect(parsed.rows[0]).toMatchObject({
      externalMatchId: "M1",
      actualWinner: "T1",
      actualScore: "2-0"
    });
    expect(parsed.rows[0].predictions[0]).toMatchObject({
      modelName: "GPT",
      predictedWinner: "T1",
      predictedScore: "2-0",
      status: "valid"
    });
  });

  it("ignores legacy Consensus columns because consensus is derived", () => {
    const parsed = parseLegacyTsv(
      "Match ID\tStage\tRound\tBO\tTeam1\tTeam2\tActual Winner\tActual Score\tConsensus\tGPT\n" +
        "M1\tSpring\tW1D1\t3\tT1\tDK\tT1\t2-0\tT1 2-0\tDK 2-1"
    );

    expect(parsed.modelNames).toEqual(["GPT"]);
    expect(parsed.rows[0].predictions).toHaveLength(1);
    expect(parsed.rows[0].predictions[0]).toMatchObject({
      modelName: "GPT",
      predictedWinner: "DK",
      predictedScore: "2-1"
    });
  });

  it("infers match length from legacy actual scores before parsing predictions", () => {
    const parsed = parseLegacyTsv(
      "Match ID\tStage\tRound\tBO\tTeam1\tTeam2\tActual Winner\tActual Score\tGPT\n" +
        "M14\tLEC Versus\tRound 4\t3\tG2\tMKOI\tG2\t3-0\tG2 3-1"
    );

    expect(parsed.rows[0]).toMatchObject({
      bestOf: 5,
      actualWinner: "G2",
      actualScore: "3-0"
    });
    expect(parsed.rows[0].messages.join(" ")).toContain("Adjusted match from BO3 to BO5");
    expect(parsed.rows[0].predictions[0]).toMatchObject({
      predictedWinner: "G2",
      predictedScore: "3-1",
      status: "valid"
    });
  });

  it("does not import winner-only actual results when the score is invalid", () => {
    const parsed = parseLegacyTsv(
      "Match ID\tStage\tRound\tBO\tTeam1\tTeam2\tActual Winner\tActual Score\tgpt\n" +
        "LCK-060\tRounds 1-2\tW6D5\t3\tKRX\tHLE\tHLE\t46054.0\tHLE 2-0"
    );

    expect(parsed.rows[0]).toMatchObject({
      actualWinner: null,
      actualScore: null
    });
    expect(parsed.rows[0].messages.join(" ")).toContain("Ignored actual result");
  });
});

describe("Leaguepedia schedule paste parser", () => {
  it("normalizes copied bracket text into matches", () => {
    const rows = parseLeaguepediaScheduleCopy(
      "Round 1\n" +
        "Sat 2026-05-23\n" +
        "KC\u2060\n" +
        "Karmine Corplogo std\n" +
        "\u2060\t17:00\t\u2060\n" +
        "G2 Esportslogo std\n" +
        "\u2060G2\n" +
        "Sun 2026-05-24\n" +
        "VIT\u2060\n" +
        "Team Vitalitylogo std\n" +
        "\u2060\t17:00\t\u2060\n" +
        "Movistar KOIlogo std\n" +
        "\u2060MKOI\n" +
        "[hide]\n" +
        "Finals\n" +
        "Sun 2026-06-07\n" +
        "TBD\u2060\n" +
        "TBDlogo std\n" +
        "\u2060\t17:00\t\u2060\n" +
        "TBDlogo std\n" +
        "\u2060TBD"
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      dateTimeUtc: "2026-05-23 17:00:00",
      roundLabel: "Round 1",
      bestOf: 3,
      team1: "KC",
      team2: "G2"
    });
    expect(rows[1]).toMatchObject({ team1: "VIT", team2: "MKOI" });
    expect(rows[2]).toMatchObject({ roundLabel: "Finals", team1: "TBD", team2: "TBD" });
  });
});

describe("Tuesday league week", () => {
  it("returns Tuesday through Monday for a mid-week reference date", () => {
    expect(getLeagueWeekRange(new Date("2026-05-21T12:00:00Z"))).toEqual({
      start: "2026-05-19",
      end: "2026-05-25"
    });
  });

  it("filters ISO date strings inclusively", () => {
    expect(isIsoDateInRange("2026-05-19T08:00:00Z", "2026-05-19", "2026-05-25")).toBe(true);
    expect(isIsoDateInRange("2026-05-26T08:00:00Z", "2026-05-19", "2026-05-25")).toBe(false);
  });
});
