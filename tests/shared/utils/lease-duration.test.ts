import { describe, expect, it } from 'vitest';
import { durationMsForConfig, formatAsicDurationLabelPt, isTimedAsicDuration, normalizeAsicDurationConfig, normalizeAsicDurationKind, normalizeAsicDurationUnit } from '../../../server/shared/utils/lease-duration.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('shared/utils/lease-duration', () => {
  describe('normalizeAsicDurationUnit', () => {
    it('reconhece variantes em pt/en', () => {
      expect(normalizeAsicDurationUnit('dias')).toBe('day');
      expect(normalizeAsicDurationUnit('week')).toBe('week');
      expect(normalizeAsicDurationUnit('meses')).toBe('month');
      expect(normalizeAsicDurationUnit('years')).toBe('year');
    });

    it('devolve null pra valores desconhecidos', () => {
      expect(normalizeAsicDurationUnit('century')).toBeNull();
      expect(normalizeAsicDurationUnit(undefined)).toBeNull();
    });
  });

  describe('normalizeAsicDurationKind', () => {
    it('aceita só os kinds conhecidos, senão cai em none', () => {
      expect(normalizeAsicDurationKind('daily')).toBe('daily');
      expect(normalizeAsicDurationKind('bogus')).toBe('none');
      expect(normalizeAsicDurationKind(undefined)).toBe('none');
    });
  });

  describe('normalizeAsicDurationConfig', () => {
    it('amount+unit explícitos têm prioridade sobre kind', () => {
      expect(normalizeAsicDurationConfig({ amount: 3, unit: 'day', kind: 'monthly' })).toEqual({ amount: 3, unit: 'day' });
    });

    it('cai no kind quando amount/unit ausentes', () => {
      expect(normalizeAsicDurationConfig({ kind: 'weekly' })).toEqual({ amount: 1, unit: 'week' });
      expect(normalizeAsicDurationConfig({ kind: 'annual' })).toEqual({ amount: 1, unit: 'year' });
    });

    it('sem amount/unit/kind válido: { amount: 0, unit: null }', () => {
      expect(normalizeAsicDurationConfig({})).toEqual({ amount: 0, unit: null });
    });
  });

  describe('isTimedAsicDuration', () => {
    it('true só quando amount > 0 e unit definido', () => {
      expect(isTimedAsicDuration({ amount: 1, unit: 'day' })).toBe(true);
      expect(isTimedAsicDuration({ amount: 0, unit: null })).toBe(false);
      expect(isTimedAsicDuration({ amount: 5, unit: null })).toBe(false);
    });
  });

  describe('durationMsForConfig', () => {
    it('converte cada unidade pra ms usando os fatores aproximados (semana=7d, mês=30d, ano=365d)', () => {
      expect(durationMsForConfig({ amount: 2, unit: 'day' })).toBe(2 * MS_PER_DAY);
      expect(durationMsForConfig({ amount: 1, unit: 'week' })).toBe(7 * MS_PER_DAY);
      expect(durationMsForConfig({ amount: 1, unit: 'month' })).toBe(30 * MS_PER_DAY);
      expect(durationMsForConfig({ amount: 1, unit: 'year' })).toBe(365 * MS_PER_DAY);
    });

    it('permanente (amount=0/unit=null): 0', () => {
      expect(durationMsForConfig({ amount: 0, unit: null })).toBe(0);
    });
  });

  describe('formatAsicDurationLabelPt', () => {
    it('permanente: "Permanente"', () => {
      expect(formatAsicDurationLabelPt({ amount: 0, unit: null })).toBe('Permanente');
    });

    it('singular vs plural em cada unidade', () => {
      expect(formatAsicDurationLabelPt({ amount: 1, unit: 'day' })).toBe('1 dia');
      expect(formatAsicDurationLabelPt({ amount: 2, unit: 'day' })).toBe('2 dias');
      expect(formatAsicDurationLabelPt({ amount: 1, unit: 'month' })).toBe('1 mês');
      expect(formatAsicDurationLabelPt({ amount: 3, unit: 'month' })).toBe('3 meses');
    });
  });
});
