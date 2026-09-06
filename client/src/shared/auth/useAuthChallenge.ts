import { collectDeviceFingerprint } from '../utils/deviceFingerprint';
import type { DeviceFingerprintPayload } from '../types/auth';
import { useTurnstileSiteKey, useTurnstileWidget } from './turnstile';

/**
 * Turnstile + fingerprint para login/registro.
 * `containerId` deve existir no DOM (ex. cf-turnstile-login).
 */
export function useAuthChallenge(containerId: string): {
  turnstileSiteKey: string;
  turnstileToken: string;
  resetTurnstile: () => void;
  captchaBlocking: boolean;
  collectFingerprintSafe: () => Promise<DeviceFingerprintPayload | undefined>;
} {
  const turnstileSiteKey = useTurnstileSiteKey();
  const { turnstileToken, resetTurnstile } = useTurnstileWidget({
    siteKey: turnstileSiteKey,
    enabled: true,
    containerId
  });

  const collectFingerprintSafe = async (): Promise<DeviceFingerprintPayload | undefined> => {
    try {
      return await collectDeviceFingerprint();
    } catch {
      return undefined;
    }
  };

  return {
    turnstileSiteKey,
    turnstileToken,
    resetTurnstile,
    captchaBlocking: turnstileSiteKey.length > 0 && !turnstileToken,
    collectFingerprintSafe
  };
}
