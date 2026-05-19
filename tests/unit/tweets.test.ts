import { describe, expect, it } from "vitest";
import { formatPreweekTweetDraft } from "../../server/services/tweets";
import type { ConsensusPrediction } from "../../server/services/consensus";
import type { Match } from "../../server/services/types";

function match(input: Partial<Match> & Pick<Match, "id" | "matchOrder" | "team1" | "team2">): Match {
  return {
    tournamentId: "t1",
    externalMatchId: null,
    dateTimeUtc: null,
    stage: null,
    roundLabel: null,
    bestOf: 3,
    actualWinner: null,
    actualScore: null,
    actualSource: null,
    manualOverride: false,
    ...input
  };
}

function consensus(predictedWinner: string, predictedScore: string): ConsensusPrediction {
  return {
    modelId: "derived_consensus",
    modelName: "Consensus",
    isDerived: true,
    predictedWinner,
    predictedScore,
    rawLine: `${predictedWinner} ${predictedScore}`,
    parseStatus: "derived"
  };
}

describe("tweet drafts", () => {
  it("formats pre-week tweets as league plus consensus for each game only", () => {
    const draft = formatPreweekTweetDraft(
      { league: "LCK" },
      [
        match({ id: "m1", matchOrder: 1, team1: "T1", team2: "DK" }),
        match({ id: "m2", matchOrder: 2, team1: "GEN", team2: "HLE" }),
        match({ id: "m3", matchOrder: 3, team1: "PAST", team2: "OLD", actualWinner: "PAST", actualScore: "2-0" })
      ],
      new Map([
        ["m1", consensus("T1", "2-0")],
        ["m2", consensus("HLE", "2-1")]
      ])
    );

    expect(draft).toBe("LCK\nT1 vs DK: T1 2-0\nGEN vs HLE: HLE 2-1");
    expect(draft).not.toContain("prediction slate");
    expect(draft).not.toContain("#");
  });

  it("omits unresolved or consensus-missing matches from pre-week tweets", () => {
    const draft = formatPreweekTweetDraft(
      { league: "LEC" },
      [
        match({ id: "m1", matchOrder: 1, team1: "KC", team2: "G2" }),
        match({ id: "m2", matchOrder: 2, team1: "TBD", team2: "NAVI" }),
        match({ id: "m3", matchOrder: 3, team1: "Seed #5", team2: "Seed #6" }),
        match({ id: "m4", matchOrder: 4, team1: "VIT", team2: "MKOI" })
      ],
      new Map([["m1", consensus("G2", "3-2")]])
    );

    expect(draft).toBe("LEC\nKC vs G2: G2 3-2");
    expect(draft).not.toContain("TBD");
    expect(draft).not.toContain("Seed #5");
    expect(draft).not.toContain("consensus pending");
    expect(draft).not.toContain("VIT vs MKOI");
  });
});
