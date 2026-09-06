import { useEffect, useState } from 'react';
import type { User } from '../../../shared/types/auth';
import { useT } from '../../../shared/i18n';
import { registerPublicUser } from '../../../shared/api/auth';
import {
  AUTH_PASSWORD_MAX,
  AUTH_REFERRAL_MAX,
  AUTH_SIGNUP_EMAIL_MAX,
  AUTH_USERNAME_MAX
} from '../../../shared/constants/authLimits';
import { Share2, User as UserIcon } from 'lucide-react';
import {
  navigateAuthMode,
  sanitizeAuthTextInput,
  sanitizeEmailInput,
  useAuthChallenge
} from '../../../shared/auth';
import { AuthModeTabs, AuthShell } from '../../../shared/ui/auth/AuthShell';
import {
  AuthEmailField,
  AuthIconTextField,
  AuthPasswordField,
  AuthSubmitButton,
  AuthTurnstileBox
} from '../../../shared/ui/auth/AuthFields';
import { clearPersistedReferral, readAndPersistReferralFromLocation } from '../lib/referralStorage';
import {
  buildClientReferralCode,
  TURNSTILE_REGISTER_CONTAINER_ID,
  validateRegisterFields
} from '../lib/registerValidation';

export type RegisterPageProps = {
  onRegistered?: (message: string) => void;
  accessLevels?: unknown;
};

export function RegisterPage({ onRegistered }: RegisterPageProps) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [referralInput, setReferralInput] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { turnstileSiteKey, turnstileToken, resetTurnstile, captchaBlocking, collectFingerprintSafe } =
    useAuthChallenge(TURNSTILE_REGISTER_CONTAINER_ID);

  const passwordsMatch = confirmPassword.length === 0 ? null : password === confirmPassword;

  useEffect(() => {
    setReferralInput(readAndPersistReferralFromLocation());
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);

    const v = validateRegisterFields({
      email,
      password,
      username,
      confirmPassword,
      referralInput,
      acceptedTerms,
      turnstileRequired: Boolean(turnstileSiteKey),
      turnstileToken
    });
    if (!v.ok) {
      setError(v.params ? t(v.key, v.params) : t(v.key));
      return;
    }

    const deviceFingerprint = await collectFingerprintSafe();

    const newUser: User = {
      email: v.email,
      password,
      username: v.username,
      isBlocked: false,
      referralCode: buildClientReferralCode(v.username),
      referredBy: referralInput || undefined,
      referrals: []
    };

    setBusy(true);
    const result = await registerPublicUser({
      ...newUser,
      newReferralFor: v.username,
      ...(deviceFingerprint ? { deviceFingerprint } : {}),
      ...(turnstileToken ? { turnstileToken } : {})
    });
    setBusy(false);

    if (!result.ok) {
      resetTurnstile();
      setError(result.error || t('auth.errRegisterFail'));
      return;
    }

    clearPersistedReferral();
    const msg = result.message || t('auth.okRegister');
    setSuccessMessage(msg);
    onRegistered?.(msg);
  };

  return (
    <AuthShell
      title={t('auth.titleRegister')}
      subtitle={t('auth.subRegister')}
      error={error}
      successMessage={successMessage}
      tabs={<AuthModeTabs active="register" onLogin={() => navigateAuthMode('login')} onRegister={() => undefined} />}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 animate-in fade-in">
        <AuthIconTextField
          label={t('auth.username')}
          value={username}
          onChange={(v) => setUsername(sanitizeAuthTextInput(v))}
          maxLength={AUTH_USERNAME_MAX}
          icon={UserIcon}
          autoComplete="username"
          placeholder={t('auth.placeholderUser')}
        />

        <AuthEmailField
          value={email}
          onChange={(val) => setEmail(sanitizeEmailInput(val))}
          maxLength={AUTH_SIGNUP_EMAIL_MAX}
        />

        <AuthPasswordField
          value={password}
          onChange={setPassword}
          maxLength={AUTH_PASSWORD_MAX}
          show={showPassword}
          onToggleShow={() => setShowPassword((p) => !p)}
          autoComplete="new-password"
          matchState={passwordsMatch}
        />

        <AuthPasswordField
          value={confirmPassword}
          onChange={setConfirmPassword}
          maxLength={AUTH_PASSWORD_MAX}
          show={showConfirmPassword}
          onToggleShow={() => setShowConfirmPassword((p) => !p)}
          autoComplete="new-password"
          label={t('auth.confirmPassword')}
          matchState={passwordsMatch}
          showMatchHint
        />

        <AuthIconTextField
          label={t('auth.referral')}
          value={referralInput}
          onChange={(v) => setReferralInput(sanitizeAuthTextInput(v))}
          maxLength={AUTH_REFERRAL_MAX}
          icon={Share2}
          placeholder={t('auth.placeholderReferral')}
        />

        <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300">
          <input
            type="checkbox"
            checked={acceptedTerms}
            onChange={(e) => setAcceptedTerms(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-amber-500 focus:ring-amber-500"
          />
          <span className="leading-relaxed">
            {t('auth.agreeTermsPrefix')}{' '}
            <a href="/terms" className="font-semibold text-amber-600 hover:text-amber-500">
              {t('footer.terms')}
            </a>{' '}
            {t('auth.agreeTermsAnd')}{' '}
            <a href="/privacy" className="font-semibold text-emerald-600 hover:text-emerald-500">
              {t('footer.privacy')}
            </a>
            .
          </span>
        </label>

        <AuthTurnstileBox containerId={TURNSTILE_REGISTER_CONTAINER_ID} siteKey={turnstileSiteKey} />

        <AuthSubmitButton busy={busy} disabled={captchaBlocking} idleLabel={t('auth.completeRegistration')} />
      </form>
    </AuthShell>
  );
}
