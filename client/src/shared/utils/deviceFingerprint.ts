/**
 * Coleta sinais do browser para fingerprint de dispositivo (login/registo).
 * Não usa bibliotecas externas; o servidor valida e persiste apenas chaves permitidas.
 */
import type { DeviceFingerprintPayload } from '../types/auth';

async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function collectDeviceFingerprint(): Promise<DeviceFingerprintPayload> {
  const nav = typeof navigator !== 'undefined' ? navigator : ({} as Navigator);
  const scr = typeof screen !== 'undefined' ? screen : ({} as Screen);
  const w = typeof window !== 'undefined' ? window : undefined;

  const components: Record<string, string | number | boolean> = {
    userAgent: typeof nav.userAgent === 'string' ? nav.userAgent.slice(0, 500) : '',
    language: typeof nav.language === 'string' ? nav.language : '',
    languages: Array.isArray(nav.languages) ? nav.languages.slice(0, 6).join(',') : '',
    platform: typeof nav.platform === 'string' ? nav.platform : '',
    hardwareConcurrency: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : 0,
    timezone: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      } catch {
        return '';
      }
    })(),
    timezoneOffset: new Date().getTimezoneOffset(),
    screenResolution: `${scr.width ?? 0}x${scr.height ?? 0}`,
    colorDepth: typeof scr.colorDepth === 'number' ? scr.colorDepth : 0,
    pixelRatio: w && typeof w.devicePixelRatio === 'number' ? w.devicePixelRatio : 1,
    touchSupport: w ? 'ontouchstart' in w : false,
    cookiesEnabled: !!nav.cookieEnabled,
    vendor: typeof nav.vendor === 'string' ? nav.vendor.slice(0, 120) : '',
    maxTouchPoints: typeof nav.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0
  };

  if (typeof (nav as Navigator & { deviceMemory?: number }).deviceMemory === 'number') {
    components.deviceMemory = (nav as Navigator & { deviceMemory?: number }).deviceMemory!;
  }

  try {
    const canvas = document.createElement('canvas');
    const gl =
      (canvas.getContext('webgl') as WebGLRenderingContext | null) ||
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        const v = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
        const r = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
        if (typeof v === 'string' && v) components.webglVendor = v.slice(0, 120);
        if (typeof r === 'string' && r) components.webglRenderer = r.slice(0, 120);
      }
    }
  } catch {
    /* ignore */
  }

  const base = JSON.stringify(components);
  const visitorId = await sha256Hex(base);
  return { visitorId, components };
}
