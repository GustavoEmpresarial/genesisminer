import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSlowRequestLogger } from '../../../server/core/ops/slow-request.js';

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

describe('createSlowRequestLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('não loga requests rápidas; loga acima do threshold', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = express();
    app.use(createSlowRequestLogger(40));
    app.get('/api/fast', (_req, res) => res.json({ ok: true }));
    app.get('/api/slow', async (_req, res) => {
      await new Promise((r) => setTimeout(r, 120));
      res.json({ ok: true });
    });

    const { server, port } = await listen(app);
    await fetch(`http://127.0.0.1:${port}/api/fast`);
    expect(warn).not.toHaveBeenCalled();

    await fetch(`http://127.0.0.1:${port}/api/slow`);
    expect(warn).toHaveBeenCalled();
    const line = String(warn.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('slow_request');
    expect(line).toContain('/api/slow');

    await new Promise<void>((r) => server.close(() => r()));
  });
});
