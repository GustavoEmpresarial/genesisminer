/**
 * Shared chrome for Hub panels. Currently used by Support (`accent="sky"`).
 * Accent drives border / glow; content is fully owned by the caller.
 */
import type { ReactNode } from 'react';

export type HubPanelAccent = 'amber' | 'sky' | 'orange';

const ACCENT: Record<
  HubPanelAccent,
  { border: string; shadow: string; headerFrom: string }
> = {
  amber: {
    border: 'border-amber-500/40',
    shadow: 'shadow-[0_0_48px_-10px_rgba(245,158,11,0.4)]',
    headerFrom: 'from-amber-950/70'
  },
  sky: {
    border: 'border-sky-500/40',
    shadow: 'shadow-[0_0_48px_-10px_rgba(56,189,248,0.35)]',
    headerFrom: 'from-sky-950/70'
  },
  orange: {
    border: 'border-orange-500/35',
    shadow: 'shadow-[0_0_32px_-8px_rgba(251,146,60,0.35)]',
    headerFrom: 'from-orange-950/80'
  }
};

type HubPanelProps = {
  accent?: HubPanelAccent;
  /** Max width constraint; omit for full width of parent. */
  maxWidthClass?: string;
  header?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function HubPanel({
  accent = 'amber',
  maxWidthClass = 'max-w-5xl',
  header,
  children,
  className = ''
}: HubPanelProps) {
  const a = ACCENT[accent];
  return (
    <div
      className={`relative mx-auto flex h-full min-h-0 w-full min-w-0 ${maxWidthClass} flex-1 flex-col overflow-hidden rounded-xl border bg-gradient-to-b from-slate-900 via-[#12100c] to-slate-950 sm:rounded-2xl ${a.border} ${a.shadow} ${className}`}
    >
      {header ? (
        <div
          className={`relative shrink-0 border-b border-white/10 bg-gradient-to-r ${a.headerFrom} via-slate-950/80 to-slate-950/90`}
        >
          {header}
        </div>
      ) : null}
      {children}
    </div>
  );
}
