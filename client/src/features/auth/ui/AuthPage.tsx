import { useCallback, useEffect, useState } from 'react';
import type { AccessLevel, User } from '../../../shared/types/auth';
import { LoginPage } from '../../login';
import { RegisterPage } from '../../register';
import { PasswordResetPage } from '../../password-reset';
import { AUTH_MODE_EVENT, type AuthMode } from '../../../shared/auth';
import { AUTH_FLASH_SESSION_EXPIRED, AUTH_REQUIRED_EVENT, consumeAuthFlashCode } from '../../../shared/api/http';
import { useT } from '../../../shared/i18n';
import { screenFromLocation, type AuthScreen } from '../lib/screenFromLocation';

export type AuthPageProps = {
  onLogin: (user: User) => void;
  accessLevels?: AccessLevel[];
  initialMode?: AuthMode;
};

/** Orquestra login / registro / redefinição (e verify email). */
export function AuthPage({ onLogin, accessLevels = [], initialMode = 'login' }: AuthPageProps) {
  const t = useT();
  const boot = screenFromLocation(initialMode);
  const [screen, setScreen] = useState<AuthScreen>(boot.screen);
  const [recoveryToken, setRecoveryToken] = useState<string | null>(boot.recoveryToken);
  const [verifyToken, setVerifyToken] = useState<string | null>(boot.verifyToken);
  const [flashSuccess, setFlashSuccess] = useState<string | null>(null);

  const onFlashAndLogin = useCallback((msg: string) => {
    setFlashSuccess(msg);
    setScreen('login');
  }, []);

  useEffect(() => {
    const applyFlash = () => {
      const code = consumeAuthFlashCode();
      if (code === AUTH_FLASH_SESSION_EXPIRED) {
        setFlashSuccess(t('auth.sessionExpiredLogin'));
        setScreen('login');
      }
    };
    applyFlash();
    window.addEventListener(AUTH_REQUIRED_EVENT, applyFlash);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, applyFlash);
  }, [t]);

  useEffect(() => {
    const sync = () => {
      const next = screenFromLocation(initialMode);
      setScreen(next.screen);
      setRecoveryToken(next.recoveryToken);
      setVerifyToken(next.verifyToken);
    };
    sync();

    const onMode = (ev: Event) => {
      const mode = (ev as CustomEvent<{ mode: AuthMode }>).detail?.mode;
      if (!mode) return;
      setScreen(mode);
      if (mode !== 'recovery') setRecoveryToken(null);
      if (mode === 'login') setVerifyToken(null);
      else setVerifyToken(null);
    };
    window.addEventListener('popstate', sync);
    window.addEventListener(AUTH_MODE_EVENT, onMode);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(AUTH_MODE_EVENT, onMode);
    };
  }, [initialMode]);

  if (screen === 'register') {
    return (
      <RegisterPage
        accessLevels={accessLevels}
        onRegistered={(msg) => {
          setFlashSuccess(msg);
          setScreen('login');
        }}
      />
    );
  }

  if (screen === 'recovery' || screen === 'verify') {
    return (
      <PasswordResetPage
        initialToken={recoveryToken}
        verifyToken={screen === 'verify' ? verifyToken : null}
        onDone={onFlashAndLogin}
      />
    );
  }

  return <LoginPage onLogin={onLogin} initialSuccess={flashSuccess} />;
}

export default AuthPage;
