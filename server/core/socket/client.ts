/**
 * Singleton do servidor Socket.IO — para módulos empurrarem eventos sem precisar
 * receber a instância `io` por parâmetro em toda a cadeia de chamada.
 *
 * Migrado de legacy/backend/lib/stack/stackIoSingleton.ts (sem mudança).
 */
import type { Server } from 'socket.io';

let io: Server | null = null;

export function setSocketIo(instance: Server | null): void {
  io = instance;
}

export function getSocketIo(): Server | null {
  return io;
}

/**
 * Encerra Socket.IO de forma ordenada: deixa de aceitar ligações e fecha as
 * existentes. Idempotente. Usado no graceful shutdown antes de `httpServer.close`.
 */
export function closeSocketIo(timeoutMs: number = 5_000): Promise<void> {
  const instance = io;
  if (!instance) return Promise.resolve();
  io = null;
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      instance.close(() => done());
    } catch {
      done();
      return;
    }
    setTimeout(done, Math.max(100, timeoutMs)).unref?.();
  });
}
