import {
  isValidScoreForBestOf,
  normalizeScoreText,
  scoreFromWinnerPerspective
} from "../lib/scoreValidation";
import { resolveTeamToken } from "../lib/teamAliases";

export type ParserMatch = {
  id: string;
  matchOrder: number;
  team1: string;
  team2: string;
  bestOf: number;
};

export type ParsedPrediction = {
  matchId: string | null;
  matchOrder: number | null;
  tournamentId?: string;
  tournamentName?: string;
  league?: string;
  team1?: string;
  team2?: string;
  bestOf?: number;
  predictedWinner: string | null;
  predictedScore: string | null;
  rawLine: string;
  status: "valid" | "warning" | "error";
  messages: string[];
};

const scorePattern = /(\d+)\s*-\s*(\d+)/;

function isPredictionHeaderLine(line: string): boolean {
  const normalized = line.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalized || scorePattern.test(line)) return false;
  return (
    /^(team\s*)?1\s+score\s+(team\s*)?2$/.test(normalized) ||
    /^team\s*a\s+score\s+team\s*b$/.test(normalized) ||
    /^team\s+score\s+team$/.test(normalized) ||
    /^winner\s+score$/.test(normalized)
  );
}

export function cleanPredictionLines(rawInput: string): string[] {
  return rawInput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("```"))
    .map((line) => line.replace(/^\d+[\).\s-]+/, "").trim())
    .filter((line) => !isPredictionHeaderLine(line));
}

function firstTeamLikeToken(text: string): string | null {
  const withoutVs = text.split(/\bvs\.?\b|:/i).pop() ?? text;
  const tokens = withoutVs.match(/[A-Za-z0-9][A-Za-z0-9 ._'&-]*/g);
  if (!tokens || tokens.length === 0) return null;
  return tokens[tokens.length - 1].trim();
}

function lastTeamLikeToken(text: string): string | null {
  const tokens = text.match(/[A-Za-z0-9][A-Za-z0-9 ._'&-]*/g);
  if (!tokens || tokens.length === 0) return null;
  return tokens[0].trim();
}

export function parsePredictionLine(rawLine: string, match: ParserMatch | undefined): ParsedPrediction {
  const base: ParsedPrediction = {
    matchId: match?.id ?? null,
    matchOrder: match?.matchOrder ?? null,
    team1: match?.team1,
    team2: match?.team2,
    bestOf: match?.bestOf,
    predictedWinner: null,
    predictedScore: null,
    rawLine,
    status: "error",
    messages: []
  };

  if (!match) {
    base.messages.push("Prediction has no matching scheduled match.");
    return base;
  }

  const scoreMatch = rawLine.match(scorePattern);
  if (!scoreMatch || scoreMatch.index === undefined) {
    base.messages.push("No score found.");
    return base;
  }

  const leftScore = Number(scoreMatch[1]);
  const rightScore = Number(scoreMatch[2]);
  const winnerPerspectiveScore = scoreFromWinnerPerspective(leftScore, rightScore);
  if (!winnerPerspectiveScore) {
    base.messages.push("Tied scores are not valid predictions.");
    return base;
  }

  const beforeScore = rawLine.slice(0, scoreMatch.index).trim();
  const afterScore = rawLine.slice(scoreMatch.index + scoreMatch[0].length).trim();
  const winnerToken = leftScore > rightScore ? firstTeamLikeToken(beforeScore) : lastTeamLikeToken(afterScore);

  if (!winnerToken) {
    base.messages.push("Could not identify a winner beside the score.");
    return base;
  }

  const resolved = resolveTeamToken(winnerToken, match.team1, match.team2);
  if (resolved.status !== "matched") {
    base.messages.push(resolved.message);
    return base;
  }

  base.predictedWinner = resolved.team;
  base.predictedScore = normalizeScoreText(winnerPerspectiveScore);

  if (!base.predictedScore || !isValidScoreForBestOf(match.bestOf, base.predictedScore)) {
    base.messages.push(`Score ${winnerPerspectiveScore} is illegal for BO${match.bestOf}.`);
    return base;
  }

  if (resolved.warning) base.messages.push(resolved.warning);
  base.status = base.messages.length > 0 ? "warning" : "valid";
  return base;
}

export function parsePredictionsForMatches(rawInput: string, matches: ParserMatch[]): ParsedPrediction[] {
  const lines = cleanPredictionLines(rawInput);
  const parsed = lines.map((line, index) => parsePredictionLine(line, matches[index]));

  if (lines.length !== matches.length) {
    parsed.push({
      matchId: null,
      matchOrder: null,
      predictedWinner: null,
      predictedScore: null,
      rawLine: "",
      status: "error",
      messages: [`Prediction count mismatch: found ${lines.length}, expected ${matches.length}.`]
    });
  }

  const seen = new Set<string>();
  for (const row of parsed) {
    if (!row.matchId) continue;
    if (seen.has(row.matchId)) {
      row.status = "error";
      row.messages.push("Duplicate match prediction.");
    }
    seen.add(row.matchId);
  }

  return parsed;
}
