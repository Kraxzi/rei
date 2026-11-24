import { describe, expect, it } from 'vitest';
import {
  areaFromText, classifyDeal, classifyType, contentHash, duplicateProbability, externalIdFromUrl, extractListing,
  isIndexUrl, isListingUrl, listingEvents, mergeAi, parseEuroAmount, roomsFromText, sameOriginLinks, sitemapLocs,
  type DedupItem, type Snapshot,
} from '../src/index.js';

describe('parsing helpers', () => {
  it('Italian price formats', () => {
    expect(parseEuroAmount('€ 250.000')).toBe(25_000_000);
    expect(parseEuroAmount('250.000,50 €')).toBe(25_000_050);
    expect(parseEuroAmount('1.200 €/mese')).toBe(120_000);
    expect(parseEuroAmount(28000)).toBe(2_800_000);
    expect(parseEuroAmount('Trattativa riservata')).toBeNull();
  });

  it('type, deal, rooms, area from Italian text', () => {
    expect(classifyType('Box auto in vendita a Sanremo')).toBe('garage');
    expect(classifyType('Posto auto coperto')).toBe('parking_space');
    expect(classifyType('Trilocale con vista mare')).toBe('apartment');
    expect(classifyType('Villa con piscina')).toBe('villa');
    expect(classifyType('Terreno agricolo con uliveto')).toBe('olive_grove');
    expect(classifyType('Locale commerciale fronte strada')).toBe('retail_unit');
    expect(classifyType('Bellissima proprietà')).toBeNull();
    expect(classifyDeal('Appartamento in affitto')).toBe('rent');
    expect(classifyDeal('Vendesi bilocale')).toBe('sale');
    expect(roomsFromText('Trilocale ristrutturato')).toBe(3);
    expect(roomsFromText('Appartamento 4 locali')).toBe(4);
    expect(areaFromText('superficie 1.250 mq')).toBe(1250);
    expect(areaFromText('75 m² commerciali')).toBe(75);
  });

  it('stable external id', () => {
    expect(externalIdFromUrl('https://a.it/immobili/vendita-trilocale-sanremo-1234/')).toBe('/immobili/vendita-trilocale-sanremo-1234');
    expect(externalIdFromUrl('https://a.it/scheda.php?id=987&lang=it')).toBe('987');
  });
});

describe('extractListing', () => {
  const jsonld = `<html><head><title>Agenzia</title>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"RealEstateListing","name":"Trilocale vista mare",
   "description":"Trilocale di 80 mq a Sanremo","image":["https://a.it/img/1.jpg","https://a.it/img/2.jpg"],
   "offers":{"@type":"Offer","price":"250000","priceCurrency":"EUR","businessFunction":"http://purl.org/goodrelations/v1#Sell"},
   "about":{"@type":"Apartment","floorSize":{"@type":"QuantitativeValue","value":80,"unitCode":"MTK"},"numberOfRooms":3,
     "address":{"@type":"PostalAddress","addressLocality":"Sanremo","postalCode":"18038","streetAddress":"Via Roma 1"},
     "geo":{"@type":"GeoCoordinates","latitude":43.815,"longitude":7.776}}}</script></head><body></body></html>`;

  it('takes everything from JSON-LD when present', () => {
    const { listing, needsAi } = extractListing(jsonld, 'https://a.it/immobili/trilocale-123');
    expect(needsAi).toBe(false);
    expect(listing).toMatchObject({
      price: 25_000_000, currency: 'EUR', dealType: 'sale', typeCode: 'apartment', areaM2: 80, rooms: 3,
      city: 'Sanremo', postalCode: '18038', address: 'Via Roma 1', lat: 43.815, lng: 7.776, method: 'jsonld', confidence: 1,
    });
    expect(listing.images).toEqual(['https://a.it/img/1.jpg', 'https://a.it/img/2.jpg']);
  });

  it('falls back to meta tags and text, asks for AI when key fields are missing', () => {
    const html = `<title>Box auto in vendita - Imperia</title><meta property="og:image" content="/foto/box.jpg"><p>Box di 18 mq</p>`;
    const { listing, needsAi } = extractListing(html, 'https://b.it/annunci/box-imperia-55');
    expect(listing.typeCode).toBe('garage');
    expect(listing.dealType).toBe('sale');
    expect(listing.images).toEqual(['https://b.it/foto/box.jpg']);
    expect(listing.price).toBeNull();
    expect(needsAi).toBe(true);
  });

  it('AI only fills gaps; structured values win', () => {
    const { listing } = extractListing(jsonld, 'https://a.it/immobili/trilocale-123');
    const merged = mergeAi({ ...listing, city: null }, {
      isListing: true, dealType: 'rent', propertyKind: 'villa', priceEuro: 1, areaM2: 999, rooms: 9, bathrooms: 2, floor: 3,
      city: 'Imperia', address: null, condition: 'good', features: { sea_view: true, elevator: null },
    });
    expect(merged).toMatchObject({ price: 25_000_000, dealType: 'sale', typeCode: 'apartment', areaM2: 80, city: 'Imperia', bathrooms: 2, floor: 3, method: 'mixed' });
    expect(merged.features).toEqual({ sea_view: true, condition: 'good' });
  });

  it('content hash changes with price, not with image order', () => {
    const base = { price: 100, title: 'x', areaM2: 1, rooms: 1, images: ['a', 'b'], dealType: 'sale' as const };
    expect(contentHash(base)).toBe(contentHash({ ...base, images: ['b', 'a'] }));
    expect(contentHash(base)).not.toBe(contentHash({ ...base, price: 99 }));
  });
});

