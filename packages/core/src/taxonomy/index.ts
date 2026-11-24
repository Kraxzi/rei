import { isFinancialModelCode } from '../financial/models.js';
import { CATEGORIES, TYPES, type CategoryDef, type TypeDef } from './data.js';
import { FIELD_LIBRARY, type FieldDef } from './fields.js';

export * from './data.js';
export * from './fields.js';

export interface ResolvedType {
  type: TypeDef;
  category: CategoryDef;
  fields: FieldDef[];
  required: string[];
}

/** Category fields + type extras, de-duplicated, resolved against a field library. */
export function resolveType(
  type: TypeDef,
  categories: readonly CategoryDef[] = CATEGORIES,
  library: Record<string, FieldDef> = FIELD_LIBRARY,
): ResolvedType {
  const category = categories.find((c) => c.code === type.category);
  if (!category) throw new Error(`unknown category ${type.category} for type ${type.code}`);
  const keys = [...new Set([...category.fields, ...(type.extraFields ?? [])])];
  const fields = keys.map((k) => {
    const d = library[k];
    if (!d) throw new Error(`unknown field ${k} in type ${type.code}`);
    return d;
  });
  return { type, category, fields, required: [...new Set([...category.required, ...(type.required ?? [])])] };
}

export interface ValidationError {
  field: string;
  message: string;
}

/** Validate a features object against a resolved type. Unknown keys are rejected to keep data clean. */
export function validateFeatures(rt: ResolvedType, features: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];
  const byKey = new Map(rt.fields.map((f) => [f.key, f]));
  for (const k of rt.required) {
    if (features[k] === undefined || features[k] === null || features[k] === '') errors.push({ field: k, message: 'required' });
  }
  for (const [k, v] of Object.entries(features)) {
    if (v === undefined || v === null) continue;
    const def = byKey.get(k);
    if (!def) { errors.push({ field: k, message: 'unknown field for this property type' }); continue; }
    switch (def.type) {
      case 'number':
      case 'integer':
        if (typeof v !== 'number' || !Number.isFinite(v)) errors.push({ field: k, message: 'must be a number' });
        else if (def.type === 'integer' && !Number.isInteger(v)) errors.push({ field: k, message: 'must be an integer' });
        else if (def.min !== undefined && v < def.min) errors.push({ field: k, message: `must be >= ${def.min}` });
        break;
      case 'boolean':
        if (typeof v !== 'boolean') errors.push({ field: k, message: 'must be true/false' });
        break;
      case 'enum':
        if (typeof v !== 'string' || !def.options?.includes(v)) errors.push({ field: k, message: `must be one of ${def.options?.join(', ')}` });
        break;
      case 'date':
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) errors.push({ field: k, message: 'must be YYYY-MM-DD' });
        break;
      case 'text':
        if (typeof v !== 'string') errors.push({ field: k, message: 'must be text' });
        break;
    }
  }
  return errors;
}

/** Consistency check of a taxonomy (used for seed data and for admin-created types). */
export function checkTaxonomy(
  categories: readonly CategoryDef[] = CATEGORIES,
  types: readonly TypeDef[] = TYPES,
  library: Record<string, FieldDef> = FIELD_LIBRARY,
): string[] {
  const problems: string[] = [];
  const codes = new Set<string>();
  for (const c of categories) {
    if (codes.has(`c:${c.code}`)) problems.push(`duplicate category ${c.code}`);
    codes.add(`c:${c.code}`);
    for (const k of [...c.fields, ...c.required]) if (!library[k]) problems.push(`category ${c.code}: unknown field ${k}`);
    for (const k of c.required) if (!c.fields.includes(k)) problems.push(`category ${c.code}: required ${k} not in fields`);
  }
  for (const t of types) {
    if (codes.has(`t:${t.code}`)) problems.push(`duplicate type ${t.code}`);
    codes.add(`t:${t.code}`);
    if (!categories.some((c) => c.code === t.category)) problems.push(`type ${t.code}: unknown category ${t.category}`);
    if (t.financialModels.length === 0) problems.push(`type ${t.code}: no financial model`);
    for (const m of t.financialModels) if (!isFinancialModelCode(m)) problems.push(`type ${t.code}: unknown financial model ${m}`);
    for (const k of [...(t.extraFields ?? []), ...(t.required ?? [])]) if (!library[k]) problems.push(`type ${t.code}: unknown field ${k}`);
  }
  return problems;
}
