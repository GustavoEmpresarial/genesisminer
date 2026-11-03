import { useEffect, useState } from 'react';
import type { User } from '../../../shared/types/auth';
import { useT } from '../../../shared/i18n';
import { login } from '../../../shared/api/auth';
import { AUTH_LOGIN_RECOVERY_EMAIL_MAX, AUTH_PASSWORD_MAX } from '../../../shared/constants/authLimits';
import {
  navigateAuthMode,
  sanitizeEmailInput,
  useAuthChallenge
} from '../../../shared/auth';
import { AuthModeTabs, AuthShell } from '../../../shared/ui/auth/AuthShell';
import {
  AuthEmailField,
  AuthPasswordField,
  AuthSubmitButton,
  AuthTurnstileBox
} from '../../../shared/ui/auth/AuthFields';
import { TURNSTILE_LOGIN_CONTAINER_ID, validateLoginCredentials } from '../lib/loginValidation';

export type LoginPageProps = {
  onLogin: (user: User) => void;
  initialSuccess?: string | null;
};

export function LoginPage({ onLogin, initialSuccess = null }: LoginPageProps) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(initialSuccess);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initialSuccess) setSuccessMessage(initialSuccess);
  }, [initialSuccess]);

  const { turnstileSiteKey, turnstileToken, resetTurnstile, captchaBlocking, collectFingerprintSafe } =
    useAuthChallenge(TURNSTILE_LOGIN_CONTAINER_ID);

  const translateErr = (key: string, params?: Record<string, string | number>) =>
    params ? t(key, params) : t(key);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    const v = validateLoginCredentials(email, password);
    if (!v.ok) {
      setError(translateErr(v.key, v.params));
      return;
    }
    if (turnstileSiteKey && !turnstileToken) {
      setError(t('auth.errCaptcha'));
      return;
    }

    const deviceFingerprint = await collectFingerprintSafe();

    setBusy(true);
    const result = await login(v.email, v.password, deviceFingerprint, turnstileToken);
    setBusy(false);

    if (result.ok) {
      if (result.user.isBlocked) {
        setError(t('auth.errBlocked'));
        return;
      }
      onLogin(result.user);
      return;
    }

    resetTurnstile();
    setError(result.error || t('auth.errBadCredentials'));
  };

  return (
    <AuthShell
      title={t('auth.titleLogin')}
      subtitle={t('auth.subLogin')}
      error={error}
      successMessage={successMessage}
      tabs={<AuthModeTabs active="login" onLogin={() => undefined} onRegister={() => navigateAuthMode('register')} />}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 animate-in fade-in">
        <AuthEmailField
          value={email}
          onChange={(v) => setEmail(sanitizeEmailInput(v))}
          maxLength={AUTH_LOGIN_RECOVERY_EMAIL_MAX}
        />
        <div>
          <AuthPasswordField
            value={password}
            onChange={setPassword}
            maxLength={AUTH_PASSWORD_MAX}
            show={showPassword}
            onToggleShow={() => setShowPassword((p) => !p)}
            autoComplete="current-password"
          />
          <button
            type="button"
            onClick={() => navigateAuthMode('recovery')}
            className="mt-1 block w-full text-right text-[10px] text-slate-500 hover:text-amber-500"
          >
            {t('auth.forgotPassword')}
          </button>
        </div>

        <AuthTurnstileBox containerId={TURNSTILE_LOGIN_CONTAINER_ID} siteKey={turnstileSiteKey} />

        <AuthSubmitButton busy={busy} disabled={captchaBlocking} idleLabel={t('auth.logIn')} />
      </form>
    </AuthShell>
  );
}
