import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config";
import { getDb, withTransaction, type AppDatabase } from "../db/connection";
import { copyPrimaryToSafety } from "../db/safety";
import { HttpError } from "../lib/httpError";
import { createId, nowIso, stableId } from "../lib/id";
import { isConsensusModelName } from "../lib/modelNames";
import {
  inferBestOfFromScore,
  isValidScoreForBestOf,
  normalizeScoreText,
  scoreFromWinnerPerspective,
  toBestOf
} from "../lib/scoreValidation";
import { resolveTeamToken } from "../lib/teamAliases";
import { parsePredictionLine, type ParserMatch } from "../parsers/predictionParser";
import { writeAudit } from "./audit";
import { mapMatch, mapModel } from "./mappers";
import { createTournament, getTournament } from "./tournaments";
import type { Match, Model } from "./types";

type LegacyModelPrediction = {
  modelName: string;
  rawCell: string;
  status: "valid" | "warning" | "error";
  predictedWinner: string | null;
  predictedScore: string | null;
  messages: string[];
};

export type ParsedLegacyRow = {
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
  predictions: LegacyModelPrediction[];
  messages: string[];
};

export type LegacyImportPreview = {
  rows: ParsedLegacyRow[];
  modelNames: string[];
  messages: string[];
};

export type ImportSummary = {
  source: string;
  tournamentsImported: number;
  matchesImported: number;
  predictionsImported: number;
  modelsCreated: number;
  skippedManualResults: number;
  messages: string[];
};

type WorkbookTable = {
  sheetName: string;
  rows: string[][];
};

type IncomingLeaguepediaMatch = {
  matchOrder: number;
  externalMatchId: string | null;
  leaguepediaMatchId: string | null;
  overviewPage: string | null;
  dateTimeUtc: string | null;
  stage: string | null;
  roundLabel: string | null;
  phase: string | null;
  tab: string | null;
  bestOf: number;
  team1: string;
  team2: string;
  actualWinner: string | null;
  actualScore: string | null;
};

export type LeaguepediaDiff = {
  key: string;
  action: "create" | "update" | "unchanged";
  existingMatchId: string | null;
  incoming: IncomingLeaguepediaMatch;
  changes: Array<{ field: string; before: string | number | null; after: string | number | null; protected?: boolean }>;
};

export type LeaguepediaTournamentOption = {
  name: string;
  overviewPage: string;
  dateStart: string | null;
  dateEnd: string | null;
  league: string | null;
  region: string | null;
  tournamentLevel: string | null;
  isOfficial: boolean;
  year: string | null;
};

type LeaguepediaCacheHit = {
  rows: Record<string, unknown>[];
  fetchedAt: string;
};

let leaguepediaQueue: Promise<void> = Promise.resolve();
let lastLeaguepediaRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function leaguepediaRateLimitMessage(label: string): string {
  return `${label} is being rate-limited by Leaguepedia/Fandom. The app will wait about a minute between live requests; try again after the cooldown if no cached result is available.`;
}

function isLeaguepediaRateLimit(payload: { error?: { code?: string; info?: string } } | null): boolean {
  const info = payload?.error?.info ?? "";
  return payload?.error?.code === "ratelimited" || /rate limit/i.test(info);
}

function isRateLimitError(error: unknown): boolean {
  return error instanceof HttpError && error.status === 429;
}

function leaguepediaQueryHash(query: unknown): string {
  return createHash("sha256").update(JSON.stringify(query)).digest("hex");
}

function readLeaguepediaCache(queryHash: string): LeaguepediaCacheHit | null {
  const db = getDb();
  const row = db
    .prepare("SELECT response_json, fetched_at FROM leaguepedia_cache WHERE query_hash = ? LIMIT 1")
    .get(queryHash) as { response_json: string; fetched_at: string } | undefined;
  if (!row) return null;
  try {
    return { rows: JSON.parse(row.response_json) as Record<string, unknown>[], fetchedAt: row.fetched_at };
  } catch {
    return null;
  }
}

function writeLeaguepediaCache(queryHash: string, query: unknown, rows: Record<string, unknown>[]): void {
  const db = getDb();
  const now = nowIso();
  db.prepare(
    `INSERT INTO leaguepedia_cache (id, query_hash, query_json, response_json, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(query_hash) DO UPDATE SET
       query_json = excluded.query_json,
       response_json = excluded.response_json,
       fetched_at = excluded.fetched_at`
  ).run(createId("leaguepedia_cache"), queryHash, JSON.stringify(query), JSON.stringify(rows), now);
}

async function runLeaguepediaRequest<T>(work: () => Promise<T>, label: string): Promise<T> {
  let result!: T;
  const run = leaguepediaQueue.then(async () => {
    const elapsed = Date.now() - lastLeaguepediaRequestAt;
    const waitMs = Math.max(0, config.leaguepediaMinRequestIntervalMs - elapsed);
    if (waitMs > 0) await sleep(waitMs);
    lastLeaguepediaRequestAt = Date.now();
    try {
      result = await work();
    } catch (error) {
      if (!isRateLimitError(error)) throw error;
      await sleep(config.leaguepediaRateLimitRetryMs);
      lastLeaguepediaRequestAt = Date.now();
      result = await work();
    }
  });
  leaguepediaQueue = run.then(
    () => undefined,
    () => undefined
  );
  await run.catch((error) => {
    if (isRateLimitError(error)) throw new HttpError(429, leaguepediaRateLimitMessage(label));
    throw error;
  });
  return result;
}

