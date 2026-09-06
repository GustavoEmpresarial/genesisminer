/**
 * Escrita de mining coins — contrato real: POST /api/mining-coins (upsert).
 * Não há DELETE; inativação = mesmo POST com isActive: false.
 */
export const MINING_COINS_WRITE_PATH = '/api/mining-coins';

export type MiningCoinWriteResult = { ok: boolean; id?: string; error?: string };

export async function inactivateMiningCoin(
  id: string,
  deps: {
    loadCoins: () => Promise<Array<{ id?: string } & Record<string, unknown>>>;
    saveCoin: (coin: Record<string, unknown>) => Promise<MiningCoinWriteResult>;
  }
): Promise<MiningCoinWriteResult> {
  const trimmed = String(id || '').trim();
  if (!trimmed) return { ok: false, error: 'id da moeda é obrigatório.' };
  let coins: Array<{ id?: string } & Record<string, unknown>>;
  try {
    coins = await deps.loadCoins();
  } catch (e) {
    const msg = e instanceof Error ? e.message.trim() : '';
    return { ok: false, error: msg || 'Erro de API ao carregar moedas.' };
  }
  const coin = coins.find((c) => String(c.id) === trimmed);
  if (!coin) return { ok: false, error: 'Moeda não encontrada.' };
  return deps.saveCoin({ ...coin, isActive: false });
}
