import { describe, expect, it } from 'vitest';
import {
  parseTransparencyHealthSettings,
  TRANSPARENCY_HEALTH_SETTINGS_DEFAULTS,
  type TransparencyHealthSettings
} from '../../../client/src/shared/api/admin-legacy';

const D = TRANSPARENCY_HEALTH_SETTINGS_DEFAULTS;

describe('parseTransparencyHealthSettings', () => {
  it('defaults reproduzem o comportamento histórico', () => {
    expect(D.weightInflow).toBe(0.4);
    expect(D.weightRent).toBe(0.35);
    expect(D.weightLedger).toBe(0.25);
    expect(D.floor).toBe(50);
    // all_time = o que o índice fazia antes; mudar para 'season' é acção deliberada.
    expect(D.periodScope).toBe('all_time');
    expect(D.overrideEnabled).toBe(false);
    expect(D.overrideValue).toBeNull();
  });

  it('resposta vazia ou lixo cai nos defaults sem lançar', () => {
    expect(parseTransparencyHealthSettings(null)).toEqual(D);
    expect(parseTransparencyHealthSettings(undefined)).toEqual(D);
    expect(parseTransparencyHealthSettings({})).toEqual(D);
    expect(parseTransparencyHealthSettings('nope' as unknown)).toEqual(D);
  });

  it('lê uma resposta completa do servidor', () => {
    const parsed = parseTransparencyHealthSettings({
      weightInflow: 0.5,
      weightRent: 0.3,
      weightLedger: 0.2,
      floor: 0,
      seasonStartMs: 1788220800000,
      periodScope: 'season',
      countUndated: false,
      overrideEnabled: true,
      overrideValue: 72,
      updatedAt: 1789000000000,
      updatedBy: '42'
    });
    expect(parsed).toEqual({
      weightInflow: 0.5,
      weightRent: 0.3,
      weightLedger: 0.2,
      floor: 0,
      seasonStartMs: 1788220800000,
      periodScope: 'season',
      countUndated: false,
      overrideEnabled: true,
      overrideValue: 72,
      updatedAt: 1789000000000,
      updatedBy: '42'
    });
  });

  it('âmbito de período desconhecido não passa', () => {
    expect(parseTransparencyHealthSettings({ periodScope: 'sempre' }).periodScope).toBe(D.periodScope);
    expect(parseTransparencyHealthSettings({ periodScope: 42 }).periodScope).toBe(D.periodScope);
    for (const scope of ['season', 'all_time', 'current_month'] as const) {
      expect(parseTransparencyHealthSettings({ periodScope: scope }).periodScope).toBe(scope);
    }
  });

  it('números inválidos não contaminam o formulário', () => {
    const parsed = parseTransparencyHealthSettings({
      weightInflow: 'abc',
      weightRent: null,
      weightLedger: NaN,
      floor: 'x'
    });
    expect(parsed.weightInflow).toBe(D.weightInflow);
    expect(parsed.weightRent).toBe(D.weightRent);
    expect(parsed.weightLedger).toBe(D.weightLedger);
    expect(parsed.floor).toBe(D.floor);
  });

  it('aceita números com vírgula decimal e arredonda inteiros', () => {
    const parsed = parseTransparencyHealthSettings({ weightInflow: '0,45', floor: '49.6' });
    expect(parsed.weightInflow).toBeCloseTo(0.45, 10);
    expect(parsed.floor).toBe(50);
  });

  it('overrideValue distingue ausente/null de zero', () => {
    expect(parseTransparencyHealthSettings({ overrideValue: null }).overrideValue).toBeNull();
    expect(parseTransparencyHealthSettings({}).overrideValue).toBeNull();
    expect(parseTransparencyHealthSettings({ overrideValue: 0 }).overrideValue).toBe(0);
    expect(parseTransparencyHealthSettings({ overrideValue: 72 }).overrideValue).toBe(72);
  });

  it('updatedBy não numérico/ausente vira null', () => {
    expect(parseTransparencyHealthSettings({ updatedBy: 99 }).updatedBy).toBeNull();
    expect(parseTransparencyHealthSettings({ updatedBy: 'admin-7' }).updatedBy).toBe('admin-7');
  });

  it('o fallback pode ser o estado atual do formulário (echo parcial do servidor)', () => {
    const current: TransparencyHealthSettings = {
      ...D,
      weightInflow: 0.6,
      weightRent: 0.2,
      weightLedger: 0.2,
      periodScope: 'season'
    };
    const parsed = parseTransparencyHealthSettings({ floor: 10 }, current);
    expect(parsed.weightInflow).toBe(0.6);
    expect(parsed.periodScope).toBe('season');
    expect(parsed.floor).toBe(10);
  });
});

describe('regra de gravação: soma dos pesos', () => {
  // Espelha a validação do servidor (`WEIGHT_SUM_EPSILON`) e o gating do botão Guardar.
  const sumOk = (s: TransparencyHealthSettings) =>
    Math.abs(s.weightInflow + s.weightRent + s.weightLedger - 1) <= 1e-3;

  it('os defaults somam 1', () => {
    expect(sumOk(D)).toBe(true);
  });

  it('pesos que não somam 1 são rejeitados', () => {
    expect(sumOk({ ...D, weightInflow: 0.5, weightRent: 0.5, weightLedger: 0.5 })).toBe(false);
    expect(sumOk({ ...D, weightInflow: 0, weightRent: 0, weightLedger: 0 })).toBe(false);
  });

  it('tolera ruído de vírgula flutuante', () => {
    expect(sumOk({ ...D, weightInflow: 0.3333, weightRent: 0.3333, weightLedger: 0.3334 })).toBe(true);
  });
});
