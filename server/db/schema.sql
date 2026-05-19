PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  league TEXT NOT NULL,
  season INTEGER,
  stage TEXT,
  round_label TEXT,
  date_start TEXT,
  date_end TEXT,
  default_best_of INTEGER NOT NULL DEFAULT 3,
  leaguepedia_overview_page TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_leaguepedia_refresh_at TEXT
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id),
  match_order INTEGER NOT NULL,
  external_match_id TEXT,
  leaguepedia_match_id TEXT,
  overview_page TEXT,
  date_time_utc TEXT,
  stage TEXT,
  round_label TEXT,
  phase TEXT,
  tab TEXT,
  best_of INTEGER NOT NULL,
  team1 TEXT NOT NULL,
  team2 TEXT NOT NULL,
  actual_winner TEXT,
  actual_score TEXT,
  actual_source TEXT,
  manual_override INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tournament_id, match_order)
);

CREATE TABLE IF NOT EXISTS model_predictions (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  model_id TEXT NOT NULL REFERENCES models(id),
  predicted_winner TEXT NOT NULL,
  predicted_score TEXT NOT NULL,
  raw_input TEXT,
  raw_line TEXT,
  parse_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(match_id, model_id)
);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  tournament_id TEXT REFERENCES tournaments(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  summary_json TEXT,
  raw_payload_path TEXT
);

CREATE TABLE IF NOT EXISTS leaguepedia_cache (
  id TEXT PRIMARY KEY,
  query_hash TEXT NOT NULL UNIQUE,
  query_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matches_tournament_order ON matches(tournament_id, match_order);
CREATE INDEX IF NOT EXISTS idx_predictions_match_model ON model_predictions(match_id, model_id);
CREATE INDEX IF NOT EXISTS idx_models_sort_order ON models(sort_order);
