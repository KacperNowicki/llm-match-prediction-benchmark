import { config } from "../config";

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function startOfUtcDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value || !isoDatePattern.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getLeagueWeekRange(
  reference = new Date(),
  startDay = config.leagueWeekStartDay
): { start: string; end: string } {
  const date = startOfUtcDate(reference);
  const day = date.getUTCDay();
  const diff = (day - startDay + 7) % 7;
  const start = new Date(date);
  start.setUTCDate(start.getUTCDate() - diff);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { start: toIsoDate(start), end: toIsoDate(end) };
}

export function addUtcDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function isIsoDateInRange(value: string | null, start: string | null, end: string | null): boolean {
  if (!value) return false;
  const date = value.slice(0, 10);
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}
