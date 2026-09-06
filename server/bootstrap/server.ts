/**
 * Entrypoint do processo: HTTP server + Express (`app.ts`) +
 * jobs de fundo no mesmo processo (yield, backup SQL, TTL de chat, ranking).
 *
 * Socket.IO vive em genesis-api (Rust / socketioxide). Este processo Express
 * serve admin (+ leftovers) e schedulers.
 *
 * Um único contentor `app` serve API e scheduler. Duplicação entre réplicas
 * é evitada por locks Redis por job (`core/redis/lock.ts` + `core/ops/job-runner.ts`).
 * Kill-switch: `SCHEDULER_ENABLED=0`.
 */
import './env.js';
import { createServer } from 'node:http';
import { buildApp } from './app.js';
import { connectRedis } from '../core/redis/client.js';
import { connectPrisma } from '../core/database/prisma.js';
import { startBackgroundSchedulers, type StopSchedulers } from './schedulers.js';
import { startKafkaIfEnabled, stopKafka } from '../core/kafka/index.js';
import {
  installProcessErrorHandlers,
  installSignalHandlers,
  log,
  markAppReady,
  markAppStarting
} from '../core/ops/index.js';

const DEFAULT_PORT = 3000;

/**
 * Sobe o processo completo: Express, crons de fundo, listen.
 * Exportado para testes de integração se necessário.
 */
export async function startServer(): Promise<ReturnType<typeof createServer>> {
  markAppStarting();
  log.info('server bootstrap starting', { module: 'server', event: 'bootstrap_start' });

  await connectPrisma();
  await connectRedis();

  const { app, deps } = buildApp();
  const httpServer = createServer(app);

  const stopSchedulers: StopSchedulers = startBackgroundSchedulers({ uploadsDir: deps.uploadsDir });
  await startKafkaIfEnabled();

  const shutdownDeps = {
    httpServer,
    stopSchedulers,
    stopKafkaFn: stopKafka
  };
  installSignalHandlers(shutdownDeps);
  installProcessErrorHandlers(shutdownDeps);

  const port = parseInt(process.env.PORT || String(DEFAULT_PORT), 10) || DEFAULT_PORT;
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  markAppReady();
  log.info('server listening', { module: 'server', event: 'listening', port });

  return httpServer;
}

void startServer().catch((err: unknown) => {
  log.error('server bootstrap failed', { module: 'server', event: 'bootstrap_failed', err });
  process.exit(1);
});
