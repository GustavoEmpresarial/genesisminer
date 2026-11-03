import { describe, expect, it } from 'vitest';
import {
  isPrincipalPublicHost,
  PRINCIPAL_PUBLIC_HOST,
  resolveMaintenanceFlag,
  shouldBlockGameAndLanding
} from '../../../client/src/app/siteMaintenanceGate.js';

describe('resolveMaintenanceFlag', () => {
  it('liga se a sessão OU o site-status reportam manutenção', () => {
    expect(resolveMaintenanceFlag(undefined, undefined)).toBe(false);
    expect(resolveMaintenanceFlag(false, false)).toBe(false);
    expect(resolveMaintenanceFlag(true, false)).toBe(true);
    expect(resolveMaintenanceFlag(false, true)).toBe(true);
    expect(resolveMaintenanceFlag(true, true)).toBe(true);
  });
});

describe('isPrincipalPublicHost', () => {
  it('aceita o apex e www de genesisdao.tech', () => {
    expect(PRINCIPAL_PUBLIC_HOST).toBe('genesisdao.tech');
    expect(isPrincipalPublicHost('genesisdao.tech')).toBe(true);
    expect(isPrincipalPublicHost('www.genesisdao.tech')).toBe(true);
    expect(isPrincipalPublicHost('genesisdao.tech:443')).toBe(true);
  });

  it('rejeita staging e outros hosts', () => {
    expect(isPrincipalPublicHost('dev.genesisdao.tech')).toBe(false);
    expect(isPrincipalPublicHost('test.genesisdao.tech')).toBe(false);
    expect(isPrincipalPublicHost('localhost')).toBe(false);
  });
});

describe('shouldBlockGameAndLanding', () => {
  it('bloqueia jogador no site principal quando a manutenção está ligada', () => {
    expect(shouldBlockGameAndLanding(true, false, 'genesisdao.tech')).toBe(true);
  });

  it('não bloqueia staging mesmo com o kill-switch armado', () => {
    expect(shouldBlockGameAndLanding(true, false, 'dev.genesisdao.tech')).toBe(false);
  });

  it('admin passa mesmo com manutenção ligada no principal', () => {
    expect(shouldBlockGameAndLanding(true, true, 'genesisdao.tech')).toBe(false);
  });

  it('não bloqueia quando a manutenção está desligada', () => {
    expect(shouldBlockGameAndLanding(false, false, 'genesisdao.tech')).toBe(false);
    expect(shouldBlockGameAndLanding(false, true, 'genesisdao.tech')).toBe(false);
  });
});
