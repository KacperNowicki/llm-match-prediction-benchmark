import { getTournamentScores } from "./scoring";
import { getTournament } from "./tournaments";
import { listMatches } from "./matches";
import { getConsensusPredictionsForMatchesFromDb, type ConsensusPrediction } from "./consensus";
import { getDb } from "../db/connection";
import { isUnresolvedTeamName } from "../lib/teamPlaceholders";
import type { Match, Tournament } from "./types";

export type TweetDraftType = "leaderboard" | "preweek" | "recap" | "league";

function emptyCombinedMessage(type: TweetDraftType): string {
  if (type === "preweek") return "No selected tournaments have resolved Consensus picks yet.";
  if (type === "recap") return "No selected tournaments have completed results to recap yet.";
  if (type === "league") return "No selected tournaments have scored matches yet.";
  return "No selected tournaments have completed prediction scores yet. Switch to Pre-week for unresolved matches with Consensus picks.";
}

function leaderboard(tournamentId: string, includeEmpty = true): string {
  const tournament = getTournament(tournamentId);
  const scores = getTournamentScores(tournamentId)
    .filter((row) => row.completedPredictions > 0)
    .slice(0, 5);

  if (scores.length === 0) {
    return includeEmpty ? `${tournament.name}\n\nNo completed prediction scores yet.` : "";
  }

  const leaderboard = scores
    .map((row, index) => `${index + 1}. ${row.modelName}: ${row.totalPoints}/${row.possiblePoints}`)
    .join("\n");

  return `${tournament.name} LLM prediction leaderboard\n\n${leaderboard}\n\n#LoLEsports`;
}

export function formatPreweekTweetDraft(
  tournament: Pick<Tournament, "league">,
  matches: Match[],
  consensusByMatch: Map<string, ConsensusPrediction>
): string {
  const lines = matches
    .filter((match) => !match.actualWinner && !match.actualScore)
    .filter((match) => ![match.team1, match.team2].some(isUnresolvedTeamName))
    .map((match) => {
      const consensus = consensusByMatch.get(match.id);
      if (!consensus?.predictedWinner || !consensus.predictedScore) return null;
      return `${match.team1} vs ${match.team2}: ${consensus.predictedWinner} ${consensus.predictedScore}`;
    })
    .filter((line): line is string => Boolean(line))
    .slice(0, 10);

  return [tournament.league, ...lines].join("\n");
}

function preweek(tournamentId: string, includeEmpty = true): string {
  const tournament = getTournament(tournamentId);
  const matches = listMatches(tournamentId);
  const consensus = getConsensusPredictionsForMatchesFromDb(getDb(), tournamentId, matches);
  const draft = formatPreweekTweetDraft(tournament, matches, consensus);
  const hasPicks = draft.split("\n").filter(Boolean).length > 1;
  if (!hasPicks) return includeEmpty ? `${tournament.league}\n\nNo resolved Consensus picks yet.` : "";
  return draft;
}

function recap(tournamentId: string, includeEmpty = true): string {
  const tournament = getTournament(tournamentId);
  const matches = listMatches(tournamentId).filter((match) => match.actualWinner && match.actualScore).slice(0, 10);
  if (matches.length === 0) return includeEmpty ? `${tournament.name}\n\nNo completed results to recap yet.` : "";
  const lines = matches.map((match) => `${match.actualWinner} ${match.actualScore} vs ${match.actualWinner === match.team1 ? match.team2 : match.team1}`);
  return `${tournament.name} result recap\n\n${lines.join("\n")}\n\nLeaderboard updated in the local tracker.\n\n#LoLEsports`;
}

function league(tournamentId: string, includeEmpty = true): string {
  const tournament = getTournament(tournamentId);
  const scores = getTournamentScores(tournamentId).filter((row) => row.completedPredictions > 0);
  const completed = listMatches(tournamentId).filter((match) => match.actualWinner && match.actualScore).length;
  const leader = scores[0];
  if (completed === 0 && !leader) return includeEmpty ? `${tournament.league}\n\nNo scored matches yet.` : "";
  return `${tournament.league} LLM benchmark update\n\n${tournament.name}: ${completed}/${tournament.matchCount} matches scored.\n${leader ? `Current leader: ${leader.modelName} with ${leader.totalPoints}/${leader.possiblePoints}.` : "No model leader yet."}\n\n#${tournament.league} #LoLEsports`;
}

export function generateTweetDraft(tournamentId: string, type: TweetDraftType = "leaderboard", includeEmpty = true): string {
  if (type === "preweek") return preweek(tournamentId, includeEmpty);
  if (type === "recap") return recap(tournamentId, includeEmpty);
  if (type === "league") return league(tournamentId, includeEmpty);
  return leaderboard(tournamentId, includeEmpty);
}

export function generateCombinedTweetDraft(tournamentIds: string[], type: TweetDraftType = "leaderboard"): string {
  const uniqueIds = [...new Set(tournamentIds)].filter(Boolean);
  if (uniqueIds.length === 0) return "";
  const drafts = uniqueIds.map((id) => generateTweetDraft(id, type, false)).filter(Boolean);
  return drafts.length ? drafts.join("\n\n") : emptyCombinedMessage(type);
}

export const generateLeaderboardTweet = leaderboard;