async function fetchLeaguepediaCargoRows(
  url: URL,
  query: Record<string, unknown>,
  label: string
): Promise<Record<string, unknown>[]> {
  const queryHash = leaguepediaQueryHash(query);
  const cached = readLeaguepediaCache(queryHash);
  try {
    const rows = await runLeaguepediaRequest(async () => {
      const response = await fetch(url, {
        headers: {
          "user-agent": "LoLPredictionHub/0.1 local workflow tool"
        }
      });
      if (!response.ok) throw new HttpError(502, `${label} failed: ${response.status}.`);
      const payload = (await response.json()) as {
        cargoquery?: Array<{ title?: Record<string, unknown> }>;
        error?: { code?: string; info?: string };
      };
      if (isLeaguepediaRateLimit(payload)) throw new HttpError(429, leaguepediaRateLimitMessage(label));
      if (payload.error) throw new HttpError(502, payload.error.info ?? `${label} failed.`);
      return (payload.cargoquery ?? []).map((item) => item.title ?? (item as Record<string, unknown>));
    }, label);
    writeLeaguepediaCache(queryHash, query, rows);
    return rows;
  } catch (error) {
    if (cached && isRateLimitError(error)) return cached.rows;
    throw error;
  }
}

function cleanCell(value: unknown): string {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}

