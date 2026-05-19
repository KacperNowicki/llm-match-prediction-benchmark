import http from "node:http";
import { URL } from "node:url";
import { config } from "./config";
import { migrateDatabase } from "./db/migrate";
import { addUtcDays, getLeagueWeekRange, isIsoDateInRange, toIsoDate } from "./lib/dateWeeks";
import { HttpError } from "./lib/httpError";
import { isUnresolvedTeamName } from "./lib/teamPlaceholders";
import { buildMultiTournamentPredictionPrompt, buildPredictionPrompt, type PromptMatchGroup } from "./prompts/promptBuilder";
import { exportTournamentTsv } from "./services/export";
import {
  applyLeaguepediaDiffs,
  createTournamentFromLeaguepedia,
  importLegacyTsvIntoTournament,
  importWorkbookBase64,
  previewLeaguepediaImport,
  searchLeaguepediaTournaments
} from "./services/imports";
import { addMatch, listMatches, updateMatch, updateMatchResult, upsertScheduleFromTsv } from "./services/matches";
import { createModel, listModels, listModelStats, reorderModels, updateModel } from "./services/models";
import { getPredictionGrid } from "./services/predictionGrid";
import {
  parseLeagueBlobPredictions,
  parsePredictions,
  savePredictions,
  updatePredictionCell,
  type PredictionTargetScope
} from "./services/predictions";
import { parseResults, saveResults } from "./services/results";
import { getTournamentScores } from "./services/scoring";
import { createTournament, getTournament, listTournaments, removeTournament } from "./services/tournaments";
import { generateCombinedTweetDraft, generateTweetDraft, type TweetDraftType } from "./services/tweets";

type RequestBody = Record<string, unknown>;

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendText(response: http.ServerResponse, status: number, text: string, contentType = "text/plain"): void {
  response.writeHead(status, {
    "content-type": `${contentType}; charset=utf-8`,
    "cache-control": "no-store"
  });
  response.end(text);
}

