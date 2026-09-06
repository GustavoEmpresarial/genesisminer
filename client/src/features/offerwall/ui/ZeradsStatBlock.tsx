import type { ReactNode } from 'react';

type Tone = 'emerald' | 'amber' | 'sky' | 'slate';

const TONE_CLASSES: Record<Tone, { wrap: string; label: string; value: string; icon: string }> = {
  emerald: {
    wrap: 'border-emerald-800/60 bg-emerald-950/30',
    label: 'text-emerald-400/90',
    value: 'text-emerald-100',
    icon: 'text-emerald-300'
  },
  amber: {
    wrap: 'border-amber-800/60 bg-amber-950/30',
    label: 'text-amber-400/90',
    value: 'text-amber-100',
    icon: 'text-amber-300'
  },
  sky: {
    wrap: 'border-sky-800/60 bg-sky-950/30',
    label: 'text-sky-400/90',
    value: 'text-sky-100',
    icon: 'text-sky-300'
  },
  slate: {
    wrap: 'border-slate-700/70 bg-slate-950/50',
    label: 'text-slate-400/90',
    value: 'text-slate-100',
    icon: 'text-slate-300'
  }
};

type ZeradsStatBlockProps = {
  label: string;
  value: string;
  icon: ReactNode;
  tone: Tone;
};

export function ZeradsStatBlock({ label, value, icon, tone }: ZeradsStatBlockProps) {
  const c = TONE_CLASSES[tone];
  return (
    <div className={`flex min-w-0 items-center gap-3 rounded-xl border ${c.wrap} p-3`}>
      <span className={`shrink-0 ${c.icon}`}>{icon}</span>
      <div className="min-w-0">
        <div className={`truncate text-[10px] font-bold uppercase tracking-widest ${c.label}`}>{label}</div>
        <div className={`truncate font-mono text-lg font-black leading-tight sm:text-xl ${c.value}`}>{value}</div>
      </div>
    </div>
  );
}
