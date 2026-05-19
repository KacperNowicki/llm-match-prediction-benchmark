import { inferBestOfFromScore, isValidScoreForBestOf, normalizeScoreText } from "../lib/scoreValidation";
import { resolveTeamToken } from "../lib/teamAliases";
import type { ParserMatch } from "./predictionParser";

export type ParsedResult = {
  matchId: string | null;
  matchOrder: number | null;
  actualWinner: string | null;
  actualScore: string | null;
  bestOf: number | null;
  rawLine: string;
  status: "valid" | "warning" | "error";
  messages: string[];
};

export function parseResultLines(rawInput: string, matches: ParserMatch[]): ParsedResult[] {
  const lines = rawInput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const rows = lines.map((line, index): ParsedResult => {
    const match = matches[index];
    const base: ParsedResult = {
      matchId: match?.id ?? null,
      matchOrder: match?.matchOrder ?? null,
      actualWinner: null,
      actualScore: null,
      bestOf: null,
      rawLine: line,
      status: "error",
      messages: []
    };

    if (!match) {
      base.messages.push("Result has no matching scheduled match.");
      return base;
    }

    const parts = line.includes("\t") ? line.split("\t") : line.split(/\s+(?=\d+\s*-\s*\d+)/);
    const winnerToken = (parts[0] ?? "").trim();
    const scoreText = normalizeScoreText(parts.slice(1).join(" ").trim());

    if (!winnerToken || !scoreText) {
      base.messages.push("Use Winner<TAB>Score, for example T1<TAB>2-1.");
      return base;
    }

    const resolved = resolveTeamToken(winnerToken, match.team1, match.team2);
    if (resolved.status !== "matched") {
      base.messages.push(resolved.message);
      return base;
    }

    let bestOf = match.bestOf;
    if (!isValidScoreForBestOf(match.bestOf, scoreText)) {
      const inferredBestOf = inferBestOfFromScore(scoreText);
      if (inferredBestOf && isValidScoreForBestOf(inferredBestOf, scoreText)) {
        bestOf = inferredBestOf;
        base.messages.push(`Adjusted match to BO${inferredBestOf} from score ${scoreText}.`);
      } else {
        base.messages.push(`Score ${scoreText} is illegal for BO${match.bestOf}.`);
        return base;
      }
    }

    base.actualWinner = resolved.team;
    base.actualScore = scoreText;
    base.bestOf = bestOf;
    if (resolved.warning) base.messages.push(resolved.warning);
    base.status = base.messages.length > 0 ? "warning" : "valid";
    return base;
  });

  if (lines.length !== matches.length) {
    rows.push({
      matchId: null,
      matchOrder: null,
      actualWinner: null,
      actualScore: null,
      bestOf: null,
      rawLine: "",
      status: "error",
      messages: [`Result count mismatch: found ${lines.length}, expected ${matches.length}.`]
    });
  }

  return rows;
}