async function readBody(request: http.IncomingMessage): Promise<RequestBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as RequestBody;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number | null = null): number | null {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function asOptionalNumber(value: unknown): number | undefined {
  const numeric = asNumber(value);
  return numeric === null ? undefined : numeric;
}

function asPredictionTargetScope(value: unknown): PredictionTargetScope {
  return value === "all" || value === "upcoming" || value === "nextMissing" ? value : "nextMissing";
}

function tournamentIdsFromParam(value: string | null, fallbackId: string): string[] {
  const ids = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return ids.length > 0 ? [...new Set(ids)] : [fallbackId];
}

async function route(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  if (!request.url || !request.method) {
    throw new HttpError(400, "Malformed request.");
  }

  const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);
  const pathname = url.pathname;
  const method = request.method;

  if (method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "GET" && pathname === "/api/bootstrap") {
    sendJson(response, 200, { tournaments: listTournaments(), models: listModels(true), modelStats: listModelStats(true) });
    return;
  }

  if (method === "GET" && pathname === "/api/models") {
    sendJson(response, 200, { models: listModels(true) });
    return;
  }

  if (method === "POST" && pathname === "/api/models") {
    const body = await readBody(request);
    sendJson(response, 201, { model: await createModel({ name: asString(body.name) }) });
    return;
  }

  const modelPatch = pathname.match(/^\/api\/models\/([^/]+)$/);
  if (modelPatch && method === "PATCH") {
    const body = await readBody(request);
    sendJson(response, 200, {
      model: await updateModel(modelPatch[1], {
        displayName: typeof body.displayName === "string" ? body.displayName : undefined,
        isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
        sortOrder: asOptionalNumber(body.sortOrder)
      })
    });
    return;
  }

  if (method === "POST" && pathname === "/api/models/reorder") {
    const body = await readBody(request);
    const modelIds = Array.isArray(body.modelIds) ? body.modelIds.map(String) : [];
    sendJson(response, 200, { models: await reorderModels(modelIds) });
    return;
  }

  if (method === "GET" && pathname === "/api/tournaments") {
    sendJson(response, 200, { tournaments: listTournaments() });
    return;
  }

  if (method === "GET" && pathname === "/api/leaguepedia/tournaments") {
    sendJson(response, 200, {
      tournaments: await searchLeaguepediaTournaments({
        query: url.searchParams.get("query"),
        year: url.searchParams.get("year"),
        includeUnofficial: url.searchParams.get("includeUnofficial") === "true",
        limit: asNumber(url.searchParams.get("limit"), 20) ?? 20
      })
    });
    return;
  }

  if (method === "POST" && pathname === "/api/leaguepedia/tournaments/add") {
    const body = await readBody(request);
    const optionBody = typeof body.option === "object" && body.option !== null
      ? (body.option as Record<string, unknown>)
      : body;
    const result = await createTournamentFromLeaguepedia({
      name: asString(optionBody.name),
      overviewPage: asString(optionBody.overviewPage, asString(body.overviewPage)),
      dateStart: asString(optionBody.dateStart) || null,
      dateEnd: asString(optionBody.dateEnd) || null,
      league: asString(optionBody.league) || null,
      region: asString(optionBody.region) || null,
      tournamentLevel: asString(optionBody.tournamentLevel) || null,
      isOfficial: optionBody.isOfficial === true || optionBody.isOfficial === "1",
      year: asString(optionBody.year) || null
    });
    sendJson(response, 201, result);
    return;
  }

  if (method === "POST" && pathname === "/api/tournaments") {
    const body = await readBody(request);
    sendJson(response, 201, {
      tournament: await createTournament({
        name: asString(body.name),
        league: asString(body.league, "Custom"),
        season: asNumber(body.season),
        stage: asString(body.stage) || null,
        roundLabel: asString(body.roundLabel) || null,
        dateStart: asString(body.dateStart) || null,
        dateEnd: asString(body.dateEnd) || null,
        defaultBestOf: asNumber(body.defaultBestOf, 3) ?? 3,
        leaguepediaOverviewPage: asString(body.leaguepediaOverviewPage) || null
      })
    });
    return;
  }

  const tournamentMatch = pathname.match(/^\/api\/tournaments\/([^/]+)$/);
  if (tournamentMatch && method === "GET") {
    const id = tournamentMatch[1];
    sendJson(response, 200, {
      tournament: getTournament(id),
      matches: listMatches(id),
      scores: getTournamentScores(id),
      predictionRows: getPredictionGrid(id)
    });
    return;
  }

  const predictionGridMatch = pathname.match(/^\/api\/tournaments\/([^/]+)\/prediction-grid$/);
  if (predictionGridMatch && method === "GET") {
    sendJson(response, 200, { rows: getPredictionGrid(predictionGridMatch[1]) });
    return;
  }

  if (tournamentMatch && method === "DELETE") {
    sendJson(response, 200, { result: await removeTournament(tournamentMatch[1]) });
    return;
  }

  const matchesMatch = pathname.match(/^\/api\/tournaments\/([^/]+)\/matches$/);
  if (matchesMatch && method === "GET") {
    sendJson(response, 200, { matches: listMatches(matchesMatch[1]) });
    return;
  }

  if (matchesMatch && method === "POST") {
    const body = await readBody(request);
    sendJson(response, 201, {
      match: await addMatch(matchesMatch[1], {
        externalMatchId: asString(body.externalMatchId) || null,
        matchOrder: asNumber(body.matchOrder) ?? undefined,
        dateTimeUtc: asString(body.dateTimeUtc) || null,
        stage: asString(body.stage) || null,
        roundLabel: asString(body.roundLabel) || null,
        bestOf: asNumber(body.bestOf, 3) ?? 3,
        team1: asString(body.team1),
        team2: asString(body.team2)
      })
    });
    return;
  }

  const schedulePaste = pathname.match(/^\/api\/tournaments\/([^/]+)\/schedule\/paste$/);
  if (schedulePaste && method === "POST") {
    const body = await readBody(request);
    const tournament = getTournament(schedulePaste[1]);
    sendJson(response, 200, {
      result: await upsertScheduleFromTsv(
        schedulePaste[1],
        asString(body.rawInput),
        asNumber(body.defaultBestOf, tournament.defaultBestOf) ?? tournament.defaultBestOf
      )
    });
    return;
  }

  const promptMatch = pathname.match(/^\/api\/tournaments\/([^/]+)\/prompt$/);
  if (promptMatch && method === "GET") {
    const tournament = getTournament(promptMatch[1]);
    const scope = url.searchParams.get("scope") ?? "upcoming";
    let start: string | null = null;
    let end: string | null = null;
    if (scope === "next7") {
      const today = new Date();
      start = toIsoDate(today);
      end = toIsoDate(addUtcDays(today, 6));
    } else if (scope === "leagueWeek") {
      const range = getLeagueWeekRange();
      start = range.start;
      end = range.end;
    } else if (scope === "custom") {
      start = url.searchParams.get("from");
      end = url.searchParams.get("to");
    }
    const today = toIsoDate(new Date());
    const includeTbd = url.searchParams.get("includeTbd") === "true";
    const selectedTournamentIds = tournamentIdsFromParam(url.searchParams.get("tournamentIds"), promptMatch[1]);
    const eligibleMatches = (tournamentId: string) => listMatches(tournamentId).filter((match) => {
      if (!includeTbd && [match.team1, match.team2].some(isUnresolvedTeamName)) return false;
      if (match.actualWinner || match.actualScore) return false;
      if (match.dateTimeUtc && match.dateTimeUtc.slice(0, 10) < today) return false;
      if (scope === "upcoming" || scope === "all") return true;
      return isIsoDateInRange(match.dateTimeUtc, start, end);
    });
    const singleTournament = selectedTournamentIds.length === 1 ? getTournament(selectedTournamentIds[0]) : tournament;
    const selectedMatches = eligibleMatches(singleTournament.id);
    const bestOfSet = new Set(selectedMatches.map((match) => match.bestOf));
    const matches = selectedMatches.map((match) => ({
      id: match.id,
      matchOrder: match.matchOrder,
      team1: match.team1,
      team2: match.team2,
      bestOf: match.bestOf
    }));
    if (selectedTournamentIds.length > 1) {
      const selectedIds = new Set(selectedTournamentIds);
      const groups: PromptMatchGroup[] = listTournaments().filter((activeTournament) => selectedIds.has(activeTournament.id)).map((activeTournament) => ({
        tournamentTitle: activeTournament.name,
        league: activeTournament.league,
        defaultBestOf: activeTournament.defaultBestOf,
        matches: eligibleMatches(activeTournament.id).map((match) => ({
          id: match.id,
          matchOrder: match.matchOrder,
          team1: match.team1,
          team2: match.team2,
          bestOf: match.bestOf
        }))
      }));
      sendJson(response, 200, {
        prompt: buildMultiTournamentPredictionPrompt(groups),
        range: {
          scope,
          start,
          end,
          includeTbd,
          matchCount: groups.reduce((total, group) => total + group.matches.length, 0),
          tournamentCount: groups.filter((group) => group.matches.length > 0).length
        }
      });
      return;
    }
    sendJson(response, 200, {
      prompt: buildPredictionPrompt({
        tournamentTitle: singleTournament.name,
        league: singleTournament.league,
        bestOf: bestOfSet.size === 1 ? selectedMatches[0]?.bestOf ?? singleTournament.defaultBestOf : singleTournament.defaultBestOf,
        matches
      }),
      range: { scope, start, end, includeTbd, matchCount: matches.length, tournamentCount: matches.length > 0 ? 1 : 0 }
    });
    return;
  }

  const legacyImport = pathname.match(/^\/api\/tournaments\/([^/]+)\/import\/legacy-tsv$/);
  if (legacyImport && method === "POST") {
    const body = await readBody(request);
    const tournament = getTournament(legacyImport[1]);
    sendJson(response, 200, {
      result: await importLegacyTsvIntoTournament(
        legacyImport[1],
        asString(body.rawInput),
        asNumber(body.defaultBestOf, tournament.defaultBestOf) ?? tournament.defaultBestOf
      )
    });
    return;
  }

  if (method === "POST" && pathname === "/api/import/workbook") {
    const body = await readBody(request);
    sendJson(response, 200, {
      result: await importWorkbookBase64(asString(body.base64), asString(body.filename, "workbook.xlsx"))
    });
    return;
  }

  const leaguepediaPreview = pathname.match(/^\/api\/tournaments\/([^/]+)\/leaguepedia\/preview$/);
  if (leaguepediaPreview && method === "POST") {
    const body = await readBody(request);
    const tournament = getTournament(leaguepediaPreview[1]);
    sendJson(response, 200, {
      result: await previewLeaguepediaImport(leaguepediaPreview[1], {
        overviewPage: asString(body.overviewPage, tournament.leaguepediaOverviewPage ?? tournament.name),
        dateStart: asString(body.dateStart) || null,
        dateEnd: asString(body.dateEnd) || null
      })
    });
    return;
  }

  const leaguepediaApply = pathname.match(/^\/api\/tournaments\/([^/]+)\/leaguepedia\/apply$/);
  if (leaguepediaApply && method === "POST") {
    const body = await readBody(request);
    sendJson(response, 200, {
      result: await applyLeaguepediaDiffs(
        leaguepediaApply[1],
        Array.isArray(body.changes) ? (body.changes as never[]) : [],
        Boolean(body.allowManualOverwrite)
      )
    });
    return;
  }

  const predictionsParse = pathname.match(/^\/api\/tournaments\/([^/]+)\/predictions\/parse$/);
  if (predictionsParse && method === "POST") {
    const body = await readBody(request);
    if (Boolean(body.leagueBlob)) {
      sendJson(response, 200, {
        rows: parseLeagueBlobPredictions(asString(body.rawInput), {
          modelId: asString(body.modelId),
          fallbackTournamentId: predictionsParse[1],
          targetScope: asPredictionTargetScope(body.targetScope)
        })
      });
      return;
    }
    sendJson(response, 200, {
      rows: parsePredictions(predictionsParse[1], asString(body.rawInput), {
        modelId: asString(body.modelId),
        targetScope: asPredictionTargetScope(body.targetScope)
      })
    });
    return;
  }

  const predictionsSave = pathname.match(/^\/api\/tournaments\/([^/]+)\/predictions\/save$/);
  if (predictionsSave && method === "POST") {
    const body = await readBody(request);
    sendJson(response, 200, {
      result: await savePredictions({
        modelId: asString(body.modelId),
        rawInput: asString(body.rawInput),
        rows: Array.isArray(body.rows) ? (body.rows as never[]) : []
      })
    });
    return;
  }

  const resultsParse = pathname.match(/^\/api\/tournaments\/([^/]+)\/results\/parse$/);
  if (resultsParse && method === "POST") {
    const body = await readBody(request);
    sendJson(response, 200, { rows: parseResults(resultsParse[1], asString(body.rawInput)) });
    return;
  }

  const resultsSave = pathname.match(/^\/api\/tournaments\/([^/]+)\/results\/save$/);
  if (resultsSave && method === "POST") {
    const body = await readBody(request);
    sendJson(response, 200, {
      result: await saveResults(Array.isArray(body.rows) ? (body.rows as never[]) : [])
    });
    return;
  }

  const matchResult = pathname.match(/^\/api\/matches\/([^/]+)\/result$/);
  if (matchResult && method === "PATCH") {
    const body = await readBody(request);
    sendJson(response, 200, {
      match: await updateMatchResult({
        matchId: matchResult[1],
        actualWinner: asString(body.actualWinner),
        actualScore: asString(body.actualScore),
        source: asString(body.source, "manual")
      })
    });
    return;
  }

  const matchUpdate = pathname.match(/^\/api\/matches\/([^/]+)$/);
  if (matchUpdate && method === "PATCH") {
    const body = await readBody(request);
    const updates: Parameters<typeof updateMatch>[0]["updates"] = {};
    if (Object.prototype.hasOwnProperty.call(body, "matchOrder")) updates.matchOrder = asOptionalNumber(body.matchOrder);
    if (Object.prototype.hasOwnProperty.call(body, "externalMatchId")) updates.externalMatchId = asString(body.externalMatchId);
    if (Object.prototype.hasOwnProperty.call(body, "dateTimeUtc")) updates.dateTimeUtc = asString(body.dateTimeUtc);
    if (Object.prototype.hasOwnProperty.call(body, "stage")) updates.stage = asString(body.stage);
    if (Object.prototype.hasOwnProperty.call(body, "roundLabel")) updates.roundLabel = asString(body.roundLabel);
    if (Object.prototype.hasOwnProperty.call(body, "bestOf")) updates.bestOf = asOptionalNumber(body.bestOf);
    if (Object.prototype.hasOwnProperty.call(body, "team1")) updates.team1 = asString(body.team1);
    if (Object.prototype.hasOwnProperty.call(body, "team2")) updates.team2 = asString(body.team2);
    if (Object.prototype.hasOwnProperty.call(body, "actualWinner")) updates.actualWinner = asString(body.actualWinner);
    if (Object.prototype.hasOwnProperty.call(body, "actualScore")) updates.actualScore = asString(body.actualScore);
    sendJson(response, 200, {
      match: await updateMatch({
        matchId: matchUpdate[1],
        updates
      })
    });
    return;
  }

  const predictionUpdate = pathname.match(/^\/api\/matches\/([^/]+)\/predictions\/([^/]+)$/);
  if (predictionUpdate && method === "PATCH") {
    const body = await readBody(request);
    sendJson(response, 200, {
      result: await updatePredictionCell({
        matchId: predictionUpdate[1],
        modelId: predictionUpdate[2],
        rawValue: asString(body.rawValue)
      })
    });
    return;
  }

  const scoresMatch = pathname.match(/^\/api\/tournaments\/([^/]+)\/scores$/);
  if (scoresMatch && method === "GET") {
    sendJson(response, 200, { scores: getTournamentScores(scoresMatch[1]) });
    return;
  }

  const exportMatch = pathname.match(/^\/api\/tournaments\/([^/]+)\/export$/);
  if (exportMatch && method === "GET") {
    const mode = url.searchParams.get("mode") === "extended" ? "extended" : "legacy";
    sendText(response, 200, exportTournamentTsv(exportMatch[1], mode), "text/tab-separated-values");
    return;
  }

  const tweetMatch = pathname.match(/^\/api\/tournaments\/([^/]+)\/tweet$/);
  if (tweetMatch && method === "GET") {
    const type = (url.searchParams.get("type") ?? "leaderboard") as TweetDraftType;
    const ids = tournamentIdsFromParam(url.searchParams.get("tournamentIds"), tweetMatch[1]);
    sendJson(response, 200, { draft: ids.length > 1 ? generateCombinedTweetDraft(ids, type) : generateTweetDraft(ids[0], type) });
    return;
  }

  throw new HttpError(404, "API route not found.");
}

async function start(): Promise<void> {
  await migrateDatabase();
  const server = http.createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Unknown server error.";
      sendJson(response, status, { error: message, details: error instanceof HttpError ? error.details : undefined });
    });
  });

  server.listen(config.apiPort, "127.0.0.1", () => {
    console.log(`LLM Match Prediction Benchmark API listening on http://127.0.0.1:${config.apiPort}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
