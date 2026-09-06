/** Accent de UI (Admin → settings.ui_accent). Hex livre → escala RGB Tailwind. */

export const UI_ACCENT_PRESET_HEX = {
  orange: '#f59e0b',
  shock_pink: '#ff1493'
} as const;

export type UiAccentPresetId = keyof typeof UI_ACCENT_PRESET_HEX;

export const DEFAULT_UI_ACCENT_HEX = UI_ACCENT_PRESET_HEX.orange;
/** Alias — valor é sempre hex `#rrggbb`. */
export const DEFAULT_UI_ACCENT = DEFAULT_UI_ACCENT_HEX;

export const UI_ACCENT_PRESETS = Object.keys(UI_ACCENT_PRESET_HEX) as UiAccentPresetId[];

export const UI_ACCENT_LABELS: Record<UiAccentPresetId, string> = {
  orange: 'Laranja',
  shock_pink: 'Rosa Shock'
};

export const UI_ACCENT_SWATCH = UI_ACCENT_PRESET_HEX;

const HEX_RE = /^#?([0-9a-f]{6})$/i;
const SHORT_HEX_RE = /^#?([0-9a-f]{3})$/i;

const SHADES = [
  '50',
  '100',
  '200',
  '300',
  '400',
  '500',
  '600',
  '700',
  '800',
  '900',
  '950'
] as const;

type Shade = (typeof SHADES)[number];
type Rgb = [number, number, number];

/** Mix ratios vs white (light) / black (dark). 500 = cor base. */
const LIGHT_MIX: Record<Exclude<Shade, '500' | '600' | '700' | '800' | '900' | '950'>, number> = {
  50: 0.92,
  100: 0.84,
  200: 0.7,
  300: 0.5,
  400: 0.28
};

const DARK_MIX: Record<Exclude<Shade, '50' | '100' | '200' | '300' | '400' | '500'>, number> = {
  600: 0.18,
  700: 0.32,
  800: 0.48,
  900: 0.6,
  950: 0.74
};

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const u = Math.max(0, Math.min(1, t));
  return [
    clampByte(a[0] + (b[0] - a[0]) * u),
    clampByte(a[1] + (b[1] - a[1]) * u),
    clampByte(a[2] + (b[2] - a[2]) * u)
  ];
}

function rgbChannel(rgb: Rgb): string {
  return `${rgb[0]} ${rgb[1]} ${rgb[2]}`;
}

function parseHexToRgb(hex: string): Rgb | null {
  const s = hex.trim().toLowerCase();
  const short = s.match(SHORT_HEX_RE);
  if (short) {
    const [a, b, c] = short[1].split('');
    return [parseInt(a + a, 16), parseInt(b + b, 16), parseInt(c + c, 16)];
  }
  const m = s.match(HEX_RE);
  if (!m) return null;
  const h = m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Normaliza para `#rrggbb`. Aceita presets legacy e hex. */
export function normalizeUiAccentHex(raw: unknown): string {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (!s) return DEFAULT_UI_ACCENT_HEX;
  if (s in UI_ACCENT_PRESET_HEX) {
    return UI_ACCENT_PRESET_HEX[s as UiAccentPresetId];
  }
  const rgb = parseHexToRgb(s.startsWith('#') ? s : `#${s}`);
  if (!rgb) return DEFAULT_UI_ACCENT_HEX;
  const [r, g, b] = rgb;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** @deprecated alias */
export function normalizeUiAccent(raw: unknown): string {
  return normalizeUiAccentHex(raw);
}

function buildScale(base: Rgb): Record<Shade, string> {
  const out = {} as Record<Shade, string>;
  const white: Rgb = [255, 255, 255];
  const black: Rgb = [0, 0, 0];
  out[50] = rgbChannel(mixRgb(base, white, LIGHT_MIX[50]));
  out[100] = rgbChannel(mixRgb(base, white, LIGHT_MIX[100]));
  out[200] = rgbChannel(mixRgb(base, white, LIGHT_MIX[200]));
  out[300] = rgbChannel(mixRgb(base, white, LIGHT_MIX[300]));
  out[400] = rgbChannel(mixRgb(base, white, LIGHT_MIX[400]));
  out[500] = rgbChannel(base);
  out[600] = rgbChannel(mixRgb(base, black, DARK_MIX[600]));
  out[700] = rgbChannel(mixRgb(base, black, DARK_MIX[700]));
  out[800] = rgbChannel(mixRgb(base, black, DARK_MIX[800]));
  out[900] = rgbChannel(mixRgb(base, black, DARK_MIX[900]));
  out[950] = rgbChannel(mixRgb(base, black, DARK_MIX[950]));
  return out;
}

/** Ligeiro desvio de matiz (+12°) para a família `orange-*`. */
function shiftHue(rgb: Rgb, deg: number): Rgb {
  const [r, g, b] = rgb.map((v) => v / 255) as Rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  h = (h + deg + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rp: number;
  let gp: number;
  let bp: number;
  if (h < 60) [rp, gp, bp] = [c, x, 0];
  else if (h < 120) [rp, gp, bp] = [x, c, 0];
  else if (h < 180) [rp, gp, bp] = [0, c, x];
  else if (h < 240) [rp, gp, bp] = [0, x, c];
  else if (h < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return [clampByte((rp + m) * 255), clampByte((gp + m) * 255), clampByte((bp + m) * 255)];
}

/** Aplica canais RGB no `:root` a partir de qualquer hex. */
export function applyUiAccent(raw: unknown): string {
  const hex = normalizeUiAccentHex(raw);
  if (typeof document === 'undefined') return hex;
  const base = parseHexToRgb(hex) ?? parseHexToRgb(DEFAULT_UI_ACCENT_HEX)!;
  const amber = buildScale(base);
  const orange = buildScale(shiftHue(base, 12));
  const root = document.documentElement;
  for (const s of SHADES) {
    root.style.setProperty(`--amber-${s}`, amber[s]);
    root.style.setProperty(`--orange-${s}`, orange[s]);
  }
  root.style.setProperty('--neon-gold-rgb', amber[400]);
  root.style.setProperty('--neon-amber-rgb', amber[500]);
  root.style.setProperty('--neon-bronze-rgb', amber[700]);
  root.style.setProperty('--neon-purple-rgb', orange[600]);
  root.style.setProperty('--neon-cyan-rgb', amber[500]);
  root.style.setProperty('--neon-gold', `rgb(${amber[400]})`);
  root.style.setProperty('--neon-amber', `rgb(${amber[500]})`);
  root.style.setProperty('--neon-bronze', `rgb(${amber[700]})`);
  root.style.setProperty('--neon-purple', `rgb(${orange[600]})`);
  root.style.setProperty('--neon-cyan', `rgb(${amber[500]})`);
  root.dataset.accent = hex;
  return hex;
}
