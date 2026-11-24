# REI — Схема базы данных (D1 / SQLite)

Миграции: `apps/api/migrations/NNNN_*.sql`, применяются `wrangler d1 migrations apply`.

Соглашения:
- id — TEXT (ULID), даты — TEXT ISO-8601 UTC, деньги — INTEGER в минимальных единицах валюты + `currency` (ISO 4217).
- Гибкие наборы полей — JSON (TEXT, проверяется в коде по схеме категории).
- Происхождение значения (`provenance`) — JSON `{ field: { source_id, fetched_at, confidence } }`.
- Все пользовательские данные — с `user_id` (мультиарендность в будущем).
- Тестовые данные — `is_test = 1`.

## Справочники

| Таблица | Назначение | Ключевые поля |
|---|---|---|
| `countries` | страны | `code` (ISO-3166 alpha-2), `name`, `currency`, `languages` JSON, `address_format` |
| `regions` | регионы/провинции | `country_code`, `code`, `name`, `level` (region/province), `bbox` JSON |
| `cities` | города/коммуны | `region_id`, `name`, `postal_codes` JSON, `lat`, `lng`, `istat_code`/аналог |
| `country_rules` | налоги и правила | `country_code`, `region_id?`, `topic` (purchase_tax, holding_tax, short_term_rental, foreign_buyers, usage…), `data` JSON, `source_url`, `verified_at`, `reliability` (verified/unverified/outdated) |
| `property_categories` | категории (жильё, коммерция…) | `code`, `name` JSON (ru/it/en), `sort` |
| `property_types` | типы внутри категорий | `category_code`, `code`, `name` JSON, `field_schema` JSON (поля, обязательные, единицы), `filters` JSON, `financial_model`, `scoring_profile`, `typical_risks` JSON, `legal_checks` JSON, `comparable_keys` JSON, `is_active` |
| `fx_rates` | курсы ЕЦБ | `date`, `base`='EUR', `quote`, `rate` |
| `market_indicators` | OMI, DVF, BORIS… | `source`, `country_code`, `zone_code`, `property_type`, `metric` (sale_eur_m2_min/max, rent_eur_m2_month…), `value`, `period`, `kind` (asking/transaction/official_estimate), `fetched_at` |

Новая категория/тип добавляется строкой в `property_types` — без изменения кода, если подходит одна из существующих финансовых моделей.

## Пользователи и доступ

| Таблица | Поля |
|---|---|
| `users` | `id`, `email?`, `display_name`, `role` (owner/admin/user), `locale`, `created_at` |
| `passkeys` | `id` (credential id), `user_id`, `public_key`, `counter`, `transports`, `created_at`, `last_used_at` |
| `sessions` | `id` (хэш токена), `user_id`, `expires_at`, `created_at`, `user_agent` |
| `audit_logs` | `id`, `user_id?`, `action`, `entity`, `entity_id`, `details` JSON, `ip_hash`, `created_at` |
| `push_subscriptions` | `id`, `user_id`, `endpoint`, `keys` JSON, `created_at` |

## Источники и сбор

| Таблица | Поля |
|---|---|
| `sources` | `id`, `name`, `kind` (auction/agency/public/bank/manual), `connector` (код адаптера), `base_url`, `country_code`, `region_id?`, `access_status` (см. Architecture §5), `audit` JSON (robots, antibot, crm, jsonld, tos_summary), `approved_by`, `approved_at`, `scan_interval_min`, `rate_limit_ms`, `is_active` |
| `source_accounts` | `id`, `user_id`, `source_id`, `token_enc`, `expires_at`, `status` — на будущее, если источник разрешит |
| `scan_runs` | `id`, `source_id`, `started_at`, `finished_at`, `status` (ok/partial/error/skipped), `pages`, `listings_seen`, `error` |
| `source_health` | `source_id`, `status` (ok/degraded/broken), `consecutive_errors`, `last_ok_at`, `last_error` |
| `job_runs` | `job_key` PK, `processed_at` — идемпотентность очередей |

## Объекты и объявления

Физический объект ≠ объявление (ТЗ VIII).

