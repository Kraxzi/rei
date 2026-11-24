import { matchesGeoFilter, type GeoFilter } from '../geo/index.js';

/** Does a property satisfy a search profile? Returns the failing criteria for transparency. */

export interface MatchSubject {
  countryCode: string;
  /** Region ids the property belongs to (province and its region). */
  regionIds: string[];
  cityId: string | null;
  typeCode: string;
  dealType: string | null;
  price: number | null;
  areaM2: number | null;
  lat: number | null;
  lng: number | null;
  condition: string | null;
  netYield: number | null;
}

export interface MatchProfile {
  countries: string[];
  regions: string[];
  cities: string[];
  typeCodes: string[];
  priceMin: number | null;
  priceMax: number | null;
  areaMin: number | null;
  areaMax: number | null;
  targetNetYield: number | null;
  condition: string[];
  geo: GeoFilter;
  isActive: boolean;
}

export function matchProfile(s: MatchSubject, p: MatchProfile): { match: boolean; failed: string[] } {
  const failed: string[] = [];
  if (!p.isActive) failed.push('поиск выключен');
  if (s.dealType === 'rent') failed.push('это аренда, а не продажа');
  if (p.countries.length && !p.countries.includes(s.countryCode)) failed.push('страна');
  if (p.regions.length) {
    // the most specific selected areas decide: provinces of a region narrow that region down
    if (!s.regionIds.some((r) => p.regions.includes(r))) failed.push('регион');
    const selectedProvinces = p.regions.filter((r) => r.includes('-p-'));
    if (selectedProvinces.length && s.regionIds.some((r) => r.includes('-p-')) && !s.regionIds.some((r) => selectedProvinces.includes(r))) failed.push('провинция');
  }
  if (p.cities.length && (!s.cityId || !p.cities.includes(s.cityId))) failed.push('город');
  if (p.typeCodes.length && !p.typeCodes.includes(s.typeCode)) failed.push('тип объекта');
  if (p.priceMin !== null && (s.price === null || s.price < p.priceMin)) failed.push('цена ниже минимума');
  if (p.priceMax !== null && (s.price === null || s.price > p.priceMax)) failed.push('цена выше бюджета');
  if (p.areaMin !== null && s.areaM2 !== null && s.areaM2 < p.areaMin) failed.push('площадь меньше');
  if (p.areaMax !== null && s.areaM2 !== null && s.areaM2 > p.areaMax) failed.push('площадь больше');
  if (p.condition.length && s.condition && !p.condition.includes(s.condition)) failed.push('состояние');
  // yield is an estimate: it filters only when known
  if (p.targetNetYield !== null && s.netYield !== null && s.netYield < p.targetNetYield) failed.push('доходность ниже цели');
  const hasGeo = (p.geo.circles?.length ?? 0) + (p.geo.polygons?.length ?? 0) + (p.geo.exclude?.length ?? 0) > 0;
  if (hasGeo && (s.lat === null || s.lng === null || !matchesGeoFilter({ lat: s.lat, lng: s.lng }, p.geo))) failed.push('зона на карте');
  return { match: failed.length === 0, failed };
}
