/**
 * Request ID HTTP: aceita header válido ou gera UUID; propaga na response + ALS.
 * Conta requests HTTP ativas para drain no shutdown.
 * Liveness continua a responder durante shutdown.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { beginHttpRequest, endHttpRequest, isShuttingDown } from './lifecycle.js';
import { runWithRequestId } from './logger.js';

export const REQUEST_ID_HEADER = 'x-request-id';

const REQUEST_ID_RE = /^[a-zA-Z0-9._:-]{8,128}$/;

const LIVE_PATHS = new Set(['/health', '/health/live', '/api/health', '/api/health/live']);

export function normalizeRequestId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return REQUEST_ID_RE.test(t) ? t : null;
}

function isLivePath(path: string): boolean {
  return LIVE_PATHS.has(path);
}

export function createRequestIdMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const path = req.path || '';

    if (isShuttingDown() && !isLivePath(path)) {
      res.status(503).json({ error: 'Service shutting down.', code: 'SHUTTING_DOWN' });
      return;
    }

    const incoming = normalizeRequestId(req.headers[REQUEST_ID_HEADER]);
    const requestId = incoming ?? randomUUID();
    res.setHeader(REQUEST_ID_HEADER, requestId);
    (req as Request & { requestId?: string }).requestId = requestId;

    const trackHttp = !isLivePath(path);
    if (trackHttp) beginHttpRequest();
    let ended = false;
    const done = (): void => {
      if (ended) return;
      ended = true;
      if (trackHttp) endHttpRequest();
    };
    res.on('finish', done);
    res.on('close', done);

    runWithRequestId(requestId, () => next());
  };
}
