import type { User } from '../../../shared/types/auth';

export function useWalletGate(user: User | null | undefined): { hasWallet: boolean } {
  const w = String(user?.polygonWallet || '').trim();
  return { hasWallet: w.length > 0 };
}
