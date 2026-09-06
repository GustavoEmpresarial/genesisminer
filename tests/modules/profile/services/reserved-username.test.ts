import { describe, expect, it } from 'vitest';
import { isReservedProfileUsername, stripInvisibleUsernameChars } from '../../../../server/modules/profile/services/reserved-username.js';

describe('isReservedProfileUsername', () => {
  it('rejeita nomes reservados exatos (case-insensitive)', () => {
    expect(isReservedProfileUsername('Admin')).toBe(true);
    expect(isReservedProfileUsername('SUPORTE')).toBe(true);
  });

  it('rejeita variações compactas (sem espaço/underscore/hífen)', () => {
    expect(isReservedProfileUsername('genesis-miner')).toBe(true);
    expect(isReservedProfileUsername('genesisminer')).toBe(true);
  });

  it('rejeita nome que começa com reservado + separador', () => {
    expect(isReservedProfileUsername('admin_oficial')).toBe(true);
    expect(isReservedProfileUsername('root-user')).toBe(true);
  });

  it('rejeita vazio', () => {
    expect(isReservedProfileUsername('')).toBe(true);
  });

  it('aceita nome normal', () => {
    expect(isReservedProfileUsername('jogador123')).toBe(false);
  });
});

describe('stripInvisibleUsernameChars', () => {
  it('remove zero-width space e BOM', () => {
    const zwsp = String.fromCharCode(0x200b);
    const bom = String.fromCharCode(0xfeff);
    expect(stripInvisibleUsernameChars(`a${zwsp}b${bom}c`)).toBe('abc');
  });

  it('não mexe em texto normal', () => {
    expect(stripInvisibleUsernameChars('jogador 123')).toBe('jogador 123');
  });
});
