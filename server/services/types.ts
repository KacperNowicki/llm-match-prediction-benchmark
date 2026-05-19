export type Tournament = {
  id: string;
  name: string;
  league: string;
  season: number | null;
  stage: string | null;
  roundLabel: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  defaultBestOf: number;
  leaguepediaOverviewPage: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  matchCount: number;
  completedCount: number;
};

export type Model = {
  id: string;
  name: string;
  displayName: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type ModelStats = {
  modelId: string;
  totalPredictions: number;
  completedMatches: number;
  dataQualityIssueCount: number;
  wrongWinnerCount: number;
  exactMissCount: number;
  missingCompletedCount: number;
};

export type Match = {
  id: string;
  tournamentId: string;
  matchOrder: number;
  externalMatchId: string | null;
  dateTimeUtc: string | null;
  stage: string | null;
  roundLabel: string | null;
  bestOf: number;
  team1: string;
  team2: string;
  actualWinner: string | null;
  actualScore: string | null;
  actualSource: string | null;
  manualOverride: boolean;
  predictionCount?: number;
};

export type Prediction = {
  id: string;
  matchId: string;
  modelId: string;
  predictedWinner: string;
  predictedScore: string;
  rawInput: string | null;
  rawLine: string | null;
  parseStatus: string;
  createdAt: string;
  updatedAt: string;
};

export type PredictionCellOutcome = "missing" | "pending" | "exact" | "score-miss" | "wrong-winner";

export type MatchPredictionCell = {
  modelId: string;
  modelName: string;
  isDerived?: boolean;
  predictedWinner: string | null;
  predictedScore: string | null;
  rawLine: string | null;
  parseStatus: string | null;
  outcome: PredictionCellOutcome;
};

export type MatchPredictionRow = {
  match: Match;
  predictions: MatchPredictionCell[];
};

export type ScoreRow = {
  modelId: string;
  modelName: string;
  totalPoints: number;
  possiblePoints: number;
  winnerCorrect: number;
  exactCorrect: number;
  completedPredictions: number;
  winnerAccuracy: number;
  exactAccuracy: number;
};
