import { mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { backup } from "node:sqlite";
import { config } from "../config";
import type { AppDatabase } from "./connection";

export async function copyPrimaryToSafety(
  database: AppDatabase,
  reason: string,
  safetyPath = config.safetyDbPath
): Promise<void> {
  try {
    mkdirSync(path.dirname(safetyPath), { recursive: true });
    const tempSafetyPath = `${safetyPath}.tmp`;
    database.exec("PRAGMA wal_checkpoint(FULL);");
    rmSync(tempSafetyPath, { force: true });
    await backup(database, tempSafetyPath);
    rmSync(safetyPath, { force: true });
    renameSync(tempSafetyPath, safetyPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Safety database backup failed before ${reason}. Operation cancelled. ${detail}`);
  }
}
