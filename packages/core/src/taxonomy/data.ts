import type { FinancialModelCode } from '../financial/models.js';

/**
 * Initial Property Asset Taxonomy (spec part III). This is seed data: the database is the source of truth
 * and an admin can add categories/types without code changes, as long as they use an existing financial model.
 */

export type I18n = { ru: string; it: string; en: string };

export interface CategoryDef {
  code: string;
  name: I18n;
  /** Fields shown for every type of the category. */
  fields: string[];
  required: string[];
  /** Search filters offered for the category (field keys + 'price', 'price_m2', 'net_yield', 'score'). */
  filters: string[];
  scoringProfile: string;
  typicalRisks: string[];
  legalChecks: string[];
  comparableKeys: string[];
}

export interface TypeDef {
  code: string;
  category: string;
  name: I18n;
  /** First = default model; others = alternative strategies (e.g. long vs short-term rental). */
  financialModels: FinancialModelCode[];
  extraFields?: string[];
  required?: string[];
}

const COMMON = ['area_m2', 'condition', 'year_built', 'energy_class'];
const BASE_FILTERS = ['price', 'price_m2', 'net_yield', 'score'];

export const CATEGORIES: CategoryDef[] = [
  {
    code: 'residential',
    name: { ru: 'Жилая', it: 'Residenziale', en: 'Residential' },
    fields: [...COMMON, 'floor', 'floors_total', 'rooms', 'bedrooms', 'bathrooms', 'elevator', 'balcony_terrace', 'garden', 'parking_included', 'sea_view', 'furnished'],
    required: ['area_m2'],
    filters: [...BASE_FILTERS, 'area_m2', 'rooms', 'condition', 'sea_view'],
    scoringProfile: 'residential',
    typicalRisks: ['Ограничения краткосрочной аренды в коммуне', 'Расходы кондоминиума и предстоящие спецсборы', 'Несоответствие кадастра фактической планировке', 'Сезонность спроса в курортных зонах'],
    legalChecks: ['Соответствие кадастровой и градостроительной документации (conformità urbanistica/catastale)', 'Отсутствие ипотек и обременений', 'Долги кондоминиума', 'Сертификат энергоэффективности'],
    comparableKeys: ['type', 'area_m2', 'rooms', 'condition', 'geohash6'],
  },
  {
    code: 'commercial',
    name: { ru: 'Коммерческая', it: 'Commerciale', en: 'Commercial' },
    fields: [...COMMON, 'floor', 'frontage_m', 'shop_windows', 'ceiling_height_m', 'tenanted', 'lease_end', 'permitted_use'],
    required: ['area_m2'],
    filters: [...BASE_FILTERS, 'area_m2', 'tenanted'],
    scoringProfile: 'commercial',
    typicalRisks: ['Вакантность после ухода арендатора', 'Зависимость от одного арендатора', 'Разрешённое использование не подходит под нужный бизнес', 'Падение трафика на улице'],
    legalChecks: ['Категория кадастра и разрешённое использование', 'Действующие договоры аренды и их условия', 'Санитарные/пожарные разрешения для общепита и медицины'],
    comparableKeys: ['type', 'area_m2', 'tenanted', 'geohash6'],
  },
  {
    code: 'industrial',
    name: { ru: 'Промышленная и складская', it: 'Industriale e logistica', en: 'Industrial & logistics' },
    fields: [...COMMON, 'ceiling_height_m', 'loading_docks', 'truck_access', 'power_kw', 'fire_certificate', 'yard_m2', 'office_m2', 'tenanted', 'lease_end', 'permitted_use'],
    required: ['area_m2'],
    filters: [...BASE_FILTERS, 'area_m2', 'ceiling_height_m', 'truck_access', 'tenanted'],
    scoringProfile: 'industrial',
    typicalRisks: ['Загрязнение грунта', 'Недостаточная электрическая мощность', 'Устаревшие пожарные системы', 'Удалённость от магистралей'],
    legalChecks: ['Экологические ограничения и история использования', 'Пожарный сертификат (CPI)', 'Разрешённое использование'],
    comparableKeys: ['type', 'area_m2', 'ceiling_height_m', 'geohash5'],
  },
  {
    code: 'parking',
    name: { ru: 'Гаражи и парковки', it: 'Box e posti auto', en: 'Garages & parking' },
    fields: ['area_m2', 'condition', 'spaces', 'covered', 'width_m', 'length_m', 'ev_charger', 'separate_title', 'access_type', 'floor'],
    required: [],
    filters: [...BASE_FILTERS, 'spaces', 'covered', 'separate_title'],
    scoringProfile: 'parking',
    typicalRisks: ['Нет отдельного объекта права — продажа только с квартирой (pertinenza)', 'Низкий локальный спрос', 'Узкий въезд, место не подходит для больших машин', 'Затопление подземных уровней'],
    legalChecks: ['Самостоятельный кадастровый номер', 'Ограничения на продажу/аренду не жителям (vincolo pertinenziale)', 'Правила кондоминиума'],
    comparableKeys: ['type', 'covered', 'geohash6'],
  },
  {
    code: 'land',
    name: { ru: 'Земельные участки', it: 'Terreni', en: 'Land' },
    fields: ['land_area_m2', 'zoning', 'buildable_m3', 'road_access', 'utilities_available', 'easements', 'slope', 'irrigation', 'trees'],
    required: ['land_area_m2'],
    filters: ['price', 'land_area_m2', 'road_access', 'zoning', 'score'],
    scoringProfile: 'land',
    typicalRisks: ['Застройка не разрешена или не подтверждена', 'Гидрогеологические и оползневые ограничения', 'Ландшафтные и природоохранные ограничения', 'Нет подъезда / коммуникаций'],
    legalChecks: ['Справка о градостроительном назначении (CDU)', 'Сервитуты и права проезда', 'Право преимущественной покупки соседей-аграриев (prelazione agraria)', 'Природоохранные и гидрогеологические ограничения'],
    comparableKeys: ['type', 'land_area_m2', 'zoning', 'geohash5'],
  },
  {
    code: 'hospitality',
    name: { ru: 'Туристическая', it: 'Ricettivo', en: 'Hospitality' },
    fields: [...COMMON, 'guest_rooms', 'beds', 'pitches', 'licence', 'seasonality', 'restaurant', 'pool', 'sea_view'],
    required: ['area_m2'],
    filters: [...BASE_FILTERS, 'guest_rooms', 'licence', 'seasonality'],
    scoringProfile: 'hospitality',
    typicalRisks: ['Сезонность и зависимость от туристического потока', 'Высокие расходы на персонал', 'Зависимость от комиссий платформ бронирования', 'Лицензия не переходит к покупателю'],
    legalChecks: ['Действующие лицензии и классификация', 'Передаваемость лицензии', 'Пожарные и санитарные требования', 'Ограничения туристической аренды в регионе'],
    comparableKeys: ['type', 'guest_rooms', 'geohash5'],
  },
  {
    code: 'specialized',
    name: { ru: 'Специализированная', it: 'Speciale', en: 'Specialised' },
    fields: ['area_m2', 'condition', 'units', 'unit_size_m2', 'security', 'access_24h', 'berth_length_m'],
    required: [],
    filters: [...BASE_FILTERS, 'units'],
    scoringProfile: 'specialized',
    typicalRisks: ['Узкий рынок покупателей — низкая ликвидность', 'Концессия/право пользования вместо собственности (причалы)', 'Зависимость от одного вида спроса'],
    legalChecks: ['Тип права: собственность, концессия, аренда', 'Срок концессии', 'Разрешённое использование'],
    comparableKeys: ['type', 'units', 'geohash5'],
  },
];

