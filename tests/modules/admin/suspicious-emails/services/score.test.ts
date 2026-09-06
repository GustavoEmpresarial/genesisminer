import { describe, expect, it } from 'vitest';
import { calculateUserSuspicionScore } from '../../../../../server/modules/admin/suspicious-emails/services/score.js';

describe('admin/suspicious-emails services/score', () => {
  it('sem motivos: score 0, riskLevel minimal', () => {
    expect(calculateUserSuspicionScore([])).toEqual({ score: 0, riskLevel: 'minimal' });
  });

  it('soma pesos sem duplicar o mesmo motivo repetido', () => {
    const out = calculateUserSuspicionScore(['no_wallet', 'no_wallet']);
    expect(out.score).toBe(15);
  });

  it('temporary_domain (60) sozinho já cruza pro nível medium', () => {
    const out = calculateUserSuspicionScore(['temporary_domain']);
    expect(out.score).toBe(60);
    expect(out.riskLevel).toBe('medium');
  });

  it('combinação que soma >= 80 vira high', () => {
    const out = calculateUserSuspicionScore(['temporary_domain', 'fake_pattern']);
    expect(out.score).toBe(105);
    expect(out.riskLevel).toBe('high');
  });

  it('motivo desconhecido não conta pontos', () => {
    const out = calculateUserSuspicionScore(['motivo_inexistente']);
    expect(out.score).toBe(0);
  });
});
