/**
 * GET/POST de monetização (Applixir / Ezoic) na tabela `settings`.
 *
 * Migrado de `legacy/backend/server.ts` (`fetchMonetizationSettingsObject`).
 * GET público omite `applixirCallbackSecret`. GET admin devolve o secret
 * (contrato do painel). POST grava KV via `upsertSettingsEntries`.
 */
import { getSettingsRecord, upsertSettingsEntries } from '../../../../shared/settings/settings-repository.js';

export const MONETIZATION_SETTINGS_KV_KEYS = [
  'applixir_enabled',
  'applixir_site_id',
  'applixir_zone_id',
  'applixir_account_id',
  'applixir_reward_message',
  'applixir_callback_secret',
  'ezoic_enabled',
  'ezoic_publisher_id',
  'ezoic_app_id',
  'ezoic_placeholder_id'
] as const;

export const DEFAULT_APPLIXIR_REWARD_MESSAGE = 'Parabéns! Você ganhou {reward} W/h';

export type MonetizationSettingsDto = {
  applixirEnabled: boolean;
  applixirSiteId: string;
  applixirZoneId: string;
  applixirAccountId: string;
  applixirRewardMessage: string;
  applixirCallbackSecret: string;
  ezoicEnabled: boolean;
  ezoicPublisherId: string;
  ezoicAppId: string;
  ezoicPlaceholderId: string;
};

export type PublicMonetizationSettingsDto = Omit<MonetizationSettingsDto, 'applixirCallbackSecret'>;

export function mapMonetizationSettingsFromKv(s: Record<string, string>): MonetizationSettingsDto {
  return {
    applixirEnabled: s.applixir_enabled === '1',
    applixirSiteId: s.applixir_site_id || '',
    applixirZoneId: s.applixir_zone_id || '',
    applixirAccountId: s.applixir_account_id || '',
    applixirRewardMessage: s.applixir_reward_message || DEFAULT_APPLIXIR_REWARD_MESSAGE,
    applixirCallbackSecret: s.applixir_callback_secret || '',
    ezoicEnabled: s.ezoic_enabled === '1',
    ezoicPublisherId: s.ezoic_publisher_id || '',
    ezoicAppId: s.ezoic_app_id || '',
    ezoicPlaceholderId: s.ezoic_placeholder_id || ''
  };
}

export function toPublicMonetizationSettings(full: MonetizationSettingsDto): PublicMonetizationSettingsDto {
  const { applixirCallbackSecret: _omit, ...publicSettings } = full;
  return publicSettings;
}

export function planMonetizationSettingsPersist(body: unknown): Array<{ key: string; value: string }> {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const reward =
    typeof b.applixirRewardMessage === 'string' ? b.applixirRewardMessage : DEFAULT_APPLIXIR_REWARD_MESSAGE;
  const secret = typeof b.applixirCallbackSecret === 'string' ? b.applixirCallbackSecret : '';
  return [
    { key: 'applixir_enabled', value: b.applixirEnabled ? '1' : '0' },
    { key: 'applixir_site_id', value: String(b.applixirSiteId || '') },
    { key: 'applixir_zone_id', value: String(b.applixirZoneId || '') },
    { key: 'applixir_account_id', value: String(b.applixirAccountId || '') },
    { key: 'applixir_reward_message', value: reward },
    { key: 'applixir_callback_secret', value: secret },
    { key: 'ezoic_enabled', value: b.ezoicEnabled ? '1' : '0' },
    { key: 'ezoic_publisher_id', value: String(b.ezoicPublisherId || '') },
    { key: 'ezoic_app_id', value: String(b.ezoicAppId || '') },
    { key: 'ezoic_placeholder_id', value: String(b.ezoicPlaceholderId || '') }
  ];
}

export async function loadMonetizationSettings(): Promise<MonetizationSettingsDto> {
  const kv = await getSettingsRecord([...MONETIZATION_SETTINGS_KV_KEYS]);
  return mapMonetizationSettingsFromKv(kv);
}

export async function persistMonetizationSettings(body: unknown): Promise<{ ok: true }> {
  await upsertSettingsEntries(planMonetizationSettingsPersist(body));
  return { ok: true };
}
