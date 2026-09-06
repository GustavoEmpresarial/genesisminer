/**
 * Live do mercado P2P — Socket.IO já anexado no backend (`/socket.io`, evento `market`).
 * Não usa raw WebSocket `/ws/market`.
 */
import { io } from 'socket.io-client';

export const MARKET_SOCKET_PATH = '/socket.io';
export const MARKET_SOCKET_EVENT = 'market';

export type MarketLivePayload = { type?: string; event?: string };

export type MarketLiveSocket = {
  connected?: boolean;
  on: (ev: string, fn: (payload?: unknown) => void) => void;
  off: (ev: string, fn: (payload?: unknown) => void) => void;
  disconnect: () => void;
};

export type SubscribeMarketLiveDeps = {
  connect: () => MarketLiveSocket;
};

let shared: MarketLiveSocket | null = null;
let refs = 0;

export function connectDefaultMarketSocket(): MarketLiveSocket {
  return io({
    path: MARKET_SOCKET_PATH,
    withCredentials: true,
    transports: ['websocket', 'polling']
  }) as unknown as MarketLiveSocket;
}

export function resetMarketLiveSharedForTests(): void {
  shared = null;
  refs = 0;
}

export function subscribeMarketLive(
  handlers: {
    onEvent: (payload: MarketLivePayload) => void;
    onConnected?: () => void;
  },
  deps?: SubscribeMarketLiveDeps
): () => void {
  const connect = deps?.connect ?? connectDefaultMarketSocket;
  if (!shared) shared = connect();
  refs += 1;

  const onMarket = (raw?: unknown) => {
    const payload = raw && typeof raw === 'object' ? (raw as MarketLivePayload) : {};
    handlers.onEvent(payload);
  };
  const onConnect = () => {
    handlers.onConnected?.();
  };

  shared.on(MARKET_SOCKET_EVENT, onMarket);
  shared.on('connect', onConnect);
  if (shared.connected) onConnect();

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    shared?.off(MARKET_SOCKET_EVENT, onMarket);
    shared?.off('connect', onConnect);
    refs -= 1;
    if (refs <= 0) {
      try {
        shared?.disconnect();
      } catch {
        /* ignore */
      }
      shared = null;
      refs = 0;
    }
  };
}

/** Só para testes — força disconnect do singleton. */
export function peekMarketLiveRefCountForTests(): number {
  return refs;
}
