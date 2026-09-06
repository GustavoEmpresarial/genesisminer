import { describe, expect, it } from 'vitest';
import { asNum, clamp, clampPage, csvCell, parseDateMs, toMs } from '../../../../../server/modules/admin/referral/services/format.js';

describe('admin/referral services/format', () => {
  describe('clamp / clampPage', () => {
    it('clampa dentro do intervalo, usa default se não-finito', () => {
      expect(clamp(5, 1, 10)).toBe(5);
      expect(clamp(-5, 1, 10)).toBe(1);
      expect(clamp(50, 1, 10)).toBe(10);
      expect(clamp(NaN, 1, 10)).toBe(1);
    });

    it('clampPage aplica o teto fixo de 99999', () => {
      expect(clampPage(999999, 1)).toBe(99999);
    });
  });

  describe('parseDateMs', () => {
    it('aceita ms numérico, string numérica, data ISO', () => {
      expect(parseDateMs(1000)).toBe(1000);
      expect(parseDateMs('1000')).toBe(1000);
      expect(parseDateMs('2026-01-01T00:00:00.000Z')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    });

    it('null/vazio/inválido devolve null', () => {
      expect(parseDateMs(null)).toBeNull();
      expect(parseDateMs('')).toBeNull();
      expect(parseDateMs('lixo-invalido-!!!')).toBeNull();
    });
  });

  describe('asNum', () => {
    it('converte number/string/bigint, devolve 0 se inválido/null', () => {
      expect(asNum(5)).toBe(5);
      expect(asNum('5.5')).toBe(5.5);
      expect(asNum(10n)).toBe(10);
      expect(asNum(null)).toBe(0);
      expect(asNum('lixo')).toBe(0);
    });
  });

  describe('toMs', () => {
    it('converte bigint/number/string pra number, 0 se inválido', () => {
      expect(toMs(100n)).toBe(100);
      expect(toMs(100)).toBe(100);
      expect(toMs('100')).toBe(100);
      expect(toMs(null)).toBe(0);
      expect(toMs('lixo')).toBe(0);
    });
  });

  describe('csvCell', () => {
    it('escapa aspas/vírgulas/quebras de linha entre aspas duplas', () => {
      expect(csvCell('a,b')).toBe('"a,b"');
      expect(csvCell('a"b')).toBe('"a""b"');
      expect(csvCell('a\nb')).toBe('"a\nb"');
    });

    it('valor simples fica sem aspas, null vira string vazia', () => {
      expect(csvCell('abc')).toBe('abc');
      expect(csvCell(null)).toBe('');
    });
  });
});
