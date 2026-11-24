-- Listing ingestion, monitoring, analysis cache, notifications.
ALTER TABLE listings ADD COLUMN deal_type TEXT CHECK (deal_type IN ('sale','rent'));
ALTER TABLE listings ADD COLUMN missed_runs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE listings ADD COLUMN last_fetched_at TEXT;
ALTER TABLE listings ADD COLUMN extraction TEXT; -- {method, confidence}
CREATE INDEX idx_listings_source_url ON listings(source_id, url);
CREATE INDEX idx_listings_deal_status ON listings(deal_type, status);

-- analysis cache on the physical property (latest values; history lives in investment_scores etc.)
ALTER TABLE properties ADD COLUMN primary_listing_id TEXT;
ALTER TABLE properties ADD COLUMN score REAL;
ALTER TABLE properties ADD COLUMN score_confidence REAL;
ALTER TABLE properties ADD COLUMN net_yield REAL;
ALTER TABLE properties ADD COLUMN undervaluation REAL;
ALTER TABLE properties ADD COLUMN analyzed_at TEXT;
CREATE INDEX idx_props_score ON properties(score);
CREATE INDEX idx_props_analyzed ON properties(analyzed_at);

-- pages that are not listings (or lack a recognisable type): remembered so we don't refetch them every run
CREATE TABLE ignored_urls (
  source_id TEXT NOT NULL REFERENCES sources(id),
  url TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, url)
);

CREATE TABLE source_crawl_state (
  source_id TEXT PRIMARY KEY REFERENCES sources(id),
  last_scan_at TEXT,
  last_complete_at TEXT,
  urls_found INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  property_id TEXT REFERENCES properties(id),
  profile_id TEXT REFERENCES search_profiles(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  pushed_at TEXT,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at);

CREATE UNIQUE INDEX idx_cities_region_name ON cities(region_id, name);
