import { useEffect, useState, type ReactNode } from 'react';
import { api, type Country, type Region, type Taxonomy } from './api';

// ---------- routing (hash based: works offline and needs no server config) ----------

export function useRoute(): string {
  const [route, setRoute] = useState(() => location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setRoute(location.hash.slice(1) || '/');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}
export const go = (path: string) => { location.hash = path; };

// ---------- cached reference data ----------

const cache = new Map<string, Promise<unknown>>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) cache.set(key, load().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key) as Promise<T>;
}

export function useLoad<T>(key: string | null, load: () => Promise<T>): { data: T | null; error: string | null } {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    if (!key) return;
    let alive = true;
    cached(key, load).then(
      (data) => alive && setState({ data, error: null }),
      (e: Error) => alive && setState({ data: null, error: e.message }),
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

export const useTaxonomy = () => useLoad<Taxonomy>('taxonomy', () => api('/ref/taxonomy'));
export const useCountries = () => useLoad<Country[]>('countries', () => api('/ref/countries'));
export const useRegions = (country: string | null, parent?: string) =>
  useLoad<Region[]>(country ? `regions:${country}:${parent ?? ''}` : null, () =>
    api(`/ref/countries/${country}/regions${parent ? `?parent=${encodeURIComponent(parent)}` : ''}`),
  );

// ---------- small components ----------

export function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  hint?: string;
  bad?: boolean;
  inputMode?: 'decimal' | 'numeric' | 'text';
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <div className={props.suffix ? 'suffixed' : undefined}>
        <input
          className={`input num${props.bad ? ' bad' : ''}`}
          value={props.value}
          inputMode={props.inputMode ?? 'decimal'}
          placeholder={props.placeholder}
          type={props.type ?? 'text'}
          aria-invalid={props.bad || undefined}
          onChange={(e) => props.onChange(e.target.value)}
        />
        {props.suffix && <em>{props.suffix}</em>}
      </div>
      {props.hint && <small>{props.hint}</small>}
    </label>
  );
}

export function Chips<T extends string>(props: { options: Array<{ value: T; label: string }>; selected: T[]; onChange: (v: T[]) => void; single?: boolean }) {
  return (
    <div className="chips">
      {props.options.map((o) => {
        const on = props.selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            className="chip"
            aria-pressed={on}
            onClick={() =>
              props.onChange(props.single ? [o.value] : on ? props.selected.filter((v) => v !== o.value) : [...props.selected, o.value])
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Page(props: { title: string; lead?: ReactNode; children: ReactNode; back?: string }) {
  return (
    <main className="page">
      {props.back && (
        <a className="link" href={`#${props.back}`}>
          Назад
        </a>
      )}
      <h1 className="page-title">{props.title}</h1>
      {props.lead && <p className="page-lead">{props.lead}</p>}
      {props.children}
    </main>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <p className="error" role="alert">{error}</p> : null;
}
