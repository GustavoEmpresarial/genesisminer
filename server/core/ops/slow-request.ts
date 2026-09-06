/**
 * Loga requests HTTP lentas (threshold configurável). Sem flood — só acima do limiar.
 */
import type { NextFunction, Request, Response } from 'express';
import { opsConfig } from './config.js';
import { log } from './logger.js';

const SKIP_PREFIXES = ['/health', '/api/health'];

export function createSlowRequestLogger(thresholdMs: number = opsConfig.slowHttpMs) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const path = req.path || '';
    if (SKIP_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
      next();
      return;
    }
    const started = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - started;
      if (durationMs < thresholdMs) return;
      log.warn('slow http request', {
        module: 'http',
        event: 'slow_request',
        durationMs,
        method: req.method,
        path,
        status: res.statusCode
      });
    });
    next();
  };
}
