import path from "node:path";

const rootDir = process.cwd();
const dataDir = process.env.LOLPH_DATA_DIR
  ? path.resolve(process.env.LOLPH_DATA_DIR)
  : path.join(rootDir, "data");

const primaryDbPath = process.env.LOLPH_DB_PATH
  ? path.resolve(process.env.LOLPH_DB_PATH)
  : path.join(dataDir, "predictions.sqlite");

const safetyDbPath = process.env.LOLPH_SAFETY_DB_PATH
  ? path.resolve(process.env.LOLPH_SAFETY_DB_PATH)
  : primaryDbPath.endsWith(".sqlite")
    ? primaryDbPath.replace(/\.sqlite$/, ".safety.sqlite")
    : path.join(path.dirname(primaryDbPath), "predictions.safety.sqlite");

export const defaultModels = ["gpt", "Grok", "Kimi", "Gemini", "DeepSeek", "GLM", "Claude"] as const;

export const legacyModelColumns = [...defaultModels];

export const config = {
  rootDir,
  dataDir,
  primaryDbPath,
  safetyDbPath,
  apiPort: Number(process.env.LOLPH_API_PORT ?? 8787),
  leagueWeekStartDay: 2,
  leaguepediaApiUrl: "https://lol.fandom.com/api.php?action=cargoquery",
  leaguepediaMinRequestIntervalMs: Number(process.env.LOLPH_LEAGUEPEDIA_MIN_INTERVAL_MS ?? 65000),
  leaguepediaRateLimitRetryMs: Number(process.env.LOLPH_LEAGUEPEDIA_RETRY_MS ?? 65000)
};
