-- Automatic source discovery per search-profile region (owner decision 24.11.2026: variant B — discover & audit
-- automatically, connect only after a human approves).
ALTER TABLE regions ADD COLUMN iso_code TEXT;
UPDATE regions SET iso_code = CASE code
  WHEN '01' THEN 'IT-21' WHEN '02' THEN 'IT-23' WHEN '03' THEN 'IT-25' WHEN '04' THEN 'IT-32' WHEN '05' THEN 'IT-34'
  WHEN '06' THEN 'IT-36' WHEN '07' THEN 'IT-42' WHEN '08' THEN 'IT-45' WHEN '09' THEN 'IT-52' WHEN '10' THEN 'IT-55'
  WHEN '11' THEN 'IT-57' WHEN '12' THEN 'IT-62' WHEN '13' THEN 'IT-65' WHEN '14' THEN 'IT-67' WHEN '15' THEN 'IT-72'
  WHEN '16' THEN 'IT-75' WHEN '17' THEN 'IT-77' WHEN '18' THEN 'IT-78' WHEN '19' THEN 'IT-82' WHEN '20' THEN 'IT-88' END
WHERE country_code = 'IT' AND level = 'region';
UPDATE regions SET iso_code = 'IT-' || code WHERE country_code = 'IT' AND level = 'province';

CREATE TABLE region_discoveries (
  id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL REFERENCES regions(id),
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','error')),
  requested_by TEXT REFERENCES users(id),
  found INTEGER NOT NULL DEFAULT 0,
  without_website INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_discoveries_region ON region_discoveries(region_id, created_at);

ALTER TABLE sources ADD COLUMN osm_id TEXT;
ALTER TABLE sources ADD COLUMN lat REAL;
ALTER TABLE sources ADD COLUMN lng REAL;
ALTER TABLE sources ADD COLUMN city TEXT;
ALTER TABLE sources ADD COLUMN verdict TEXT CHECK (verdict IN ('pending','suitable','review','rejected'));
ALTER TABLE sources ADD COLUMN audited_at TEXT;
ALTER TABLE sources ADD COLUMN decision TEXT CHECK (decision IN ('approved','declined'));
CREATE INDEX idx_sources_region_verdict ON sources(region_id, verdict);

-- AI provider usage ledger (daily budget on the free tier)
CREATE TABLE ai_calls (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  ok INTEGER NOT NULL,
  tokens_in INTEGER, tokens_out INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_calls_day ON ai_calls(day);
