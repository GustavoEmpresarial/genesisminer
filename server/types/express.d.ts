/**
 * Augmentation de `Request` do Express — campos setados pelos middlewares de auth.
 *
 * Migrado de legacy/backend/types/express-augment.d.ts + types/express-auth.d.ts
 * (dois arquivos separados no legado, com `userId` divergente entre eles —
 * `string | number` num, `number` no outro. Consolidado aqui num só, tipado
 * como o middleware de fato usa: `number`, ver `modules/auth/http-auth.ts`).
 */
import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    userId?: number;
    auth?: { kind: 'jwt' | 'session'; jti?: string; exp?: number };
    /** Definido pelo middleware `isAdmin` após `loadAdminGateContext` (ainda a migrar). */
    isSuperAdmin?: boolean;
    adminPermissions?: unknown;
    /** Sessão em modo gerência (gerente a operar conta do dono). */
    managerMode?: boolean;
    managerUserId?: number;
    actingAsOwnerId?: number;
  }
}
