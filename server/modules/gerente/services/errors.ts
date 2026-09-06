/**
 * Migrado de legacy/backend/modules/account-manager/accountManager.service.ts
 * (só a classe de erro — extraída pra arquivo próprio).
 * Estende `HttpControlledError` para `respondIfHttpControlledError` no controller.
 */
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';

const DEFAULT_HTTP_STATUS = 400;

export class AccountManagerError extends HttpControlledError {
  readonly code: string;

  /** Alias estável para callers/testes que leem `httpStatus`. */
  get httpStatus(): number {
    return this.statusCode;
  }

  constructor(code: string, message: string, httpStatus: number = DEFAULT_HTTP_STATUS) {
    super(httpStatus, { error: message, code });
    this.name = 'AccountManagerError';
    this.code = code;
  }
}