const t = (code: string, category: string, ru: string, it: string, en: string, financialModels: FinancialModelCode[], extra: Partial<TypeDef> = {}): TypeDef => ({
  code, category, name: { ru, it, en }, financialModels, ...extra,
});

const RES: FinancialModelCode[] = ['residential_long_term', 'residential_short_term'];
const MULTI: FinancialModelCode[] = ['commercial_lease', 'residential_long_term'];
const COM: FinancialModelCode[] = ['commercial_lease', 'area_rental'];
const IND: FinancialModelCode[] = ['area_rental', 'commercial_lease'];
const PARK: FinancialModelCode[] = ['unit_rental'];
const HOSP: FinancialModelCode[] = ['hospitality'];

export const TYPES: TypeDef[] = [
  // 3.1 residential
  t('apartment', 'residential', 'Квартира', 'Appartamento', 'Apartment', RES),
  t('serviced_apartment', 'residential', 'Апартаменты', 'Appartamento residence', 'Serviced apartment', RES),
  t('studio', 'residential', 'Студия', 'Monolocale', 'Studio', RES),
  t('room', 'residential', 'Комната', 'Stanza', 'Room', RES),
  t('house', 'residential', 'Дом', 'Casa indipendente', 'House', RES),
  t('villa', 'residential', 'Вилла', 'Villa', 'Villa', RES),
  t('townhouse', 'residential', 'Таунхаус', 'Villetta a schiera', 'Townhouse', RES),
  t('apartment_building', 'residential', 'Многоквартирное здание', 'Palazzo', 'Apartment building', MULTI, { extraFields: ['units'] }),
  t('income_building', 'residential', 'Доходный дом', 'Stabile a reddito', 'Income building', MULTI, { extraFields: ['units'] }),
  t('residential_complex', 'residential', 'Жилой комплекс', 'Complesso residenziale', 'Residential complex', MULTI, { extraFields: ['units'] }),
  // 3.2 commercial
  t('shop', 'commercial', 'Магазин', 'Negozio', 'Shop', COM),
  t('retail_unit', 'commercial', 'Торговое помещение', 'Locale commerciale', 'Retail unit', COM),
  t('office', 'commercial', 'Офис', 'Ufficio', 'Office', COM),
  t('restaurant', 'commercial', 'Ресторан', 'Ristorante', 'Restaurant', COM),
  t('cafe', 'commercial', 'Кафе', 'Caffetteria', 'Café', COM),
  t('bar', 'commercial', 'Бар', 'Bar', 'Bar', COM),
  t('beauty_salon', 'commercial', 'Салон красоты', 'Centro estetico', 'Beauty salon', COM),
  t('medical_unit', 'commercial', 'Медицинское помещение', 'Studio medico', 'Medical unit', COM),
  t('clinic', 'commercial', 'Клиника', 'Clinica', 'Clinic', COM),
  t('commercial_building', 'commercial', 'Коммерческое здание', 'Edificio commerciale', 'Commercial building', COM),
  t('service_premises', 'commercial', 'Помещение для услуг', 'Locale per servizi', 'Service premises', COM),
  // 3.3 industrial
  t('warehouse', 'industrial', 'Склад', 'Magazzino', 'Warehouse', IND),
  t('hangar', 'industrial', 'Ангар', 'Capannone', 'Hangar', IND),
  t('logistics_center', 'industrial', 'Логистический центр', 'Centro logistico', 'Logistics centre', IND),
  t('production_unit', 'industrial', 'Производственное помещение', 'Laboratorio produttivo', 'Production unit', IND),
  t('cold_storage', 'industrial', 'Холодильный склад', 'Magazzino frigorifero', 'Cold storage', IND),
  t('workshop', 'industrial', 'Мастерская', 'Officina', 'Workshop', IND),
  t('industrial_building', 'industrial', 'Производственное здание', 'Edificio industriale', 'Industrial building', IND),
  t('distribution_center', 'industrial', 'Распределительный центр', 'Centro di distribuzione', 'Distribution centre', IND),
  // 3.4 parking
  t('garage', 'parking', 'Индивидуальный гараж', 'Box auto', 'Garage', PARK),
  t('parking_space', 'parking', 'Парковочное место', 'Posto auto', 'Parking space', PARK),
  t('underground_parking', 'parking', 'Подземный паркинг', 'Parcheggio interrato', 'Underground car park', PARK, { required: ['spaces'] }),
  t('surface_parking', 'parking', 'Наземная парковка', 'Parcheggio scoperto', 'Surface car park', PARK, { required: ['spaces'] }),
  t('parking_complex', 'parking', 'Парковочный комплекс', 'Autosilo', 'Parking complex', PARK, { required: ['spaces'] }),
  t('car_park', 'parking', 'Автостоянка', 'Autorimessa', 'Car park', PARK, { required: ['spaces'] }),
  t('motorcycle_space', 'parking', 'Место для мотоцикла', 'Posto moto', 'Motorcycle space', PARK),
  t('garage_complex', 'parking', 'Гаражный комплекс', 'Complesso di box', 'Garage complex', PARK, { required: ['spaces'] }),
  t('car_service', 'parking', 'Автосервис', 'Autofficina', 'Car service', ['commercial_lease', 'area_rental']),
  // 3.5 land
  t('land_residential', 'land', 'Земля под жилую застройку', 'Terreno edificabile residenziale', 'Residential development land', ['land']),
  t('land_commercial', 'land', 'Земля под коммерческую застройку', 'Terreno edificabile commerciale', 'Commercial development land', ['land']),
  t('land_industrial', 'land', 'Промышленная земля', 'Terreno industriale', 'Industrial land', ['land']),
  t('land_agricultural', 'land', 'Сельскохозяйственный участок', 'Terreno agricolo', 'Agricultural land', ['land']),
  t('vineyard', 'land', 'Виноградник', 'Vigneto', 'Vineyard', ['land']),
  t('olive_grove', 'land', 'Оливковая роща', 'Uliveto', 'Olive grove', ['land']),
  t('orchard', 'land', 'Сад', 'Frutteto', 'Orchard', ['land']),
  t('land_camping', 'land', 'Земля под кемпинг', 'Terreno per campeggio', 'Land for camping', ['land']),
  t('land_tourism', 'land', 'Земля под туристический проект', 'Terreno turistico', 'Land for tourism project', ['land']),
  t('land_parking', 'land', 'Земля под парковку', 'Terreno per parcheggio', 'Land for parking', ['land', 'unit_rental']),
  t('land_solar', 'land', 'Земля под солнечную станцию', 'Terreno per fotovoltaico', 'Land for solar', ['land']),
  // 3.6 hospitality
  t('hotel', 'hospitality', 'Отель', 'Hotel', 'Hotel', HOSP),
  t('aparthotel', 'hospitality', 'Апарт-отель', 'Residence turistico', 'Aparthotel', HOSP),
  t('bnb', 'hospitality', 'B&B', 'Bed & Breakfast', 'B&B', HOSP),
  t('guest_house', 'hospitality', 'Гостевой дом', 'Affittacamere', 'Guest house', HOSP),
  t('tourist_complex', 'hospitality', 'Туристический комплекс', 'Complesso turistico', 'Tourist complex', HOSP),
  t('campsite', 'hospitality', 'Кемпинг', 'Campeggio', 'Campsite', HOSP),
  t('glamping', 'hospitality', 'Глэмпинг', 'Glamping', 'Glamping', HOSP),
  t('hostel', 'hospitality', 'Хостел', 'Ostello', 'Hostel', HOSP),
  t('resort', 'hospitality', 'Курортный объект', 'Resort', 'Resort', HOSP),
  t('holiday_home', 'hospitality', 'Дом отдыха', 'Casa vacanze', 'Holiday home', ['residential_short_term', 'hospitality']),
  // 3.7 specialized
  t('self_storage', 'specialized', 'Self-storage', 'Self storage', 'Self-storage', ['unit_rental']),
  t('storage_box', 'specialized', 'Складской бокс', 'Box deposito', 'Storage box', ['unit_rental']),
  t('container_yard', 'specialized', 'Контейнерная площадка', 'Area container', 'Container yard', ['unit_rental', 'area_rental']),
  t('boat_storage', 'specialized', 'Хранение лодок', 'Rimessaggio barche', 'Boat storage', ['unit_rental']),
  t('marina_berth', 'specialized', 'Причал', 'Ormeggio', 'Mooring', ['unit_rental']),
  t('yacht_berth', 'specialized', 'Яхтенное место', 'Posto barca', 'Yacht berth', ['unit_rental']),
  t('rv_site', 'specialized', 'Площадка для автодомов', 'Area sosta camper', 'RV site', ['unit_rental']),
  t('storeroom', 'specialized', 'Кладовая', 'Cantina / ripostiglio', 'Storeroom', ['unit_rental']),
  t('basement', 'specialized', 'Подвальное помещение', 'Seminterrato', 'Basement', ['unit_rental', 'area_rental']),
  t('other_specialized', 'specialized', 'Другой специализированный актив', 'Altro immobile speciale', 'Other specialised asset', ['unit_rental', 'area_rental', 'commercial_lease']),
];
