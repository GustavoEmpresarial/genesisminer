/**
 * Liveness vs readiness.
 * - live: processo vivo (não depende de PG/Redis).
 * - ready: aceita tráfego (fase ready + deps críticas leves).
 */
import type { Express, Request, Response } from 'express';
import pool from '../database/pool.js';
import { getRedis } from '../redis/client.js';
import { opsConfig } from './config.js';
import { isAppReady, isShuttingDown } from './lifecycle.js';
import { log } from './logger.js';

const HTTP_OK = 200;
const HTTP_SERVICE_UNAVAILABLE = 503;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('readiness check timeout')), ms);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkPostgres(): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    return true;
  } finally {
    client.release();
  }
}

async function checkRedisIfConfigured(): Promise<boolean> {
  if (!process.env.REDIS_URL?.trim()) return true;
  const r = getRedis();
  if (!r) return false;
  const pong = await r.ping();
  return pong === 'PONG';
}

export function registerHealthRoutes(app: Express): void {
  const live = (_req: Request, res: Response): void => {
    res.status(HTTP_OK).json({ ok: true, status: 'live' });
  };

  const ready = async (_req: Request, res: Response): Promise<void> => {
    if (isShuttingDown() || !isAppReady()) {
      res.status(HTTP_SERVICE_UNAVAILABLE).json({
        ok: false,
        status: 'not_ready',
        reason: isShuttingDown() ? 'shutting_down' : 'starting'
      });
      return;
    }

    const timeout = opsConfig.readinessCheckTimeoutMs;
    try {
      const [pgOk, redisOk] = await Promise.all([
        withTimeout(checkPostgres(), timeout),
        withTimeout(checkRedisIfConfigured(), timeout)
      ]);
      if (!pgOk || !redisOk) {
        res.status(HTTP_SERVICE_UNAVAILABLE).json({
          ok: false,
          status: 'not_ready',
          reason: !pgOk ? 'postgres' : 'redis'
        });
        return;
      }
      res.status(HTTP_OK).json({ ok: true, status: 'ready' });
    } catch (err) {
      log.warn('readiness check failed', { module: 'health', event: 'readiness_fail', err });
      res.status(HTTP_SERVICE_UNAVAILABLE).json({ ok: false, status: 'not_ready', reason: 'dependency_timeout' });
    }
  };

  app.get('/health', live);
  app.get('/health/live', live);
  app.get('/health/ready', (req, res) => {
    void ready(req, res);
  });
  app.get('/api/health', live);
  app.get('/api/health/live', live);
  app.get('/api/health/ready', (req, res) => {
    void ready(req, res);
  });
}
