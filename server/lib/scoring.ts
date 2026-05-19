import { sameTeam } from "./teamAliases";

export type ScoreInput = {
  predictedWinner: string;
  predictedScore: string;
  actualWinner: string | null;
  actualScore: string | null;
};

export type ScoreResult = {
  winnerPoint: number;
  scorePoint: number;
  total: number;
};

export function scorePrediction(input: ScoreInput): ScoreResult {
  if (!input.actualWinner || !input.actualScore) {
    return { winnerPoint: 0, scorePoint: 0, total: 0 };
  }

  const winnerPoint = sameTeam(input.predictedWinner, input.actualWinner) ? 1 : 0;
  const scorePoint = winnerPoint === 1 && input.predictedScore === input.actualScore ? 1 : 0;
  return { winnerPoint, scorePoint, total: winnerPoint + scorePoint };
}

