export function isUnresolvedTeamName(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return true;
  return (
    normalized === "tbd" ||
    normalized === "bye" ||
    /^seed\s*#?\d+$/.test(normalized) ||
    /^round\s+\d+\s+winner$/.test(normalized) ||
    /^round\s+\d+\s+loser$/.test(normalized) ||
    /^(winner|loser)\s+(of\s+)?/.test(normalized) ||
    /\b(winner|loser)\s+of\b/.test(normalized)
  );
}
