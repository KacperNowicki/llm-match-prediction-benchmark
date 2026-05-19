export type TeamResolution =
  | { status: "matched"; team: string; warning?: string }
  | { status: "ambiguous"; message: string }
  | { status: "unknown"; message: string };

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function initials(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .toLowerCase();
}

function aliasesFor(team: string): Set<string> {
  const base = normalize(team);
  const values = new Set<string>([base]);
  const initialValue = initials(team);
  if (initialValue.length > 1) values.add(initialValue);
  return values;
}

function tokenMatchesTeam(token: string, team: string): { matched: boolean; exact: boolean; warning?: string } {
  const tokenNorm = normalize(token);
  if (!tokenNorm) return { matched: false, exact: false };
  for (const alias of aliasesFor(team)) {
    if (tokenNorm === alias) return { matched: true, exact: true };
  }
  for (const alias of aliasesFor(team)) {
    if (alias.length >= 2 && tokenNorm.endsWith(alias) && tokenNorm.length - alias.length <= 8) {
      return { matched: true, exact: false, warning: `"${token.trim()}" was normalized to "${team}".` };
    }
  }
  return { matched: false, exact: false };
}

export function resolveTeamToken(token: string, team1: string, team2: string): TeamResolution {
  const left = tokenMatchesTeam(token, team1);
  const right = tokenMatchesTeam(token, team2);

  if (left.exact && !right.exact) return { status: "matched", team: team1, warning: left.warning };
  if (right.exact && !left.exact) return { status: "matched", team: team2, warning: right.warning };

  if (left.matched && right.matched) {
    return { status: "ambiguous", message: `Winner "${token.trim()}" matches both teams.` };
  }

  if (left.matched) return { status: "matched", team: team1, warning: left.warning };
  if (right.matched) return { status: "matched", team: team2, warning: right.warning };

  return {
    status: "unknown",
    message: `Winner "${token.trim()}" is not ${team1} or ${team2}.`
  };
}

export function sameTeam(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalize(a) === normalize(b);
}
