/**
 * Tipos do `GET /api/dashboard/state` — espelham `backend/modules/dashboard/dashboard.types.ts`.
 * Manter sincronizado com o backend (campos opcionais para retro-compatibilidade).
 */

export type DashboardMinerStatus = 'online' | 'idle' | 'offline';

export interface DashboardMinerState {
  status: DashboardMinerStatus;
  levelLabel: string | null;
  accessLevelId: string | null;
  hashTotal: number;
  hashByCoinId: Record<string, number>;
  energyPercent: number | null;
  energyChargeWh: number | null;
  energyCapacityWh: number | null;
  rigsOnline: number;
  rigsTotal: number;
}

export interface DashboardTokenBalance {
  coinId: string;
  symbol: string;
  name: string;
  amount: number;
  usdcRate: number;
}

export interface DashboardWalletState {
  usdc: number;
  tokens: DashboardTokenBalance[];
}

export type DashboardEcosystemModuleStatus = 'available' | 'coming_soon';

export interface DashboardEcosystemModule {
  id: string;
  title: string;
  subtitle: string;
  imageUrl: string | null;
  href: string;
  external: boolean;
  status: DashboardEcosystemModuleStatus;
}

export type DashboardNotificationType = 'system' | 'reward' | 'event' | 'info';

export interface DashboardNotification {
  id: string;
  type: DashboardNotificationType;
  title: string;
  message: string;
  link?: string | null;
  createdAt: number;
  read: boolean;
}

export interface DashboardEvent {
  id: string;
  title: string;
  subtitle: string;
  endsAt: number | null;
  status: 'active' | 'upcoming' | 'ended';
}

export interface DashboardRankingEntry {
  position: number;
  username: string;
  hash: number;
  hashUnit: string;
  isMe: boolean;
}

export interface DashboardRanking {
  top: DashboardRankingEntry[];
  myPosition: number | null;
  myHash: number;
}

export interface DashboardQuickAccessItem {
  id: string;
  title: string;
  viewId: string | null;
  href: string;
  icon: string;
}

export interface DashboardState {
  serverTime: number;
  miner: DashboardMinerState;
  wallet: DashboardWalletState;
  ecosystemModules: DashboardEcosystemModule[];
  notifications: DashboardNotification[];
  events: DashboardEvent[];
  ranking: DashboardRanking;
  quickAccess: DashboardQuickAccessItem[];
}

/** Resultado discriminado por `ok` (`getDashboardState` nunca lança). */
export type DashboardStateResult =
  | { ok: true; data: DashboardState }
  | { ok: false; status: number; error: string };
