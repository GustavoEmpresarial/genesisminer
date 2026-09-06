import React, { useEffect, useState } from 'react';
import { useT } from '../../../shared/i18n';
import { requestPasswordReset, resetPasswordSecure, verifyEmailToken } from '../../../shared/api/auth';
import { AUTH_LOGIN_RECOVERY_EMAIL_MAX, AUTH_PASSWORD_MAX } from '../../../shared/constants/authLimits';
import { Key, Mail, ShieldCheck } from 'lucide-react';
import { navigateAuthMode, sanitizeEmailInput } from '../../../shared/auth';
import { AuthShell } from '../../../shared/ui/auth/AuthShell';
import { AuthEmailField, AuthPasswordField } from '../../../shared/ui/auth/AuthFields';
import {
  type RecoveryStep,
  validateNewPasswordPair,
  validateRecoveryEmail
} from '../lib/passwordResetValidation';

export type PasswordResetPageProps = {
  initialToken?: string | null;
  verifyToken?: string | null;
  /** Flash de sucesso no login após reset/verify. */
  onDone?: (message: string) => void;
};

export function PasswordResetPage({
  initialToken = null,
  verifyToken = null,
  onDone
}: PasswordResetPageProps) {
  const t = useT();
  const isVerify = Boolean(verifyToken);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [recoveryStep, setRecoveryStep] = useState<RecoveryStep>(initialToken ? 'reset' : 'email');
  const [recoveryToken, setRecoveryToken] = useState(initialToken || '');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const passwordsMatch = confirmPassword.length === 0 ? null : password === confirmPassword;

  useEffect(() => {
    if (!verifyToken) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    setSuccessMessage(null);
    void verifyEmailToken(verifyToken).then((result) => {
      if (cancelled) return;
      setBusy(false);
      if (result.ok) {
        const msg = result.message || t('auth.okVerify');
        setSuccessMessage(msg);
        onDone?.(msg);
        navigateAuthMode('login');
      } else {
        setError(result.error || t('auth.errVerify'));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [verifyToken, t, onDone]);

  useEffect(() => {
    if (initialToken) {
      setRecoveryToken(initialToken);
      setRecoveryStep('reset');
    }
  }, [initialToken]);

  const handleRequestEmail = async () => {
    const v = validateRecoveryEmail(email);
    if (!v.ok) {
      setError(v.params ? t(v.key, v.params) : t(v.key));
      return;
    }
    setError(null);
    setSuccessMessage(null);
    setBusy(true);
    const res = await requestPasswordReset(v.email);
    setBusy(false);
    if (res.ok) setRecoveryStep('sent');
    else setError(res.error || t('auth.errSendEmail'));
  };

  const handleRecoveryReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setSuccessMessage(null);
    const v = validateNewPasswordPair(password, confirmPassword);
    if (!v.ok) {
      setError(v.params ? t(v.key, v.params) : t(v.key));
      return;
    }

    setBusy(true);
    const res = await resetPasswordSecure(recoveryToken, password);
    setBusy(false);

    if (res.ok) {
      const msg = t('auth.errResetOk');
      setSuccessMessage(msg);
      onDone?.(msg);
      navigateAuthMode('login');
    } else {
      setError(res.error || t('auth.errResetFail'));
    }
  };

  if (isVerify) {
    return (
      <AuthShell
        title={t('auth.titleVerify')}
        subtitle={t('auth.subVerify')}
        error={error}
        successMessage={successMessage}
      >
        <div className="space-y-4 text-center">
          <div className="mb-2 flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-900/30">
              <Mail size={32} />
            </div>
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {busy ? t('auth.verifying') : t('auth.verifyIdle')}
          </p>
          <button
            type="button"
            onClick={() => navigateAuthMode('login')}
            className="w-full rounded-lg bg-slate-800 py-3 font-bold text-white hover:bg-slate-700"
          >
            {t('auth.goToLogin')}
          </button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('auth.titleRecovery')}
      subtitle={t('auth.subRecovery')}
      error={error}
      successMessage={successMessage}
    >
      <div className="space-y-6">
        {recoveryStep === 'email' && (
          <div className="space-y-4 font-normal">
            <div className="mb-2 flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800">
                <ShieldCheck size={32} />
              </div>
            </div>
            <p className="mb-4 text-center text-xs text-slate-500">{t('auth.recoveryHint')}</p>
            <AuthEmailField
              value={email}
              onChange={(val) => setEmail(sanitizeEmailInput(val))}
              maxLength={AUTH_LOGIN_RECOVERY_EMAIL_MAX}
              label={t('auth.registeredEmail')}
            />
            <button
              type="button"
              onClick={() => void handleRequestEmail()}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-slate-800 py-3 font-bold text-white hover:bg-slate-700 disabled:opacity-60"
            >
              {busy ? t('auth.sending') : t('auth.sendLink')} <Mail size={16} />
            </button>
            <button
              type="button"
              onClick={() => navigateAuthMode('login')}
              className="mt-2 w-full text-center text-xs text-slate-500 hover:text-amber-500"
            >
              {t('auth.backToLogin')}
            </button>
          </div>
        )}

        {recoveryStep === 'sent' && (
          <div className="space-y-4 text-center">
            <div className="mb-2 flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-green-600 dark:bg-green-900/30">
                <Mail size={32} />
              </div>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {t('auth.sentBody', { email })
                .split(String(email))
                .map((part, i, arr) => (
                  <React.Fragment key={i}>
                    {part}
                    {i < arr.length - 1 ? (
                      <strong className="text-slate-900 dark:text-white">{email}</strong>
                    ) : null}
                  </React.Fragment>
                ))}
            </p>
            <p className="text-xs text-slate-500">{t('auth.linkExpires')}</p>
            <button
              type="button"
              onClick={() => navigateAuthMode('login')}
              className="w-full rounded-lg bg-slate-800 py-3 font-bold text-white hover:bg-slate-700"
            >
              {t('auth.backToLogin')}
            </button>
          </div>
        )}

        {recoveryStep === 'reset' && (
          <form onSubmit={(e) => void handleRecoveryReset(e)} className="space-y-4">
            <div className="mb-4 text-center">
              <div className="inline-flex items-center gap-2 rounded-full bg-green-100 px-3 py-1 text-xs font-bold text-green-700 dark:bg-green-900/30 dark:text-green-400">
                <ShieldCheck size={14} /> {t('auth.validLink')}
              </div>
            </div>
            <AuthPasswordField
              value={password}
              onChange={setPassword}
              maxLength={AUTH_PASSWORD_MAX}
              show={showPassword}
              onToggleShow={() => setShowPassword((p) => !p)}
              autoComplete="new-password"
              label={t('auth.newPassword')}
              matchState={passwordsMatch}
              icon={Key}
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
              icon={Key}
            />
            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 py-3 font-bold text-white hover:bg-green-500 disabled:opacity-60"
            >
              {busy ? t('auth.saving') : t('auth.resetPassword')}
            </button>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
