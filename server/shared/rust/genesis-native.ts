/**
 * Loader for the optional Rust native addon (`genesis-node`).
 * Falls back silently when the `.node` binary is absent (dev without Rust build).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type GenesisNativeMerge = {
  mergePing?: () => string;
  mergeNormalizeRarity?: (raw: string) => string;
  mergeComputeResultStatsJson?: (sourceJson: string, settingsJson: string) => string | null | undefined;
  mergeSourceCatalogsEquivalentJson?: (leftJson: string, rightJson: string) => boolean;
};

export type GenesisNativeCalculator = {
  calculatorPing?: () => string;
  calculatorComputeSnapshotJson?: (inputJson: string) => string;
};

export type GenesisNativeAuth = {
  authPing?: () => string;
  authValidateLoginFieldsJson?: (email?: string, password?: string) => string;
  authValidateLoginEmailJson?: (email?: string) => string;
  authValidateLoginPasswordJson?: (password?: string) => string;
  authPasswordStrengthJson?: (password: string) => string;
  authAssertSignupEmailJson?: (email: string) => string;
  authValidateUsernameJson?: (username?: string) => string;
  authValidateSignupPasswordJson?: (password: string | undefined, required: boolean) => string;
  authValidateReferralJson?: (code?: string) => string;
  authValidateWalletJson?: (wallet?: string) => string;
  authGenerateReferralCode?: (username: string) => string;
  authBuildSignedTokenJson?: (purpose: string, email: string, expiryMs: number, secret: string) => string;
  authParseSignedTokenJson?: (purpose: string, token: string, secret: string, nowMs: number) => string;
  authHashTokenSha256?: (token: string) => string;
  authTimingSafeHexEqual?: (a: string, b: string) => boolean;
  authLockoutStatusJson?: (lockedUntilMs: number | undefined, nowMs: number) => string;
  authEmailFlagsJson?: (emailVerified: number, emailVerificationRequired: number) => string;
  authSanitizeFingerprintJson?: (rawJson: string) => string | null | undefined;
};

export type GenesisNativeTransparency = {
  transparencyPing?: () => string;
  transparencyComputeHealthJson?: (
    entriesJson: string,
    nowMs: number,
    cashJson?: string
  ) => string;
};

export type GenesisNativeCheckin = {
  checkinPing?: () => string;
  checkinUtcDayFromMs?: (ms: number) => string;
  checkinPeriodStartMs?: (nowMs: number) => number;
  checkinWindowJson?: (lastCheckinAtMs: number | undefined, nowMs: number) => string;
};

export type GenesisNativeGameNav = {
  gameNavPing?: () => string;
  gameNavBuildJson?: (inputJson: string) => string;
};

export type GenesisNativeMining = {
  miningPing?: () => string;
  miningTenMinMs?: () => number;
  miningEffectiveNetworkJson?: (
    coinId: string,
    dbNetworkHashrate: number,
    runtimeJson: string,
    impliedJson: string,
    independentPool: boolean
  ) => number;
  miningNetworkFromYieldPerHash?: (
    yieldPerHash: number,
    blockReward: number,
    blockTimeSec: number
  ) => number;
  miningUtcMidnightMs?: (ts: number) => number;
  miningLastCompletedTenMinGrid?: (ts: number) => number;
  miningCreditCapNowMs?: (nowMs: number, gridEnabled: boolean) => number;
  miningListPendingBoundariesJson?: (checkpointMs: number, capMs: number) => string;
  miningListCreditWindowsJson?: (startMs: number, endMs: number) => string;
  miningCalculateIntegratedYieldJson?: (startMs: number, endMs: number, historyJson: string) => number;
  miningBuildBlockHistoryRowsJson?: (optsJson: string) => string;
  miningConsolidateBlockHistoryJson?: (rowsJson: string) => string;
  miningAssertTickEconomyJson?: (totalGainedJson: string, rowsJson: string) => void;
  miningBuildYieldBoundaryJson?: (
    coinsJson: string,
    realNetworkJson: string,
    effectiveAtMs: number
  ) => string;
};

export type GenesisNativePartnerGames = {
  partnerGamesPing?: () => string;
  partnerGamesSessionConfigJson?: () => string;
  partnerGamesAcceptHeartbeatJson?: (lastMs: number | undefined, nowMs: number) => string;
};

export type GenesisNativeMarket = {
  marketPing?: () => string;
  marketClampPageJson?: (limit?: number, offset?: number) => string;
  marketClampTaxPercent?: (raw: number) => number;
  marketReservedUntil?: (nowMs: number) => number;
  marketReservationActive?: (reservedUntilMs: number | undefined, nowMs: number) => boolean;
  marketBandReferenceUsd?: (baseCost: number, bookFallback?: number) => number;
};

export type GenesisNativeLuckyBoxes = {
  luckyBoxesPing?: () => string;
  luckyBoxesRollIndependentJson?: (itemsJson: string, samplesJson: string) => string;
  luckyBoxesRollGrantAllJson?: (itemsJson: string, samplesJson: string) => string;
};

export type GenesisNativeWallet = {
  walletPing?: () => string;
  walletParseDeskPercent?: (raw: number) => number | null | undefined;
  walletFractionAllowedJson?: (fraction: number, mode: string) => string;
};

export type GenesisNativeHeader = {
  headerPing?: () => string;
  headerAggregateHashJson?: (entriesJson: string) => string;
};

export type GenesisNativeCatalog = {
  catalogPing?: () => string;
  catalogParseUpgradeWriteRowsJson?: (rawListJson: string) => string;
  catalogAssertCanonicalIdsImmutableJson?: (rowsJson: string) => string;
  catalogIsProtectedUpgradeRowJson?: (
    id: string,
    category?: string,
    rowType?: string
  ) => boolean;
};

export type GenesisNative = GenesisNativeMerge &
  GenesisNativeCalculator &
  GenesisNativeAuth &
  GenesisNativeTransparency &
  GenesisNativeCheckin &
  GenesisNativeGameNav &
  GenesisNativeMining &
  GenesisNativePartnerGames &
  GenesisNativeMarket &
  GenesisNativeLuckyBoxes &
  GenesisNativeWallet &
  GenesisNativeHeader &
  GenesisNativeCatalog;

let cached: GenesisNative | null | undefined;

export function loadGenesisNative(): GenesisNative | null {
  if (cached !== undefined) return cached;
  try {
    const require = createRequire(import.meta.url);
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(dir, '../../../native/genesis.node'),
      path.join(dir, '../../../../native/genesis.node'),
      path.join(process.cwd(), 'native/genesis.node')
    ];
    for (const candidate of candidates) {
      try {
        cached = require(candidate) as GenesisNative;
        return cached;
      } catch {
        /* try next */
      }
    }
    cached = null;
    return cached;
  } catch {
    cached = null;
    return cached;
  }
}