function normalizeHeader(value: string): string {
  return cleanCell(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function splitTsv(rawInput: string): string[][] {
  return rawInput
    .split(/\r?\n/)
    .map((line) => line.split("\t").map(cleanCell))
    .filter((cells) => cells.some(Boolean));
}

function headerIndex(headers: string[], names: string[]): number {
  const normalized = names.map(normalizeHeader);
  return headers.findIndex((header) => normalized.includes(header));
}

function parseBestOf(value: string, fallback = 3): number {
  const match = value.match(/\d+/);
  return toBestOf(match ? Number(match[0]) : fallback);
}

function normalizeWinnerScore(
  winnerRaw: string,
  scoreRaw: string,
  team1: string,
  team2: string,
  bestOf: number
): { winner: string | null; score: string | null; bestOf: number | null; message?: string } {
  if (!winnerRaw && !scoreRaw) return { winner: null, score: null, bestOf: null };
  if (!winnerRaw || !scoreRaw) {
    return {
      winner: null,
      score: null,
      bestOf: null,
      message: `Ignored incomplete actual result: winner "${winnerRaw || "-"}", score "${scoreRaw || "-"}".`
    };
  }
  const winner = resolveTeamToken(winnerRaw, team1, team2);
  if (winner.status !== "matched") return { winner: null, score: null, bestOf: null, message: winner.message };

  const normalized = normalizeScoreText(scoreRaw);
  if (normalized && isValidScoreForBestOf(bestOf, normalized)) {
    return { winner: winner.team, score: normalized, bestOf };
  }

  const match = scoreRaw.match(/(\d+)\s*-\s*(\d+)/);
  if (!match) {
    return {
      winner: null,
      score: null,
      bestOf: null,
      message: `Ignored actual result for ${team1} vs ${team2}: score "${scoreRaw}" is not a score.`
    };
  }
  const fromWinnerPerspective = scoreFromWinnerPerspective(Number(match[1]), Number(match[2]));
  if (fromWinnerPerspective && isValidScoreForBestOf(bestOf, fromWinnerPerspective)) {
    return { winner: winner.team, score: fromWinnerPerspective, bestOf };
  }
  const inferredBestOf = fromWinnerPerspective ? inferBestOfFromScore(fromWinnerPerspective) : null;
  if (fromWinnerPerspective && inferredBestOf && isValidScoreForBestOf(inferredBestOf, fromWinnerPerspective)) {
    return {
      winner: winner.team,
      score: fromWinnerPerspective,
      bestOf: inferredBestOf,
      message: `Adjusted match from BO${bestOf} to BO${inferredBestOf} based on actual score ${fromWinnerPerspective}.`
    };
  }
  return {
    winner: null,
    score: null,
    bestOf: null,
    message: `Ignored actual result for ${team1} vs ${team2}: score "${scoreRaw}" is illegal for BO${bestOf}.`
  };
}

export function parseLegacyTsv(rawInput: string, defaultBestOf = 3): LegacyImportPreview {
  const rows = splitTsv(rawInput);
  if (rows.length === 0) return { rows: [], modelNames: [], messages: ["No rows found."] };

  const headers = rows[0].map(normalizeHeader);
  const matchIdIndex = headerIndex(headers, ["Match ID", "MatchID", "ID"]);
  const dateIndex = headerIndex(headers, ["Date", "Date Time", "DateTime", "UTC", "DateTimeUTC"]);
  const stageIndex = headerIndex(headers, ["Stage"]);
  const roundIndex = headerIndex(headers, ["Round"]);
  const boIndex = headerIndex(headers, ["BO", "Best Of", "BestOf"]);
  const team1Index = headerIndex(headers, ["Team1", "Team 1"]);
  const team2Index = headerIndex(headers, ["Team2", "Team 2"]);
  const actualWinnerIndex = headerIndex(headers, ["Actual Winner", "ActualWinner", "Winner"]);
  const actualScoreIndex = headerIndex(headers, ["Actual Score", "ActualScore", "Score"]);
  const knownIndexes = new Set(
    [
      matchIdIndex,
      dateIndex,
      stageIndex,
      roundIndex,
      boIndex,
      team1Index,
      team2Index,
      actualWinnerIndex,
      actualScoreIndex
    ].filter((index) => index >= 0)
  );

  if (team1Index < 0 || team2Index < 0) {
    return { rows: [], modelNames: [], messages: ["Import needs Team1 and Team2 columns."] };
  }

  const modelColumns = rows[0]
    .map((header, index) => ({ name: cleanCell(header), index }))
    .filter((column) => column.name && !knownIndexes.has(column.index) && !isConsensusModelName(column.name));

  const parsedRows = rows.slice(1).flatMap((cells, rowIndex): ParsedLegacyRow[] => {
    const team1 = cleanCell(cells[team1Index]);
    const team2 = cleanCell(cells[team2Index]);
    if (!team1 || !team2) return [];
    const parsedBestOf = parseBestOf(cleanCell(cells[boIndex]), defaultBestOf);
    const messages: string[] = [];
    const actual = normalizeWinnerScore(
      cleanCell(cells[actualWinnerIndex]),
      cleanCell(cells[actualScoreIndex]),
      team1,
      team2,
      parsedBestOf
    );
    if (actual.message) messages.push(actual.message);
    const bestOf = actual.bestOf ?? parsedBestOf;

    const parserMatch: ParserMatch = {
      id: `import_${rowIndex + 1}`,
      matchOrder: rowIndex + 1,
      team1,
      team2,
      bestOf
    };

    const predictions = modelColumns.flatMap((column): LegacyModelPrediction[] => {
      const rawCell = cleanCell(cells[column.index]);
      if (!rawCell) return [];
      const parsed = parsePredictionLine(rawCell, parserMatch);
      return [
        {
          modelName: column.name,
          rawCell,
          status: parsed.status,
          predictedWinner: parsed.predictedWinner,
          predictedScore: parsed.predictedScore,
          messages: parsed.messages
        }
      ];
    });

    return [
      {
        matchOrder: rowIndex + 1,
        externalMatchId: matchIdIndex >= 0 ? cleanCell(cells[matchIdIndex]) || null : null,
        dateTimeUtc: dateIndex >= 0 ? cleanCell(cells[dateIndex]) || null : null,
        stage: stageIndex >= 0 ? cleanCell(cells[stageIndex]) || null : null,
        roundLabel: roundIndex >= 0 ? cleanCell(cells[roundIndex]) || null : null,
        bestOf,
        team1,
        team2,
        actualWinner: actual.winner,
        actualScore: actual.score,
        predictions,
        messages
      }
    ];
  });

  return {
    rows: parsedRows,
    modelNames: modelColumns.map((column) => column.name),
    messages: []
  };
}

function findModel(db: AppDatabase, name: string): Model | null {
  const row = db
    .prepare("SELECT * FROM models WHERE lower(name) = lower(?) OR lower(display_name) = lower(?) LIMIT 1")
    .get(name, name) as Record<string, unknown> | undefined;
  return row ? mapModel(row) : null;
}

function ensureModel(db: AppDatabase, name: string, counters: { modelsCreated: number }): Model {
  const existing = findModel(db, name);
  if (existing) return existing;
  const now = nowIso();
  const nextOrder = Number(
    (db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM models").get() as { next_order: number })
      .next_order
  );
  const id = stableId("model", name);
  db.prepare(
    `INSERT INTO models (id, name, display_name, is_active, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`
  ).run(id, name, name, nextOrder, now, now);
  counters.modelsCreated += 1;
  const model = mapModel(db.prepare("SELECT * FROM models WHERE id = ?").get(id) as Record<string, unknown>);
  writeAudit({ action: "model.create.import", entityType: "model", entityId: id, after: model });
  return model;
}

function createImportBatch(
  db: AppDatabase,
  source: string,
  tournamentId: string | null,
  status: string,
  summary: unknown
): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO import_batches (
      id, source, tournament_id, started_at, finished_at, status, summary_json, raw_payload_path
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(createId("import"), source, tournamentId, now, now, status, JSON.stringify(summary));
}

function upsertLegacyRows(
  db: AppDatabase,
  tournamentId: string,
  parsed: LegacyImportPreview,
  source: string,
  summary: ImportSummary
): void {
  const now = nowIso();
  const existingByOrder = db.prepare("SELECT * FROM matches WHERE tournament_id = ? AND match_order = ?");
  const insertMatch = db.prepare(
    `INSERT INTO matches (
      id, tournament_id, match_order, external_match_id, date_time_utc, stage, round_label,
      best_of, team1, team2, actual_winner, actual_score, actual_source, manual_override, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  );
  const updateMatch = db.prepare(
    `UPDATE matches
     SET external_match_id = ?, date_time_utc = ?, stage = ?, round_label = ?,
         best_of = ?, team1 = ?, team2 = ?,
         actual_winner = CASE WHEN manual_override = 1 THEN actual_winner ELSE ? END,
         actual_score = CASE WHEN manual_override = 1 THEN actual_score ELSE ? END,
         actual_source = CASE WHEN manual_override = 1 THEN actual_source ELSE ? END,
         updated_at = ?
     WHERE tournament_id = ? AND match_order = ?`
  );
  const selectMatch = db.prepare("SELECT * FROM matches WHERE tournament_id = ? AND match_order = ?");
  const upsertPrediction = db.prepare(
    `INSERT INTO model_predictions (
      id, match_id, model_id, predicted_winner, predicted_score, raw_input, raw_line,
      parse_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(match_id, model_id) DO UPDATE SET
       predicted_winner = excluded.predicted_winner,
       predicted_score = excluded.predicted_score,
       raw_input = excluded.raw_input,
       raw_line = excluded.raw_line,
       parse_status = excluded.parse_status,
       updated_at = excluded.updated_at`
  );

  for (const row of parsed.rows) {
    const existing = existingByOrder.get(tournamentId, row.matchOrder) as Record<string, unknown> | undefined;
    const hasActual = Boolean(row.actualWinner && row.actualScore);
    if (existing) {
      if (hasActual && Number(existing.manual_override) === 1) summary.skippedManualResults += 1;
      updateMatch.run(
        row.externalMatchId,
        row.dateTimeUtc,
        row.stage,
        row.roundLabel,
        row.bestOf,
        row.team1,
        row.team2,
        row.actualWinner,
        row.actualScore,
        hasActual ? source : null,
        now,
        tournamentId,
        row.matchOrder
      );
    } else {
      insertMatch.run(
        createId("match"),
        tournamentId,
        row.matchOrder,
        row.externalMatchId,
        row.dateTimeUtc,
        row.stage,
        row.roundLabel,
        row.bestOf,
        row.team1,
        row.team2,
        row.actualWinner,
        row.actualScore,
        hasActual ? source : null,
        now,
        now
      );
    }

    const match = mapMatch(selectMatch.get(tournamentId, row.matchOrder) as Record<string, unknown>);
    summary.matchesImported += 1;
    for (const prediction of row.predictions) {
      if (!prediction.predictedWinner || !prediction.predictedScore || prediction.status === "error") continue;
      const model = ensureModel(db, prediction.modelName, summary);
      upsertPrediction.run(
        createId("prediction"),
        match.id,
        model.id,
        prediction.predictedWinner,
        prediction.predictedScore,
        prediction.rawCell,
        prediction.rawCell,
        prediction.status,
        now,
        now
      );
      summary.predictionsImported += 1;
    }
  }

  db.prepare("UPDATE tournaments SET updated_at = ? WHERE id = ?").run(now, tournamentId);
  createImportBatch(db, source, tournamentId, "completed", summary);
  writeAudit({ action: "legacy.import", entityType: "tournament", entityId: tournamentId, after: summary });
}

export async function importLegacyTsvIntoTournament(
  tournamentId: string,
  rawInput: string,
  defaultBestOf = 3,
  source = "legacy-tsv"
): Promise<ImportSummary> {
  const parsed = parseLegacyTsv(rawInput, defaultBestOf);
  if (parsed.rows.length === 0) throw new HttpError(400, parsed.messages[0] ?? "No importable rows found.");

  const db = getDb();
  await copyPrimaryToSafety(db, `${source} import`);
  const summary: ImportSummary = {
    source,
    tournamentsImported: 1,
    matchesImported: 0,
    predictionsImported: 0,
    modelsCreated: 0,
    skippedManualResults: 0,
    messages: parsed.messages
  };

  withTransaction(db, () => upsertLegacyRows(db, tournamentId, parsed, source, summary));
  return summary;
}

function escapeXmlDecode(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function attributesOf(xml: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of xml.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    attributes[match[1]] = escapeXmlDecode(match[2]);
  }
  return attributes;
}

function columnIndexFromCell(cellRef: string): number {
  const letters = cellRef.match(/[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((text) => escapeXmlDecode(text[1])).join("")
  );
}

function parseSheetXml(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const attrs = attributesOf(cellMatch[1] || cellMatch[3] || "");
      const columnIndex = attrs.r ? columnIndexFromCell(attrs.r) : cells.length;
      const body = cellMatch[2] ?? "";
      const rawValue = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
      const inline = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
      const value =
        attrs.t === "s"
          ? sharedStrings[Number(rawValue)] ?? ""
          : attrs.t === "inlineStr"
            ? escapeXmlDecode(inline)
            : escapeXmlDecode(rawValue);
      cells[columnIndex] = cleanCell(value);
    }
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows;
}

function tableToTsv(rows: string[][]): string | null {
  const headerRowIndex = rows.findIndex((row) => {
    const headers = row.map(normalizeHeader);
    return headers.includes("team1") && headers.includes("team2");
  });
  if (headerRowIndex < 0) return null;
  return rows
    .slice(headerRowIndex)
    .filter((row) => row.some(Boolean))
    .map((row) => row.map((cell) => cleanCell(cell).replace(/\t/g, " ")).join("\t"))
    .join("\n");
}

function workbookTablesFromXlsx(base64: string): WorkbookTable[] {
  const root = mkdtempSync(path.join(os.tmpdir(), "lph-xlsx-"));
  try {
    const archivePath = path.join(root, "workbook.zip");
    const extractDir = path.join(root, "unzipped");
    mkdirSync(extractDir);
    writeFileSync(archivePath, Buffer.from(base64, "base64"));
    const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    execFileSync("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${psQuote(archivePath)} -DestinationPath ${psQuote(extractDir)} -Force`
    ], { stdio: "pipe" });

    const workbookPath = path.join(extractDir, "xl", "workbook.xml");
    const relsPath = path.join(extractDir, "xl", "_rels", "workbook.xml.rels");
    if (!existsSync(workbookPath) || !existsSync(relsPath)) throw new HttpError(400, "Workbook XML is missing.");

    const workbookXml = readFileSync(workbookPath, "utf8");
    const relsXml = readFileSync(relsPath, "utf8");
    const sharedStringsPath = path.join(extractDir, "xl", "sharedStrings.xml");
    const sharedStrings = existsSync(sharedStringsPath)
      ? parseSharedStrings(readFileSync(sharedStringsPath, "utf8"))
      : [];

    const rels = new Map<string, string>();
    for (const rel of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
      const attrs = attributesOf(rel[1]);
      if (attrs.Id && attrs.Target) rels.set(attrs.Id, attrs.Target.replace(/^\/xl\//, ""));
    }

    const tables: WorkbookTable[] = [];
    for (const sheet of workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
      const attrs = attributesOf(sheet[1]);
      const relId = attrs["r:id"];
      const target = relId ? rels.get(relId) : null;
      if (!attrs.name || !target) continue;
      const sheetPath = path.join(extractDir, "xl", target.replace(/^xl\//, ""));
      if (!existsSync(sheetPath)) continue;
      const rows = parseSheetXml(readFileSync(sheetPath, "utf8"), sharedStrings);
      if (tableToTsv(rows)) tables.push({ sheetName: attrs.name, rows });
    }
    return tables;
  } finally {
    if (root.startsWith(os.tmpdir())) rmSync(root, { recursive: true, force: true });
  }
}

function inferLeague(sheetName: string): string {
  const upper = sheetName.toUpperCase();
  for (const league of ["LCK", "LEC", "LCS", "LPL", "MSI", "WORLDS"]) {
    if (upper.includes(league)) return league;
  }
  return "Custom";
}

function getOrCreateTournamentForSheet(db: AppDatabase, sheetName: string): string {
  const existing = db
    .prepare("SELECT id FROM tournaments WHERE lower(name) = lower(?) LIMIT 1")
    .get(sheetName) as { id: string } | undefined;
  if (existing) return existing.id;

  const now = nowIso();
  const id = createId("tournament");
  db.prepare(
    `INSERT INTO tournaments (
      id, name, league, season, stage, round_label, date_start, date_end,
      default_best_of, leaguepedia_overview_page, status, created_at, updated_at
     ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, 3, NULL, 'active', ?, ?)`
  ).run(id, sheetName, inferLeague(sheetName), now, now);
  writeAudit({ action: "tournament.create.import", entityType: "tournament", entityId: id, after: { name: sheetName } });
  return id;
}

export async function importWorkbookBase64(base64: string, filename = "workbook.xlsx"): Promise<ImportSummary> {
  const tables = workbookTablesFromXlsx(base64);
  if (tables.length === 0) throw new HttpError(400, "No workbook sheets with Team1 and Team2 headers were found.");

  const db = getDb();
  await copyPrimaryToSafety(db, "legacy workbook import");
  const summary: ImportSummary = {
    source: `legacy-workbook:${filename}`,
    tournamentsImported: 0,
    matchesImported: 0,
    predictionsImported: 0,
    modelsCreated: 0,
    skippedManualResults: 0,
    messages: []
  };

  withTransaction(db, () => {
    for (const table of tables) {
      const tsv = tableToTsv(table.rows);
      if (!tsv) continue;
      const parsed = parseLegacyTsv(tsv, 3);
      if (parsed.rows.length === 0) continue;
      const tournamentId = getOrCreateTournamentForSheet(db, table.sheetName);
      summary.tournamentsImported += 1;
      upsertLegacyRows(db, tournamentId, parsed, summary.source, summary);
    }
    createImportBatch(db, summary.source, null, "completed", summary);
    writeAudit({ action: "legacy.workbook.import", entityType: "workbook", after: summary });
  });

  return summary;
}

function cargoValue(row: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = row[name] ?? row[name.toLowerCase()] ?? row[name.replaceAll("_", " ")];
    if (value !== undefined && value !== null) return cleanCell(value);
  }
  return "";
}

function escapeCargoString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function inferLeagueCode(name: string, league: string | null): string {
  const haystack = `${name} ${league ?? ""}`.toUpperCase();
  const known = ["LCK", "LEC", "LCS", "LPL", "LCP", "MSI", "VCS", "PCS", "LJL", "CBLOL", "EMEA", "WORLDS"];
  return known.find((code) => haystack.includes(code)) ?? league ?? "Custom";
}

function inferOverviewPage(name: string, league: string | null, year: string | null): string | null {
  const leagueCode = inferLeagueCode(name, league);
  const normalizedName = name
    .replace(new RegExp(`\\b${leagueCode}\\b`, "i"), "")
    .replace(/\b20\d{2}\b/g, "")
    .trim();
  if (!year || !leagueCode || !normalizedName) return null;
  const slug = normalizedName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug ? `${leagueCode}/${year}_Season/${slug}` : null;
}

function isLikelySameTournamentName(optionName: string, localName: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/\b20\d{2}\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const option = normalize(optionName);
  const local = normalize(localName);
  return option === local || option.includes(local) || local.includes(option);
}

function localLeaguepediaFallbackOptions(input: {
  query?: string | null;
  year?: string | null;
  limit?: number;
}): LeaguepediaTournamentOption[] {
  const query = input.query?.trim().toLowerCase();
  if (!query) return [];
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT name, league, season, date_start, date_end, leaguepedia_overview_page
       FROM tournaments
       WHERE lower(name) LIKE ?
       ORDER BY status = 'active' DESC, updated_at DESC
       LIMIT ?`
    )
    .all(`%${query}%`, Math.max(1, Math.min(input.limit ?? 12, 20))) as Array<Record<string, unknown>>;
  const options = rows.flatMap((row): LeaguepediaTournamentOption[] => {
    const name = cleanCell(row.name);
    const league = cleanCell(row.league) || null;
    const year = cleanCell(row.season) || input.year?.trim() || null;
    const overviewPage = cleanCell(row.leaguepedia_overview_page) || inferOverviewPage(name, league, year);
    if (!name || !overviewPage) return [];
    return [
      {
        name: year && !name.includes(year) ? `${league ?? ""} ${year} ${name.replace(new RegExp(`^${league}\\s+`, "i"), "")}`.trim() : name,
        overviewPage,
        dateStart: cleanCell(row.date_start) || null,
        dateEnd: cleanCell(row.date_end) || null,
        league,
        region: null,
        tournamentLevel: null,
        isOfficial: true,
        year
      }
    ];
  });
  const nonCopied = options.filter((option) => !/kopia|copy/i.test(option.name));
  return nonCopied.length > 0 ? nonCopied : options;
}

function findExistingTournamentForLeaguepedia(
  db: AppDatabase,
  option: LeaguepediaTournamentOption
): { id: string; status: string; leaguepedia_overview_page: string | null } | null {
  const byOverview = db
    .prepare("SELECT id, status, leaguepedia_overview_page FROM tournaments WHERE leaguepedia_overview_page = ? LIMIT 1")
    .get(option.overviewPage) as { id: string; status: string; leaguepedia_overview_page: string | null } | undefined;
  if (byOverview) return byOverview;

  const optionLeague = inferLeagueCode(option.name, option.league);
  const candidates = db.prepare("SELECT id, name, league, status, leaguepedia_overview_page FROM tournaments").all() as Array<{
    id: string;
    name: string;
    league: string;
    status: string;
    leaguepedia_overview_page: string | null;
  }>;
  const scored = candidates
    .filter((candidate) => inferLeagueCode(candidate.name, candidate.league) === optionLeague)
    .filter((candidate) => isLikelySameTournamentName(option.name, candidate.name))
    .map((candidate) => {
      const exact = candidate.name.toLowerCase() === option.name.toLowerCase();
      const copiedSheet = /kopia|copy/i.test(candidate.name);
      const active = candidate.status === "active";
      return {
        candidate,
        score: (exact ? 0 : 3) + (copiedSheet ? 20 : 0) + (active ? 0 : 1) + Math.abs(candidate.name.length - option.name.length) / 100
      };
    })
    .sort((left, right) => left.score - right.score);
  return scored[0]?.candidate ?? null;
}

function normalizeLeaguepediaTournament(row: Record<string, unknown>): LeaguepediaTournamentOption {
  return {
    name: cargoValue(row, ["Name"]),
    overviewPage: cargoValue(row, ["OverviewPage"]),
    dateStart: cargoValue(row, ["DateStart"]) || null,
    dateEnd: cargoValue(row, ["Date"]) || null,
    league: cargoValue(row, ["League"]) || null,
    region: cargoValue(row, ["Region"]) || null,
    tournamentLevel: cargoValue(row, ["TournamentLevel"]) || null,
    isOfficial: cargoValue(row, ["IsOfficial"]) === "1",
    year: cargoValue(row, ["Year"]) || null
  };
}

function tournamentSearchWhere(input: { query?: string | null; year?: string | null; includeUnofficial?: boolean }): string {
  const parts: string[] = [];
  const query = input.query?.trim();
  if (query) {
    const escaped = escapeCargoString(query);
    parts.push(
      `(Name LIKE '%${escaped}%' OR OverviewPage LIKE '%${escaped}%' OR League LIKE '%${escaped}%')`
    );
  }
  if (input.year?.trim()) parts.push(`Year='${escapeCargoString(input.year.trim())}'`);
  if (!input.includeUnofficial) parts.push("IsOfficial=1");
  return parts.join(" AND ");
}

async function fetchLeaguepediaTournamentRows(input: {
  query?: string | null;
  year?: string | null;
  includeUnofficial?: boolean;
  overviewPage?: string | null;
  limit?: number;
}): Promise<Record<string, unknown>[]> {
  const url = new URL(config.leaguepediaApiUrl);
  url.searchParams.set("format", "json");
  url.searchParams.set("tables", "Tournaments");
  url.searchParams.set(
    "fields",
    "Name,OverviewPage,DateStart,Date,League,Region,TournamentLevel,IsOfficial,Year"
  );
  if (input.overviewPage) {
    url.searchParams.set("where", `OverviewPage='${escapeCargoString(input.overviewPage)}'`);
  } else {
    const where = tournamentSearchWhere(input);
    if (where) url.searchParams.set("where", where);
  }
  url.searchParams.set("order_by", "DateStart DESC, Name ASC");
  url.searchParams.set("limit", String(Math.max(1, Math.min(input.limit ?? 20, 50))));

  return fetchLeaguepediaCargoRows(
    url,
    {
      table: "Tournaments",
      query: input.query ?? null,
      year: input.year ?? null,
      includeUnofficial: Boolean(input.includeUnofficial),
      overviewPage: input.overviewPage ?? null,
      limit: Math.max(1, Math.min(input.limit ?? 20, 50))
    },
    "Leaguepedia tournament search"
  );
}

export async function searchLeaguepediaTournaments(input: {
  query?: string | null;
  year?: string | null;
  includeUnofficial?: boolean;
  limit?: number;
}): Promise<LeaguepediaTournamentOption[]> {
  const localFallback = localLeaguepediaFallbackOptions(input);
  if (localFallback.length > 0) return localFallback;

  let rows: Record<string, unknown>[];
  try {
    rows = await fetchLeaguepediaTournamentRows(input);
  } catch (error) {
    if (localFallback.length > 0 && isRateLimitError(error)) return localFallback;
    throw error;
  }
  return rows
    .map(normalizeLeaguepediaTournament)
    .filter((tournament) => tournament.name && tournament.overviewPage);
}

export async function createTournamentFromLeaguepedia(
  input: string | LeaguepediaTournamentOption
): Promise<{
  tournament: ReturnType<typeof getTournament>;
  schedule: { applied: number; skippedManualResults: number; message?: string };
}> {
  const suppliedOption = typeof input === "string" ? null : input;
  const overviewPage = typeof input === "string" ? input : input.overviewPage;
  const rows = suppliedOption?.name
    ? []
    : await fetchLeaguepediaTournamentRows({ overviewPage, limit: 1, includeUnofficial: true });
  const option = suppliedOption?.name ? suppliedOption : rows[0] ? normalizeLeaguepediaTournament(rows[0]) : null;
  if (!option?.overviewPage) throw new HttpError(404, "Leaguepedia tournament not found.");

  const db = getDb();
  const existing = findExistingTournamentForLeaguepedia(db, option) ?? undefined;

  let tournament: ReturnType<typeof getTournament>;
  if (existing) {
    if (existing.status !== "active" || !existing.leaguepedia_overview_page) {
      await copyPrimaryToSafety(db, "Leaguepedia tournament restore");
      const now = nowIso();
      db.prepare(
        `UPDATE tournaments
         SET status = 'active',
             leaguepedia_overview_page = COALESCE(leaguepedia_overview_page, ?),
             updated_at = ?
         WHERE id = ?`
      ).run(option.overviewPage, now, existing.id);
      writeAudit({
        action: "tournament.restore.leaguepedia",
        entityType: "tournament",
        entityId: existing.id,
        after: { status: "active", overviewPage: option.overviewPage }
      });
    }
    tournament = getTournament(existing.id);
  } else {
    tournament = await createTournament({
      name: option.name,
      league: inferLeagueCode(option.name, option.league),
      season: option.year ? Number(option.year) || null : null,
      dateStart: option.dateStart,
      dateEnd: option.dateEnd,
      defaultBestOf: 3,
      leaguepediaOverviewPage: option.overviewPage
    });
  }

  const localTournament = getTournament(tournament.id);
  if (localTournament.matchCount > 0) {
    return {
      tournament: localTournament,
      schedule: {
        applied: 0,
        skippedManualResults: 0,
        message: `Opened local schedule with ${localTournament.matchCount} matches. Use Preview Diff when you want to refresh Leaguepedia.`
      }
    };
  }

  let schedule: { applied: number; skippedManualResults: number; message?: string };
  try {
    const preview = await previewLeaguepediaImport(tournament.id, { overviewPage: option.overviewPage });
    schedule = await applyLeaguepediaDiffs(tournament.id, preview.changes, false);
  } catch (error) {
    if (!isRateLimitError(error)) throw error;
    const currentTournament = getTournament(tournament.id);
    const localMatches = currentTournament.matchCount;
    schedule = {
      applied: 0,
      skippedManualResults: 0,
      message: localMatches > 0
        ? `Opened local schedule with ${localMatches} matches. ${leaguepediaRateLimitMessage("Leaguepedia schedule fetch")}`
        : `Created tournament without schedule. ${leaguepediaRateLimitMessage("Leaguepedia schedule fetch")}`
    };
  }
  return { tournament: getTournament(tournament.id), schedule };
}

function leaguepediaWhere(input: { overviewPage?: string | null; dateStart?: string | null; dateEnd?: string | null }): string {
  const parts: string[] = [];
  if (input.overviewPage) parts.push(`OverviewPage='${escapeCargoString(input.overviewPage)}'`);
  if (input.dateStart) parts.push(`DateTime_UTC >= '${escapeCargoString(input.dateStart)} 00:00:00'`);
  if (input.dateEnd) parts.push(`DateTime_UTC <= '${escapeCargoString(input.dateEnd)} 23:59:59'`);
  return parts.join(" AND ");
}

async function fetchLeaguepediaRows(input: {
  overviewPage?: string | null;
  dateStart?: string | null;
  dateEnd?: string | null;
}): Promise<Record<string, unknown>[]> {
  const url = new URL(config.leaguepediaApiUrl);
  url.searchParams.set("format", "json");
  url.searchParams.set("tables", "MatchSchedule");
  url.searchParams.set(
    "fields",
    "MatchId,OverviewPage,DateTime_UTC,Team1,Team2,BestOf,Winner,Team1Score,Team2Score,Phase,Round,Tab"
  );
  const where = leaguepediaWhere(input);
  if (where) url.searchParams.set("where", where);
  url.searchParams.set("order_by", "DateTime_UTC ASC, MatchId ASC");
  url.searchParams.set("limit", "500");

  return fetchLeaguepediaCargoRows(
    url,
    {
      table: "MatchSchedule",
      overviewPage: input.overviewPage ?? null,
      dateStart: input.dateStart ?? null,
      dateEnd: input.dateEnd ?? null,
      limit: 500
    },
    "Leaguepedia schedule fetch"
  );
}

function normalizeLeaguepediaRows(rows: Record<string, unknown>[]): IncomingLeaguepediaMatch[] {
  return rows
    .map((row, index) => {
      const team1 = cargoValue(row, ["Team1"]);
      const team2 = cargoValue(row, ["Team2"]);
      const bestOf = parseBestOf(cargoValue(row, ["BestOf"]), 3);
      const winner = cargoValue(row, ["Winner"]);
      const team1Score = Number(cargoValue(row, ["Team1Score"]));
      const team2Score = Number(cargoValue(row, ["Team2Score"]));
      const actualScore =
        Number.isFinite(team1Score) && Number.isFinite(team2Score) && team1Score !== team2Score
          ? scoreFromWinnerPerspective(team1Score, team2Score)
          : null;
      const resolvedWinner = winner && winner !== "0" && winner.toUpperCase() !== "TBD"
        ? resolveTeamToken(winner, team1, team2)
        : null;
      const actualWinner =
        resolvedWinner?.status === "matched"
          ? resolvedWinner.team
          : winner && winner !== "0" && winner.toUpperCase() !== "TBD"
            ? winner
            : null;
      return {
        matchOrder: index + 1,
        externalMatchId: cargoValue(row, ["MatchId"]) || null,
        leaguepediaMatchId: cargoValue(row, ["MatchId"]) || null,
        overviewPage: cargoValue(row, ["OverviewPage"]) || null,
        dateTimeUtc: cargoValue(row, ["DateTime UTC", "DateTime_UTC"]) || null,
        stage: cargoValue(row, ["Phase"]) || null,
        roundLabel: cargoValue(row, ["Round"]) || null,
        phase: cargoValue(row, ["Phase"]) || null,
        tab: cargoValue(row, ["Tab"]) || null,
        bestOf,
        team1: team1 || "TBD",
        team2: team2 || "TBD",
        actualWinner,
        actualScore: actualScore && isValidScoreForBestOf(bestOf, actualScore) ? actualScore : null
      };
    })
    .filter((row) => row.team1 || row.team2);
}

function diffField(
  changes: LeaguepediaDiff["changes"],
  field: string,
  before: string | number | null,
  after: string | number | null,
  protectedChange = false
): void {
  if ((before ?? null) !== (after ?? null)) changes.push({ field, before, after, protected: protectedChange });
}

function buildLeaguepediaDiffs(tournamentId: string, incoming: IncomingLeaguepediaMatch[]): LeaguepediaDiff[] {
  const db = getDb();
  const existingRows = db.prepare("SELECT * FROM matches WHERE tournament_id = ?").all(tournamentId) as Array<
    Record<string, unknown>
  >;
  const byLeaguepedia = new Map(existingRows.map((row) => [String(row.leaguepedia_match_id || row.external_match_id), row]));
  const byOrder = new Map(existingRows.map((row) => [Number(row.match_order), row]));

  return incoming.map((row) => {
    const existing =
      (row.leaguepediaMatchId ? byLeaguepedia.get(row.leaguepediaMatchId) : undefined) ?? byOrder.get(row.matchOrder);
    const changes: LeaguepediaDiff["changes"] = [];
    if (existing) {
      diffField(changes, "team1", cleanCell(existing.team1), row.team1);
      diffField(changes, "team2", cleanCell(existing.team2), row.team2);
      diffField(changes, "bestOf", Number(existing.best_of), row.bestOf);
      diffField(changes, "dateTimeUtc", cleanCell(existing.date_time_utc), row.dateTimeUtc);
      diffField(changes, "stage", cleanCell(existing.stage), row.stage);
      diffField(changes, "roundLabel", cleanCell(existing.round_label), row.roundLabel);
      const protectedActual = Number(existing.manual_override) === 1;
      diffField(changes, "actualWinner", cleanCell(existing.actual_winner), row.actualWinner, protectedActual);
      diffField(changes, "actualScore", cleanCell(existing.actual_score), row.actualScore, protectedActual);
    }
    return {
      key: row.leaguepediaMatchId ?? `order-${row.matchOrder}`,
      action: existing ? (changes.length > 0 ? "update" : "unchanged") : "create",
      existingMatchId: existing ? String(existing.id) : null,
      incoming: row,
      changes
    };
  });
}

export async function previewLeaguepediaImport(
  tournamentId: string,
  input: { overviewPage?: string | null; dateStart?: string | null; dateEnd?: string | null }
): Promise<{ changes: LeaguepediaDiff[]; fetched: number; queryHash: string }> {
  const rows = await fetchLeaguepediaRows(input);
  const incoming = normalizeLeaguepediaRows(rows);
  const queryHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return { changes: buildLeaguepediaDiffs(tournamentId, incoming), fetched: incoming.length, queryHash };
}

export async function applyLeaguepediaDiffs(
  tournamentId: string,
  changes: LeaguepediaDiff[],
  allowManualOverwrite = false
): Promise<{ applied: number; skippedManualResults: number }> {
  const selected = changes.filter((change) => change.action !== "unchanged");
  if (selected.length === 0) return { applied: 0, skippedManualResults: 0 };

  const db = getDb();
  await copyPrimaryToSafety(db, "Leaguepedia diff apply");
  let skippedManualResults = 0;

  withTransaction(db, () => {
    const now = nowIso();
    const insert = db.prepare(
      `INSERT INTO matches (
        id, tournament_id, match_order, external_match_id, leaguepedia_match_id, overview_page,
        date_time_utc, stage, round_label, phase, tab, best_of, team1, team2,
        actual_winner, actual_score, actual_source, manual_override, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    );
    const update = db.prepare(
      `UPDATE matches
       SET external_match_id = ?, leaguepedia_match_id = ?, overview_page = ?, date_time_utc = ?,
           stage = ?, round_label = ?, phase = ?, tab = ?, best_of = ?, team1 = ?, team2 = ?,
           actual_winner = ?, actual_score = ?, actual_source = ?, updated_at = ?
       WHERE id = ?`
    );
    const existing = db.prepare("SELECT * FROM matches WHERE id = ?");

    for (const change of selected) {
      const row = change.incoming;
      if (!change.existingMatchId) {
        insert.run(
          createId("match"),
          tournamentId,
          row.matchOrder,
          row.externalMatchId,
          row.leaguepediaMatchId,
          row.overviewPage,
          row.dateTimeUtc,
          row.stage,
          row.roundLabel,
          row.phase,
          row.tab,
          row.bestOf,
          row.team1,
          row.team2,
          row.actualWinner,
          row.actualScore,
          row.actualWinner && row.actualScore ? "leaguepedia" : null,
          now,
          now
        );
        continue;
      }

      const before = existing.get(change.existingMatchId) as Record<string, unknown>;
      const protectedActual = Number(before.manual_override) === 1 && !allowManualOverwrite;
      if (protectedActual && (row.actualWinner || row.actualScore)) skippedManualResults += 1;
      const existingActualWinner = before.actual_winner ? String(before.actual_winner) : null;
      const existingActualScore = before.actual_score ? String(before.actual_score) : null;
      const existingActualSource = before.actual_source ? String(before.actual_source) : null;
      update.run(
        row.externalMatchId,
        row.leaguepediaMatchId,
        row.overviewPage,
        row.dateTimeUtc,
        row.stage,
        row.roundLabel,
        row.phase,
        row.tab,
        row.bestOf,
        row.team1,
        row.team2,
        protectedActual ? existingActualWinner : row.actualWinner,
        protectedActual ? existingActualScore : row.actualScore,
        protectedActual ? existingActualSource : row.actualWinner && row.actualScore ? "leaguepedia" : null,
        now,
        change.existingMatchId
      );
    }

    db.prepare("UPDATE tournaments SET updated_at = ?, last_leaguepedia_refresh_at = ? WHERE id = ?").run(
      now,
      now,
      tournamentId
    );
    const summary = { applied: selected.length, skippedManualResults };
    createImportBatch(db, "leaguepedia", tournamentId, "completed", summary);
    writeAudit({ action: "leaguepedia.apply", entityType: "tournament", entityId: tournamentId, after: summary });
  });

  return { applied: selected.length, skippedManualResults };
}
