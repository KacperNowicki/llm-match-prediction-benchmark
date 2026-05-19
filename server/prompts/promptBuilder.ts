import { describeValidScores, toBestOf } from "../lib/scoreValidation";
import type { ParserMatch } from "../parsers/predictionParser";

export type PromptMatchGroup = {
  tournamentTitle: string;
  league: string;
  defaultBestOf: number;
  matches: ParserMatch[];
};

function formatMatchLines(matches: ParserMatch[], includeBestOf: boolean): string {
  const lines = matches
    .map((match, index) => {
      const bestOf = includeBestOf ? ` (BO${toBestOf(match.bestOf)})` : "";
      return `${index + 1}. ${match.team1} vs ${match.team2}${bestOf}`;
    })
    .join("\n");
  return lines || "No upcoming non-TBD matches are available for this selection.";
}

export function buildPredictionPrompt(options: {
  tournamentTitle: string;
  league: string;
  bestOf: number;
  matches: ParserMatch[];
}): string {
  const bestOf = toBestOf(options.bestOf);
  const scores = describeValidScores(bestOf);
  const matchLines = formatMatchLines(options.matches, false);

  return [
    "Use web search to look up the latest information about each team's recent form, roster changes, standings, and head-to-head records for the 2026 season. Think step by step about each matchup before predicting. Then predict the winner and score for all matches below.",
    "",
    `All matches are Best of ${bestOf}. Possible scores are ${scores}.`,
    "",
    `After your analysis, respond with a final answer section containing exactly 1 TSV codeblock for ${options.league}.`,
    "",
    `For the ${options.league} block, include one prediction per line in ONLY the format:`,
    `"TeamName ${scores.split(" or ")[0]}"`,
    "or",
    `"TeamName ${scores.split(" or ")[1] ?? scores.split(" or ")[0]}"`,
    "",
    "Match the order given below. Do not add any extra text, explanations, labels inside the codeblock, or commentary after the final answer section.",
    "",
    options.tournamentTitle,
    matchLines
  ].join("\n");
}

export function buildMultiTournamentPredictionPrompt(groups: PromptMatchGroup[]): string {
  const nonEmptyGroups = groups.filter((group) => group.matches.length > 0);
  const bodyGroups = nonEmptyGroups.length > 0 ? nonEmptyGroups : groups.slice(0, 1);
  const sections = bodyGroups
    .map((group) => {
      const bestOfSet = new Set(group.matches.map((match) => toBestOf(match.bestOf)));
      const includeBestOf = bestOfSet.size !== 1;
      const scores =
        bestOfSet.size === 1
          ? `All matches in this block are Best of ${[...bestOfSet][0]}. Possible scores are ${describeValidScores([...bestOfSet][0])}.`
          : "Each match line includes BO. BO1 scores: 1-0. BO3 scores: 2-0 or 2-1. BO5 scores: 3-0, 3-1, or 3-2.";

      return [
        `${group.league} - ${group.tournamentTitle}`,
        scores,
        formatMatchLines(group.matches, includeBestOf)
      ].join("\n");
    })
    .join("\n\n");

  return [
    "Use web search to look up the latest information about each team's recent form, roster changes, standings, and head-to-head records for the 2026 season. Think step by step about each matchup before predicting. Then predict the winner and score for all matches below.",
    "",
    "After your analysis, respond with a final answer section containing exactly one TSV codeblock total.",
    "",
    "Inside that one codeblock, write the league/tournament header line exactly as shown below, then one prediction per line in ONLY the format:",
    '"TeamName score"',
    "",
    "Then write the next league/tournament header and its predictions. Match the order given in each block. Do not add explanations, extra labels inside the codeblock, or commentary after the final answer section.",
    "",
    sections || "No upcoming non-TBD matches are available for this selection."
  ].join("\n");
}
