# Segurança — referência (legado)

Mecanismos identificados no código, a validar/documentar em detalhe:

- **Auth**: JWT (`jsonwebtoken`) + refresh token (`backend/src/auth/refreshTokenStore.ts`), cookies (`backend/src/auth/cookies.ts`).
- **CORS**: `CORS_ALLOWED_ORIGINS` / `CORS_EXTRA_ORIGINS`, `backend/utils/corsConfig` (via `helmet`/`cors`).
- **Rate limit**: `express-rate-limit` (política por rota não documentada ainda).
- **Anti-bot**: Cloudflare Turnstile (`backend/utils/cloudflareTurnstile.ts`).
- **Anti-fraude cadastro**: `signupProxyVpnGuard.ts`, `signupPolicy.ts`, `registrationValidation.ts`.
- **Device fingerprint**: `deviceFingerprintModel.ts`, `deviceFingerprintAdminController.ts`.
- **Threat observer**: `securityThreatObserver.ts` (detecção de comportamento suspeito).
- **Segurança de senha**: `profilePasswordPolicy.ts`, `bcryptjs`.
- **Headers HTTP**: `helmet`.
- **Auditoria**: `profile_audit_log` (Postgres), `adminUserAudit.controller.ts`, `adminSecurityBulk.controller.ts`.

## Pendente (cobrir as 12 categorias de segurança do padrão de prompts)
- [ ] XSS — sanitização (frontend usa `dompurify`; backend a confirmar).
- [ ] SQL injection — Prisma cobre a maior parte; checar SQL cru em `server.ts`/`models/`.
- [ ] CSRF — não identificado middleware explícito ainda; confirmar.
- [ ] Auth — detalhar fluxo completo JWT+refresh.
- [ ] Rate limiting — mapear por rota.
- [ ] Validação de input — `validation/` (só 3 arquivos; maioria dos módulos valida inline).
- [ ] Exposição de dados — checar payloads admin vs. player.
- [ ] Tratamento de erro — `apiErrorResponse.ts`, `prismaHttpResponse.ts`.
- [ ] Upload de arquivo — `multer` + `sharp` + `supportUploadLimits.ts`.
- [ ] WebSocket — `chat.socket.ts`, auth de socket (`chat.auth.ts`).
- [ ] Criptografia — hash de senha (`bcryptjs`), `checkinBonusHash.ts` (uso a confirmar).
- [ ] Regras de negócio — idempotência (`lucky-boxes.idempotency.ts`, `shop_checkout_idempotency`, `wheelIdempotency.ts`).
