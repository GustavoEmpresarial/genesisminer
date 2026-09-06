/**
 * Secret compartilhado para HMAC de tokens de verificação de email e reset de senha.
 * Falha ruidosamente (lança) na primeira chamada se a variável de ambiente estiver
 * ausente ou for muito curta, em vez de silenciosamente usar um fallback fraco
 * hardcoded — um token HMAC-assinado com secret fraco/previsível é forjável.
 *
 * Migrado de legacy/backend/utils/authFlowSecret.ts (sem mudança de comportamento).
 */
// ⚠️ Divergência herdada do legado, não resolvida aqui: o check abaixo só exige 16
// chars, mas a mensagem de erro pede 32. Não foi corrigido na migração pra não mudar
// comportamento de segurança sem confirmar com o dono do projeto qual dos dois
// números é o pretendido (ver docs/architecture/DECISIONS.md #5) — subir o mínimo
// pra 32 sem aviso quebraria o boot de quem já tem um secret de 16-31 chars em
// produção; baixar a mensagem pra "16" reduziria a segurança percebida sem decisão
// explícita. Corrigir isto é decisão de produto/segurança, não de estilo de código.
const AUTH_FLOW_SECRET_MIN_LENGTH = 16;

/**
 * Lê e valida o secret de HMAC dos fluxos de auth (verificação de email, reset
 * de senha). Aceita `AUTH_FLOW_TOKEN_SECRET`; se ausente, cai para `JWT_SECRET`
 * (reuso deliberado — mesmo nível de sigilo exigido).
 *
 * @throws {Error} Se nenhuma das duas variáveis estiver definida, ou se o
 *   valor resultante for menor que {@link AUTH_FLOW_SECRET_MIN_LENGTH}.
 */
export function getAuthFlowTokenSecret(): string {
  const secret = (process.env.AUTH_FLOW_TOKEN_SECRET || process.env.JWT_SECRET || '').trim();
  if (secret.length < AUTH_FLOW_SECRET_MIN_LENGTH) {
    throw new Error(
      '[SECURITY] AUTH_FLOW_TOKEN_SECRET não definido ou demasiado curto. ' +
        'Defina AUTH_FLOW_TOKEN_SECRET com pelo menos 32 caracteres aleatórios.'
    );
  }
  return secret;
}
