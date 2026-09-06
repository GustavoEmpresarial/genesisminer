import React from 'react';
import type { Upgrade } from '../../servers/types';
import { getUpgradeMarketSpecs } from '../lib/upgradeMarketSpec';

const TONE_CLASS = {
  green: 'text-emerald-400',
  orange: 'text-orange-400',
  sky: 'text-sky-400',
  yellow: 'text-yellow-400',
  slate: 'text-slate-400'
} as const;

type Props = {
  item: Upgrade;
  catalog?: Upgrade[];
  className?: string;
  /** Mostra só o valor (sem label) — mais compacto nos cards. */
  compact?: boolean;
};

export const UpgradeMarketSpecLine: React.FC<Props> = ({ item, catalog = [], className = '', compact = true }) => {
  const specs = getUpgradeMarketSpecs(item, catalog);
  if (specs.length === 0) return null;

  return (
    <div className={`min-w-0 space-y-0.5 ${className}`}>
      {specs.map((s) => (
        <div
          key={s.label}
          className={`truncate text-[10px] font-mono leading-snug ${TONE_CLASS[s.tone || 'slate']}`}
          title={`${s.label}: ${s.value}`}
        >
          {compact ? s.value : `${s.label}: ${s.value}`}
        </div>
      ))}
    </div>
  );
};
