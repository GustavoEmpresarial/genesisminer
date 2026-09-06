import type { ReactNode } from 'react';

type QuestSectionTitleProps = {
  children: ReactNode;
  tone: 'amber' | 'sky' | 'yellow';
};

/** Section h2 — same classes as legacy QuestsPage. */
export function QuestSectionTitle({ children, tone }: QuestSectionTitleProps) {
  const toneClass =
    tone === 'sky'
      ? 'text-sky-300/90'
      : tone === 'yellow'
        ? 'text-yellow-300/90'
        : 'text-amber-300/90';
  return (
    <h2 className={`flex items-center gap-2 text-sm font-black uppercase tracking-widest ${toneClass}`}>
      {children}
    </h2>
  );
}
