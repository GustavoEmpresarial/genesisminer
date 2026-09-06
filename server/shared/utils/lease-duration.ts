/**
 * Configuração de validade (amount+unit) pra qualquer coisa "alugada por
 * tempo" (máquina temporária/ASIC, boost, etc.) — parsing, normalização e
 * formatação de label em pt-BR. Funções puras, sem I/O.
 *
 * Migrado de legacy/backend/lib/asicLease.ts — só as funções puras de
 * configuração/formatação de duração. O arquivo original (736 linhas)
 * também tinha a criação real de registros `player_asic_leases` — isso é
 * lógica de domínio (grava no banco, decide regras de negócio de
 * upgrade/servidor), então mora em `modules/upgrades`/`modules/servers`,
 * não aqui; ver docs/development/backend/MIGRATION_TRACKER.md.
 */
import { MS_PER_DAY } from './time.js';

/** Dias por semana — exato, não aproximação. */
const DAYS_PER_WEEK = 7;

/** Aproximação de dias por mês usada para converter "N meses" em ms. Não
 *  considera meses de 28/29/30/31 dias — é deliberadamente uma aproximação
 *  fixa (mesma usada no legado), suficiente para prazo de aluguel/boost, não
 *  para cálculo de calendário exato. */
const DAYS_PER_MONTH_APPROX = 30;

/** Aproximação de dias por ano (não considera ano bissexto) — mesma lógica
 *  de `DAYS_PER_MONTH_APPROX`. */
const DAYS_PER_YEAR_APPROX = 365;

/** Formato legado (dropdown antigo de "tipo de duração"). Leitura de dados
 *  antigos ainda passa por aqui; escrita nova prefere `amount`+`unit`. */
export const ASIC_DURATION_KINDS = ['none', 'daily', 'weekly', 'monthly', 'annual'] as const;
export type AsicDurationKind = (typeof ASIC_DURATION_KINDS)[number];

/** Unidade de duração no formato atual (`amount` + `unit`). */
export const ASIC_DURATION_UNITS = ['day', 'week', 'month', 'year'] as const;
export type AsicDurationUnit = (typeof ASIC_DURATION_UNITS)[number];

/** Configuração normalizada de duração. `unit: null` (com `amount` 0)
 *  significa "sem prazo" (permanente) — ver {@link isTimedAsicDuration}. */
export type AsicDurationConfig = {
  amount: number;
  unit: AsicDurationUnit | null;
};

/**
 * Normaliza uma unidade de duração vinda de fonte não confiável (form,
 * body de request, coluna legada) para o enum canônico `AsicDurationUnit`.
 * Aceita variações em inglês/português, singular/plural, case-insensitive.
 *
 * @returns A unidade canônica, ou `null` se não reconhecida.
 */
export function normalizeAsicDurationUnit(raw: unknown): AsicDurationUnit | null {
  const u = String(raw ?? '').trim().toLowerCase();
  if (u === 'day' || u === 'days' || u === 'dia' || u === 'dias') return 'day';
  if (u === 'week' || u === 'weeks' || u === 'semana' || u === 'semanas') return 'week';
  if (u === 'month' || u === 'months' || u === 'mes' || u === 'meses') return 'month';
  if (u === 'year' || u === 'years' || u === 'ano' || u === 'anos') return 'year';
  return null;
}

/**
 * Normaliza um "tipo de duração" no formato legado (dropdown antigo).
 * Diferente de {@link normalizeAsicDurationUnit}, sempre devolve um valor
 * válido: cai em `'none'` para qualquer entrada não reconhecida.
 */
export function normalizeAsicDurationKind(raw: unknown): AsicDurationKind {
  const k = String(raw ?? 'none').trim().toLowerCase();
  if ((ASIC_DURATION_KINDS as readonly string[]).includes(k)) return k as AsicDurationKind;
  return 'none';
}

/**
 * Resolve a configuração de validade final a partir da entrada bruta,
 * priorizando o formato atual (`amount`+`unit`) e caindo para o formato
 * legado (`kind`) só quando `amount`/`unit` não formam uma duração válida —
 * assim registros antigos (só `kind`) continuam funcionando sem migração de
 * dado, e registros novos (`amount`+`unit`) não são reinterpretados por engano.
 *
 * @param raw - `amount`/`unit` no formato atual, e/ou `kind` no formato legado.
 * @returns Configuração normalizada; `{ amount: 0, unit: null }` = sem prazo.
 */
export function normalizeAsicDurationConfig(raw: { amount?: unknown; unit?: unknown; kind?: unknown }): AsicDurationConfig {
  const amount = Math.floor(Number(raw.amount) || 0);
  const unit = normalizeAsicDurationUnit(raw.unit);
  if (amount > 0 && unit) return { amount, unit };

  switch (normalizeAsicDurationKind(raw.kind)) {
    case 'daily':
      return { amount: 1, unit: 'day' };
    case 'weekly':
      return { amount: 1, unit: 'week' };
    case 'monthly':
      return { amount: 1, unit: 'month' };
    case 'annual':
      return { amount: 1, unit: 'year' };
    default:
      return { amount: 0, unit: null };
  }
}

/** Devolve `true` se `cfg` representa uma duração com prazo real (não permanente). */
export function isTimedAsicDuration(cfg: AsicDurationConfig): boolean {
  return cfg.amount > 0 && cfg.unit != null;
}

/**
 * Converte a configuração de duração para milissegundos, prontos para somar
 * a um timestamp de início e obter a data de expiração.
 *
 * @returns `0` quando `cfg` não é uma duração temporizada (permanente).
 */
export function durationMsForConfig(cfg: AsicDurationConfig): number {
  if (!isTimedAsicDuration(cfg)) return 0;
  const { amount, unit } = cfg;
  switch (unit) {
    case 'day':
      return amount * MS_PER_DAY;
    case 'week':
      return amount * DAYS_PER_WEEK * MS_PER_DAY;
    case 'month':
      return amount * DAYS_PER_MONTH_APPROX * MS_PER_DAY;
    case 'year':
      return amount * DAYS_PER_YEAR_APPROX * MS_PER_DAY;
    default:
      return 0;
  }
}

/**
 * Formata a duração como texto legível em português (ex.: "7 dias",
 * "1 mês"), com singular/plural correto.
 *
 * @returns `'Permanente'` quando `cfg` não é uma duração temporizada.
 */
export function formatAsicDurationLabelPt(cfg: AsicDurationConfig): string {
  if (!isTimedAsicDuration(cfg)) return 'Permanente';
  const n = cfg.amount;
  const unit = cfg.unit as AsicDurationUnit;
  const labelsByUnit: Record<AsicDurationUnit, [singular: string, plural: string]> = {
    day: ['dia', 'dias'],
    week: ['semana', 'semanas'],
    month: ['mês', 'meses'],
    year: ['ano', 'anos']
  };
  const [singular, plural] = labelsByUnit[unit];
  return `${n} ${n === 1 ? singular : plural}`;
}
