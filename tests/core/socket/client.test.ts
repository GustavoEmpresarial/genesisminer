import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('core/socket/client', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('getSocketIo devolve null antes de qualquer setSocketIo', async () => {
    const { getSocketIo } = await import('../../../server/core/socket/client.js');
    expect(getSocketIo()).toBeNull();
  });

  it('setSocketIo grava a instância, getSocketIo devolve a mesma referência', async () => {
    const { setSocketIo, getSocketIo } = await import('../../../server/core/socket/client.js');
    const fakeIo = { emit: vi.fn() } as any;
    setSocketIo(fakeIo);
    expect(getSocketIo()).toBe(fakeIo);
  });

  it('setSocketIo(null) limpa o singleton', async () => {
    const { setSocketIo, getSocketIo } = await import('../../../server/core/socket/client.js');
    setSocketIo({ emit: vi.fn() } as any);
    setSocketIo(null);
    expect(getSocketIo()).toBeNull();
  });
});
