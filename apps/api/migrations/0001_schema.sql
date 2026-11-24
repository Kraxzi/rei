-- REI initial schema. See docs/Database.md.
-- Conventions: TEXT ids (ULID), ISO-8601 UTC timestamps, money INTEGER minor units + currency, JSON as TEXT.

-- ---------- reference ----------
CREATE TABLE countries (
  code TEXT PRIMARY KEY,               -- ISO 3166-1 alpha-2
  name TEXT NOT NULL,                  -- JSON {ru,it,en}
  currency TEXT NOT NULL,
  languages TEXT NOT NULL DEFAULT '[]',
  address_format TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE regions (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL REFERENCES countries(code),
  parent_id TEXT REFERENCES regions(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('region','province')),
  bbox TEXT,
  UNIQUE (country_code, level, code)
);
CREATE INDEX idx_regions_parent ON regions(parent_id);

CREATE TABLE cities (
  id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL REFERENCES regions(id),
  name TEXT NOT NULL,
  official_code TEXT,
  postal_codes TEXT NOT NULL DEFAULT '[]',
  lat REAL,
  lng REAL
);
CREATE INDEX idx_cities_region ON cities(region_id);
CREATE INDEX idx_cities_name ON cities(name);

CREATE TABLE country_rules (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL REFERENCES countries(code),
  region_id TEXT REFERENCES regions(id),
  topic TEXT NOT NULL,                 -- purchase_tax, holding_tax, short_term_rental, foreign_buyers, usage, ...
  applies_to TEXT,                     -- JSON filter: categories/types/buyer kind
  data TEXT NOT NULL,                  -- JSON
  source_url TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  reliability TEXT NOT NULL CHECK (reliability IN ('verified','unverified','outdated')),
  notes TEXT
);
CREATE INDEX idx_rules_country_topic ON country_rules(country_code, topic);

CREATE TABLE property_categories (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  fields TEXT NOT NULL,
  required TEXT NOT NULL,
  filters TEXT NOT NULL,
  scoring_profile TEXT NOT NULL,
  typical_risks TEXT NOT NULL,
  legal_checks TEXT NOT NULL,
  comparable_keys TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE property_types (
  code TEXT PRIMARY KEY,
  category_code TEXT NOT NULL REFERENCES property_categories(code),
  name TEXT NOT NULL,
  financial_models TEXT NOT NULL,      -- JSON array, first = default
  extra_fields TEXT NOT NULL DEFAULT '[]',
  required TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_types_category ON property_types(category_code);

CREATE TABLE field_definitions (
  key TEXT PRIMARY KEY,
  def TEXT NOT NULL                    -- JSON FieldDef
);

CREATE TABLE fx_rates (
  date TEXT NOT NULL,
  quote TEXT NOT NULL,
  rate REAL NOT NULL,                  -- units of quote per 1 EUR (ECB)
  PRIMARY KEY (date, quote)
);

CREATE TABLE market_indicators (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                -- omi, dvf, boris, ...
  country_code TEXT NOT NULL,
  zone_code TEXT NOT NULL,
  city_id TEXT REFERENCES cities(id),
  property_type TEXT,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  period TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('asking','transaction','official_estimate')),
  source_url TEXT,
  fetched_at TEXT NOT NULL
);
CREATE INDEX idx_mi_lookup ON market_indicators(country_code, zone_code, property_type, metric, period);

-- ---------- users & access ----------
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('owner','admin','user')),
  locale TEXT NOT NULL DEFAULT 'ru',
  created_at TEXT NOT NULL
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,                 -- credential id (base64url)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,            -- base64url COSE key
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX idx_passkeys_user ON passkeys(user_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- SHA-256 of the session token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  user_id TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('register','login')),
  expires_at TEXT NOT NULL
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  details TEXT,
  ip_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_logs(created_at);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  keys TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ---------- sources & collection ----------
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('auction','agency','public','bank','manual','test')),
  connector TEXT NOT NULL,
  base_url TEXT,
  country_code TEXT REFERENCES countries(code),
  region_id TEXT REFERENCES regions(id),
  access_status TEXT NOT NULL CHECK (access_status IN
    ('official_api','partner_feed','authorized_account','approved_public','manual_import','not_connected','forbidden','candidate')),
  audit TEXT,
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  scan_interval_min INTEGER NOT NULL DEFAULT 720,
  rate_limit_ms INTEGER NOT NULL DEFAULT 5000,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_sources_base_url ON sources(base_url);

CREATE TABLE source_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id),
  token_enc TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE scan_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','ok','partial','error','skipped')),
  pages INTEGER NOT NULL DEFAULT 0,
  listings_seen INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX idx_scan_runs_source ON scan_runs(source_id, started_at);

CREATE TABLE source_health (
  source_id TEXT PRIMARY KEY REFERENCES sources(id),
  status TEXT NOT NULL CHECK (status IN ('ok','degraded','broken')),
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_ok_at TEXT,
  last_error TEXT
);

CREATE TABLE job_runs (
  job_key TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);