export function genesisRustEnabled(): boolean {
  const v = String(process.env.GENESIS_USE_RUST ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function genesisCalculatorRustEnabled(): boolean {
  const v = String(process.env.GENESIS_CALCULATOR_RUST ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function genesisAuthRustEnabled(): boolean {
  const v = String(process.env.GENESIS_AUTH_RUST ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function genesisTransparencyRustEnabled(): boolean {
  const v = String(process.env.GENESIS_TRANSPARENCY_RUST ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function genesisCheckinRustEnabled(): boolean {
  const v = String(process.env.GENESIS_CHECKIN_RUST ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function genesisNavRustEnabled(): boolean {
  const v = String(process.env.GENESIS_NAV_RUST ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Network math only (2 modelos). Progress/cron I/O stays Node. */
export function genesisMiningRustEnabled(): boolean {
  const v = String(process.env.GENESIS_MINING_RUST ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Partner Games (BlockMiner) session config + heartbeat gate. */
export function genesisPartnerGamesRustEnabled(): boolean {
  const v = String(process.env.GENESIS_PARTNER_GAMES_RUST ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Black-market page/tax/reserve helpers. */
export function genesisMarketRustEnabled(): boolean {
  const v = String(process.env.GENESIS_MARKET_RUST ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Lucky-box loot rolls (samples from Node RNG). */
export function genesisLuckyBoxesRustEnabled(): boolean {
  const v = String(process.env.GENESIS_LUCKY_BOXES_RUST ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Wallet desk percent / fraction helpers (deposits stay Node). */
export function genesisWalletRustEnabled(): boolean {
  const v = String(process.env.GENESIS_WALLET_RUST ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Player-game header hash aggregation (`totalHash` / `hashByCoinId`). */
export function genesisHeaderRustEnabled(): boolean {
  const v = String(process.env.GENESIS_HEADER_RUST ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Catalog / Shop hardware write-path validation (parse + identity). */
export function genesisCatalogRustEnabled(): boolean {
  const v = String(process.env.GENESIS_CATALOG_RUST ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}
