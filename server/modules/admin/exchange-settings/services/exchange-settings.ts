/**
 * GET/POST `/api/exchange-settings` (AdminExchange).
 *
 * Só tabela `settings` KV: `exchange_min_usdc`, `exchange_fee_percent`.
 * Sem linha `economy_settings`. Semântica do legado (`legacy/backend/server.ts`):
 *
 * GET (público): chave ausente/'' → min 0.1, fee 0. Sem clamp.
 * POST (super): min = max(0, Number||0); fee clamp [0,100]; upsert atómico via
 * `upsertSettingsEntries`.
 *
 * O jogador lê as mesmas chaves em `wallet-state` / liquidate com regras
 * próprias — esta tarefa não as altera.
 */
import { HttpControlledError } from '../../../../shared/errors/http-controlled-error.js';
import { getSettingsRecord, upsertSettingsEntries } from '../../../../shared/settings/settings-repository.js';

const HTTP_BAD_REQUEST = 400;
const MIN_DEFAULT = 0.1;
const FEE_DEFAULT = 0;
const FEE_MAX = 100;

export const EXCHANGE_SETTINGS_KV_KEYS = ['exchange_min_usdc', 'exchange_fee_percent'] as const;

export type ExchangeSettingsDto = {
  minExchangeAmount: number;
  exchangeFeePercent: number;
};

function kvPresent(v: string | undefined): boolean {
  return v != null && v !== '';
}

/** Contrato GET — Number() cru quando a chave existe (NaN possível, como o legado). */
export function mapExchangeSettingsFromKv(kv: Record<string, string>): ExchangeSettingsDto {
  const min = kvPresent(kv.exchange_min_usdc) ? Number(kv.exchange_min_usdc) : MIN_DEFAULT;
  const fee = kvPresent(kv.exchange_fee_percent) ? Number(kv.exchange_fee_percent) : FEE_DEFAULT;
  return { minExchangeAmount: min, exchangeFeePercent: fee };
}

export async function loadExchangeSettings(): Promise<ExchangeSettingsDto> {
  const kv = await getSettingsRecord([...EXCHANGE_SETTINGS_KV_KEYS]);
  return mapExchangeSettingsFromKv(kv);
}

export function planExchangeSettingsPersist(body: unknown): { min: number; fee: number } {
  if (body != null && (typeof body !== 'object' || Array.isArray(body))) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Invalid payload.' });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const min = Math.max(0, Number(b.minExchangeAmount) || 0);
  const fee = Math.max(0, Math.min(FEE_MAX, Number(b.exchangeFeePercent) || 0));
  return { min, fee };
}

export async function persistExchangeSettings(body: unknown): Promise<{ ok: true }> {
  const { min, fee } = planExchangeSettingsPersist(body);
  await upsertSettingsEntries([
    { key: 'exchange_min_usdc', value: String(min) },
    { key: 'exchange_fee_percent', value: String(fee) }
  ]);
  return { ok: true };
}
