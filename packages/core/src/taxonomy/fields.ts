/** Field library shared by property types. Types pick fields by key; new fields can also be defined in the DB. */

export type FieldType = 'number' | 'integer' | 'boolean' | 'enum' | 'text' | 'date';

export interface FieldDef {
  key: string;
  type: FieldType;
  unit?: string;
  min?: number;
  options?: readonly string[];
  label: { ru: string; en: string };
}

const f = (key: string, type: FieldType, ru: string, en: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  key, type, label: { ru, en }, ...(type === 'number' || type === 'integer' ? { min: 0 } : {}), ...extra,
});

export const FIELD_LIBRARY: Record<string, FieldDef> = Object.fromEntries(
  [
    // common
    f('area_m2', 'number', 'Площадь', 'Area', { unit: 'm2' }),
    f('condition', 'enum', 'Состояние', 'Condition', { options: ['new', 'renovated', 'good', 'to_renovate', 'ruin'] }),
    f('year_built', 'integer', 'Год постройки', 'Year built'),
    f('energy_class', 'text', 'Энергокласс', 'Energy class'),
    f('floor', 'integer', 'Этаж', 'Floor', { min: -5 }),
    f('floors_total', 'integer', 'Этажей в здании', 'Floors in building'),
    // residential
    f('rooms', 'integer', 'Комнат', 'Rooms'),
    f('bedrooms', 'integer', 'Спален', 'Bedrooms'),
    f('bathrooms', 'integer', 'Санузлов', 'Bathrooms'),
    f('units', 'integer', 'Квартир / единиц', 'Units'),
    f('elevator', 'boolean', 'Лифт', 'Elevator'),
    f('balcony_terrace', 'boolean', 'Балкон / терраса', 'Balcony / terrace'),
    f('garden', 'boolean', 'Сад', 'Garden'),
    f('parking_included', 'boolean', 'Парковка в комплекте', 'Parking included'),
    f('sea_view', 'boolean', 'Вид на море', 'Sea view'),
    f('furnished', 'boolean', 'С мебелью', 'Furnished'),
    // commercial
    f('frontage_m', 'number', 'Фасад / витрина', 'Frontage', { unit: 'm' }),
    f('shop_windows', 'integer', 'Витрин', 'Shop windows'),
    f('ceiling_height_m', 'number', 'Высота потолков', 'Ceiling height', { unit: 'm' }),
    f('tenanted', 'boolean', 'Сдано арендатору', 'Tenanted'),
    f('lease_end', 'date', 'Окончание аренды', 'Lease end'),
    f('permitted_use', 'text', 'Разрешённое использование', 'Permitted use'),
    // industrial
    f('loading_docks', 'integer', 'Погрузочных доков', 'Loading docks'),
    f('truck_access', 'boolean', 'Подъезд для фур', 'Truck access'),
    f('power_kw', 'number', 'Электрическая мощность', 'Power', { unit: 'kW' }),
    f('fire_certificate', 'boolean', 'Пожарный сертификат', 'Fire certificate'),
    f('yard_m2', 'number', 'Площадка / двор', 'Yard', { unit: 'm2' }),
    f('office_m2', 'number', 'Офисная часть', 'Office part', { unit: 'm2' }),
    // parking
    f('spaces', 'integer', 'Машиномест', 'Spaces'),
    f('covered', 'boolean', 'Крытое', 'Covered'),
    f('width_m', 'number', 'Ширина', 'Width', { unit: 'm' }),
    f('length_m', 'number', 'Длина', 'Length', { unit: 'm' }),
    f('ev_charger', 'boolean', 'Зарядка для электромобиля', 'EV charger'),
    f('separate_title', 'boolean', 'Отдельный объект права (кадастр)', 'Separate legal title'),
    f('access_type', 'enum', 'Доступ', 'Access', { options: ['street', 'ramp', 'lift', 'courtyard'] }),
    // land
    f('land_area_m2', 'number', 'Площадь участка', 'Plot area', { unit: 'm2' }),
    f('zoning', 'text', 'Зонирование', 'Zoning'),
    f('buildable_m3', 'number', 'Допустимый объём застройки', 'Buildable volume', { unit: 'm3' }),
    f('road_access', 'boolean', 'Подъезд с дороги', 'Road access'),
    f('utilities_available', 'boolean', 'Коммуникации', 'Utilities available'),
    f('easements', 'text', 'Сервитуты', 'Easements'),
    f('slope', 'enum', 'Рельеф', 'Slope', { options: ['flat', 'gentle', 'steep', 'terraced'] }),
    f('irrigation', 'boolean', 'Орошение', 'Irrigation'),
    f('trees', 'integer', 'Деревьев', 'Trees'),
    // hospitality
    f('guest_rooms', 'integer', 'Номеров', 'Guest rooms'),
    f('beds', 'integer', 'Кроватей', 'Beds'),
    f('pitches', 'integer', 'Мест (кемпинг)', 'Pitches'),
    f('licence', 'boolean', 'Действующая лицензия', 'Operating licence'),
    f('seasonality', 'enum', 'Сезонность', 'Seasonality', { options: ['year_round', 'seasonal'] }),
    f('restaurant', 'boolean', 'Ресторан', 'Restaurant'),
    f('pool', 'boolean', 'Бассейн', 'Pool'),
    // specialized
    f('unit_size_m2', 'number', 'Размер единицы', 'Unit size', { unit: 'm2' }),
    f('security', 'boolean', 'Охрана / видеонаблюдение', 'Security'),
    f('access_24h', 'boolean', 'Доступ 24/7', '24/7 access'),
    f('berth_length_m', 'number', 'Длина места', 'Berth length', { unit: 'm' }),
  ].map((d) => [d.key, d]),
);
