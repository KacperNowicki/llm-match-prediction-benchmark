import { getDb } from "../db/connection";
import { createId, nowIso } from "../lib/id";

export type AuditEntry = {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
};

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function writeAudit(entry: AuditEntry): void {
  getDb()
    .prepare(
      `INSERT INTO audit_log (
        id, action, entity_type, entity_id, before_json, after_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      createId("audit"),
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      jsonOrNull(entry.before),
      jsonOrNull(entry.after),
      nowIso()
    );
}
