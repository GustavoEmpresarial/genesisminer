/**
 * loadAsicDurationConfig must SELECT nft_mining_coin_id so GPU NFT machines
 * (e.g. dolar_f2p2) pass isNftRoomCatalogMachineRow and keep timed duration.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { isTimedAsicDuration, loadAsicDurationConfig } from '../../../../server/modules/mining-engine/services/asic-lease.js';

const DOLAR_F2P2 = 'dolar_f2p2';
const ASIC_TIMED = 'asic_timed_x';
const GPU_NO_NFT = 'gpu_plain';

function clientReturning(row: Record<string, unknown> | undefined): PoolClient {
  return {
    query: vi.fn(async () => ({ rows: row ? [row] : [] }))
  } as unknown as PoolClient;
}

describe('loadAsicDurationConfig', () => {
  it('GPU + nft_mining_coin_id + duration → timed (dolar_f2p2 gate)', async () => {
    const client = clientReturning({
      type: 'machine',
      category: 'GPU',
      id: DOLAR_F2P2,
      nft_mining_coin_id: 'coin_dolar',
      asic_duration_amount: 90,
      asic_duration_unit: 'day',
      asic_duration_kind: 'timed'
    });

    const cfg = await loadAsicDurationConfig(client, DOLAR_F2P2);

    expect(isTimedAsicDuration(cfg)).toBe(true);
    expect(cfg.amount).toBe(90);
    expect(cfg.unit).toBe('day');
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/nft_mining_coin_id/),
      [DOLAR_F2P2]
    );
  });

  it('non-asic category + amount>0 but no nft coin → permanent (NFT gate)', async () => {
    const client = clientReturning({
      type: 'machine',
      category: 'GPU',
      id: GPU_NO_NFT,
      nft_mining_coin_id: null,
      asic_duration_amount: 90,
      asic_duration_unit: 'day',
      asic_duration_kind: 'timed'
    });

    const cfg = await loadAsicDurationConfig(client, GPU_NO_NFT);

    expect(isTimedAsicDuration(cfg)).toBe(false);
    expect(cfg).toEqual({ amount: 0, unit: null });
  });

  it('asic_* without coin + duration → timed via category', async () => {
    const client = clientReturning({
      type: 'machine',
      category: 'asic',
      id: ASIC_TIMED,
      nft_mining_coin_id: null,
      asic_duration_amount: 7,
      asic_duration_unit: 'day',
      asic_duration_kind: 'timed'
    });

    const cfg = await loadAsicDurationConfig(client, ASIC_TIMED);

    expect(isTimedAsicDuration(cfg)).toBe(true);
    expect(cfg.amount).toBe(7);
    expect(cfg.unit).toBe('day');
  });
});
