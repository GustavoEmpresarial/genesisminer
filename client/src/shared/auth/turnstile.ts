import { useEffect, useState } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string;
      remove?: (widgetId: string) => void;
      reset?: (widgetId?: string) => void;
    };
  }
}

/** Carrega site key Turnstile a partir de `/api/security/turnstile-config`. */
export function useTurnstileSiteKey(): string {
  const [turnstileSiteKey, setTurnstileSiteKey] = useState('');

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/security/turnstile-config', { credentials: 'include' })
      .then((res) => res.json().catch(() => ({})))
      .then((data: { enabled?: boolean; siteKey?: string }) => {
        if (cancelled) return;
        if (data.enabled && typeof data.siteKey === 'string') {
          setTurnstileSiteKey(data.siteKey.trim());
        } else {
          setTurnstileSiteKey('');
        }
      })
      .catch(() => {
        if (!cancelled) setTurnstileSiteKey('');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return turnstileSiteKey;
}

/**
 * Injeta script + renderiza widget Turnstile quando `enabled`.
 * `containerId` deve existir no DOM (ex. cf-turnstile-login).
 */
export function useTurnstileWidget(opts: {
  siteKey: string;
  enabled: boolean;
  containerId: string;
}): { turnstileToken: string; setTurnstileToken: (t: string) => void; resetTurnstile: () => void } {
  const { siteKey, enabled, containerId } = opts;
  const [turnstileToken, setTurnstileToken] = useState('');

  useEffect(() => {
    if (!siteKey || !enabled) return;
    if (document.querySelector('script[data-cf-turnstile-script="1"]')) return;
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.setAttribute('data-cf-turnstile-script', '1');
    document.head.appendChild(script);
  }, [siteKey, enabled]);

  useEffect(() => {
    if (!siteKey || !enabled) return;
    let cancelled = false;
    let widgetId: string | null = null;

    const renderWidget = () => {
      if (cancelled) return;
      const container = document.getElementById(containerId);
      if (!container || !window.turnstile) return;
      container.innerHTML = '';
      setTurnstileToken('');
      widgetId = window.turnstile.render(container, {
        sitekey: siteKey,
        theme: 'dark',
        callback: (token: string) => setTurnstileToken(token),
        'expired-callback': () => setTurnstileToken(''),
        'error-callback': () => setTurnstileToken('')
      });
    };

    const tryRender = () => {
      if (cancelled) return;
      if (window.turnstile) {
        renderWidget();
        return;
      }
      window.setTimeout(tryRender, 200);
    };

    tryRender();
    return () => {
      cancelled = true;
      setTurnstileToken('');
      if (widgetId && window.turnstile?.remove) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          /* ignore */
        }
      }
    };
  }, [siteKey, enabled, containerId]);

  const resetTurnstile = () => {
    setTurnstileToken('');
    try {
      window.turnstile?.reset?.();
    } catch {
      /* ignore */
    }
  };

  return { turnstileToken, setTurnstileToken, resetTurnstile };
}
