import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CAT_ROW = { id: 'cat-1', title: 'Categoria 1', sort_order: 0, is_published: 1, created_at: 1000n, updated_at: 1000n };
const PAGE_ROW = { id: 'page-1', category_id: 'cat-1', title: 'Página 1', slug: 'pagina-1', content_html: '<p>oi</p>', sort_order: 0, is_published: 1, created_at: 1000n, updated_at: 1000n };

describe('guide services/guide', () => {
  let prismaMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
        guide_categories: {
          findMany: vi.fn().mockResolvedValue([CAT_ROW]),
          findUnique: vi.fn().mockResolvedValue(CAT_ROW),
          create: vi.fn().mockResolvedValue(CAT_ROW),
          update: vi.fn().mockResolvedValue(CAT_ROW),
          delete: vi.fn().mockResolvedValue(CAT_ROW)
        },
        guide_pages: {
          findMany: vi.fn().mockResolvedValue([PAGE_ROW]),
          create: vi.fn().mockResolvedValue(PAGE_ROW),
          update: vi.fn().mockResolvedValue(PAGE_ROW),
          delete: vi.fn().mockResolvedValue(PAGE_ROW)
        }
      }
    };
    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
  });

  describe('listPublishedGuide / listGuideAdmin', () => {
    it('agrupa páginas dentro da categoria certa', async () => {
      const { listPublishedGuide } = await import('../../../../server/modules/guide/services/guide.js');
      const cats = await listPublishedGuide();
      expect(cats).toHaveLength(1);
      expect(cats[0].pages).toHaveLength(1);
      expect(cats[0].pages[0].id).toBe('page-1');
    });

    it('listPublishedGuide só filtra categorias/páginas publicadas', async () => {
      const { listPublishedGuide } = await import('../../../../server/modules/guide/services/guide.js');
      await listPublishedGuide();
      expect(prismaMock.prisma.guide_categories.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { is_published: 1 } }));
      expect(prismaMock.prisma.guide_pages.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { is_published: 1, category: { is_published: 1 } } }));
    });

    it('listGuideAdmin lista tudo sem filtro', async () => {
      const { listGuideAdmin } = await import('../../../../server/modules/guide/services/guide.js');
      await listGuideAdmin();
      const call = prismaMock.prisma.guide_categories.findMany.mock.calls[0][0];
      expect(call.where).toBeUndefined();
    });

    it('categoria sem páginas devolve pages: []', async () => {
      prismaMock.prisma.guide_pages.findMany.mockResolvedValue([]);
      const { listPublishedGuide } = await import('../../../../server/modules/guide/services/guide.js');
      const cats = await listPublishedGuide();
      expect(cats[0].pages).toEqual([]);
    });
  });

  describe('createGuideCategory', () => {
    it('título vazio lança erro', async () => {
      const { createGuideCategory } = await import('../../../../server/modules/guide/services/guide.js');
      await expect(createGuideCategory({ title: '  ' })).rejects.toThrow('Title required.');
    });

    it('cria com isPublished true por default', async () => {
      const { createGuideCategory } = await import('../../../../server/modules/guide/services/guide.js');
      await createGuideCategory({ title: 'Nova' });
      expect(prismaMock.prisma.guide_categories.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ title: 'Nova', is_published: 1 }) }));
    });
  });

  describe('createGuidePage', () => {
    it('exige categoryId e title', async () => {
      const { createGuidePage } = await import('../../../../server/modules/guide/services/guide.js');
      await expect(createGuidePage({ categoryId: '', title: 'X' })).rejects.toThrow('Category and title required.');
      await expect(createGuidePage({ categoryId: 'cat-1', title: '' })).rejects.toThrow('Category and title required.');
    });

    it('categoria inexistente: erro', async () => {
      prismaMock.prisma.guide_categories.findUnique.mockResolvedValue(null);
      const { createGuidePage } = await import('../../../../server/modules/guide/services/guide.js');
      await expect(createGuidePage({ categoryId: 'nao-existe', title: 'X' })).rejects.toThrow('Category not found.');
    });

    it('sanitiza <script> e handlers inline do contentHtml', async () => {
      const { createGuidePage } = await import('../../../../server/modules/guide/services/guide.js');
      await createGuidePage({ categoryId: 'cat-1', title: 'X', contentHtml: '<p onclick="evil()">oi</p><script>alert(1)</script>' });
      const data = prismaMock.prisma.guide_pages.create.mock.calls[0][0].data;
      expect(data.content_html).not.toContain('<script');
      expect(data.content_html).not.toContain('onclick');
    });

    it('remove esquema javascript: do html', async () => {
      const { createGuidePage } = await import('../../../../server/modules/guide/services/guide.js');
      await createGuidePage({ categoryId: 'cat-1', title: 'X', contentHtml: '<a href="javascript:alert(1)">x</a>' });
      const data = prismaMock.prisma.guide_pages.create.mock.calls[0][0].data;
      expect(data.content_html).not.toContain('javascript:');
    });
  });

  describe('updateGuideCategory / updateGuidePage', () => {
    it('updateGuideCategory só actualiza campos presentes e devolve páginas actuais', async () => {
      const { updateGuideCategory } = await import('../../../../server/modules/guide/services/guide.js');
      const out = await updateGuideCategory('cat-1', { title: 'Editada' });
      expect(prismaMock.prisma.guide_categories.update).toHaveBeenCalledWith({ where: { id: 'cat-1' }, data: expect.objectContaining({ title: 'Editada' }) });
      expect(out.pages).toHaveLength(1);
    });

    it('updateGuideCategory rejeita título vazio', async () => {
      const { updateGuideCategory } = await import('../../../../server/modules/guide/services/guide.js');
      await expect(updateGuideCategory('cat-1', { title: '   ' })).rejects.toThrow('Title required.');
      expect(prismaMock.prisma.guide_categories.update).not.toHaveBeenCalled();
    });

    it('updateGuidePage sanitiza contentHtml quando presente', async () => {
      const { updateGuidePage } = await import('../../../../server/modules/guide/services/guide.js');
      await updateGuidePage('page-1', { contentHtml: '<script>bad()</script>ok' });
      const data = prismaMock.prisma.guide_pages.update.mock.calls[0][0].data;
      expect(data.content_html).toBe('ok');
    });

    it('updateGuidePage valida categoria ao mover', async () => {
      prismaMock.prisma.guide_categories.findUnique.mockResolvedValue(null);
      const { updateGuidePage } = await import('../../../../server/modules/guide/services/guide.js');
      await expect(updateGuidePage('page-1', { categoryId: 'ghost' })).rejects.toThrow('Category not found.');
      expect(prismaMock.prisma.guide_pages.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteGuideCategory / deleteGuidePage', () => {
    it('sucesso: true; erro na BD: false', async () => {
      const { deleteGuideCategory, deleteGuidePage } = await import('../../../../server/modules/guide/services/guide.js');
      expect(await deleteGuideCategory('cat-1')).toBe(true);
      expect(await deleteGuidePage('page-1')).toBe(true);
      prismaMock.prisma.guide_categories.delete.mockRejectedValue(new Error('fk'));
      expect(await deleteGuideCategory('cat-1')).toBe(false);
    });
  });

  describe('reorderGuideCategories / reorderGuidePages', () => {
    it('reorderGuideCategories atribui sort_order sequencial numa tx', async () => {
      const { reorderGuideCategories } = await import('../../../../server/modules/guide/services/guide.js');
      await reorderGuideCategories(['b', 'a']);
      expect(prismaMock.prisma.$transaction).toHaveBeenCalledOnce();
      const ops = prismaMock.prisma.$transaction.mock.calls[0][0];
      expect(ops).toHaveLength(2);
      const results = await Promise.all(ops);
      expect(results[0]).toEqual(CAT_ROW);
      expect(prismaMock.prisma.guide_categories.update).toHaveBeenCalledWith({ where: { id: 'b' }, data: expect.objectContaining({ sort_order: 0 }) });
      expect(prismaMock.prisma.guide_categories.update).toHaveBeenCalledWith({ where: { id: 'a' }, data: expect.objectContaining({ sort_order: 1 }) });
    });

    it('reorderGuidePages também move a página pra categoria informada', async () => {
      prismaMock.prisma.guide_categories.findUnique.mockResolvedValue({ id: 'cat-2' });
      const { reorderGuidePages } = await import('../../../../server/modules/guide/services/guide.js');
      await reorderGuidePages('cat-2', ['page-1']);
      expect(prismaMock.prisma.$transaction).toHaveBeenCalledOnce();
      expect(prismaMock.prisma.guide_pages.update).toHaveBeenCalledWith({ where: { id: 'page-1' }, data: expect.objectContaining({ sort_order: 0, category_id: 'cat-2' }) });
    });

    it('reorderGuidePages exige categoryId', async () => {
      const { reorderGuidePages } = await import('../../../../server/modules/guide/services/guide.js');
      await expect(reorderGuidePages('', ['page-1'])).rejects.toThrow('Category required.');
      expect(prismaMock.prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
