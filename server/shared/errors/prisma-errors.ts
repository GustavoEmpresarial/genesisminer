/**
 * Mapeia erros do cliente Prisma para status/corpo HTTP seguros — traduz o
 * código interno do Prisma (`P2002`, `P2025`, ...) pra uma mensagem
 * amigável e um status HTTP correto, em vez de deixar o erro do driver
 * vazar cru pro cliente (que exporia estrutura de tabela/coluna, nome de
 * constraint, etc.).
 *
 * "Seguros" no sentido de: em produção (`NODE_ENV=production`), detalhes
 * técnicos (`err.code`, `err.errorCode`) são omitidos do corpo JSON — só a
 * mensagem genérica e um `code` de negócio estável (`'DUPLICATE'`,
 * `'NOT_FOUND'`, ...) chegam ao cliente. Fora de produção, o código Prisma
 * original também é incluído, pra facilitar debug local sem precisar ir ao
 * log do servidor.
 *
 * Migrado de legacy/backend/utils/prismaHttpResponse.ts (sem mudança de comportamento).
 */
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * Reconhece um erro do Prisma e devolve o status/corpo HTTP correspondente,
 * sem enviar nada — quem chama decide se/como responder (ver também
 * {@link sendIfPrismaHttpError} para o caso comum de "mapear e já enviar").
 *
 * Códigos tratados especificamente: `P2002` (unique constraint → 409
 * duplicado), `P2025` (registro não encontrado → 404), `P2003` (FK
 * inválida → 400), `P2024` (timeout de pool de conexão → 503), `P2034`
 * (conflito de transação/write conflict → 409). Qualquer outro `P1*`
 * (erro de conexão com o banco) → 503; qualquer outro `PXXXX` não mapeado
 * → 500 genérico.
 *
 * @returns `null` se `err` não for um erro Prisma reconhecido por esta
 *   função (deixa quem chama tratar como erro genérico/inesperado).
 */
export function mapPrismaClientError(
  err: unknown
): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        return {
          status: 409,
          body: {
            error: 'This email or username is already in use.',
            code: 'DUPLICATE'
          }
        };
      case 'P2025':
        return {
          status: 404,
          body: { error: 'Record not found.', code: 'NOT_FOUND' }
        };
      case 'P2003':
        return {
          status: 400,
          body: { error: 'Invalid reference.', code: 'FK_VIOLATION' }
        };
      case 'P2024':
        return {
          status: 503,
          body: {
            error: 'Operation timed out. Please try again.',
            code: 'TIMEOUT'
          }
        };
      case 'P2034':
        return {
          status: 409,
          body: {
            error: 'Conflict while saving. Please try again.',
            code: 'TRANSACTION_CONFLICT'
          }
        };
      default:
        if (err.code.startsWith('P1')) {
          return {
            status: 503,
            body: {
              error: 'Database unavailable. Please try again.',
              code: IS_PROD ? 'DB_UNAVAILABLE' : err.code
            }
          };
        }
        return {
          status: 500,
          body: {
            error: 'Error processing the request.',
            ...(IS_PROD ? {} : { code: err.code })
          }
        };
    }
  }
  if (err instanceof Prisma.PrismaClientValidationError) {
    return {
      status: 400,
      body: {
        error: 'Invalid data.',
        ...(IS_PROD ? {} : { code: 'PRISMA_VALIDATION' })
      }
    };
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return {
      status: 503,
      body: {
        error: 'Service temporarily unavailable.',
        code: IS_PROD ? 'DB_INIT' : err.errorCode
      }
    };
  }
  if (err instanceof Prisma.PrismaClientRustPanicError) {
    return {
      status: 503,
      body: { error: 'Service temporarily unavailable.', code: 'DB_PANIC' }
    };
  }
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return {
      status: 503,
      body: {
        error: 'Error communicating with the database.',
        code: IS_PROD ? 'UNKNOWN_DB' : 'PRISMA_UNKNOWN'
      }
    };
  }
  return null;
}

/**
 * Atalho pro caso comum: mapeia `err` via {@link mapPrismaClientError} e, se
 * reconhecido, já loga (`console.error`, com stack) e envia a resposta —
 * poupa o `if (mapped) { res.status(...).json(...) }` repetido em cada
 * catch-block de controller. Não faz nada (nem loga) se `err` não for um
 * erro Prisma reconhecido, ou se a resposta já tiver sido enviada
 * (`res.headersSent`) — assim é seguro chamar "por via das dúvidas" em
 * catch-blocks genéricos sem risco de tentar responder duas vezes.
 *
 * @param logTag - Identifica a origem no log (ex.: `'POST /api/upgrades'`).
 * @returns `true` se enviou a resposta (chamador não deve responder de novo).
 */
export function sendIfPrismaHttpError(res: Response, err: unknown, logTag: string): boolean {
  const mapped = mapPrismaClientError(err);
  if (!mapped || res.headersSent) return false;
  const details =
    err instanceof Error ? { msg: err.message, stack: err.stack } : { msg: String(err), stack: undefined };
  console.error(`[Prisma ${mapped.status}] ${logTag}`, details.msg, details.stack || '');
  res.status(mapped.status).json(mapped.body);
  return true;
}