describe('crawl', () => {
  it('sitemap index and url sets', () => {
    const xml = `<sitemapindex><sitemap><loc>https://a.it/sm-immobili.xml</loc></sitemap></sitemapindex>
      <urlset><url><loc>https://a.it/immobili/villa-sanremo-1234</loc></url><url><loc>https://a.it/chi-siamo</loc></url></urlset>`;
    expect(sitemapLocs(xml)).toEqual({ sitemaps: ['https://a.it/sm-immobili.xml'], pages: ['https://a.it/immobili/villa-sanremo-1234', 'https://a.it/chi-siamo'] });
  });

  it('detail vs index vs other pages', () => {
    const o = 'https://a.it';
    expect(isListingUrl('https://a.it/immobili/villa-sanremo-1234', o)).toBe(true);
    expect(isListingUrl('https://a.it/scheda.php?id=55&tipo=vendita', o)).toBe(true);
    expect(isListingUrl('https://a.it/vendita/bilocale-con-terrazzo-vista-mare', o)).toBe(true);
    expect(isListingUrl('https://a.it/immobili/', o)).toBe(false);
    expect(isListingUrl('https://a.it/immobili?page=2', o)).toBe(false);
    expect(isListingUrl('https://a.it/chi-siamo', o)).toBe(false);
    expect(isListingUrl('https://a.it/immobili/foto-1234.jpg', o)).toBe(false);
    expect(isListingUrl('https://other.it/immobili/villa-1234', o)).toBe(false);
    expect(isIndexUrl('https://a.it/vendita/', o)).toBe(true);
    expect(isIndexUrl('https://a.it/immobili?tipo=box', o)).toBe(true);
  });

  it('same-origin links', () => {
    const html = '<a href="/immobili/1#top">x</a><a href="https://a.it/immobili/2">y</a><a href="https://fb.com/x">z</a><a href="mailto:a@a.it">m</a>';
    expect(sameOriginLinks(html, 'https://a.it/')).toEqual(['https://a.it/immobili/1', 'https://a.it/immobili/2']);
  });
});

describe('monitoring events', () => {
  const s: Snapshot = { price: 100_000_00, currency: 'EUR', dealType: 'sale', title: 'Bilocale', areaM2: 50, rooms: 2, images: ['a.jpg'], status: 'active' };
  it('new, price drop with %, photos, reappeared', () => {
    expect(listingEvents(null, s).map((e) => e.type)).toEqual(['new']);
    const drop = listingEvents(s, { ...s, price: 90_000_00 });
    expect(drop).toEqual([{ type: 'price_down', old: 100_000_00, new: 90_000_00, change: -0.1 }]);
    expect(listingEvents(s, { ...s, price: 110_000_00 })[0]!.type).toBe('price_up');
    expect(listingEvents(s, { ...s, images: ['a.jpg', 'b.jpg'] })[0]!.type).toBe('photos_changed');
    expect(listingEvents({ ...s, status: 'removed' }, s).map((e) => e.type)).toEqual(['reappeared']);
    expect(listingEvents(s, { ...s })).toEqual([]);
  });
});

describe('duplicates', () => {
  const a: DedupItem = { typeCode: 'apartment', dealType: 'sale', price: 250_000_00, areaM2: 80, rooms: 3, lat: 43.815, lng: 7.776, city: 'Sanremo', text: 'Trilocale luminoso con terrazzo vista mare zona centrale vicino stazione', images: ['https://a.it/u/IMG_1234.jpg', 'https://a.it/u/IMG_1235.jpg'] };

  it('same flat on two agencies → high probability', () => {
    const b = { ...a, price: 249_000_00, areaM2: 81, lat: 43.8152, lng: 7.7762, text: 'Trilocale luminoso con terrazzo e vista mare in zona centrale', images: ['https://b.it/media/IMG_1234.jpg', 'https://b.it/media/IMG_1235.jpg'] };
    expect(duplicateProbability(a, b).probability).toBeGreaterThanOrEqual(0.85);
  });

  it('similar but different flats → review range or below', () => {
    const c = { ...a, areaM2: 95, rooms: 4, price: 320_000_00, text: 'Quadrilocale', images: [], lat: 43.817, lng: 7.779 };
    expect(duplicateProbability(a, c).probability).toBeLessThan(0.55);
  });

  it('hard stops: other deal type, other category, far away, other city', () => {
    expect(duplicateProbability(a, { ...a, dealType: 'rent' }).probability).toBe(0);
    expect(duplicateProbability(a, { ...a, typeCode: 'garage' }).probability).toBe(0);
    expect(duplicateProbability(a, { ...a, lat: 44.4, lng: 8.9 }).probability).toBe(0);
    expect(duplicateProbability({ ...a, lat: null, lng: null }, { ...a, lat: null, lng: null, city: 'Imperia' }).probability).toBe(0);
  });
});
