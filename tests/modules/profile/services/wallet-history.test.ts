import { describe, expect, it } from 'vitest';
import { normalizeWalletCompareKey, tryNormalizeWallet } from '../../../../server/modules/profile/services/wallet-history.js';

const VALID_ADDR_LOWER = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';

describe('tryNormalizeWallet', () => {
  it('null/vazio/"0x"/"null" devolvem null', () => {
    expect(tryNormalizeWallet(null)).toBeNull();
    expect(tryNormalizeWallet('')).toBeNull();
    expect(tryNormalizeWallet('0x')).toBeNull();
    expect(tryNormalizeWallet('null')).toBeNull();
  });

  it('normaliza endereço válido pro formato checksum', () => {
    const normalized = tryNormalizeWallet(VALID_ADDR_LOWER);
    expect(normalized).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('endereço inválido cai no fallback de texto truncado', () => {
    expect(tryNormalizeWallet('nao-e-endereco')).toBe('nao-e-endereco');
  });
});

describe('normalizeWalletCompareKey', () => {
  it('mesma carteira em casing diferente gera a mesma chave', () => {
    const a = normalizeWalletCompareKey(VALID_ADDR_LOWER);
    const b = normalizeWalletCompareKey(VALID_ADDR_LOWER.toUpperCase().replace('0X', '0x'));
    expect(a).toBe(b);
  });

  it('vazio gera chave vazia', () => {
    expect(normalizeWalletCompareKey(null)).toBe('');
  });
});
