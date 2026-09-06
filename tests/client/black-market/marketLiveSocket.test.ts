import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MARKET_SOCKET_EVENT,
  MARKET_SOCKET_PATH,
  peekMarketLiveRefCountForTests,
  resetMarketLiveSharedForTests,
  subscribeMarketLive,
  type MarketLiveSocket
} from '../../../client/src/features/black-market/lib/marketLiveSocket.js';

function fakeSocket(init?: { connected?: boolean }): MarketLiveSocket & {
  handlers: Record<string, Set<(payload?: unknown) => void>>;
  emit: (ev: string, payload?: unknown) => void;
} {
  const handlers: Record<string, Set<(payload?: unknown) => void>> = {};
  const sock: MarketLiveSocket & {
    handlers: typeof handlers;
    emit: (ev: string, payload?: unknown) => void;
  } = {
    connected: init?.connected ?? false,
    handlers,
    on(ev, fn) {
      (handlers[ev] ??= new Set()).add(fn);
    },
    off(ev, fn) {
      handlers[ev]?.delete(fn);
    },
    disconnect: vi.fn(),
    emit(ev, payload) {
      for (const fn of handlers[ev] ?? []) fn(payload);
    }
  };
  return sock;
}

afterEach(() => {
  resetMarketLiveSharedForTests();
});

describe('subscribeMarketLive', () => {
  it('usa path /socket.io e evento market', () => {
    expect(MARKET_SOCKET_PATH).toBe('/socket.io');
    expect(MARKET_SOCKET_EVENT).toBe('market');
  });

  it('recebe o evento market e faz cleanup ao unscrever', () => {
    const sock = fakeSocket();
    const onEvent = vi.fn();
    const unsub = subscribeMarketLive({ onEvent }, { connect: () => sock });
    sock.emit('market', { type: 'market', event: 'listing_created' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'market', event: 'listing_created' });
    unsub();
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
    expect(peekMarketLiveRefCountForTests()).toBe(0);
    sock.emit('market', { type: 'market', event: 'listing_sold' });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('não cria segunda conexão com dois subscribers; disconnect só no último unsub', () => {
    const sock = fakeSocket();
    const connect = vi.fn(() => sock);
    const a = subscribeMarketLive({ onEvent: vi.fn() }, { connect });
    const b = subscribeMarketLive({ onEvent: vi.fn() }, { connect });
    expect(connect).toHaveBeenCalledTimes(1);
    a();
    expect(sock.disconnect).not.toHaveBeenCalled();
    b();
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
  });

  it('onConnected dispara se já estiver connected', () => {
    const sock = fakeSocket({ connected: true });
    const onConnected = vi.fn();
    const unsub = subscribeMarketLive({ onEvent: vi.fn(), onConnected }, { connect: () => sock });
    expect(onConnected).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('onConnected dispara no evento connect', () => {
    const sock = fakeSocket({ connected: false });
    const onConnected = vi.fn();
    const unsub = subscribeMarketLive({ onEvent: vi.fn(), onConnected }, { connect: () => sock });
    expect(onConnected).not.toHaveBeenCalled();
    sock.emit('connect');
    expect(onConnected).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('unsub duplo não desconecta duas vezes', () => {
    const sock = fakeSocket();
    const unsub = subscribeMarketLive({ onEvent: vi.fn() }, { connect: () => sock });
    unsub();
    unsub();
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
  });
});
