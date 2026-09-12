-- Issue #1 Phase 1: 集計値だけを保存するD1スキーマ
-- 実データ投入前に必ずローカルで適用し、検証済みSQLだけをremoteへ送る。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sync_runs (
  sync_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  source_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging', 'active', 'failed', 'superseded')),
  source_max_date TEXT,
  daily_count INTEGER NOT NULL DEFAULT 0,
  monthly_count INTEGER NOT NULL DEFAULT 0,
  category_count INTEGER NOT NULL DEFAULT 0,
  asset_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
);

CREATE TABLE IF NOT EXISTS daily_summaries (
  sync_id TEXT NOT NULL,
  date TEXT NOT NULL,
  income_yen INTEGER NOT NULL,
  expense_yen INTEGER NOT NULL,
  balance_yen INTEGER NOT NULL,
  transaction_count INTEGER NOT NULL,
  PRIMARY KEY (sync_id, date)
);

CREATE TABLE IF NOT EXISTS monthly_summaries (
  sync_id TEXT NOT NULL,
  month TEXT NOT NULL,
  income_yen INTEGER NOT NULL,
  expense_yen INTEGER NOT NULL,
  balance_yen INTEGER NOT NULL,
  transaction_count INTEGER NOT NULL,
  PRIMARY KEY (sync_id, month)
);

CREATE TABLE IF NOT EXISTS category_daily_totals (
  sync_id TEXT NOT NULL,
  date TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('income', 'expense')),
  category TEXT NOT NULL,
  amount_yen INTEGER NOT NULL,
  transaction_count INTEGER NOT NULL,
  PRIMARY KEY (sync_id, date, direction, category)
);

CREATE TABLE IF NOT EXISTS category_totals (
  sync_id TEXT NOT NULL,
  month TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('income', 'expense')),
  category TEXT NOT NULL,
  amount_yen INTEGER NOT NULL,
  transaction_count INTEGER NOT NULL,
  PRIMARY KEY (sync_id, month, direction, category)
);

CREATE TABLE IF NOT EXISTS asset_summaries (
  sync_id TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  amount_yen INTEGER NOT NULL,
  PRIMARY KEY (sync_id, as_of_date, asset_type)
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_status_completed
  ON sync_runs (status, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_summaries_sync_date
  ON daily_summaries (sync_id, date);
CREATE INDEX IF NOT EXISTS idx_category_daily_sync_date
  ON category_daily_totals (sync_id, date, direction, category);
CREATE INDEX IF NOT EXISTS idx_category_totals_sync_month
  ON category_totals (sync_id, month, direction, category);

