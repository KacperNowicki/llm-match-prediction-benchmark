import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config";

export type AppDatabase = InstanceType<typeof DatabaseSync>;

let db: AppDatabase | null = null;

export function ensureDatabaseFile(dbPath = config.primaryDbPath): void {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  if (!existsSync(dbPath)) {
    const initial = new DatabaseSync(dbPath);
    initial.close();
  }
}

export function openDatabase(dbPath = config.primaryDbPath): AppDatabase {
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA journal_mode = DELETE;");
  database.exec("PRAGMA synchronous = FULL;");
  return database;
}

export function getDb(): AppDatabase {
  if (!db) {
    ensureDatabaseFile();
    db = openDatabase();
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function withTransaction<T>(database: AppDatabase, work: () => T): T {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = work();
    database.exec("COMMIT;");
    return result;
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

