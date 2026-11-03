import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(join(config.dataDir, "pricewatch.db"));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS items (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  query         TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'other',
  priority      TEXT NOT NULL DEFAULT 'buy',      -- 'buy' | 'bargain'
  target        REAL,                              -- in base currency
  notes         TEXT NOT NULL DEFAULT '',
  pricespy_ids  TEXT NOT NULL DEFAULT '[]',        -- JSON array of PriceSpy product ids
  allow_used    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                     -- 'changedetection' | 'pricespy' | 'manual'
  seller        TEXT NOT NULL,
  country       TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL DEFAULT '',
  currency      TEXT NOT NULL DEFAULT '',
  shipping      REAL,                              -- base currency, null = unknown
  import_fees   REAL,                              -- base currency, null = none/unknown
  condition     TEXT NOT NULL DEFAULT 'new',
  cd_uuid       TEXT,
  ext_key       TEXT,                              -- e.g. pricespy "<productId>:<shopId>"
  note          TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  UNIQUE(item_id, kind, ext_key)
);

CREATE TABLE IF NOT EXISTS observations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  t             TEXT NOT NULL,
  price         REAL,
  currency      TEXT NOT NULL DEFAULT '',
  in_stock      INTEGER,                           -- 1, 0 or NULL (unknown)
  total_base    REAL,
  raw           TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS obs_source_t ON observations(source_id, t);

CREATE TABLE IF NOT EXISTS item_history (
  item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  t             TEXT NOT NULL,
  best          REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS hist_item_t ON item_history(item_id, t);

CREATE TABLE IF NOT EXISTS alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                     -- 'target' | 'drop' | 'discovery' | 'restock'
  msg           TEXT NOT NULL,
  total         REAL,
  seller        TEXT,
  t             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discoveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  t             TEXT NOT NULL,
  origin        TEXT NOT NULL,                     -- 'pricespy' | 'claude' | 'manual'
  text          TEXT NOT NULL,
  url           TEXT,
  price         REAL,
  currency      TEXT,
  seller        TEXT
);

CREATE TABLE IF NOT EXISTS kv (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);
`);

export const nowIso = () => new Date().toISOString();

export function kvGet<T>(key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function kvSet(key: string, value: unknown): void {
  db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}

export interface ItemRow {
  id: string;
  name: string;
  query: string;
  category: string;
  priority: string;
  target: number | null;
  notes: string;
  pricespy_ids: string;
  allow_used: number;
  active: number;
  created_at: string;
}

export interface SourceRow {
  id: number;
  item_id: string;
  kind: string;
  seller: string;
  country: string;
  url: string;
  currency: string;
  shipping: number | null;
  import_fees: number | null;
  condition: string;
  cd_uuid: string | null;
  ext_key: string | null;
  note: string;
  active: number;
  created_at: string;
}

export interface ObservationRow {
  id: number;
  source_id: number;
  t: string;
  price: number | null;
  currency: string;
  in_stock: number | null;
  total_base: number | null;
  raw: string;
}