-- ---------- properties & listings ----------
CREATE TABLE properties (
  id TEXT PRIMARY KEY,
  type_code TEXT NOT NULL REFERENCES property_types(code),
  country_code TEXT NOT NULL REFERENCES countries(code),
  region_id TEXT REFERENCES regions(id),
  city_id TEXT REFERENCES cities(id),
  address_norm TEXT,
  postal_code TEXT,
  lat REAL,
  lng REAL,
  geo_precision TEXT CHECK (geo_precision IN ('exact','street','city','unknown')),
  geohash TEXT,
  area_m2 REAL,
  rooms INTEGER,
  floor INTEGER,
  features TEXT NOT NULL DEFAULT '{}',
  provenance TEXT NOT NULL DEFAULT '{}',
  merged_into TEXT REFERENCES properties(id),
  is_test INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_props_geohash ON properties(geohash);
CREATE INDEX idx_props_latlng ON properties(lat, lng);
CREATE INDEX idx_props_type_country ON properties(type_code, country_code);
CREATE INDEX idx_props_city ON properties(city_id);

CREATE TABLE listings (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  description TEXT,
  price INTEGER,
  currency TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','removed','reappeared')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  removed_at TEXT,
  raw TEXT NOT NULL,
  normalized TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_id, external_id)
);
CREATE INDEX idx_listings_property ON listings(property_id);
CREATE INDEX idx_listings_status_seen ON listings(status, last_seen_at);

CREATE TABLE listing_events (
  id TEXT PRIMARY KEY,
  listing_id TEXT REFERENCES listings(id),
  property_id TEXT NOT NULL REFERENCES properties(id),
  type TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  occurred_at TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_events_property ON listing_events(property_id, occurred_at);

CREATE TABLE price_history (
  listing_id TEXT NOT NULL REFERENCES listings(id),
  price INTEGER NOT NULL,
  currency TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (listing_id, observed_at)
);

CREATE TABLE property_images (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  listing_id TEXT REFERENCES listings(id),
  url TEXT NOT NULL,
  phash TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  gone_at TEXT
);
CREATE INDEX idx_images_property ON property_images(property_id);

CREATE TABLE property_documents (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  url_or_note TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE dedup_candidates (
  id TEXT PRIMARY KEY,
  property_a TEXT NOT NULL REFERENCES properties(id),
  property_b TEXT NOT NULL REFERENCES properties(id),
  probability REAL NOT NULL,
  signals TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','merged','rejected')),
  decided_by TEXT,
  decided_at TEXT,
  UNIQUE (property_a, property_b)
);

CREATE TABLE comparable_properties (
  property_id TEXT NOT NULL REFERENCES properties(id),
  comparable_id TEXT NOT NULL REFERENCES properties(id),
  similarity REAL NOT NULL,
  basis TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (property_id, comparable_id)
);

-- ---------- analytics ----------
CREATE TABLE property_valuations (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  method TEXT NOT NULL,
  value_low INTEGER, value_mid INTEGER, value_high INTEGER,
  currency TEXT NOT NULL,
  inputs TEXT NOT NULL,
  confidence REAL NOT NULL,
  computed_at TEXT NOT NULL
);
CREATE INDEX idx_valuations_property ON property_valuations(property_id, computed_at);

CREATE TABLE rental_models (
  id TEXT PRIMARY KEY,
  property_id TEXT REFERENCES properties(id),
  user_id TEXT REFERENCES users(id),
  model TEXT NOT NULL,
  inputs TEXT NOT NULL,
  assumptions TEXT NOT NULL,
  results TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  computed_at TEXT NOT NULL
);
CREATE INDEX idx_rental_models_property ON rental_models(property_id, computed_at);

CREATE TABLE investment_scores (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  profile_code TEXT NOT NULL,
  score REAL NOT NULL,
  components TEXT NOT NULL,
  confidence REAL NOT NULL,
  confidence_reasons TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  computed_at TEXT NOT NULL
);
CREATE INDEX idx_scores_property ON investment_scores(property_id, computed_at);

CREATE TABLE ai_analyses (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  module TEXT NOT NULL CHECK (module IN ('property','location','market','legal','financial','deal')),
  tier INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output TEXT NOT NULL,
  tokens_in INTEGER, tokens_out INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_lookup ON ai_analyses(property_id, module, input_hash);

-- ---------- user data ----------
CREATE TABLE search_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  countries TEXT NOT NULL DEFAULT '[]',
  regions TEXT NOT NULL DEFAULT '[]',
  cities TEXT NOT NULL DEFAULT '[]',
  geo TEXT NOT NULL DEFAULT '{}',
  type_codes TEXT NOT NULL DEFAULT '[]',
  price_min INTEGER, price_max INTEGER,
  area_min REAL, area_max REAL,
  target_net_yield REAL,
  condition TEXT NOT NULL DEFAULT '[]',
  extra TEXT NOT NULL DEFAULT '{}',
  strategy TEXT NOT NULL DEFAULT 'income' CHECK (strategy IN ('income','growth','value_add','mixed')),
  refresh_min INTEGER NOT NULL DEFAULT 720,
  notify TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_profiles_user ON search_profiles(user_id);

CREATE TABLE favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(id),
  priority INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, property_id)
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES listing_events(id),
  profile_id TEXT REFERENCES search_profiles(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('push','telegram')),
  status TEXT NOT NULL CHECK (status IN ('queued','sent','failed','suppressed')),
  sent_at TEXT,
  UNIQUE (user_id, event_id, channel)
);

CREATE TABLE portfolios (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_currency TEXT NOT NULL DEFAULT 'EUR'
);

CREATE TABLE portfolio_assets (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  property_id TEXT REFERENCES properties(id),
  name TEXT NOT NULL,
  purchase_date TEXT,
  purchase_price INTEGER,
  currency TEXT NOT NULL DEFAULT 'EUR',
  forecast_model_id TEXT REFERENCES rental_models(id)
);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES portfolio_assets(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  category TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  note TEXT
);

CREATE TABLE rental_income (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES portfolio_assets(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  tenant TEXT,
  note TEXT
);
