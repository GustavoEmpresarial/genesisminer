/**
 * unhandledRejection / uncaughtException → log + graceful shutdown.
 */
import type { Server } from 'node:http';
import { isShuttingDown } from './lifecycle.js';
import { log } from './logger.js';
import { requestGracefulShutdown, type GracefulShutdownDeps } from './shutdown.js';

let installed = false;

export function installProcessErrorHandlers(deps: GracefulShutdownDeps): void {
  if (installed) return;
  installed = true;

  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', { module: 'process', event: 'unhandledRejection', err: reason });
    if (isShuttingDown()) return;
    void requestGracefulShutdown({ ...deps, exitCode: 1 }, 'unhandledRejection');
  });

  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', { module: 'process', event: 'uncaughtException', err });
    if (isShuttingDown()) return;
    void requestGracefulShutdown({ ...deps, exitCode: 1 }, 'uncaughtException');
  });
}

/** Testes. */
export function resetProcessErrorHandlersForTests(): void {
  installed = false;
}

export type { Server };
