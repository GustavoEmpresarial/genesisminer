import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cobre especificamente a correção do risco documentado em
 * `resolveSuspiciousUsersWorkingSet`/`deactivateFilteredSuspiciousUsers`:
 * um jogador que já minerou de verdade (hash real > 0) mas zerou saldo e
 * desligou as rigs não pode ser desactivado por um filtro `dead_account`/
 * `never_mined` baseado só na aproximação (sem hash real).
 */
describe('modules/admin/suspicious-emails/services/report — refinação por hash real', () => {
  let dbMock: Record<string, any>;
  let snapshotMock: Record<string, any>;
  let sessionClient: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };

  const DEAD_ACCOUNT_ROW_BASE = {
    username: 'player',
    referred_by: null,
    is_blocked: 0,
    last_active_at: null,
    polygon_wallet: null,
    access_level_id: null,
    access_level_name: null,
    gs_last_updated: null,
    // > 30 dias atrás — dispara o "inactive" via grace period de accountStart.
    gs_start_time: Date.now() - 200 * 24 * 60 * 60 * 1000,
    referrer_id: null,
    referrer_username: null,
    referrer_email: null,
    coin_balance_sum: 0,
    rack_count: 0,
    racks_mining_on: 0,
    has_stock: false,
    total_usdc_deposited: 0,
    last_checkin_at_ms: null
  };

  beforeEach(() => {
    vi.resetModules();

    sessionClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const s = String(sql);
        if (s.includes('BEGIN') || s.includes('COMMIT') || s.includes('ROLLBACK')) return { rows: [], rowCount: 0 };
        if (s.includes('UPDATE users SET is_blocked')) {
          const batch = (params?.[0] as number[] | undefined) ?? [];
          return { rows: [], rowCount: batch.length };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    };

    dbMock = {
      default: {
        query: vi.fn(async (sql: string) => {
          const s = String(sql);
          // Query principal (candidatos): tem sempre `userSelectSql` embutido —
          // checar isto primeiro, porque o CTE `WITH dup AS (... AS em ...)`
          // dela também contém a substring "AS em" (usada pela query de
          // duplicados isolada), então a ordem de checagem importa aqui.
          if (s.includes('racks_mining_on')) {
            return {
              rows: [
                { id: 42, email: 'realminer@gmail.com', ...DEAD_ACCOUNT_ROW_BASE },
                { id: 43, email: 'trulydead@gmail.com', ...DEAD_ACCOUNT_ROW_BASE }
              ]
            };
          }
          if (s.includes('AS em')) return { rows: [] }; // duplicados (query isolada)
          if (s.includes('AS d, count')) return { rows: [] }; // contagem por domínio
          return { rows: [] };
        }),
        connect: vi.fn(async () => sessionClient)
      }
    };

    snapshotMock = {
      // id 42 minerou de verdade (hash real > 0); id 43 nunca minerou mesmo.
      computePlayerGameHeaderSnapshot: vi.fn(async (userId: number) => ({
        totalHash: userId === 42 ? 5 : 0,
        coinBalances: {},
        usdc: 0,
        hashByCoinId: {},
        serverUpdatedAt: Date.now()
      }))
    };

    vi.doMock('../../../../../server/core/database/pool.js', () => dbMock);
    vi.doMock('../../../../../server/modules/mining-engine/services/player-game-header-snapshot.js', () => snapshotMock);
    vi.doMock('../../../../../server/modules/auth/services/auth-worker-client.js', () => ({
      callAuthSessionDeleteByUser: vi.fn().mockResolvedValue({ ok: true, deletedCount: 0 })
    }));
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/pool.js');
    vi.doUnmock('../../../../../server/modules/mining-engine/services/player-game-header-snapshot.js');
    vi.doUnmock('../../../../../server/modules/auth/services/auth-worker-client.js');
  });

  it('poupa quem tem hash real > 0 (não desactiva um minerador de verdade por engano)', async () => {
    const { deactivateFilteredSuspiciousUsers } = await import(
      '../../../../../server/modules/admin/suspicious-emails/services/report.js'
    );

    const result = await deactivateFilteredSuspiciousUsers(
      { reason: 'dead_account' },
      { expectedCount: 2, adminUserId: 1 }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('esperava sucesso');
    expect(result.excludedByRealMining).toBe(1);
    expect(result.deactivated).toBe(1);

    // Só o id 43 (hash real 0) entra no UPDATE — id 42 (hash real 5) é poupado.
    const updateCall = sessionClient.query.mock.calls.find((c) => String(c[0]).includes('UPDATE users SET is_blocked'));
    expect(updateCall?.[1]).toEqual([[43]]);
  });

  it('filtro sem dependência de hash (ex.: all) não paga o custo da refinação', async () => {
    const { deactivateFilteredSuspiciousUsers } = await import(
      '../../../../../server/modules/admin/suspicious-emails/services/report.js'
    );

    const result = await deactivateFilteredSuspiciousUsers({ reason: 'all' }, { expectedCount: 2, adminUserId: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('esperava sucesso');
    expect(result.excludedByRealMining).toBe(0);
    expect(result.deactivated).toBe(2);
    expect(snapshotMock.computePlayerGameHeaderSnapshot).not.toHaveBeenCalled();
  });
});
