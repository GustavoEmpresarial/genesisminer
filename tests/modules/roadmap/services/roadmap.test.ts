import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BASE_ROW = {
  id: 'step-1',
  title: 'Etapa 1',
  description: 'Desc',
  status: 'planned',
  planned_date: '2026-Q1',
  image_url: null,
  is_highlight: 0,
  sort_order: 0,
  is_published: 1,
  created_at: 1000n,
  updated_at: 1000n
};

describe('roadmap services/roadmap', () => {
  let prismaMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        roadmap_steps: {
          findMany: vi.fn().mockResolvedValue([BASE_ROW]),
          create: vi.fn().mockResolvedValue(BASE_ROW),
          update: vi.fn().mockResolvedValue(BASE_ROW),
          delete: vi.fn().mockResolvedValue(BASE_ROW)
        },
        $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops))
      }
    };
    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
  });

  describe('listPublishedRoadmap / listRoadmapAdmin', () => {
    it('listPublishedRoadmap filtra só publicadas', async () => {
      const { listPublishedRoadmap } = await import('../../../../server/modules/roadmap/services/roadmap.js');
      const steps = await listPublishedRoadmap();
      expect(prismaMock.prisma.roadmap_steps.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { is_published: 1 } }));
      expect(steps[0]).toMatchObject({ id: 'step-1', isPublished: true });
    });

    it('listRoadmapAdmin lista tudo, sem filtro de publicação', async () => {
      const { listRoadmapAdmin } = await import('../../../../server/modules/roadmap/services/roadmap.js');
      await listRoadmapAdmin();
      expect(prismaMock.prisma.roadmap_steps.findMany).toHaveBeenCalledWith(expect.not.objectContaining({ where: expect.anything() }));
    });

    it('status inválido na BD cai em "planned"', async () => {
      prismaMock.prisma.roadmap_steps.findMany.mockResolvedValue([{ ...BASE_ROW, status: 'lixo' }]);
      const { listPublishedRoadmap } = await import('../../../../server/modules/roadmap/services/roadmap.js');
      const steps = await listPublishedRoadmap();
      expect(steps[0].status).toBe('planned');
    });
  });

  describe('createRoadmapStep', () => {
    it('título vazio lança HttpControlledError 400', async () => {
      const { createRoadmapStep } = await import('../../../../server/modules/roadmap/services/roadmap.js');
      await expect(createRoadmapStep({ title: '  ' })).rejects.toMatchObject({ statusCode: 400, jsonBody: expect.objectContaining({ code: 'VALIDATION' }) });
    });

    it('cria com defaults (isPublished true, status planned)', async () => {
      const { createRoadmapStep } = await import('../../../../server/modules/roadmap/services/roadmap.js');
      await createRoadmapStep({ title: 'Nova etapa' });
      expect(prismaMock.prisma.roadmap_steps.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ title: 'Nova etapa', status: 'planned', is_published: 1 }) }));
    });

    it('isPublished: false grava is_published=0', async () => {
      const { createRoadmapStep } = await import('../../../../server/modules/roadmap/services/roadmap.js');
      await createRoadmapStep({ title: 'X', isPublished: false });
      expect(prismaMock.prisma.roadmap_steps.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ is_published: 0 }) }));
    });

    it('trunca description/plannedDate/imageUrl nos limites', async () => {
      const { createRoadmapStep } = await import('../../../../server/modules/roadmap/services/roadmap.js');
      await createRoadmapStep({ title: 'X', description: 'a'.repeat(9000), plannedDate: 'b'.repeat(50), imageUrl: 'c'.repeat(600) });
      const data = prismaMock.prisma.roadmap_steps.create.mock.calls[0][0].data;
      expect(data.description.length).toBe(8000);
      expect(data.planned_date.length).toBe(40);
      expect(data.image_url.length).toBe(500);
    });
  });

  describe('updateRoadmapStep', () => {
    it('só actualiza os campos informados', async () => {
      const { updateRoadmapStep } = await import('../../../../server/modules/roadmap/services/roadmap.js');
      await updateRoadmapStep('step-1', { title: 'Novo título' });
      expect(prismaMock.prisma.roadmap_steps.update).toHaveBeenCalledWith({ where: { id: 'step-1' }, data: expect.objectContaining({ title: 'Novo título' }) });
      const data = prismaMock.prisma.roadmap_steps.update.mock.calls[0][0].data;
      expect(data.description).toBeUndefined();
    });

    it('rejeita título vazio', async () => {
      const { updateRoadmapStep } = await import('../../../../server/modules/roadmap/services/roadmap.js');
      await expect(updateRoadmapStep('step-1', { title: '   ' })).rejects.toMatchObject({
        statusCode: 400,
        jsonBody: expect.objectContaining({ code: 'VALIDATION' })
      });
      expect(prismaMock.prisma.roadmap_steps.update).not.toHaveBeenCalled();
    });

    it('status inválido no update cai em "planned"', async () => {
      const { updateRoadmapStep } = await import('../../../../server/modules/roadmap/services/roadmap.js');
      await updateRoadmapStep('step-1', { status: 'lixo' });
      expect(prismaMock.prisma.roadmap_steps.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'planned' }) }));
    });
  });

  describe('deleteRoadmapStep', () => {
    it('sucesso: true', async () => {
      const { deleteRoadmapStep } = await import('../../../../server/modules/roadmap/services/roadmap.js');
      expect(await deleteRoadmapStep('step-1')).toBe(true);
    });

    it('erro na BD: false', async () => {
      prismaMock.prisma.roadmap_steps.delete.mockRejectedValue(new Error('not found'));
      const { deleteRoadmapStep } = await import('../../../../server/modules/roadmap/services/roadmap.js');
      expect(await deleteRoadmapStep('nao-existe')).toBe(false);
    });
  });

  describe('reorderRoadmapSteps', () => {
    it('atribui sort_order sequencial numa tx', async () => {
      const { reorderRoadmapSteps } = await import('../../../../server/modules/roadmap/services/roadmap.js');
      await reorderRoadmapSteps(['c', 'a', 'b']);
      expect(prismaMock.prisma.$transaction).toHaveBeenCalledOnce();
      const calls = prismaMock.prisma.roadmap_steps.update.mock.calls;
      expect(calls[0][0]).toMatchObject({ where: { id: 'c' }, data: expect.objectContaining({ sort_order: 0 }) });
      expect(calls[1][0]).toMatchObject({ where: { id: 'a' }, data: expect.objectContaining({ sort_order: 1 }) });
      expect(calls[2][0]).toMatchObject({ where: { id: 'b' }, data: expect.objectContaining({ sort_order: 2 }) });
    });
  });
});
