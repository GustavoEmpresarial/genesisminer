/** Tipos de domínio da sala (extraídos de legacy/frontend/types.ts). */
export interface SlotLayout {
  id: string; // for machines: 'slot_0', 'slot_1'..., for aux: 'battery', 'wiring', 'ai_0'...
  type: 'machine' | 'battery' | 'wiring' | 'multiplier' | 'power' | 'config' | 'coin_selector' | 'battery_bar' | 'production_display'
  | 'stat_monitor';
  x: number; // percentage 0-100
  y: number; // percentage 0-100
  w: number; // percentage
  h: number; // percentage
}

export interface RigLayout {
  slots: SlotLayout[];
  canvasWidth?: number;  // Reference width (e.g. 500px)
  canvasHeight?: number; // Reference height (e.g. 800px)
}

export type UpgradeRarity =
  | 'common'
  | 'uncommon'
  | 'rare'
  | 'epic'
  | 'legendary'
  | 'supreme';

export type RoomKind = 'standard' | 'nft' | 'asic';

/** Valores canónicos de afinidade de sala (singles, pairs, any). */
export type RackRoomAffinity =
  | 'standard'
  | 'nft'
  | 'asic'
  | 'any'
  | 'asic+nft'
  | 'asic+standard'
  | 'nft+standard';

export const ROOM_KINDS = ['asic', 'nft', 'standard'] as const satisfies readonly RoomKind[];

export const RACK_ROOM_AFFINITY_VALUES = [
  'standard',
  'nft',
  'asic',
  'any',
  'asic+nft',
  'asic+standard',
  'nft+standard'
] as const satisfies readonly RackRoomAffinity[];

/** Chassis comum sem campo na BD: Prisma `upgrades.rack_room_affinity @default("standard")`. */
export const COMMON_CHASSIS_DEFAULT_RACK_ROOM_AFFINITY = 'standard' as const satisfies RackRoomAffinity;

const ROOM_KIND_COUNT = ROOM_KINDS.length;
const AFFINITY_KIND_JOIN = '+';
const AFFINITY_TOKEN_SPLIT_RE = /[+,\s]+/;
const ROOM_KIND_SET: ReadonlySet<string> = new Set(ROOM_KINDS);

function isRoomKindToken(t: string): t is RoomKind {
  return ROOM_KIND_SET.has(t);
}

export interface Upgrade {
  id: string;
  name: string;
  category: string;
  type: 'machine' | 'infrastructure' | 'battery' | 'wiring' | 'multiplier';
  baseCost: number;
  baseProduction: number; // Production per second
  powerConsumption?: number; // Watts (consumed per second)
  powerCapacity?: number; // Watt-hours (total energy storage)
  multiplier?: number; // Percentage increase (e.g. 0.1 for 10%)
  slotsCapacity?: number; // For racks: number of machine slots
  aiSlotsCapacity?: number; // For racks: number of machine slots
  description: string;
  icon: string;

  // New Fields for Editor & Market Logic
  status: 'normal' | 'legacy' | 'exclusive' | 'limited';
  maxGlobalStock?: number; // For limited editions
  totalSold?: number; // Total sold count for limited editions
  /** Raridade para Merge Station (GPUs / Chips IA). */
  rarity?: UpgradeRarity;

  // Visuals
  image?: string; // Base64 or URL of the item image (AI Generated)

  // Circuit Effects
  energyConsumptionReduction?: number; // 0.1 = 10% reduction for rigs


  // Compatibility Logic
  compatibleRacks?: string[]; // Rack IDs (base ou merge). Linhagem merge↔base é aceite em runtime.

  // Custom Layout (for infrastructure/racks)
  layout?: RigLayout;

  // Market Availability
  sellInHardwareMarket?: boolean;
  sellInBlackMarket?: boolean;
  mergeEnabled?: boolean;
  isActive?: boolean;
  isNft?: boolean;
  /** Moeda fixa da máquina (ASIC/NFT). null = sem moeda fixa (chave presente no JSON). */
  nftMiningCoinId?: string | null;
  /** standard | nft | asic | any — afinidade de sala para chassis (infrastructure). */
  rackRoomAffinity?: RackRoomAffinity;
  /** Legado (dropdown antigo); preferir amount+unit */
  asicDurationKind?: AsicDurationKind;
  /** Validade: quantidade (0 = permanente) */
  asicDurationAmount?: number;
  /** day | week | month | year */
  asicDurationUnit?: AsicDurationUnit;
  visibleToAccessLevelIds?: string[];
}

export const ASIC_DURATION_KINDS = ['none', 'daily', 'weekly', 'monthly', 'annual'] as const;
export type AsicDurationKind = (typeof ASIC_DURATION_KINDS)[number];

export const ASIC_DURATION_UNITS = ['day', 'week', 'month', 'year'] as const;
export type AsicDurationUnit = (typeof ASIC_DURATION_UNITS)[number];

