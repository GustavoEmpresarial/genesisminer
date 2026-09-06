/**
 * Padding wrapper for Hub pages that do not self-pad
 * (`mini_blog`, `support`). Quests / transparency pad themselves.
 */
import type { ReactNode } from 'react';

type HubPageFrameProps = {
  children: ReactNode;
  /** Tighter padding (e.g. support mobile). */
  compact?: boolean;
};

export function HubPageFrame({ children, compact = false }: HubPageFrameProps) {
  return (
    <div
      className={
        compact
          ? 'flex min-h-0 w-full min-w-0 flex-1 flex-col p-2 sm:p-4 lg:p-6'
          : 'flex min-h-0 w-full min-w-0 flex-1 flex-col p-3 sm:p-4 lg:p-6'
      }
    >
      {children}
    </div>
  );
}
