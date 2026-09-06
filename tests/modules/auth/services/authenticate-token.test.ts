import { describe, expect, it, vi } from 'vitest';
import { createAuthenticateTokenMiddleware } from '../../../../server/modules/auth/services/http-auth.js';

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    }
  };
  return res;
}

describe('createAuthenticateTokenMiddleware', () => {
  it('req.userId ausente: 401 AUTH_REQUIRED', () => {
    const authenticateToken = createAuthenticateTokenMiddleware();
    const req = { userId: undefined } as any;
    const res = fakeRes();
    const next = vi.fn();
    authenticateToken(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Not authenticated', code: 'AUTH_REQUIRED' });
    expect(next).not.toHaveBeenCalled();
  });

  it('req.userId presente: passa adiante', () => {
    const authenticateToken = createAuthenticateTokenMiddleware();
    const req = { userId: 7 } as any;
    const res = fakeRes();
    const next = vi.fn();
    authenticateToken(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
});