export const ASIC_DURATION_UNIT_LABELS: Record<AsicDurationUnit, string> = {
  day: 'Dias',
  week: 'Semanas',
  month: 'Meses',
  year: 'Anos'
};

export function resolveAsicDurationForForm(u: Pick<Upgrade, 'asicDurationAmount' | 'asicDurationUnit' | 'asicDurationKind'>): {
  permanent: boolean;
  amount: number;
  unit: AsicDurationUnit;
} {
  const amount = Math.floor(Number(u.asicDurationAmount) || 0);
  const unitRaw = u.asicDurationUnit;
  if (amount > 0 && unitRaw && ASIC_DURATION_UNITS.includes(unitRaw as AsicDurationUnit)) {
    return { permanent: false, amount, unit: unitRaw as AsicDurationUnit };
  }
  const kind = String(u.asicDurationKind || 'none').toLowerCase();
  if (kind === 'daily') return { permanent: false, amount: 1, unit: 'day' };
  if (kind === 'weekly') return { permanent: false, amount: 1, unit: 'week' };
  if (kind === 'monthly') return { permanent: false, amount: 1, unit: 'month' };
  if (kind === 'annual') return { permanent: false, amount: 1, unit: 'year' };
  return { permanent: true, amount: 7, unit: 'day' };
}

export function resolveAsicValidityLabel(u: Pick<Upgrade, 'asicDurationAmount' | 'asicDurationUnit' | 'asicDurationKind'>): string {
  const d = resolveAsicDurationForForm(u);
  if (d.permanent) return 'Permanent';
  return formatAsicDurationPreview(d.amount, d.unit);
}

