import { describe, expect, it } from 'vitest';
import { CATEGORIES, TYPES, checkTaxonomy, resolveType, validateFeatures, type TypeDef } from '../src/index.js';

describe('taxonomy', () => {
  it('seed data is consistent', () => {
    expect(checkTaxonomy()).toEqual([]);
  });

  it('covers every category of spec part III', () => {
    expect(CATEGORIES.map((c) => c.code)).toEqual(['residential', 'commercial', 'industrial', 'parking', 'land', 'hospitality', 'specialized']);
    const perCategory = Object.fromEntries(CATEGORIES.map((c) => [c.code, TYPES.filter((t) => t.category === c.code).length]));
    expect(perCategory).toEqual({ residential: 10, commercial: 11, industrial: 8, parking: 9, land: 11, hospitality: 10, specialized: 10 });
  });

  it('every type resolves and has names in ru/it/en', () => {
    for (const t of TYPES) {
      const r = resolveType(t);
      expect(r.fields.length).toBeGreaterThan(0);
      expect(t.name.ru && t.name.it && t.name.en).toBeTruthy();
    }
  });

  it('new type without code changes (admin path)', () => {
    const custom: TypeDef = { code: 'wine_cellar', category: 'specialized', name: { ru: 'Винный погреб', it: 'Cantina vinicola', en: 'Wine cellar' }, financialModels: ['area_rental'] };
    expect(checkTaxonomy(CATEGORIES, [...TYPES, custom])).toEqual([]);
    expect(checkTaxonomy(CATEGORIES, [...TYPES, { ...custom, financialModels: ['magic' as never] }])).toContain('type wine_cellar: unknown financial model magic');
    expect(checkTaxonomy(CATEGORIES, [...TYPES, TYPES[0]!])).toContain('duplicate type apartment');
  });

  it('validates features', () => {
    const apt = resolveType(TYPES.find((t) => t.code === 'apartment')!);
    expect(validateFeatures(apt, { area_m2: 75, rooms: 3, sea_view: true, condition: 'good' })).toEqual([]);
    expect(validateFeatures(apt, { rooms: 3 })).toEqual([{ field: 'area_m2', message: 'required' }]);
    const errs = validateFeatures(apt, { area_m2: -1, rooms: 2.5, sea_view: 'yes', condition: 'shiny', pitches: 3 });
    expect(errs.map((e) => e.field).sort()).toEqual(['area_m2', 'condition', 'pitches', 'rooms', 'sea_view']);
  });

  it('type-level required fields', () => {
    const car = resolveType(TYPES.find((t) => t.code === 'car_park')!);
    expect(validateFeatures(car, {})).toEqual([{ field: 'spaces', message: 'required' }]);
    const land = resolveType(TYPES.find((t) => t.code === 'olive_grove')!);
    expect(validateFeatures(land, { land_area_m2: 12000, trees: 300, lease_end: '2030-01-01' })[0]?.field).toBe('lease_end');
  });
});
