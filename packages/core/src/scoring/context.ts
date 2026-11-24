/** Location and market-growth inputs for the Investment Score. */

// ---------- location (OpenStreetMap points of interest around the property) ----------

export interface PoiCounts {
  station: number; // rail / metro within 1.5 km
  bus: number; // bus stops within 500 m
  grocery: number; // supermarkets / grocery within 800 m
  pharmacy: number;
  health: number; // hospital / clinic / doctors within 1.5 km
  school: number;
  food: number; // restaurants, cafés, bars within 800 m
  beach: number; // within 2 km
}

export const EMPTY_POI: PoiCounts = { station: 0, bus: 0, grocery: 0, pharmacy: 0, health: 0, school: 0, food: 0, beach: 0 };

export function poiOverpassQuery(lat: number, lng: number): string {
  const at = (r: number) => `(around:${r},${lat},${lng})`;
  return `[out:json][timeout:25];
(
  nwr${at(1500)}["railway"~"^(station|halt)$"];
  nwr${at(500)}["highway"="bus_stop"];
  nwr${at(800)}["shop"~"^(supermarket|convenience|grocery|greengrocer|bakery)$"];
  nwr${at(800)}["amenity"="pharmacy"];
  nwr${at(1500)}["amenity"~"^(hospital|clinic|doctors)$"];
  nwr${at(1500)}["amenity"~"^(school|kindergarten)$"];
  nwr${at(800)}["amenity"~"^(restaurant|cafe|bar|pub)$"];
  nwr${at(2000)}["natural"="beach"];
);
out tags center qt 400;`;
}

export function countPois(elements: Array<{ tags?: Record<string, string> }>): PoiCounts {
  const c = { ...EMPTY_POI };
  for (const e of elements) {
    const t = e.tags ?? {};
    if (t.railway === 'station' || t.railway === 'halt') c.station++;
    else if (t.highway === 'bus_stop') c.bus++;
    else if (t.shop) c.grocery++;
    else if (t.amenity === 'pharmacy') c.pharmacy++;
    else if (['hospital', 'clinic', 'doctors'].includes(t.amenity ?? '')) c.health++;
    else if (['school', 'kindergarten'].includes(t.amenity ?? '')) c.school++;
    else if (['restaurant', 'cafe', 'bar', 'pub'].includes(t.amenity ?? '')) c.food++;
    else if (t.natural === 'beach') c.beach++;
  }
  return c;
}

const cap = (n: number, k: number) => Math.min(1, n / k);

/** 0–100 location score; weights depend on how the category earns money (tourists value the beach, etc.). */
export function locationScore(p: PoiCounts, category: string): { value: number; details: string } {
  const tourist = category === 'hospitality';
  const w = tourist
    ? { station: 15, bus: 5, grocery: 10, pharmacy: 5, health: 5, school: 0, food: 30, beach: 30 }
    : category === 'commercial'
      ? { station: 20, bus: 15, grocery: 15, pharmacy: 5, health: 5, school: 5, food: 35, beach: 0 }
      : category === 'industrial' || category === 'land'
        ? { station: 40, bus: 20, grocery: 10, pharmacy: 0, health: 0, school: 0, food: 10, beach: 20 }
        : { station: 20, bus: 10, grocery: 20, pharmacy: 10, health: 10, school: 10, food: 10, beach: 10 };
  const v =
    w.station * cap(p.station, 1) + w.bus * cap(p.bus, 3) + w.grocery * cap(p.grocery, 2) + w.pharmacy * cap(p.pharmacy, 1) +
    w.health * cap(p.health, 1) + w.school * cap(p.school, 2) + w.food * cap(p.food, 6) + w.beach * cap(p.beach, 1);
  const parts = [
    p.station ? 'станция до 1,5 км' : 'нет станции рядом',
    `${p.grocery} магазинов`, `${p.food} кафе/ресторанов`,
    p.pharmacy ? 'аптека рядом' : null, p.beach ? 'пляж до 2 км' : null,
  ].filter(Boolean);
  return { value: Math.round(v), details: parts.join(', ') };
}

// ---------- market growth (official house price index) ----------

/** JSON-stat 2.0 (Eurostat dissemination API) with a single series -> [{period, value}] sorted by period. */
export function parseJsonStatSeries(js: { value?: Record<string, number> | number[]; dimension?: Record<string, { category?: { index?: Record<string, number> } }>; id?: string[] }): Array<{ period: string; value: number }> {
  const time = js.dimension?.time?.category?.index ?? js.dimension?.TIME_PERIOD?.category?.index ?? {};
  const values = js.value ?? {};
  const out: Array<{ period: string; value: number }> = [];
  for (const [period, idx] of Object.entries(time)) {
    const v = Array.isArray(values) ? values[idx] : values[String(idx)];
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ period, value: v });
  }
  return out.sort((a, b) => a.period.localeCompare(b.period));
}

/** Average annual price change over the last `years` observations (percent values -> fraction). */
export function growthFromHpi(rates: Array<{ period: string; value: number }>, years = 3): { value: number; basis: string } | null {
  const last = rates.slice(-years);
  if (!last.length) return null;
  const avg = last.reduce((s, r) => s + r.value, 0) / last.length / 100;
  return { value: avg, basis: `${last[0]!.period}–${last[last.length - 1]!.period}` };
}
