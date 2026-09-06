import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseTransparencyEntryId,
  planCreateTransparencyEntry,
  planUpdateTransparencyEntry,
  type TransparencyEntryRow
} from '../../../../../server/modules/admin/transparency/services/admin-transparency.js';

const existing: TransparencyEntryRow = {
  id: 7,
  category: 'pool',
  title: 'Old',
  body: 'b',
  amount_usdc: 1,
  link_url: 'https://a',
  sort_order: 2,
  created_at: 1,
  updated_at: 2
};

describe('parseTransparencyEntryId', () => {
  it('id < 1 ou NaN → 400', () => {
    for (const raw of ['0', '-1', 'x', '']) {
      try {
        parseTransparencyEntryId(raw);
        throw new Error('expected');
      } catch (e: any) {
        expect(e.statusCode).toBe(400);
        expect(e.jsonBody.error).toBe('ID inválido');
      }
    }
  });

  it('id ≥ 1', () => {
    expect(parseTransparencyEntryId('12')).toBe(12);
  });
});

describe('planCreateTransparencyEntry', () => {
  it('categoria inválida / título vazio / limites', () => {
    try {
      planCreateTransparencyEntry({ category: 'nope', title: 'x' });
      throw new Error('expected');
    } catch (e: any) {
      expect(e.jsonBody.error).toBe('Categoria inválida');
    }
    try {
      planCreateTransparencyEntry({ category: 'pool', title: '  ' });
      throw new Error('expected');
    } catch (e: any) {
      expect(e.jsonBody.error).toBe('Título obrigatório');
    }
    try {
      planCreateTransparencyEntry({ category: 'pool', title: 'a'.repeat(301) });
      throw new Error('expected');
    } catch (e: any) {
      expect(e.jsonBody.error).toBe('Título longo demais');
    }
    try {
      planCreateTransparencyEntry({ category: 'pool', title: 't', body: 'b'.repeat(8001) });
      throw new Error('expected');
    } catch (e: any) {
      expect(e.jsonBody.error).toBe('Descrição longa demais');
    }
    try {
      planCreateTransparencyEntry({ category: 'pool', title: 't', amountUsdc: 'nope' });
      throw new Error('expected');
    } catch (e: any) {
      expect(e.jsonBody.error).toBe('Valor USDC inválido');
    }
    try {
      planCreateTransparencyEntry({ category: 'pool', title: 't', linkUrl: 'h'.repeat(2049) });
      throw new Error('expected');
    } catch (e: any) {
      expect(e.jsonBody.error).toBe('Link longo demais');
    }
  });

  it('defaults: body/link vazios → null; amount omitido → null; sort NaN → 0', () => {
    expect(planCreateTransparencyEntry({ category: 'expense', title: ' Host ' })).toEqual({
      category: 'expense',
      title: 'Host',
      body: null,
      amount_usdc: null,
      link_url: null,
      sort_order: 0
    });
    const withAmt = planCreateTransparencyEntry({
      category: 'investment',
      title: 't',
      body: '  x  ',
      amountUsdc: '3.5',
      linkUrl: ' https://e ',
      sortOrder: '4.9'
    });
    expect(withAmt.amount_usdc).toBe(3.5);
    expect(withAmt.body).toBe('x');
    expect(withAmt.link_url).toBe('https://e');
    expect(withAmt.sort_order).toBe(4);
  });
});

describe('planUpdateTransparencyEntry', () => {
  it('omite campos undefined; amount vazio/null zera; body vazio → null', () => {
    expect(planUpdateTransparencyEntry({}, existing)).toEqual({
      category: 'pool',
      title: 'Old',
      body: 'b',
      amount_usdc: 1,
      link_url: 'https://a',
      sort_order: 2
    });
    const cleared = planUpdateTransparencyEntry(
      { amountUsdc: null, body: '', linkUrl: null, title: 'New' },
      existing
    );
    expect(cleared.title).toBe('New');
    expect(cleared.body).toBeNull();
    expect(cleared.amount_usdc).toBeNull();
    expect(cleared.link_url).toBeNull();
  });

  it('categoria inválida no PATCH', () => {
    try {
      planUpdateTransparencyEntry({ category: 'x' }, existing);
      throw new Error('expected');
    } catch (e: any) {
      expect(e.jsonBody.error).toBe('Categoria inválida');
    }
  });
});

describe('create/update/delete prisma', () => {
  let prismaMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        transparency_entries: {
          create: vi.fn(),
          findUnique: vi.fn(),
          update: vi.fn(),
          deleteMany: vi.fn()
        }
      }
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
  });

  it('create persiste e mapeia DTO', async () => {
    prismaMock.prisma.transparency_entries.create.mockResolvedValue({
      id: 1,
      category: 'pool',
      title: 'T',
      body: null,
      amount_usdc: null,
      link_url: null,
      sort_order: 0,
      created_at: 99n,
      updated_at: 99n
    });
    const { createTransparencyEntry } = await import(
      '../../../../../server/modules/admin/transparency/services/admin-transparency.js'
    );
    const dto = await createTransparencyEntry({ category: 'pool', title: 'T' }, 99);
    expect(dto).toMatchObject({ id: 1, title: 'T', createdAt: 99, updatedAt: 99 });
    expect(prismaMock.prisma.transparency_entries.create.mock.calls[0][0].data.created_at).toBe(99n);
  });

  it('update 404 se inexistente; update existente', async () => {
    prismaMock.prisma.transparency_entries.findUnique.mockResolvedValue(null);
    const { updateTransparencyEntry } = await import(
      '../../../../../server/modules/admin/transparency/services/admin-transparency.js'
    );
    try {
      await updateTransparencyEntry(3, { title: 'x' });
      throw new Error('expected');
    } catch (e: any) {
      expect(e.statusCode).toBe(404);
    }

    prismaMock.prisma.transparency_entries.findUnique.mockResolvedValue(existing);
    prismaMock.prisma.transparency_entries.update.mockResolvedValue({
      ...existing,
      title: 'New',
      updated_at: 50n
    });
    const dto = await updateTransparencyEntry(7, { title: 'New' }, 50);
    expect(dto.title).toBe('New');
    expect(prismaMock.prisma.transparency_entries.update).toHaveBeenCalled();
  });

  it('delete 404 se count 0; ok se apagou', async () => {
    prismaMock.prisma.transparency_entries.deleteMany.mockResolvedValue({ count: 0 });
    const { deleteTransparencyEntry } = await import(
      '../../../../../server/modules/admin/transparency/services/admin-transparency.js'
    );
    try {
      await deleteTransparencyEntry(9);
      throw new Error('expected');
    } catch (e: any) {
      expect(e.statusCode).toBe(404);
    }
    prismaMock.prisma.transparency_entries.deleteMany.mockResolvedValue({ count: 1 });
    await expect(deleteTransparencyEntry(9)).resolves.toEqual({ ok: true });
  });

  it('erro de banco propaga', async () => {
    prismaMock.prisma.transparency_entries.create.mockRejectedValue(new Error('db down'));
    const { createTransparencyEntry } = await import(
      '../../../../../server/modules/admin/transparency/services/admin-transparency.js'
    );
    await expect(createTransparencyEntry({ category: 'pool', title: 'T' })).rejects.toThrow('db down');
  });
});
