import { describe, expect, it, vi } from 'vitest';
import {
  mergeSeasonPassIntoCatalog,
  replaceSeasonPassViaFullCatalog
} from '../../../client/src/features/admin/lib/seasonPassCatalog.js';

const a = { id: 'a', name: 'Alpha', seasonId: 's1' };
const b = { id: 'b', name: 'Beta', seasonId: 's1' };
const c = { id: 'c', name: 'Gamma', seasonId: 's2' };

describe('mergeSeasonPassIntoCatalog', () => {
  it('editar um pass preserva os demais', () => {
    const next = mergeSeasonPassIntoCatalog([a, b], { ...a, name: 'Alpha 2' });
    expect(next).toHaveLength(2);
    expect(next.find((p) => p.id === 'b')).toEqual(b);
    expect(next.find((p) => p.id === 'a')?.name).toBe('Alpha 2');
  });

  it('criar um pass preserva os existentes', () => {
    const next = mergeSeasonPassIntoCatalog([a, b], c);
    expect(next.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('sem id lança', () => {
    expect(() => mergeSeasonPassIntoCatalog([a], { id: '', name: 'x' })).toThrow(/id/);
  });
});

describe('replaceSeasonPassViaFullCatalog', () => {
  it('payload enviado contém a lista completa', async () => {
    const save = vi.fn().mockResolvedValue({ ok: true });
    const result = await replaceSeasonPassViaFullCatalog(
      { ...a, name: 'Novo' },
      {
        load: async () => ({ ok: true, passes: [a, b] }),
        save
      }
    );
    expect(result.ok).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    const sent = save.mock.calls[0][0] as typeof a[];
    expect(sent.map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect(sent.find((p) => p.id === 'a')?.name).toBe('Novo');
    expect(sent.find((p) => p.id === 'b')).toEqual(b);
  });

  it('criar envia catálogo anterior mais o novo', async () => {
    const save = vi.fn().mockResolvedValue({ ok: true });
    await replaceSeasonPassViaFullCatalog(c, {
      load: async () => ({ ok: true, passes: [a, b] }),
      save
    });
    const sent = save.mock.calls[0][0] as typeof a[];
    expect(sent.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('GET falhou: não chama POST', async () => {
    const save = vi.fn();
    const result = await replaceSeasonPassViaFullCatalog(a, {
      load: async () => ({ ok: false, error: 'HTTP 500' }),
      save
    });
    expect(result).toEqual({ ok: false, error: 'HTTP 500' });
    expect(save).not.toHaveBeenCalled();
  });

  it('erro do POST não produz sucesso', async () => {
    const result = await replaceSeasonPassViaFullCatalog(a, {
      load: async () => ({ ok: true, passes: [a, b] }),
      save: async () => ({ ok: false, error: 'HTTP 403' })
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('HTTP 403');
  });
});
