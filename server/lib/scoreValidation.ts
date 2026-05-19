export type BestOf = 1 | 3 | 5;

const validScores: Record<BestOf, string[]> = {
  1: ["1-0"],
  3: ["2-0", "2-1"],
  5: ["3-0", "3-1", "3-2"]
};

export function toBestOf(value: unknown): BestOf {
  const numeric = Number(value);
  if (numeric === 1 || numeric === 3 || numeric === 5) return numeric;
  return 3;
}

export function normalizeScoreText(score: string): string | null {
  const match = score.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) return null;
  return `${Number(match[1])}-${Number(match[2])}`;
}

export function scoreFromWinnerPerspective(leftScore: number, rightScore: number): string | null {
  if (leftScore === rightScore) return null;
  const high = Math.max(leftScore, rightScore);
  const low = Math.min(leftScore, rightScore);
  return `${high}-${low}`;
}

export function isValidScoreForBestOf(bestOf: number, score: string): boolean {
  const normalized = normalizeScoreText(score);
  if (!normalized) return false;
  const bo = toBestOf(bestOf);
  return validScores[bo].includes(normalized);
}

export function inferBestOfFromScore(score: string): BestOf | null {
  const normalized = normalizeScoreText(score);
  if (!normalized) return null;
  const [left, right] = normalized.split("-").map(Number);
  const high = Math.max(left, right);
  if (high === 1) return 1;
  if (high === 2) return 3;
  if (high === 3) return 5;
  return null;
}

export function getValidScores(bestOf: number): string[] {
  return validScores[toBestOf(bestOf)];
}

export function describeValidScores(bestOf: number): string {
  return getValidScores(bestOf).join(" or ");
}
