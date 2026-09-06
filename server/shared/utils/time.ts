/**
 * Constantes de conversão de tempo — única fonte de verdade pra "quantos ms tem
 * 1 minuto/hora/dia" em vez de cada arquivo repetir `60 * 1000` como número
 * solto (número mágico). Qualquer cálculo de duração no projeto (throttle,
 * backoff, lease, cron) deve importar daqui, não reinventar.
 */
/* eslint-disable no-magic-numbers -- estas são as próprias definições de unidade de tempo
   (1000ms/s, 60s/min, 60min/h) — não têm "constante mais nomeada" possível, são a raiz. */

/** 1 segundo em milissegundos. */
export const MS_PER_SECOND = 1000;

/** 1 minuto em milissegundos (60s). */
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;

/** 1 hora em milissegundos (60min). */
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** 1 dia em milissegundos (24h). Semana/mês/ano não entram aqui de propósito:
 *  mês e ano não têm duração fixa em ms (calendário) — cada consumidor que
 *  precisar de uma aproximação (ex. `lease-duration.ts`) declara a própria
 *  constante de dias-por-mês/ano, nomeada e documentada como aproximação. */
export const MS_PER_DAY = 24 * MS_PER_HOUR;
/* eslint-enable no-magic-numbers */
