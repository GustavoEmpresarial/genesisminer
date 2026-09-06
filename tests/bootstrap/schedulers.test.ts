import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('bootstrap/schedulers', () => {
  let yieldMock: Record<string, ReturnType<typeof vi.fn>>;
  let backupMock: Record<string, ReturnType<typeof vi.fn>>;
  let chatMock: Record<string, ReturnType<typeof vi.fn>>;
  let rankingMock: Record<string, ReturnType<typeof vi.fn>>;
  let idemPurgeMock: Record<string, ReturnType<typeof vi.fn>>;
  let gerenteMock: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.resetModules();
    yieldMock = { startMiningYieldCron: vi.fn(() => vi.fn()) };
    backupMock = { startScheduledSqlBackups: vi.fn(() => vi.fn()) };
    chatMock = { startChatTtlCron: vi.fn(() => vi.fn()) };
    rankingMock = { startPublicMiningRankingRefreshLoop: vi.fn(() => vi.fn()) };
    idemPurgeMock = { startIdempotencyPurgeCron: vi.fn(() => vi.fn()) };
    gerenteMock = { startGerentePayoutCron: vi.fn(() => vi.fn()) };
    vi.doMock('../../server/modules/mining-engine/index.js', () => yieldMock);
    vi.doMock('../../server/modules/admin/backup/index.js', () => backupMock);
    vi.doMock('../../server/modules/chat/index.js', () => chatMock);
    vi.doMock('../../server/modules/ranking/index.js', () => rankingMock);
    vi.doMock('../../server/modules/admin/maintenance/index.js', () => idemPurgeMock);
    vi.doMock('../../server/modules/gerente/index.js', () => gerenteMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('../../server/modules/mining-engine/index.js');
    vi.doUnmock('../../server/modules/admin/backup/index.js');
    vi.doUnmock('../../server/modules/chat/index.js');
    vi.doUnmock('../../server/modules/ranking/index.js');
    vi.doUnmock('../../server/modules/admin/maintenance/index.js');
    vi.doUnmock('../../server/modules/gerente/index.js');
  });

  it('SCHEDULER_ENABLED=0: não inicia nenhum job', async () => {
    vi.stubEnv('SCHEDULER_ENABLED', '0');
    const { startBackgroundSchedulers } = await import('../../server/bootstrap/schedulers.js');
    const stop = startBackgroundSchedulers({ uploadsDir: '/tmp' });
    expect(yieldMock.startMiningYieldCron).not.toHaveBeenCalled();
    expect(backupMock.startScheduledSqlBackups).not.toHaveBeenCalled();
    expect(chatMock.startChatTtlCron).not.toHaveBeenCalled();
    expect(rankingMock.startPublicMiningRankingRefreshLoop).not.toHaveBeenCalled();
    expect(idemPurgeMock.startIdempotencyPurgeCron).not.toHaveBeenCalled();
    expect(gerenteMock.startGerentePayoutCron).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it('default: inicia os 6 jobs e stop() chama cada stop individual', async () => {
    vi.stubEnv('SCHEDULER_ENABLED', '1');
    const stopYield = vi.fn();
    const stopBackup = vi.fn();
    const stopChat = vi.fn();
    const stopRanking = vi.fn();
    const stopIdem = vi.fn();
    const stopGerente = vi.fn();
    yieldMock.startMiningYieldCron.mockReturnValue(stopYield);
    backupMock.startScheduledSqlBackups.mockReturnValue(stopBackup);
    chatMock.startChatTtlCron.mockReturnValue(stopChat);
    rankingMock.startPublicMiningRankingRefreshLoop.mockReturnValue(stopRanking);
    idemPurgeMock.startIdempotencyPurgeCron.mockReturnValue(stopIdem);
    gerenteMock.startGerentePayoutCron.mockReturnValue(stopGerente);

    const { startBackgroundSchedulers } = await import('../../server/bootstrap/schedulers.js');
    const stop = startBackgroundSchedulers({ uploadsDir: '/uploads' });
    expect(yieldMock.startMiningYieldCron).toHaveBeenCalledOnce();
    expect(backupMock.startScheduledSqlBackups).toHaveBeenCalledOnce();
    expect(chatMock.startChatTtlCron).toHaveBeenCalledWith({ uploadsDir: '/uploads' });
    expect(rankingMock.startPublicMiningRankingRefreshLoop).toHaveBeenCalledOnce();
    expect(idemPurgeMock.startIdempotencyPurgeCron).toHaveBeenCalledOnce();
    expect(gerenteMock.startGerentePayoutCron).toHaveBeenCalledOnce();

    stop();
    expect(stopYield).toHaveBeenCalledOnce();
    expect(stopBackup).toHaveBeenCalledOnce();
    expect(stopChat).toHaveBeenCalledOnce();
    expect(stopRanking).toHaveBeenCalledOnce();
    expect(stopIdem).toHaveBeenCalledOnce();
    expect(stopGerente).toHaveBeenCalledOnce();
  });
});
