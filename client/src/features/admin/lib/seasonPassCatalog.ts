/**
 * POST /api/season-passes substitui o catálogo inteiro.
 * Editar/criar um passe exige GET + merge + POST da lista completa.
 */
import { apiFetch } from '../../../shared/api/http';
import type { SeasonPass } from './adminTypes';

export type CatalogLoadResult<T> =
  | { ok: true; passes: T[] }
  | { ok: false; error: string };

export type CatalogSaveResult = { ok: true } | { ok: false; error: string };

export function mergeSeasonPassIntoCatalog<T extends { id: string }>(catalog: T[], pass: T): T[] {
  const id = String(pass.id ?? '').trim();
  if (!id) {
    throw new Error('id do passe é obrigatório');
  }
  const idx = catalog.findIndex((p) => p.id === id);
  if (idx < 0) return [...catalog, { ...pass, id }];
  const next = catalog.slice();
  next[idx] = { ...catalog[idx], ...pass, id };
  return next;
}

export async function replaceSeasonPassViaFullCatalog<T extends { id: string }>(
  pass: T,
  http: {
    load: () => Promise<CatalogLoadResult<T>>;
    save: (passes: T[]) => Promise<CatalogSaveResult>;
  }
): Promise<{ ok: true; passes: T[] } | { ok: false; error: string }> {
  const loaded = await http.load();
  if (!loaded.ok) return loaded;
  let next: T[];
  try {
    next = mergeSeasonPassIntoCatalog(loaded.passes, pass);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Passe inválido.' };
  }
  const saved = await http.save(next);
  if (!saved.ok) return saved;
  return { ok: true, passes: next };
}

export async function loadSeasonPassesForReplace(): Promise<CatalogLoadResult<SeasonPass>> {
  try {
    const res = await apiFetch('/api/season-passes');
    if (!res.ok) {
      return { ok: false, error: `Não foi possível carregar o catálogo (HTTP ${res.status}).` };
    }
    const data: unknown = await res.json().catch(() => null);
    if (!Array.isArray(data)) {
      return { ok: false, error: 'Resposta inválida ao carregar passes.' };
    }
    return { ok: true, passes: data as SeasonPass[] };
  } catch {
    return { ok: false, error: 'Erro de rede ao carregar passes.' };
  }
}

export async function postSeasonPassesCatalog(passes: SeasonPass[]): Promise<CatalogSaveResult> {
  try {
    const res = await apiFetch('/api/season-passes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(passes)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: text.trim() || `Erro ao gravar passes (HTTP ${res.status}).` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Erro de rede ao gravar passes.' };
  }
}

export async function saveSeasonPassPreservingCatalog(
  pass: SeasonPass
): Promise<{ ok: true; passes: SeasonPass[] } | { ok: false; error: string }> {
  return replaceSeasonPassViaFullCatalog(pass, {
    load: loadSeasonPassesForReplace,
    save: postSeasonPassesCatalog
  });
}
