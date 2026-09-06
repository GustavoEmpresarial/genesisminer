import { describe, expect, it } from 'vitest';
import { daysBetweenUtc, parseDistributionDateMs, utcDayEndMsFromTs, utcDayStartMsFromTs, ymdFromUtcMs } from '../../../../../server/modules/admin/mining-distribution/services/dates.js';

describe('admin/mining-distribution services/dates', () => {
  describe('parseDistributionDateMs', () => {
    it('aceita ms numérico ou string numérica', () => {
      expect(parseDistributionDateMs(1000)).toBe(1000);
      expect(parseDistributionDateMs('1000')).toBe(1000);
    });

    it('aceita YYYY-MM-DD como meia-noite UTC', () => {
      expect(parseDistributionDateMs('2026-01-15')).toBe(Date.parse('2026-01-15T00:00:00.000Z'));
    });

    it('null/vazio/inválido devolve null', () => {
      expect(parseDistributionDateMs(null)).toBeNull();
      expect(parseDistributionDateMs('')).toBeNull();
      expect(parseDistributionDateMs('lixo-nao-parseavel-!!!')).toBeNull();
    });
  });

  describe('utcDayStartMsFromTs / utcDayEndMsFromTs', () => {
    it('calcula início e fim do dia UTC', () => {
      const mid = Date.parse('2026-03-10T14:30:00.000Z');
      expect(utcDayStartMsFromTs(mid)).toBe(Date.parse('2026-03-10T00:00:00.000Z'));
      expect(utcDayEndMsFromTs(mid)).toBe(Date.parse('2026-03-10T23:59:59.999Z'));
    });
  });

  describe('ymdFromUtcMs', () => {
    it('formata YYYY-MM-DD em UTC', () => {
      expect(ymdFromUtcMs(Date.parse('2026-01-05T23:59:59.000Z'))).toBe('2026-01-05');
    });
  });

  describe('daysBetweenUtc', () => {
    it('mesmo dia devolve 1', () => {
      const t = Date.parse('2026-01-01T05:00:00.000Z');
      expect(daysBetweenUtc(t, t)).toBe(1);
    });

    it('7 dias corridos devolve 8 (inclusive nas duas pontas)', () => {
      const from = Date.parse('2026-01-01T00:00:00.000Z');
      const to = Date.parse('2026-01-08T00:00:00.000Z');
      expect(daysBetweenUtc(from, to)).toBe(8);
    });
  });
});
