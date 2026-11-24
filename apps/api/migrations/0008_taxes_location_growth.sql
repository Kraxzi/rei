-- Verified Italian tax rules (documentation of what the engine applies), POI cache, analysis columns.
CREATE TABLE location_cache (
  geohash6 TEXT PRIMARY KEY,
  pois TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

ALTER TABLE properties ADD COLUMN net_yield_after_tax REAL;
ALTER TABLE properties ADD COLUMN location_score REAL;

INSERT INTO country_rules (id, country_code, topic, applies_to, data, source_url, verified_at, reliability, notes) VALUES
('it-purchase-private', 'IT', 'purchase_tax', '{"seller":"private"}',
 '{"registro":{"second_home":0.09,"first_home":0.02,"min_eur":1000},"ipotecaria_eur":50,"catastale_eur":50,"prezzo_valore":{"who":"individual buying residential + pertinences","base":"rendita x 1.05 x 120 (first home 110)"}}',
 'https://www.agenziaentrate.gov.it/portale/documents/20143/3949367/Guida_acquisto__Casa_imposte_e_agevolazioni.pdf', '2026-11-24', 'verified',
 'Agenzia delle Entrate, guida marzo 2024; minimo 1 000 € e tabelle: guida Notariato 2025.'),
('it-purchase-vat', 'IT', 'purchase_tax', '{"seller":"vat_company","category":"residential"}',
 '{"iva":{"standard":0.10,"first_home":0.04},"registro_eur":200,"ipotecaria_eur":200,"catastale_eur":200}',
 'https://lavoripubblici.it/documenti2025/lvpb1/guida-notariato-agevolazioni-prima-casa-2025.pdf', '2026-11-24', 'verified',
 'Lusso A/1, A/8, A/9 e immobili non abitativi: non gestiti automaticamente.'),
('it-imu', 'IT', 'holding_tax', '{}',
 '{"base":"rendita x 1.05 x multiplier","multipliers":{"A":160,"A/10":80,"B":140,"C/1":55,"C/2":160,"C/3":140,"C/6":160,"C/7":160,"D":65},"rate_base":0.0086,"rate_max":0.0106,"main_residence":"exempt except A/1, A/8, A/9"}',
 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2019-12-27;160', '2026-11-24', 'verified',
 'Aliquota effettiva decisa da ogni comune (fino a 1,14% in alcuni comuni).'),
('it-cedolare', 'IT', 'rental_income_tax', '{}',
 '{"long_ordinary":0.21,"long_concordato":0.10,"short_first":0.21,"short_second":0.26,"short_from_third":"partita IVA"}',
 'https://www.agenziaentrate.gov.it/portale/cedolare-secca', '2026-11-24', 'verified',
 'Legge di Bilancio 2026 per le locazioni brevi.');

INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('tax_profile', '{"buyer":"individual","firstHome":false,"rentalRegime":"long_ordinary"}', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