/** Tempo restante até `expiresAt` (ms). */
export function formatAsicRemainingUntil(expiresAtMs: number, nowMs: number = Date.now()): string {
  const left = Math.floor(Number(expiresAtMs) - nowMs);
  if (!Number.isFinite(left) || left <= 0) return 'Expired';
  const totalSec = Math.floor(left / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return '<1m';
}

export function formatAsicDurationPreview(amount: number, unit: AsicDurationUnit): string {
  const n = Math.max(1, Math.floor(amount) || 1);
  const labels: Record<AsicDurationUnit, [string, string]> = {
    day: ['day', 'days'],
    week: ['week', 'weeks'],
    month: ['month', 'months'],
    year: ['year', 'years']
  };
  const pair = labels[unit];
  return `${n} ${n === 1 ? pair[0] : pair[1]}`;
}

export type AsicLeaseSummary = {
  itemId: string;
  inStock: number;
  equipped: number;
  nearestExpiresAt: number | null;
};

export type AsicLeaseDetail = {
  leaseId: string;
  itemId: string;
  expiresAt: number;
  status: 'stock' | 'equipped';
  rackId: string | null;
  slotIndex: number | null;
};

/** ASIC (máquina) elegível na Sala NFT — só id `asic_*` ou categoria com «asic». */
export function isAsicMachineUpgrade(u: Pick<Upgrade, 'id' | 'category' | 'type'>): boolean {
  if (u.type !== 'machine') return false;
  const id = String(u.id || '').trim().toLowerCase();
  if (id.startsWith('asic_')) return true;
  return String(u.category || '')
    .trim()
    .toLowerCase()
    .includes('asic');
}

/** Renomeações acidentais no admin — não contar como ASICs NFT. */
export const NFT_ROOM_EXCLUDED_MACHINE_IDS = ['gpu_iceberg_v1', 'rally_v3'] as const;

/**
 * Colecionável NFT — id `nft_*` ou categoria com «nft».
 * Não inclui ASIC real; esses vão para a Sala ASICs.
 */
export function isNftCollectibleMachine(
  u: Pick<Upgrade, 'id' | 'category' | 'type' | 'nftMiningCoinId'>
): boolean {
  if (String(u.type ?? '') !== 'machine') return false;
  const id = String(u.id || '').trim().toLowerCase();
  if ((NFT_ROOM_EXCLUDED_MACHINE_IDS as readonly string[]).includes(id)) return false;
  if (isAsicMachineUpgrade(u)) return false;
  if (id.startsWith('nft_')) return true;
  return String(u.category || '')
    .trim()
    .toLowerCase()
    .includes('nft');
}

/**
 * Catálogo legado: ASIC real **ou** colecionável NFT. Gates da Sala NFT usam `isNftCollectibleMachine`.
 */
export function isNftRoomCatalogMachine(
  u: Pick<Upgrade, 'id' | 'category' | 'type' | 'nftMiningCoinId'>
): boolean {
  if (isAsicMachineUpgrade(u)) return true;
  return isNftCollectibleMachine(u);
}

/** Sala padrão do projeto (AdminRigRooms); rigs antigos vinham com room_id NULL ou "main" no servidor. */
export const DEFAULT_RIG_ROOM_ID = 'room_initial';

/** Sala NFT (`SALA NFTs`) — alinhado com `NFT_AUTO_ROOM_ID` no backend. Distinta da Sala ASICs. */
export const NFT_AUTO_ROOM_ID = 'room_1777158991085'; // SALA NFTs
/** Único chassis legado NFT (fallback quando affinity em falta). */
export const NFT_AUTO_ALLOWED_CHASSIS_ID = 'rack_armario_1';

export const ASIC_ROOM_ID = 'room_1775484506874'; // SALA DAS ASICS
export const EXTRA_ROOM_ID = 'room_1776433944492'; // SALA EXTRA
export const ASIC_POLICY_ROOM_NAME_KEYS = ['sala das asics'] as const;

/** Moeda fixa dos ASICs Dólar / Gênesis (Sala ASICs) — não escolhível por rig. */
export const USDC_INTERNO_COIN_ID = 'usdc_interno';

export function findUsdcInternoMiningCoin(coins: MiningCoin[] | undefined | null): MiningCoin | undefined {
  if (!coins?.length) return undefined;
  const byId = coins.find((c) => c.id === USDC_INTERNO_COIN_ID);
  if (byId) return byId;
  return coins.find((c) => normalizeMiningCoinSymbolKey(c.symbol) === 'USDC_INT');
}

/** Moeda do primeiro colecionável `nft_*` no rack cuja `nftMiningCoinId` exista em `coins`. */
export function findNftRackDisplayCoin(
  rack: Pick<PlacedRack, 'slots'>,
  upgrades: readonly Pick<Upgrade, 'id' | 'type' | 'category' | 'nftMiningCoinId'>[],
  coins: MiningCoin[] | undefined | null
): MiningCoin | undefined {
  if (!coins?.length) return undefined;
  for (const slotId of rack.slots) {
    if (!slotId) continue;
    const up = upgrades.find((u) => u.id === slotId);
    if (!up || !isNftCollectibleMachine(up)) continue;
    const coinId = String(up.nftMiningCoinId ?? '').trim();
    if (!coinId) continue;
    const coin = coins.find((c) => c.id === coinId);
    if (coin) return coin;
  }
  return undefined;
}

/**
 * Moedas fixas do rack na Sala ASICs (únicas, ordem de aparecimento nos slots).
 * Sem preferência GEMT/USDC_INT — rack misto devolve todas.
 */
export function listAsicRackDisplayCoins(
  rack: Pick<PlacedRack, 'slots'>,
  upgrades: readonly Pick<Upgrade, 'id' | 'type' | 'category' | 'nftMiningCoinId'>[],
  coins: MiningCoin[] | undefined | null
): MiningCoin[] {
  if (!coins?.length) return [];
  const unique: MiningCoin[] = [];
  const seenIds = new Set<string>();
  for (const slotId of rack.slots) {
    if (!slotId) continue;
    const up = upgrades.find((u) => u.id === slotId);
    if (!up || !isAsicMachineUpgrade(up)) continue;
    const coinId = String(up.nftMiningCoinId ?? '').trim();
    if (!coinId || seenIds.has(coinId)) continue;
    const coin = coins.find((c) => c.id === coinId);
    if (!coin) continue;
    seenIds.add(coinId);
    unique.push(coin);
  }
  return unique;
}

/** Soma `baseProduction` das ASICs por moeda de display (mesma ordem que `listAsicRackDisplayCoins`). */
export function listAsicRackBaseProductionByCoin(
  rack: Pick<PlacedRack, 'slots'>,
  upgrades: readonly Pick<
    Upgrade,
    'id' | 'type' | 'category' | 'nftMiningCoinId' | 'baseProduction'
  >[],
  coins: MiningCoin[] | undefined | null
): { coin: MiningCoin; baseProduction: number }[] {
  const displayCoins = listAsicRackDisplayCoins(rack, upgrades, coins);
  return displayCoins.map((coin) => {
    let baseProduction = 0;
    for (const slotId of rack.slots) {
      if (!slotId) continue;
      const up = upgrades.find((u) => u.id === slotId);
      if (!up || !isAsicMachineUpgrade(up)) continue;
      if (String(up.nftMiningCoinId ?? '').trim() !== coin.id) continue;
      baseProduction += Number(up.baseProduction) || 0;
    }
    return { coin, baseProduction };
  });
}

/**
 * Primeira moeda de display do rack (compat). Preferir `listAsicRackDisplayCoins` na UI.
 * Rack vazio / sem coin resolvível → `undefined`.
 */
export function findAsicRackDisplayCoin(
  rack: Pick<PlacedRack, 'slots'>,
  upgrades: readonly Pick<Upgrade, 'id' | 'type' | 'category' | 'nftMiningCoinId'>[],
  coins: MiningCoin[] | undefined | null
): MiningCoin | undefined {
  return listAsicRackDisplayCoins(rack, upgrades, coins)[0];
}

export function isAsicSalaRoomContext(
  roomId: string | null | undefined,
  roomName?: string | null,
  roomKind?: RoomKind | string | null,
  nftAutoArmario1Only?: boolean | null
): boolean {
  return resolveClientRoomKind({
    roomId,
    roomName,
    roomKind,
    nftAutoArmario1Only: nftAutoArmario1Only === true ? true : undefined
  }) === 'asic';
}

/**
 * Parse tokens ∈ {standard,nft,asic}; vazio/0 kinds → `standard`;
 * explícito `any` ou 3 kinds → `any`; 1 → single; 2 → `a+b` sorted.
 * Aceita legado/sujo (vírgulas, espaços, case).
 */
export function normalizeRackRoomAffinity(raw: unknown): RackRoomAffinity {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (v === 'any') return 'any';

  const kinds = new Set<RoomKind>();
  for (const token of v.split(AFFINITY_TOKEN_SPLIT_RE)) {
    const t = token.trim();
    if (!t || t === 'any') continue;
    if (isRoomKindToken(t)) kinds.add(t);
  }

  if (kinds.size === 0) return 'standard';
  if (kinds.size === ROOM_KIND_COUNT) return 'any';
  if (kinds.size === 1) {
    return [...kinds][0]!;
  }
  return [...kinds].sort().join(AFFINITY_KIND_JOIN) as RackRoomAffinity;
}

/**
 * Kinds efectivamente permitidos (`any` → os três).
 *
 * - `standard`: só salas normais
 * - `asic`: só Sala ASICs (ex. Rack Army / promo — bonus e sorteios)
 * - `nft`: só Sala NFT
 * - pares (`asic+standard`, `asic+nft`, …): união dos kinds
 */
export function rackRoomAffinityKinds(affinity: RackRoomAffinity | string): RoomKind[] {
  const n = normalizeRackRoomAffinity(affinity);
  if (n === 'any') return [...ROOM_KINDS];
  if (n === 'standard' || n === 'asic' || n === 'nft') return [n];
  return n.split(AFFINITY_KIND_JOIN).filter(isRoomKindToken);
}

export function isChassisAllowedForRoomAffinity(affinity: RackRoomAffinity, roomKind: RoomKind): boolean {
  return rackRoomAffinityKinds(affinity).includes(roomKind);
}

/** Chassis de bonus/sorteio com affinity `asic` na BD (fallback se a API ainda não manda o campo). */
const ASIC_ONLY_CHASSIS_ROOT_IDS = ['rack_army', 'rack_promo'] as const;

/** Rack A3 — só salas standard (override de produto; ignora affinity da BD). */
const STANDARD_ONLY_CHASSIS_ROOT_IDS = ['rack_a63'] as const;

function isAsicOnlyChassisRootId(chassisId: string): boolean {
  const id = String(chassisId || '').trim().toLowerCase();
  if ((ASIC_ONLY_CHASSIS_ROOT_IDS as readonly string[]).includes(id)) return true;
  return ASIC_ONLY_CHASSIS_ROOT_IDS.some((root) => id.startsWith(`merge_${root}_`) || id.includes(`_${root}_`));
}

function isStandardOnlyChassisRootId(chassisId: string): boolean {
  const id = String(chassisId || '').trim().toLowerCase();
  return STANDARD_ONLY_CHASSIS_ROOT_IDS.some((root) => id === root || id.includes('_' + root + '_'));
}

export function resolveChassisRackRoomAffinity(
  chassisId: string,
  affinityFromUpgrade?: RackRoomAffinity | string | null
): RackRoomAffinity {
  // Regra de produto: Rack A3 (e merges) só salas normais — não configurável no admin.
  if (isStandardOnlyChassisRootId(chassisId)) return 'standard';
  if (affinityFromUpgrade != null && String(affinityFromUpgrade).trim() !== '') {
    return normalizeRackRoomAffinity(affinityFromUpgrade);
  }
  if (String(chassisId || '').trim() === NFT_AUTO_ALLOWED_CHASSIS_ID) return 'nft';
  if (isAsicOnlyChassisRootId(chassisId)) return 'asic';
  return COMMON_CHASSIS_DEFAULT_RACK_ROOM_AFFINITY;
}

/** Nomes normalizados de sala com a mesma política (id pode variar na BD). */
export const NFT_AUTO_POLICY_ROOM_NAME_KEYS = [
  'sala nfts',
  'nfts auto',
  'nft auto',
  'nfts arbam',
  'sala dolar/nfts',
  'sala dolar / nfts'
] as const;

/** Só mineiráveis na Sala NFT (ASIC + moeda no admin). */
export const NFT_ROOM_EXCLUSIVE_MINING_COIN_SYMBOLS = ['USDT', 'USDC', 'CBBTC', 'DAI', 'GHO', 'GEMT', 'GENT'] as const;

/** Stables NFT: payback/H/s usam fallback $1 se `usdc_rate`/`price_usd` vazios. */
export const NFT_ROOM_STABLE_USD_SYMBOLS = ['DAI', 'USDT', 'USDC', 'GHO'] as const;

/** Dólar F2P/Gênesis — não exclusivo apesar do prefixo `usdc_` no id. */
const NFT_ROOM_NON_EXCLUSIVE_MINING_COIN_IDS = ['usdc_interno'] as const;
const NFT_ROOM_NON_EXCLUSIVE_MINING_COIN_SYMBOLS = ['USDC_INT'] as const;

const NFT_EXCLUSIVE_COIN_ID_KEYS = ['usdt', 'usdc', 'cbbtc', 'dai', 'gho', 'gemt'] as const;

export const NFT_ROOM_EXCLUSIVE_COIN_ERROR_PT =
  'USDT, USDC, cbBTC, DAI, GHO, and GEMT can only be mined by ASICs in the NFT Room.';

export function normalizeMiningCoinSymbolKey(symbol: string | null | undefined): string {
  return String(symbol ?? '')
    .trim()
    .toUpperCase();
}

function isNftRoomNonExclusiveMiningCoinId(id: string): boolean {
  const low = id.trim().toLowerCase();
  return (NFT_ROOM_NON_EXCLUSIVE_MINING_COIN_IDS as readonly string[]).includes(low);
}

function isNftRoomNonExclusiveMiningCoinSymbol(symbol: string): boolean {
  const sym = normalizeMiningCoinSymbolKey(symbol);
  return (NFT_ROOM_NON_EXCLUSIVE_MINING_COIN_SYMBOLS as readonly string[]).includes(sym);
}

export function isNftRoomExclusiveMiningCoin(
  coin: Pick<MiningCoin, 'id' | 'symbol' | 'nftRoomOnly'> | string | null | undefined
): boolean {
  if (coin == null) return false;
  if (typeof coin === 'object') {
    if (isNftRoomNonExclusiveMiningCoinId(coin.id) || isNftRoomNonExclusiveMiningCoinSymbol(coin.symbol)) {
      return false;
    }
    if (coin.nftRoomOnly) return true;
  }
  if (typeof coin === 'string') {
    const low = coin.trim().toLowerCase();
    if (!low) return false;
    if (isNftRoomNonExclusiveMiningCoinId(low) || isNftRoomNonExclusiveMiningCoinSymbol(low)) return false;
    return (NFT_EXCLUSIVE_COIN_ID_KEYS as readonly string[]).some(
      (k) => low === k || low.endsWith(`_${k}`) || low.startsWith(`${k}_`)
    );
  }
  const sym = normalizeMiningCoinSymbolKey(coin.symbol);
  if (isNftRoomNonExclusiveMiningCoinSymbol(sym)) return false;
  if ((NFT_ROOM_EXCLUSIVE_MINING_COIN_SYMBOLS as readonly string[]).includes(sym)) return true;
  if (sym.startsWith('NFT_')) return true;
  return isNftRoomExclusiveMiningCoin(coin.id);
}

/**
 * Pool independente: não disputa H/s com outros (GHO_nft, exclusivas NFT, usdc_interno).
 * Alinhado a `isIndependentNetworkPoolMiningCoinRef` no servidor.
 */
export function isIndependentNetworkPoolMiningCoin(
  coin:
    | (Pick<MiningCoin, 'id' | 'symbol' | 'nftRoomOnly'> & { independentPool?: boolean })
    | string
    | null
    | undefined
): boolean {
  if (coin == null) return false;
  if (typeof coin === 'object' && coin.independentPool === true) return true;
  if (typeof coin === 'string') {
    if (isNftRoomNonExclusiveMiningCoinId(coin) || isNftRoomNonExclusiveMiningCoinSymbol(coin)) return true;
    return isNftRoomExclusiveMiningCoin(coin);
  }
  if (isNftRoomNonExclusiveMiningCoinId(coin.id) || isNftRoomNonExclusiveMiningCoinSymbol(coin.symbol)) {
    return true;
  }
  return isNftRoomExclusiveMiningCoin(coin);
}

/** Moedas que podem ser escolhidas na rig (salas normais). */
export function miningCoinsSelectableOnRig(coins: MiningCoin[]): MiningCoin[] {
  return coins.filter((c) => !isNftRoomExclusiveMiningCoin(c));
}

/** USDT, cbBTC, DAI, GHO, GEMT — selector admin e listagens NFT. */
export function filterNftRoomExclusiveMiningCoins(coins: MiningCoin[]): MiningCoin[] {
  return coins.filter((c) => isNftRoomExclusiveMiningCoin(c));
}

export function isNftRoomStableUsdCoin(
  coin: Pick<MiningCoin, 'id' | 'symbol'> | string | null | undefined
): boolean {
  if (coin == null) return false;
  const sym =
    typeof coin === 'string'
      ? normalizeMiningCoinSymbolKey(coin)
      : normalizeMiningCoinSymbolKey(coin.symbol) ||
        (isNftRoomExclusiveMiningCoin(coin.id) ? normalizeMiningCoinSymbolKey(coin.id) : '');
  return (NFT_ROOM_STABLE_USD_SYMBOLS as readonly string[]).includes(sym);
}

/** Taxa USD para payback/estimativas NFT (stables → $1; cbBTC exige taxa no admin). */
export function resolveNftRoomCoinUsdRate(coin: MiningCoin | undefined): number {
  if (!coin) return 0;
  const usdc = Number(coin.usdcRate);
  if (Number.isFinite(usdc) && usdc > 0) return usdc;
  const px = Number(coin.priceUSD);
  if (Number.isFinite(px) && px > 0) return px;
  if (isNftRoomStableUsdCoin(coin)) return 1;
  return 0;
}

/** Taxa USD para payback/estimativas da Sala ASICs (USDC_INT → $1 se usdcRate/priceUSD ≤ 0). */
export function resolveAsicRoomCoinUsdRate(coin: MiningCoin | undefined): number {
  if (!coin) return 0;
  const usdc = Number(coin.usdcRate);
  if (Number.isFinite(usdc) && usdc > 0) return usdc;
  const px = Number(coin.priceUSD);
  if (Number.isFinite(px) && px > 0) return px;
  const id = String(coin.id || '').trim().toLowerCase();
  const sym = normalizeMiningCoinSymbolKey(coin.symbol);
  if (id === USDC_INTERNO_COIN_ID || sym === 'USDC_INT') return 1;
  return 0;
}

export function normalizeRigRoomPolicyNameKey(name: string | null | undefined): string {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export function isNftAutoArmario1OnlyRoom(room: { id: string; name?: string } | null | undefined): boolean {
  if (!room?.id) return false;
  if (normalizePlacedRackRoomId(room.id) === NFT_AUTO_ROOM_ID) return true;
  const kn = normalizeRigRoomPolicyNameKey(room.name);
  return (NFT_AUTO_POLICY_ROOM_NAME_KEYS as readonly string[]).includes(kn);
}

/** Colocação de rig: usa flag/roomKind do servidor quando existir, senão id legado ou nome da sala. */
export function isNftAutoArmario1OnlyRoomContext(
  roomId: string | null | undefined,
  roomName?: string | null,
  serverNftFlag?: boolean
): boolean {
  if (serverNftFlag === true) return true;
  if (roomId != null && normalizePlacedRackRoomId(roomId) === NFT_AUTO_ROOM_ID) return true;
  return (NFT_AUTO_POLICY_ROOM_NAME_KEYS as readonly string[]).includes(normalizeRigRoomPolicyNameKey(roomName));
}

export function resolveClientRoomKind(opts: {
  roomId?: string | null;
  roomName?: string | null;
  roomKind?: RoomKind | string | null;
  nftAutoArmario1Only?: boolean;
}): RoomKind {
  // Server RoomKind is only standard|nft; ASIC room is `standard` there.
  // Id/name must beat a stale API `standard` so Sala ASICs is not treated as normal.
  if (opts.nftAutoArmario1Only === true || isNftAutoArmario1OnlyRoomContext(opts.roomId, opts.roomName, opts.nftAutoArmario1Only)) {
    return 'nft';
  }
  const id = opts.roomId != null ? normalizePlacedRackRoomId(opts.roomId) : '';
  if (id === ASIC_ROOM_ID) return 'asic';
  if ((ASIC_POLICY_ROOM_NAME_KEYS as readonly string[]).includes(normalizeRigRoomPolicyNameKey(opts.roomName))) {
    return 'asic';
  }
  const fromApi = opts.roomKind != null ? String(opts.roomKind).trim().toLowerCase() : '';
  if (fromApi === 'nft' || fromApi === 'asic' || fromApi === 'standard') return fromApi;
  return 'standard';
}

export function chassisRoomAffinityRejectMessage(affinity: RackRoomAffinity, roomKind: RoomKind): string {
  if (roomKind === 'nft') {
    return 'Only the Rack H1 NFT Collection chassis is allowed in this room.';
  }
  if (roomKind === 'asic') {
    return 'Only racks configured for the ASICs room can be placed here.';
  }
  const n = normalizeRackRoomAffinity(affinity);
  if (n === 'nft') {
    return 'The Dollar NFT Rack can only be placed in the NFT Room.';
  }
  if (n === 'asic') {
    return 'This rack can only be placed in the ASICs room.';
  }
  if (n === 'standard') {
    return 'This rack can only be placed in normal rooms.';
  }
  return 'This rack is not allowed in this room type.';
}

export function normalizePlacedRackRoomId(roomId: string | null | undefined): string {
  const s = roomId != null ? String(roomId).trim() : '';
  if (!s || s === 'main') return DEFAULT_RIG_ROOM_ID;
  return s;
}

export interface PlacedRack {
  id: string;
  itemId: string; // The upgrade ID (e.g., 'rack_10u')
  slots: (string | null)[]; // Variable size based on rack type
  /** UUID de lease por slot (ASIC com validade). */
  slotLeaseIds?: (string | null)[];
  roomId: string;
  slotIndex: number;

  // Electrical System
  wiringId: string | null; // Slot for wiring
  /** Instância (`stored_batteries.id`); não usar id de catálogo de `upgrades`. */
  batteryId: string | null;
  /** Snapshot BD: id de catálogo (`upgrades.id`) da bateria montada — UI sem depender só do armazém. */
  batteryCatalogItemId?: string | null;
  batteryDisplayName?: string | null;
  batteryImageUrl?: string | null;

  // AI System
  multiplierSlots: (string | null)[]; // Slots for AI optimizers

  isOn: boolean; // Power switch state
  selectedCoinId?: string; // Mining coin selected for this rack
}

export interface StoredBattery {
  id: string; // Instance UUID infinita (post-purge_charging migration)
  itemId: string; // Type ID (e.g. battery_estelar)
  /** Rótulo curto derivado do id (servidor). */
  publicRef?: string | null;
  displayName?: string | null;
  imageUrl?: string | null;
}

export interface MarketListing {
  id: string;
  /** ID numérico do vendedor (fonte de verdade; não confundir com reservedBy). */
  sellerId?: number;
  sellerName: string;
  itemId: string;
  /** USDC por unidade */
  price: number;
  qty: number; // Quantity of items in this listing
  /** Total USDC (price × qty). Calculado no cliente se o servidor for mais antigo. */
  lineTotal?: number;
  /** Em custódia: USDC realmente debitado ao comprar (servidor). */
  buyerPaidUsdc?: number;
  expiresAt: number; // For bots, it expires. For players, it might not expire or expire slowly.
  isPlayer?: boolean; // Flag to identify if it's a player listing
  reservedBy?: string;
  reservedUntil?: number;
  status?: 'active' | 'sold';
}

/** Linha de GET /api/market/history (compras ou vendas P2P). */
export interface P2PMarketTradeHistoryEntry {
  at: number;
  itemId: string;
  qty: number;
  unitPrice: number;
  /** Total debitado do comprador (USDC). */
  buyerPaidUsdc: number;
  /** Líquido creditado ao vendedor no cofre P2P (após taxa). */
  sellerReceivedUsdc: number;
  taxUsdc: number;
  /** Vendedor (em compras) ou comprador (em vendas). */
  counterpartName: string;
}

export interface P2PMarketTradeHistory {
  purchases: P2PMarketTradeHistoryEntry[];
  sales: P2PMarketTradeHistoryEntry[];
}

export interface SystemNews {
  id: string;
  text: string;
  link?: string;
  active: boolean;
  duration?: number; // Duration in seconds to display this news
  authorName?: string;
  createdAt: number;
  adType?: 'horizontal' | 'vertical';
  imageUrl?: string;
}

export interface AccessLevel {
  id: string;
  name: string;
  description: string;
  isDefault: boolean; // Assigned on free registration
  isActive: boolean; // If false, users with this role cannot login
  priceUsdc?: number; // If > 0, requires Web3 payment
  contractAddress?: string; // For simulation of payment
  inactiveMessage?: string; // Message shown when user tries to login with inactive role
  newsPostingEnabled?: boolean;
  allowedPages?: string[];
}

export interface RigRoom {
  id: string;
  name: string;
  initialCapacity: number;
  maxCapacity: number;
  baseSlotPrice: number;
  slotPriceIncreasePercent: number;
  /**
   * Plan/membership IDs (`access_levels.id`) that unlock this **room**.
   * Rooms ≠ plans. Plans are membership seals; rooms are mining floors.
   */
  allowedPlanIds: string[];
  allowedSeasonPassIds?: string[];
  isActive: boolean;
  sortOrder: number;
  owned?: boolean;
  unlockedSlots?: number;
  roomKind?: RoomKind;
  nftAutoArmario1Only?: boolean;
}

// LOOT BOXES
export type LootBoxTrigger = string;

export interface LootBoxItem {
  id: string; // If type=item: upgrade ID • if currency: 'usdc' • if coin: mining coin ID • if bundle: AdminUpgrade ID
  type: 'item' | 'currency' | 'coin' | 'bundle';
  minQty: number;
  maxQty: number;
  /** Loja/outros: peso na roleta (um prémio). Cadastro (`trigger=registration`): linha entra no pacote se > 0. */
  probability: number;
}

export interface LootBox {
  id: string;
  name: string;
  description: string;
  price: number; // Cost in USDC if bought in shop
  trigger: LootBoxTrigger;
  items: LootBoxItem[];
  icon: string;
  isActive?: boolean;
}

export interface GameState {
  usdc: number;
  blackMarketBalance?: number;
  startTime: number;

  stock: Record<string, number>;
  unopenedBoxes: Record<string, number>; // ID of LootBox -> Quantity
  claimedBoxes?: string[]; // IDs of unique lootboxes already claimed by the player
  storedBatteries: StoredBattery[];
  placedRacks: PlacedRack[];
  playerListings: MarketListing[]; // Items the player is selling
  coinBalances?: Record<string, number>;
  /** USD recuperado por mineração de ASICs na Sala NFT (servidor). */
  nftAsicMinedUsdTotal?: number;
  /** USD recuperado por mineração de ASICs na Sala ASICs (servidor). */
  asicRoomMinedUsdTotal?: number;
  /** Resumo de ASICs com validade (stock/equipados + expiração mais próxima). */
  asicLeases?: AsicLeaseSummary[];
  /** Leases activos (para tempo restante por slot). */
  asicLeaseDetails?: AsicLeaseDetail[];

  // Referral State
  claimedReferrals: number;
  referralBonusClaimed: boolean;

  // Daily Actions State (key -> timestamp)
  dailyActions?: Record<string, number>;
}

/** Payload opcional enviado em login/registo para auditoria de dispositivo. */
export type DeviceFingerprintPayload = {
  visitorId: string;
  components: Record<string, string | number | boolean>;
};

/** Linha devolvida por GET /api/admin/device-fingerprints. */
export interface AdminDeviceFingerprintLog {
  id: string;
  userId: number;
  email: string | null;
  username: string | null;
  eventType: string;
  fingerprintHash: string;
  payloadJson: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
}

export interface User {
  username: string;
  email: string;
  password?: string;
  isAdmin?: boolean;
  /** Acesso total às rotas admin (API); operadores com só `adminPermissions` ficam restritos. */
  isSuperAdmin?: boolean;
  polygonWallet?: string; // Web3 Wallet Address
  isBlocked?: boolean; // If true, user cannot login
  accessLevelId?: string; // Linked AccessLevel ID
  accessLevelIds?: string[]; // All possessed access levels

  // Referral System
  referralCode?: string; // Unique code for this user
  referredBy?: string; // Code of the user who referred this user
  referrals?: string[]; // List of usernames referred by this user
  totalUsdcDeposited?: number;
  totalCryptoWithdrawn?: number;
  lastActiveAt?: number;
  isNewRegistration?: boolean;
  isImpersonating?: boolean;
  /** Gerente a operar a conta do dono. */
  isManagingAccount?: boolean;
  managerMode?: boolean;
  managerUserId?: number | null;
  actingAsOwnerId?: number | null;
  emailVerified?: boolean;
  emailVerificationRequired?: boolean;
  id?: string;
  adminPermissions?: string[];
  /** Não persistido no utilizador; só enviado no body de login/registo. */
  deviceFingerprint?: DeviceFingerprintPayload;
}

export interface Web3Settings {
  depositWallet: string;
  payoutWallet: string;
  depositTokenContract: string;
  depositTokenContractBnb?: string;
  depositTokenContractBase?: string;
  withdrawTokenName: string;
  withdrawTokenContract: string;
  withdrawTokens?: Array<{
    name: string;
    symbol?: string;
    coinId?: string;
    network?: 'polygon' | 'bnb' | 'base';
    contract: string;
    payoutWallet: string;
    minAmount?: number;
    minWithdrawalUsdc?: number;
    feePercent?: number;
    disabled?: boolean;
  }>;
  minDepositUsdc?: number;
  depositPolygonDisabled?: boolean;
  depositBnbDisabled?: boolean;
  depositBaseDisabled?: boolean;
}

export interface AdminUpgradeItemGrant { itemId: string; qty: number }
export interface AdminUpgradeBoxGrant { boxId: string; qty: number }
export interface AdminUpgradeCoinGrant { coinId: string; amount: number }
export interface AdminUpgrade {
  id: string;
  name: string;
  description: string;
  priceUsdc: number;
  grantUsdc?: number;
  grantAccessLevelId?: string;
  isActive?: boolean;
  items?: AdminUpgradeItemGrant[];
  boxes?: AdminUpgradeBoxGrant[];
  passes?: string[];
  coins?: AdminUpgradeCoinGrant[];
  visibleToAccessLevelIds?: string[];
}

export interface MiningCoin {
  id: string;
  name: string;
  symbol: string;
  networkHashrate: number;
  blockReward: number;
  blockTime: number;
  priceUSD: number;
  displayPriceUsd?: number;
  livePriceUsd?: number | null;
  algorithm: string;
  difficulty: number;
  multiplier: number;
  color: string;
  description: string;
  minProportion: number; // minimum proportion based on miner power
  usdcRate: number; // value per USDC
  isActive: boolean; // if false, visible but not selectable
  /** Marcada na BD: só pode ser mineirada na Sala NFT (ASIC). Persiste após renomear. */
  nftRoomOnly?: boolean;
  /** Pool independente: não disputa H/s com outros (piso admin). */
  independentPool?: boolean;
  showInExchange: boolean;
  realNetworkHashrate?: number;
  targetDailyUSD?: number;
}

