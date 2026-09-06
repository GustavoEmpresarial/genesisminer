import { describe, expect, it } from 'vitest';
import {
  detectSuspiciousEmail,
  getEmailDomain,
  isFakeEmailPattern,
  isInvalidEmailFormat,
  isProviderTypoDomain,
  isSuspiciousDomainHeuristic,
  isTemporaryEmailDomain,
  isTrustedEmailDomain,
  normalizeEmail
} from '../../../../../server/modules/admin/suspicious-emails/services/detect.js';

describe('admin/suspicious-emails services/detect', () => {
  describe('normalizeEmail / getEmailDomain', () => {
    it('normaliza para minúsculas sem espaços nas pontas', () => {
      expect(normalizeEmail('  Foo@Bar.COM  ')).toBe('foo@bar.com');
    });

    it('extrai o domínio em minúsculas', () => {
      expect(getEmailDomain('Foo@Bar.COM')).toBe('bar.com');
    });

    it('sem @ ou email null: devolve null', () => {
      expect(getEmailDomain('semarroba')).toBeNull();
      expect(getEmailDomain(null)).toBeNull();
      expect(getEmailDomain('foo@')).toBeNull();
    });
  });

  describe('isTrustedEmailDomain / isTemporaryEmailDomain', () => {
    it('gmail.com é confiável, mailinator.com é descartável', () => {
      expect(isTrustedEmailDomain('gmail.com')).toBe(true);
      expect(isTemporaryEmailDomain('mailinator.com')).toBe(true);
      expect(isTrustedEmailDomain('random-unknown.com')).toBe(false);
      expect(isTemporaryEmailDomain('gmail.com')).toBe(false);
    });
  });

  describe('isInvalidEmailFormat', () => {
    it('aceita email bem formado', () => {
      expect(isInvalidEmailFormat('user@example.com')).toBe(false);
    });

    it('rejeita null, vazio, sem @, múltiplos @, sem ponto no domínio', () => {
      expect(isInvalidEmailFormat(null)).toBe(true);
      expect(isInvalidEmailFormat('')).toBe(true);
      expect(isInvalidEmailFormat('semarroba.com')).toBe(true);
      expect(isInvalidEmailFormat('a@b@c.com')).toBe(true);
      expect(isInvalidEmailFormat('user@localhost')).toBe(true);
    });

    it('rejeita whitespace embutido e TLD inválido (curto demais ou com símbolo)', () => {
      expect(isInvalidEmailFormat('user name@example.com')).toBe(true);
      expect(isInvalidEmailFormat('user@example.c')).toBe(true);
      expect(isInvalidEmailFormat('user@example.c!m')).toBe(true);
    });

    it('rejeita local-part maior que 64 chars', () => {
      expect(isInvalidEmailFormat(`${'a'.repeat(65)}@example.com`)).toBe(true);
    });
  });

  describe('isProviderTypoDomain', () => {
    it('detecta typos conhecidos de domínios grandes', () => {
      expect(isProviderTypoDomain('gmial.com')).toBe(true);
      expect(isProviderTypoDomain('gmail.com')).toBe(false);
    });
  });

  describe('isFakeEmailPattern', () => {
    it('detecta email fake exacto, domínio example.*, prefixos no-reply', () => {
      expect(isFakeEmailPattern('test@test.com')).toBe(true);
      expect(isFakeEmailPattern('foo@example.com')).toBe(true);
      expect(isFakeEmailPattern('no-reply@empresa.com')).toBe(true);
      expect(isFakeEmailPattern('joao.silva@gmail.com')).toBe(false);
    });
  });

  describe('isSuspiciousDomainHeuristic', () => {
    it('domínio muito longo é suspeito', () => {
      expect(isSuspiciousDomainHeuristic('a'.repeat(40) + '.com')).toBe(true);
    });

    it('TLD raro e curto é suspeito', () => {
      expect(isSuspiciousDomainHeuristic('site.tk')).toBe(true);
    });

    it('domínio com muitos dígitos é suspeito', () => {
      expect(isSuspiciousDomainHeuristic('123456.com')).toBe(true);
    });

    it('domínio normal não é suspeito', () => {
      expect(isSuspiciousDomainHeuristic('empresa.com')).toBe(false);
    });
  });

  describe('detectSuspiciousEmail', () => {
    it('email inválido: só invalid_format, pára aí', () => {
      expect(detectSuspiciousEmail('lixo')).toEqual(['invalid_format']);
    });

    it('domínio temporário: temporary_domain + domain_not_trusted (mailinator não é confiável)', () => {
      const reasons = detectSuspiciousEmail('user@mailinator.com');
      expect(reasons).toContain('temporary_domain');
    });

    it('domínio confiável (gmail): não marca domain_not_trusted', () => {
      const reasons = detectSuspiciousEmail('joao@gmail.com');
      expect(reasons).not.toContain('domain_not_trusted');
    });

    it('email duplicado no contexto: marca duplicate_email', () => {
      const reasons = detectSuspiciousEmail('joao@gmail.com', { duplicateNormalizedEmails: new Set(['joao@gmail.com']) });
      expect(reasons).toContain('duplicate_email');
    });

    it('emailVerified false: marca unverified_email', () => {
      const reasons = detectSuspiciousEmail('joao@gmail.com', { emailVerified: false });
      expect(reasons).toContain('unverified_email');
    });

    it('alto volume + domínio temporário: marca suspicious_domain também', () => {
      const reasons = detectSuspiciousEmail('user@mailinator.com', { domainTotalCounts: new Map([['mailinator.com', 20]]), highVolumeDomainThreshold: 8 });
      expect(reasons).toContain('suspicious_domain');
    });
  });
});
