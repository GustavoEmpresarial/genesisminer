export type PlayerCalculatorCoinRow = { label: string; coins: number; usd: number };

export type PlayerCalculatorCoinPayload = {
  id: string;
  symbol: string;
  name: string;
  priceUSD: number;
  networkHashrate: number;
  blockReward: number;
  blockTime: number;
  userPowerHps: number;
  dailyCoins: number;
  dailyUsd: number;
  projection30Usd: number;
  nftRoomOnly: boolean;
  independentPool: boolean;
  rows: PlayerCalculatorCoinRow[];
  blockHistory: Array<{
    id: string;
    roomId: string | null;
    windowStartMs: number;
    windowEndMs: number;
    creditedBlocks: number;
    amountCoins: number;
    amountUsd: number;
    userHashHps: number;
    networkHashrate: number;
    blockReward: number;
    blockTime: number;
  }>;
};

export type PlayerCalculatorScopeOption = { id: string; name: string };

export type PlayerCalculatorCoinComparison = {
  id: string;
  symbol: string;
  name: string;
  priceUSD: number;
  isActivelyMining: boolean;
  dailyCoins: number;
  dailyUsd: number;
  projection30Usd: number;
  rows: PlayerCalculatorCoinRow[];
};

export type PlayerCalculatorSnapshot = {
  scope: string;
  scopesUi: PlayerCalculatorScopeOption[];
  generalPowerHps: number;
  coinComparisons: PlayerCalculatorCoinComparison[];
  coins: PlayerCalculatorCoinPayload[];
};
