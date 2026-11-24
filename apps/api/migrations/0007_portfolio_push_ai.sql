-- App settings (generated keys etc.), push, portfolio helpers, auction source candidate.
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Official Italian judicial auctions portal: added as a candidate. It goes through the same audit and needs
-- an explicit approval like any other source (its terms and technical access are checked, not assumed).
INSERT OR IGNORE INTO sources (id, name, kind, connector, base_url, country_code, access_status, verdict, is_active, created_at)
VALUES ('pvp-it', 'Portale delle Vendite Pubbliche (Минюст Италии)', 'auction', 'generic', 'https://pvp.giustizia.it', 'IT', 'candidate', 'pending', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE INDEX idx_portfolio_assets_portfolio ON portfolio_assets(portfolio_id);
CREATE INDEX idx_expenses_asset ON expenses(asset_id, date);
CREATE INDEX idx_income_asset ON rental_income(asset_id, period_start);

ALTER TABLE portfolio_assets ADD COLUMN total_cost INTEGER;      -- price + purchase costs actually paid
ALTER TABLE portfolio_assets ADD COLUMN expected_noi INTEGER;    -- forecast net operating income per year
ALTER TABLE portfolio_assets ADD COLUMN created_at TEXT;
