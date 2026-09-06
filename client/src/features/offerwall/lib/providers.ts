/** Catálogo de providers do Offerwall (UI). MoneyRain / Offerwall.me = soon (manutenção), sem server. */
export type ProviderStatus = 'live' | 'soon';
export type Accent = 'emerald' | 'sky' | 'amber' | 'violet';

export type ProviderDef = {
  id: string;
  nameKey: string;
  taglineKey: string;
  descriptionKey: string;
  status: ProviderStatus;
  accent: Accent;
};

export const ACCENT_CLASSES: Record<Accent, { ring: string; chip: string; iconBg: string; gradient: string }> = {
  emerald: {
    ring: 'border-emerald-700/60 hover:border-emerald-500/70',
    chip: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/60',
    iconBg: 'bg-emerald-600/90',
    gradient: 'from-slate-900/90 via-slate-900/70 to-emerald-950/30'
  },
  sky: {
    ring: 'border-sky-700/60 hover:border-sky-500/70',
    chip: 'bg-sky-900/40 text-sky-300 border-sky-700/60',
    iconBg: 'bg-sky-600/90',
    gradient: 'from-slate-900/90 via-slate-900/70 to-sky-950/30'
  },
  amber: {
    ring: 'border-amber-700/60 hover:border-amber-500/70',
    chip: 'bg-amber-900/40 text-amber-300 border-amber-700/60',
    iconBg: 'bg-amber-600/90',
    gradient: 'from-slate-900/90 via-slate-900/70 to-amber-950/30'
  },
  violet: {
    ring: 'border-violet-700/60 hover:border-violet-500/70',
    chip: 'bg-violet-900/40 text-violet-300 border-violet-700/60',
    iconBg: 'bg-violet-600/90',
    gradient: 'from-slate-900/90 via-slate-900/70 to-violet-950/30'
  }
};

export const OFFERWALL_PROVIDERS: ProviderDef[] = [
  {
    id: 'zerads',
    nameKey: 'offerwall.providerZeradsName',
    taglineKey: 'offerwall.providerZeradsTagline',
    descriptionKey: 'offerwall.providerZeradsDesc',
    status: 'live',
    accent: 'emerald'
  },
  {
    id: 'moneyrain',
    nameKey: 'offerwall.providerMoneyRainName',
    taglineKey: 'offerwall.providerSoonTagline',
    descriptionKey: 'offerwall.providerMoneyRainDesc',
    status: 'soon',
    accent: 'sky'
  },
  {
    id: 'offerwall_me',
    nameKey: 'offerwall.providerOfferwallMeName',
    taglineKey: 'offerwall.providerSoonTagline',
    descriptionKey: 'offerwall.providerOfferwallMeDesc',
    status: 'soon',
    accent: 'amber'
  }
];
