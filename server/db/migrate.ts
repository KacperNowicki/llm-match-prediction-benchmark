import { readFileSync } from "node:fs";
import path from "node:path";
import { defaultModels } from "../config";
import { nowIso, stableId } from "../lib/id";
import { copyPrimaryToSafety } from "./safety";
import { ensureDatabaseFile, getDb, withTransaction } from "./connection";

export async function migrateDatabase(): Promise<void> {
  ensureDatabaseFile();
  const db = getDb();
  await copyPrimaryToSafety(db, "migration");
  const schema = readFileSync(path.join(process.cwd(), "server", "db", "schema.sql"), "utf8");

  withTransaction(db, () => {
    db.exec(schema);
    seedDefaultModels(db);
    db.prepare(
      `INSERT INTO app_settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run("league_week_start_day", JSON.stringify(2), nowIso());
  });
}

function seedDefaultModels(db: ReturnType<typeof getDb>): void {
  const now = nowIso();
  const insert = db.prepare(
    `INSERT INTO models (id, name, display_name, is_active, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(name) DO NOTHING`
  );

  defaultModels.forEach((name, index) => {
    insert.run(stableId("model", name), name, name, index + 1, now, now);
  });
}

