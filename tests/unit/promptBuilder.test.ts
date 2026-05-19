import { describe, expect, it } from "vitest";
import { isUnresolvedTeamName } from "../../server/lib/teamPlaceholders";
import { buildMultiTournamentPredictionPrompt } from "../../server/prompts/promptBuilder";

describe("prompt builder", () => {
  it("recognizes unresolved bracket participants", () => {
    expect(isUnresolvedTeamName("TBD")).toBe(true);
    expect(isUnresolvedTeamName("Seed #5")).toBe(true);
    expect(isUnresolvedTeamName("Round 1 Winner")).toBe(true);
    expect(isUnresolvedTeamName("Winner of Match 3")).toBe(true);
    expect(isUnresolvedTeamName("T1")).toBe(false);
  });

  it("builds one grouped prompt across active tournament slates", () => {
    const prompt = buildMultiTournamentPredictionPrompt([
      {
        tournamentTitle: "LCK 2026 Road to MSI",
        league: "LCK",
        defaultBestOf: 5,
        matches: [
          { id: "m1", matchOrder: 1, team1: "T1", team2: "DK", bestOf: 5 }
        ]
      },
      {
        tournamentTitle: "LEC 2026 Spring Playoffs",
        league: "LEC",
        defaultBestOf: 3,
        matches: [
          { id: "m2", matchOrder: 1, team1: "G2", team2: "MKOI", bestOf: 3 },
          { id: "m3", matchOrder: 2, team1: "KC", team2: "FNC", bestOf: 5 }
        ]
      }
    ]);

    expect(prompt).toContain("exactly one TSV codeblock total");
    expect(prompt).toContain("write the league/tournament header line exactly as shown");
    expect(prompt).toContain("LCK - LCK 2026 Road to MSI");
    expect(prompt).toContain("1. T1 vs DK");
    expect(prompt).toContain("LEC - LEC 2026 Spring Playoffs");
    expect(prompt).toContain("1. G2 vs MKOI (BO3)");
    expect(prompt).toContain("2. KC vs FNC (BO5)");
  });
});
