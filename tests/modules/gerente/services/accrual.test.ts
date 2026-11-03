import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_MANAGER_PERCENT_MULTIPLIER,
  ACCOUNT_MANAGER_SHARE,
  ACCOUNT_MANAGER_SHARE_PERCENT
} from '../../../../server/modules/gerente/services/constants.js';

describe('accrueManagerMiningShare', () => {
  const ORIGINAL = process.env.ACCOUNT_MANAGER_ENABLED;
  let client: { query: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    process.env.ACCOUNT_MANAGER_ENABLED = '1';
    client = { query: vi.fn() };
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ACCOUNT_MANAGER_ENABLED;
    else process.env.ACCOUNT_MANAGER_ENABLED = ORIGINAL;
  });

  it('share canónico é 5% do minerado', () => {
    expect(ACCOUNT_MANAGER_SHARE_PERCENT).toBe(5);
    expect(ACCOUNT_MANAGER_SHARE * ACCOUNT_MANAGER_PERCENT_MULTIPLIER).toBe(ACCOUNT_MANAGER_SHARE_PERCENT);
  });

  it('feature desligada: não consulta a BD', async () => {
    process.env.ACCOUNT_MANAGER_ENABLED = '0';
    const { accrueManagerMiningShare } = await import('../../../../server/modules/gerente/services/accrual.js');
    await accrueManagerMiningShare(client as any, 1, [{ coinId: 'btc', amount: 10 }]);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('sem ganhos positivos: não consulta a BD', async () => {
    const { accrueManagerMiningShare } = await import('../../../../server/modules/gerente/services/accrual.js');
    await accrueManagerMiningShare(client as any, 1, [{ coinId: 'btc', amount: 0 }, { coinId: '', amount: 5 }]);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('sem contrato ativo pro dono: não grava accrual', async () => {
    client.query.mockResolvedValueOnce({ rows: [] });
    const { accrueManagerMiningShare } = await import('../../../../server/modules/gerente/services/accrual.js');
    await accrueManagerMiningShare(client as any, 1, [{ coinId: 'btc', amount: 10 }]);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('contrato ativo mas ainda não "hiredAt" (nowMs < hiredAt): não grava', async () => {
    const future = Date.now() + 100000;
    client.query.mockResolvedValueOnce({ rows: [{ id: 5, hired_at: future }] });
    const { accrueManagerMiningShare } = await import('../../../../server/modules/gerente/services/accrual.js');
    await accrueManagerMiningShare(client as any, 1, [{ coinId: 'btc', amount: 10 }], Date.now());
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('contrato ativo e válido: grava ACCOUNT_MANAGER_SHARE de cada moeda ganha', async () => {
    const now = Date.now();
    const btcMined = 10;
    const ethMined = 20;
    client.query.mockResolvedValueOnce({ rows: [{ id: 5, hired_at: now - 1000 }] }).mockResolvedValue({ rows: [] });
    const { accrueManagerMiningShare } = await import('../../../../server/modules/gerente/services/accrual.js');
    await accrueManagerMiningShare(client as any, 1, [{ coinId: 'btc', amount: btcMined }, { coinId: 'eth', amount: ethMined }], now);
    expect(client.query).toHaveBeenCalledTimes(3);
    const btcCall = client.query.mock.calls[1];
    expect(btcCall[1]).toEqual([5, 'btc', expect.any(Number), btcMined, btcMined * ACCOUNT_MANAGER_SHARE]);
    const ethCall = client.query.mock.calls[2];
    expect(ethCall[1]).toEqual([5, 'eth', expect.any(Number), ethMined, ethMined * ACCOUNT_MANAGER_SHARE]);
  });
});
