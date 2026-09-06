/**
 * Erro de negócio com resposta HTTP explícita (status + corpo JSON já
 * fechado) — o padrão usado no projeto pra "controller/service decide o
 * erro, camada de fora só repassa": em vez de cada `try/catch` de rota
 * verificar manualmente `err.statusCode`/`err.jsonBody` com casts, um service
 * lança `throw new HttpControlledError(422, { error: '...', code: 'X' })` e
 * o handler de erro do Express faz `if (err instanceof HttpControlledError)
 * res.status(err.statusCode).json(err.jsonBody)`. Amplamente usado em toda a
 * migração (28 pontos de uso) como a forma padrão de erro "esperado" (vs.
 * exception genuinamente inesperada, que deve virar 500 genérico).
 *
 * Extraído de legacy/backend/utils/apiErrorResponse.ts (a classe estava
 * misturada com os helpers de resposta 500 nesse arquivo; agora vive isolada
 * em `shared/errors`, sem os helpers — que ficaram no lugar de origem).
 */
export class HttpControlledError extends Error {
  /** Status HTTP a devolver ao cliente. */
  readonly statusCode: number;
  /** Corpo JSON completo da resposta — o handler só faz `res.json(jsonBody)`. */
  readonly jsonBody: Record<string, unknown>;

  /**
   * @param statusCode - Status HTTP da resposta (ex.: `400`, `404`, `409`, `422`).
   * @param jsonBody - Corpo a devolver. `error`/`message` (nessa ordem de
   *   prioridade), se presentes como string, viram a `message` do próprio
   *   `Error` (útil pra quem só faz `console.error(err.message)` sem
   *   conhecer `HttpControlledError` especificamente).
   */
  constructor(statusCode: number, jsonBody: Record<string, unknown>) {
    const message =
      typeof jsonBody.error === 'string'
        ? jsonBody.error
        : typeof jsonBody.message === 'string'
          ? jsonBody.message
          : 'Request failed';
    super(message);
    this.name = 'HttpControlledError';
    this.statusCode = statusCode;
    this.jsonBody = jsonBody;
  }
}
