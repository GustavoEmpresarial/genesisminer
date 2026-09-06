import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cobre especificamente a correção do achado de segurança documentado em
 * DECISIONS.md: o limite antifraude de cadastro por IP (3 contas/90 dias)
 * usava `users.last_active_at` como proxy de "conta criada recentemente",
 * mas esse campo nunca é preenchido no momento do registo — só depois de
 * algum login. Uma conta criada e nunca usada nunca contava para o limite.
 * A correção usa `game_states.start_time` (gravado de forma síncrona no
 * registo) via JOIN explícito.
 */
describe('modules/auth/services/user-creation — limite antifraude por IP', () => {
  let prismaMock: Record<string, any>;
  let grantAsicMock: { ensureUserHasDefaultAsicRoom: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.resetModules();
    grantAsicMock = {
      ensureUserHasDefaultAsicRoom: vi.fn().mockResolvedValue(undefined)
    };
    prismaMock = {
      Prisma: { PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {} },
      prisma: {
        users: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 99 }),
          update: vi.fn().mockResolvedValue(undefined)
        },
        $queryRaw: vi.fn().mockResolvedValue([{ count: 0 }]),
        user_history_ips: { createMany: vi.fn().mockResolvedValue(undefined) },
        loot_boxes: { findMany: vi.fn().mockResolvedValue([]) },
        unopened_boxes: { upsert: vi.fn().mockResolvedValue(undefined) },
        player_claimed_boxes: { createMany: vi.fn().mockResolvedValue(undefined) },
        game_states: { create: vi.fn().mockResolvedValue(undefined) },
        user_rig_rooms: { createMany: vi.fn().mockResolvedValue({ count: 1 }) }
      }
    };
    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('@prisma/client', () => ({ Prisma: prismaMock.Prisma }));
    vi.doMock('../../../../server/modules/rooms/services/grant-default-asic-room.js', () => grantAsicMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
    vi.doUnmock('@prisma/client');
    vi.doUnmock('../../../../server/modules/rooms/services/grant-default-asic-room.js');
  });

  it('conta CRIADA e nunca usada (last_active_at nulo) ainda assim entra no limite (via game_states.start_time)', async () => {
    // Simula 3 contas já criadas recentemente a partir do mesmo IP — o cenário
    // exato do bug: essas contas nunca logaram (last_active_at seria null no
    // schema antigo), mas `game_states.start_time` foi gravado no registo.
    prismaMock.prisma.$queryRaw.mockResolvedValue([{ count: 3 }]);
    const { getUserIdByEmail, IpLimitError } = await import(
      '../../../../server/modules/auth/services/user-creation.js'
    );

    await expect(getUserIdByEmail('novo@gmail.com', '203.0.113.1', { allowAnyDomain: true })).rejects.toBeInstanceOf(
      IpLimitError
    );
    expect(prismaMock.prisma.users.create).not.toHaveBeenCalled();

    // Confirma que a query usada é o JOIN com game_states (não mais `users.count`
    // filtrando por `last_active_at`).
    const sql = String(prismaMock.prisma.$queryRaw.mock.calls[0]?.[0]?.join?.('') ?? prismaMock.prisma.$queryRaw.mock.calls[0]);
    expect(sql).toContain('game_states');
  });

  it('abaixo do limite: cria a conta normalmente', async () => {
    prismaMock.prisma.$queryRaw.mockResolvedValue([{ count: 2 }]);
    const { getUserIdByEmail } = await import('../../../../server/modules/auth/services/user-creation.js');

    const id = await getUserIdByEmail('outro@gmail.com', '203.0.113.5', { allowAnyDomain: true });

    expect(id).toBe(99);
    expect(prismaMock.prisma.users.create).toHaveBeenCalled();
    expect(grantAsicMock.ensureUserHasDefaultAsicRoom).toHaveBeenCalledWith(99);
  });

  it('sem IP resolvível (ex.: IP privado/loopback): não consulta o limite, cria direto', async () => {
    const { getUserIdByEmail } = await import('../../../../server/modules/auth/services/user-creation.js');

    const id = await getUserIdByEmail('local@gmail.com', '127.0.0.1', { allowAnyDomain: true });

    expect(id).toBe(99);
    expect(prismaMock.prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
