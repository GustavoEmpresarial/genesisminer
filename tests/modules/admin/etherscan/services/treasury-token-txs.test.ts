import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampTreasuryTxOffset,
  clampTreasuryTxPage,
  redactSecrets,
  resolveTreasuryAddress
} from '../../../../../server/modules/admin/etherscan/services/treasury-token-txs.js';

describe('clamp page/offset', () => {
  it('page 1–100, default 1', () => {
    expect(clampTreasuryTxPage(undefined)).toBe(1);
    expect(clampTreasuryTxPage('0')).toBe(1);
    expect(clampTreasuryTxPage('50')).toBe(50);
    expect(clampTreasuryTxPage('999')).toBe(100);
  });

  it('offset 1–1000, default 20 (`0` cai no default via || 20)', () => {
    expect(clampTreasuryTxOffset(undefined)).toBe(20);
    expect(clampTreasuryTxOffset('0')).toBe(20);
    expect(clampTreasuryTxOffset('20')).toBe(20);
    expect(clampTreasuryTxOffset('1000')).toBe(1000);
    expect(clampTreasuryTxOffset('5000')).toBe(1000);
  });
});

describe('resolveTreasuryAddress', () => {
  const primary = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  it('usa address se estiver na allowlist; senão primary', () => {
    expect(resolveTreasuryAddress('0x2c386Bf962339B497d5EC6A0EdB255D30004F3B6', primary)).toBe(
      '0x2c386bf962339b497d5ec6a0edb255d30004f3b6'
    );
    expect(resolveTreasuryAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', primary)).toBe(primary);
    expect(resolveTreasuryAddress('', '')).toBe('0x3d9bda32f0cba0e84c332fd0151d434a4840f38a');
  });
});

describe('redactSecrets', () => {
  it('remove chave e apikey= da URL', () => {
    const k = 'sekrit-key-xyz';
    expect(redactSecrets(`https://api.etherscan.io/v2/api?apikey=${k}&x=1`, [k])).not.toMatch(k);
    expect(redactSecrets(`err ${k}`, [k])).toBe('err [redacted]');
  });
});

describe('getTreasuryTokenTxs', () => {
  const KEY = 'test-etherscan-key';
  let settingsRepo: { getSettingValue: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.resetModules();
    settingsRepo = { getSettingValue: vi.fn().mockResolvedValue(null) };
    vi.doMock('../../../../../server/shared/settings/settings-repository.js', () => settingsRepo);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/shared/settings/settings-repository.js');
  });

  it('503 se API key vazia', async () => {
    const { getTreasuryTokenTxs } = await import(
      '../../../../../server/modules/admin/etherscan/services/treasury-token-txs.js'
    );
    try {
      await getTreasuryTokenTxs({}, { apiKey: '' });
      throw new Error('expected');
    } catch (e: any) {
      expect(e.statusCode).toBe(503);
      expect(e.jsonBody.error).toBe('ETHERSCAN_API_KEY não configurada no servidor.');
    }
  });

  it('sucesso: devolve JSON Etherscan; chave não vai na resposta; URL tem tokentx', async () => {
    let calledUrl = '';
    const fetchImpl = async (url: string) => {
      calledUrl = url;
      return {
        json: async () => ({ status: '1', message: 'OK', result: [{ hash: '0xabc', from: '0x1', to: '0x2', value: '1', timeStamp: '1' }] })
      };
    };
    const { getTreasuryTokenTxs } = await import(
      '../../../../../server/modules/admin/etherscan/services/treasury-token-txs.js'
    );
    const data = (await getTreasuryTokenTxs({ page: '1', offset: '20' }, { apiKey: KEY, fetchImpl })) as Record<string, unknown>;
    expect(data.status).toBe('1');
    expect(Array.isArray(data.result)).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(KEY);
    expect(calledUrl).toContain('module=account');
    expect(calledUrl).toContain('action=tokentx');
    expect(calledUrl).toContain('chainid=137');
    expect(calledUrl).toContain(`apikey=${KEY}`);
  });

  it('lista vazia Etherscan (status 0)', async () => {
    const fetchImpl = async () => ({
      json: async () => ({ status: '0', message: 'No transactions found', result: [] })
    });
    const { getTreasuryTokenTxs } = await import(
      '../../../../../server/modules/admin/etherscan/services/treasury-token-txs.js'
    );
    const data = (await getTreasuryTokenTxs({}, { apiKey: KEY, fetchImpl })) as Record<string, unknown>;
    expect(data.status).toBe('0');
    expect(data.result).toEqual([]);
  });

  it('sanitize se o JSON externo ecoar a chave', async () => {
    const fetchImpl = async () => ({
      json: async () => ({ status: '0', message: `bad key ${KEY}`, result: KEY })
    });
    const { getTreasuryTokenTxs } = await import(
      '../../../../../server/modules/admin/etherscan/services/treasury-token-txs.js'
    );
    const data = await getTreasuryTokenTxs({}, { apiKey: KEY, fetchImpl });
    expect(JSON.stringify(data)).not.toMatch(KEY);
  });

  it('fetch rejeitado → 502 sem chave na mensagem', async () => {
    const fetchImpl = async (url: string) => {
      throw new Error(`connect ${url}`);
    };
    const { getTreasuryTokenTxs } = await import(
      '../../../../../server/modules/admin/etherscan/services/treasury-token-txs.js'
    );
    try {
      await getTreasuryTokenTxs({}, { apiKey: KEY, fetchImpl });
      throw new Error('expected');
    } catch (e: any) {
      expect(e.statusCode).toBe(502);
      expect(e.jsonBody.error).toBe('Falha ao contactar Etherscan.');
      expect(JSON.stringify(e.jsonBody)).not.toMatch(KEY);
    }
  });

  it('abort/timeout → 502', async () => {
    const fetchImpl = async (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<never>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    const { getTreasuryTokenTxs } = await import(
      '../../../../../server/modules/admin/etherscan/services/treasury-token-txs.js'
    );
    try {
      await getTreasuryTokenTxs({}, { apiKey: KEY, fetchImpl, timeoutMs: 15 });
      throw new Error('expected');
    } catch (e: any) {
      expect(e.statusCode).toBe(502);
    }
  });
});
