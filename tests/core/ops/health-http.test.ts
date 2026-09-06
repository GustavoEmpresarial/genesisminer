import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRequestIdMiddleware,
  markAppReady,
  markAppShuttingDown,
  markAppStarting,
  registerHealthRoutes,
  REQUEST_ID_HEADER,
  resetLifecycleForTests
} from '../../../server/core/ops/index.js';

function listen(app: express.Express): Promise<{ server: import('node:http').Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

describe('core/ops health + request-id HTTP', () => {
  afterEach(() => {
    resetLifecycleForTests();
    vi.restoreAllMocks();
  });

  it('liveness 200 mesmo em shutdown; readiness 503 em shutdown', async () => {
    const app = express();
    registerHealthRoutes(app);
    app.use(createRequestIdMiddleware());

    // Mock readiness deps: mark ready then shutting down — ready endpoint checks phase first
    markAppReady();
    const { server, port } = await listen(app);

    const live1 = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(live1.status).toBe(200);

    markAppShuttingDown();
    const live2 = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(live2.status).toBe(200);

    const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(ready.status).toBe(503);
    const body = (await ready.json()) as { reason?: string };
    expect(body.reason).toBe('shutting_down');

    await new Promise<void>((r) => server.close(() => r()));
  });

  it('request ID: gera e propaga; reutiliza header válido', async () => {
    markAppStarting();
    markAppReady();
    const app = express();
    registerHealthRoutes(app);
    app.use(createRequestIdMiddleware());
    app.get('/api/ping', (_req, res) => res.json({ ok: true }));

    const { server, port } = await listen(app);

    const a = await fetch(`http://127.0.0.1:${port}/api/ping`);
    const gen = a.headers.get(REQUEST_ID_HEADER);
    expect(gen).toBeTruthy();
    expect(gen!.length).toBeGreaterThanOrEqual(8);

    const b = await fetch(`http://127.0.0.1:${port}/api/ping`, {
      headers: { [REQUEST_ID_HEADER]: 'client-req-12345' }
    });
    expect(b.headers.get(REQUEST_ID_HEADER)).toBe('client-req-12345');

    await new Promise<void>((r) => server.close(() => r()));
  });

  it('durante shutdown requests normais recebem 503', async () => {
    markAppReady();
    markAppShuttingDown();
    const app = express();
    registerHealthRoutes(app);
    app.use(createRequestIdMiddleware());
    app.get('/api/ping', (_req, res) => res.json({ ok: true }));

    const { server, port } = await listen(app);
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`);
    expect(res.status).toBe(503);
    await new Promise<void>((r) => server.close(() => r()));
  });
});
