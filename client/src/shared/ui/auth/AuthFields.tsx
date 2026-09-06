import { ArrowRight, Eye, EyeOff, Lock, Mail, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import { passwordFieldBorder } from '../../auth/input';

const AUTH_INPUT_CLASS =
  'w-full rounded-lg border border-slate-200 bg-slate-50 py-3 pl-10 pr-4 text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-amber-500 focus:ring-1 focus:ring-amber-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white dark:placeholder:text-slate-600';

type FieldWrapProps = {
  label: string;
  children: ReactNode;
};

export function AuthFieldLabel({ label, children }: FieldWrapProps) {
  return (
    <div className="space-y-1">
      <label className="ml-1 text-xs font-bold uppercase text-slate-500">{label}</label>
      {children}
    </div>
  );
}

type AuthIconTextFieldProps = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLength: number;
  icon: LucideIcon;
  type?: 'text' | 'email';
  autoComplete?: string;
  placeholder?: string;
};

/** Campo texto/email com ícone à esquerda (username, referral, etc.). */
export function AuthIconTextField({
  label,
  value,
  onChange,
  maxLength,
  icon: Icon,
  type = 'text',
  autoComplete = 'off',
  placeholder
}: AuthIconTextFieldProps) {
  return (
    <AuthFieldLabel label={label}>
      <div className="relative">
        <Icon className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={maxLength}
          autoComplete={autoComplete}
          className={AUTH_INPUT_CLASS}
          placeholder={placeholder}
        />
      </div>
    </AuthFieldLabel>
  );
}

type AuthEmailFieldProps = {
  value: string;
  onChange: (v: string) => void;
  maxLength: number;
  label?: string;
};

export function AuthEmailField({ value, onChange, maxLength, label }: AuthEmailFieldProps) {
  const t = useT();
  return (
    <AuthIconTextField
      label={label ?? t('auth.email')}
      value={value}
      onChange={onChange}
      maxLength={maxLength}
      icon={Mail}
      type="email"
      autoComplete="email"
      placeholder={t('auth.placeholderEmail')}
    />
  );
}

type AuthPasswordFieldProps = {
  value: string;
  onChange: (v: string) => void;
  maxLength: number;
  show: boolean;
  onToggleShow: () => void;
  autoComplete?: string;
  label?: string;
  /** null = sem validação visual de match */
  matchState?: boolean | null;
  icon?: LucideIcon;
  showMatchHint?: boolean;
};

export function AuthPasswordField({
  value,
  onChange,
  maxLength,
  show,
  onToggleShow,
  autoComplete = 'current-password',
  label,
  matchState = null,
  icon: Icon = Lock,
  showMatchHint = false
}: AuthPasswordFieldProps) {
  const t = useT();
  const border =
    matchState === null
      ? 'border-slate-200 dark:border-slate-700 focus:border-amber-500 focus:ring-1 focus:ring-amber-500'
      : passwordFieldBorder(value.length > 0, matchState);

  return (
    <AuthFieldLabel label={label ?? t('auth.password')}>
      <div className="relative">
        <Icon className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={maxLength}
          autoComplete={autoComplete}
          className={`w-full rounded-lg border bg-slate-50 py-3 pl-10 pr-12 text-slate-900 outline-none transition-all placeholder:text-slate-400 dark:bg-slate-950 dark:text-white dark:placeholder:text-slate-600 ${border}`}
          placeholder="••••••••"
        />
        <button
          type="button"
          onClick={onToggleShow}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 transition-colors hover:text-slate-200"
          aria-label={show ? t('auth.hidePassword') : t('auth.showPassword')}
        >
          {show ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {showMatchHint && value.length > 0 && matchState !== null && (
        <p className={`text-[11px] ${matchState ? 'text-emerald-400' : 'text-red-400'}`}>
          {matchState ? t('auth.passwordsMatch') : t('auth.passwordsMismatch')}
        </p>
      )}
    </AuthFieldLabel>
  );
}

type AuthTurnstileBoxProps = {
  containerId: string;
  siteKey: string;
};

export function AuthTurnstileBox({ containerId, siteKey }: AuthTurnstileBoxProps) {
  const t = useT();
  if (!siteKey) return null;
  return (
    <AuthFieldLabel label={t('auth.verification')}>
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 dark:border-slate-700 dark:bg-slate-950">
        <div id={containerId} className="min-h-[65px]" />
      </div>
    </AuthFieldLabel>
  );
}

type AuthSubmitButtonProps = {
  busy: boolean;
  disabled?: boolean;
  idleLabel: string;
  busyLabel?: string;
};

/** CTA principal login/registro (gradiente amber). */
export function AuthSubmitButton({ busy, disabled, idleLabel, busyLabel }: AuthSubmitButtonProps) {
  const t = useT();
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-amber-600 to-amber-500 py-3 font-bold text-white shadow-lg transition-all hover:from-amber-500 hover:to-amber-400 active:scale-95 disabled:opacity-60"
    >
      {busy ? (
        <span className="animate-pulse">{busyLabel ?? t('auth.processing')}</span>
      ) : (
        <>
          {idleLabel} <ArrowRight size={18} />
        </>
      )}
    </button>
  );
}