| Таблица | Поля |
|---|---|
| `properties` | физический объект: `id`, `type_code`, `country_code`, `region_id`, `city_id`, `address_norm`, `postal_code`, `lat`, `lng`, `geo_precision` (exact/street/city), `geohash`, `area_m2`, `rooms`, `floor`, `features` JSON, `provenance` JSON, `is_test`, `created_at`, `updated_at` |
| `listings` | объявление на источнике: `id`, `property_id`, `source_id`, `external_id`, `url`, `title`, `description`, `price` INTEGER, `currency`, `status` (active/removed/reappeared), `first_seen_at`, `last_seen_at`, `removed_at?`, `raw` JSON (исходник как есть), `normalized` JSON, `content_hash`, `is_test` · UNIQUE(`source_id`,`external_id`) |
| `listing_events` | `id`, `listing_id`, `property_id`, `type` (new, price_down, price_up, features_changed, photos_changed, republished, removed, reappeared, cross_posted), `old_value` JSON, `new_value` JSON, `occurred_at`, `event_key` UNIQUE (защита от дублей уведомлений) |
| `price_history` | `listing_id`, `price`, `currency`, `observed_at` |
| `property_images` | `id`, `property_id`, `listing_id`, `url` (ссылка на оригинал), `phash?`, `position`, `first_seen_at`, `gone_at?` |
| `property_documents` | `id`, `property_id`, `user_id`, `kind`, `url_or_note`, `created_at` |
| `dedup_candidates` | `id`, `property_a`, `property_b`, `probability`, `signals` JSON, `status` (pending/merged/rejected), `decided_by`, `decided_at` |
| `comparable_properties` | `property_id`, `comparable_id`, `similarity`, `basis` JSON, `computed_at` |

Аукционы: `listings.normalized` содержит `auction` {date, base_price, min_offer, court, procedure_id, lot}; тип события `auction_scheduled`.

## Аналитика

| Таблица | Поля |
|---|---|
| `property_valuations` | `id`, `property_id`, `method` (omi_range/comparables/manual), `value_low`, `value_mid`, `value_high`, `currency`, `inputs` JSON, `confidence`, `computed_at` |
| `rental_models` | `id`, `property_id`, `user_id?`, `model` (код финмодели), `inputs` JSON, `assumptions` JSON, `results` JSON (сценарии × горизонты), `engine_version`, `computed_at` |
| `investment_scores` | `id`, `property_id`, `profile_code`, `score` 0–100, `components` JSON, `confidence` (0–1), `confidence_reasons` JSON, `engine_version`, `computed_at` |
| `ai_analyses` | `id`, `property_id`, `module` (property/location/market/legal/financial/deal), `tier` (2/3), `provider`, `model`, `input_hash`, `output` JSON (вывод, данные, источники, недостающее, предположения, уверенность, риски, что проверить), `tokens_in`, `tokens_out`, `created_at` |

## Пользовательское

| Таблица | Поля |
|---|---|
| `search_profiles` | `id`, `user_id`, `name`, `countries` JSON, `regions` JSON, `cities` JSON, `geo` JSON (центр+радиус / полигоны / исключения), `type_codes` JSON, `price_min/max`, `area_min/max`, `target_net_yield`, `condition` JSON, `extra` JSON, `strategy` (income/growth/value_add/mixed), `refresh_min`, `notify` JSON (пороги), `is_active`, `created_at`, `updated_at` |
| `favorites` | `user_id`, `property_id`, `priority`, `created_at` |
| `notes` | `id`, `user_id`, `property_id`, `text`, `created_at` |
| `alerts` | `id`, `user_id`, `event_id`, `profile_id?`, `channel` (push/telegram), `status` (queued/sent/failed/suppressed), `sent_at` · UNIQUE(`user_id`,`event_id`,`channel`) |
| `portfolios` | `id`, `user_id`, `name`, `base_currency` |
| `portfolio_assets` | `id`, `portfolio_id`, `property_id?`, `name`, `purchase_date`, `purchase_price`, `currency`, `forecast_model_id?` |
| `expenses` | `id`, `asset_id`, `date`, `category`, `amount`, `currency`, `note` |
| `rental_income` | `id`, `asset_id`, `period_start`, `period_end`, `amount`, `currency`, `tenant?`, `note` |

## Индексы (основные)

- `properties(geohash)`, `properties(lat, lng)`, `properties(type_code, country_code)`, `properties(city_id)`
- `listings(property_id)`, `listings(status, last_seen_at)`, UNIQUE `listings(source_id, external_id)`
- `listing_events(property_id, occurred_at)`, UNIQUE `listing_events(event_key)`
- `investment_scores(property_id, computed_at)`, `ai_analyses(property_id, module, input_hash)`

## Гео без PostGIS

- Радиус: префильтр по bbox (`lat BETWEEN … AND lng BETWEEN …`, индекс), затем точная дистанция (haversine) в коде.
- Полигоны и исключаемые зоны: bbox полигона → кандидаты из SQL → point-in-polygon в коде.
- Дедуп: соседи по префиксу geohash (точность 6–7 знаков ≈ 1 км / 150 м).
