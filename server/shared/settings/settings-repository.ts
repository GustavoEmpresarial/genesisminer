/**
 * Repositório genérico de configuração key-value (tabela `settings`) — usado
 * por qualquer módulo que precise de flags/parâmetros editáveis pelo admin
 * em tempo real, sem precisar de deploy nem migration de banco nova.
 *
 * Não é config de ambiente/processo (isso é `.env`/`process.env`) — é estado
 * de negócio ajustável em runtime: liga/desliga de mercado, valores de
 * recompensa, parâmetros de carteira, etc. Cada chave é uma string livre
 * (namespaced por convenção do módulo consumidor, ex.
 * `hardware_market_open`), o valor é sempre string — conversão pro tipo
 * final (número, boolean, JSON) é responsabilidade de quem chama.
 *
 * Consumidores atuais: `modules/checkin` (parâmetros de recompensa),
 * `modules/shop` (liga/desliga do mercado de hardware), `modules/wallet`
 * (parâmetros de carteira/saque), `modules/admin/security-bulk` (flags de
 * bloqueio em massa).
 *
 * Migrado de legacy/backend/lib/settingsPrisma.ts (sem mudança de comportamento).
 */
import { prisma } from '../../core/database/prisma.js';

/**
 * Lê o valor de uma chave de configuração.
 *
 * @returns O valor (string), ou `null` se a chave não existir.
 */
export async function getSettingValue(key: string): Promise<string | null> {
  const row = await prisma.settings.findUnique({ where: { key }, select: { value: true } });
  return row?.value ?? null;
}

/**
 * Lê várias chaves de configuração numa única consulta.
 *
 * Deduplica `keys` e descarta entradas vazias/inválidas antes de consultar;
 * se sobrar lista vazia (ou `keys` já vier vazio), devolve `{}` sem tocar
 * no banco — evita um `findMany` com `IN ()` desnecessário.
 *
 * @param keys - Chaves a buscar.
 * @returns Mapa chave→valor. Chaves em falta na BD simplesmente não
 *   aparecem no resultado (comportamento equivalente a `WHERE key = ANY(...)`,
 *   não lança nem preenche com `null`) — quem chama decide o default.
 */
export async function getSettingsRecord(keys: readonly string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const uniqueValidKeys = [...new Set(keys.filter((k) => typeof k === 'string' && k.length > 0))];
  if (uniqueValidKeys.length === 0) return {};
  const rows = await prisma.settings.findMany({
    where: { key: { in: uniqueValidKeys } },
    select: { key: true, value: true }
  });
  const settingsByKey: Record<string, string> = {};
  for (const row of rows) settingsByKey[row.key] = row.value;
  return settingsByKey;
}

/**
 * Cria ou atualiza várias chaves de configuração numa única transação —
 * ou tudo grava, ou nada grava (evita o admin salvar um formulário de
 * configuração e ficar com metade das chaves antigas, metade novas, se
 * uma escrita falhar no meio).
 *
 * @param entries - Pares chave/valor a gravar. Lista vazia é no-op (não
 *   abre transação).
 */
export async function upsertSettingsEntries(entries: Array<{ key: string; value: string }>): Promise<void> {
  if (entries.length === 0) return;
  await prisma.$transaction(
    entries.map((entry) =>
      prisma.settings.upsert({
        where: { key: entry.key },
        create: { key: entry.key, value: entry.value },
        update: { value: entry.value }
      })
    )
  );
}
