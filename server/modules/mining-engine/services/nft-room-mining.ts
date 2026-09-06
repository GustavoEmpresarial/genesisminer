/**
 * Sala NFT (`SALA NFTs` / NFTs AUTO): apenas ASICs; cada modelo de ASIC minera
 * a moeda definida em `upgrades.nft_mining_coin_id` (painel admin).
 * Distinta da Sala ASICs (`SALA DAS ASICS` / plano `sala_das_asics`).
 *
 * Migrado de legacy/backend/lib/nftRoomMining.ts (verbatim).
 */
import { normalizePlacedRackRoomId } from './rack-room-id.js';
// Só a constante — não importar `isAsicMiningRoomId` (room-kind → nft-room-mining = ciclo).
import { ASIC_ROOM_ID } from './room-kind.js';

export const NFT_AUTO_ROOM_ID = 'room_1777158991085'; // SALA NFTs
export const NFT_AUTO_ALLOWED_CHASSIS_ID = 'rack_armario_1';
export const NFT_AUTO_POLICY_ROOM_NAME_KEYS = [
  'sala nfts',
  'nfts auto',
  'nft auto',
  'nfts arbam',
  'sala dolar/nfts',
  'sala dolar / nfts'
] as const;

/** Só mineiráveis na Sala NFT (ASIC + moeda admin). Símbolos canónicos (uppercase). */
export const NFT_ROOM_EXCLUSIVE_MINING_COIN_SYMBOLS = ['USDT', 'USDC', 'CBBTC', 'DAI', 'GHO', 'GEMT', 'GENT'] as const;

/** Stables: fallback $1 em payback se taxa USD ausente na BD. */
export const NFT_ROOM_STABLE_USD_SYMBOLS = ['DAI', 'USDT', 'USDC', 'GHO'] as const;

/**
 * Moedas internas (Dólar F2P/Gênesis) — NÃO exclusivas da Sala NFT.
 * Precisa de allowlist: o id `usdc_interno` casa com o prefixo `usdc_` das chaves exclusivas.
 */
export const NFT_ROOM_NON_EXCLUSIVE_MINING_COIN_IDS = ['usdc_interno'] as const;
export const NFT_ROOM_NON_EXCLUSIVE_MINING_COIN_SYMBOLS = ['USDC_INT'] as const;

const NFT_EXCLUSIVE_COIN_ID_KEYS = ['usdt', 'usdc', 'cbbtc', 'dai', 'gho', 'gemt'] as const;

export function normalizeMiningCoinSymbolKey(symbol: unknown): string {
  return String(symbol ?? '')
    .trim()
    .toUpperCase();
}

function isNftRoomNonExclusiveMiningCoinId(id: unknown): boolean {
  const low = String(id ?? '')
    .trim()
    .toLowerCase();
  if (!low) return false;
  return (NFT_ROOM_NON_EXCLUSIVE_MINING_COIN_IDS as readonly string[]).includes(low);
}

function isNftRoomNonExclusiveMiningCoinSymbol(symbol: unknown): boolean {
  const sym = normalizeMiningCoinSymbolKey(symbol);
  if (!sym) return false;
  return (NFT_ROOM_NON_EXCLUSIVE_MINING_COIN_SYMBOLS as readonly string[]).includes(sym);
}

export function isNftRoomExclusiveMiningCoinSymbol(symbol: unknown): boolean {
  const sym = normalizeMiningCoinSymbolKey(symbol);
  if (!sym) return false;
  if (isNftRoomNonExclusiveMiningCoinSymbol(sym)) return false;
  if ((NFT_ROOM_EXCLUSIVE_MINING_COIN_SYMBOLS as readonly string[]).includes(sym)) return true;
  // Moedas renomeadas no admin (ex.: NFT_DAI, NFT_USDT).
  return sym.startsWith('NFT_');
}

/** Por flag BD, id/símbolo canónico, ou id de `mining_coins`. */
export function isNftRoomExclusiveMiningCoinRef(
  ref: { id?: unknown; symbol?: unknown; nft_room_only?: unknown; nftRoomOnly?: unknown } | string | null | undefined
): boolean {
  if (ref == null) return false;
  if (typeof ref === 'object') {
    if (isNftRoomNonExclusiveMiningCoinId(ref.id) || isNftRoomNonExclusiveMiningCoinSymbol(ref.symbol)) {
      return false;
    }
    const flag = ref.nft_room_only ?? ref.nftRoomOnly;
    if (flag === 1 || flag === true) return true;
  }
  if (typeof ref === 'string') {
    const low = ref.trim().toLowerCase();
    if (!low) return false;
    if (isNftRoomNonExclusiveMiningCoinId(low) || isNftRoomNonExclusiveMiningCoinSymbol(low)) return false;
    return (NFT_EXCLUSIVE_COIN_ID_KEYS as readonly string[]).some((k) => low === k || low.endsWith(`_${k}`) || low.startsWith(`${k}_`));
  }
  if (isNftRoomExclusiveMiningCoinSymbol(ref.symbol)) return true;
  return isNftRoomExclusiveMiningCoinRef(String(ref.id ?? ''));
}

export const NFT_ROOM_EXCLUSIVE_COIN_ERROR = 'USDT, USDC, cbBTC, DAI, GHO, and GEMT can only be mined by ASICs in the NFT Room.';

/** Same English string as `POST /api/server-room/room-coins` NFT auto-room reject. */
export const NFT_ROOM_COIN_LOCKED_ERROR =
  'In the NFT Room each ASIC uses the coin set in the admin panel (per model). Bulk coin change is not allowed here.';

/** Same English string as `POST /api/server-room/room-coins` ASIC-room reject. */
export const ASIC_ROOM_COIN_LOCKED_ERROR =
  'In the ASIC Room each machine uses the coin set in the admin panel (per model). Bulk coin change is not allowed here.';

/** Power ON: standard rooms need a selected coin; NFT/ASIC rooms take coin from the machine catalog. */
export function rackPowerIsOn(
  wantOn: boolean,
  coinComesFromMachine: boolean,
  hasSelectedCoin: boolean
): boolean {
  return wantOn && (coinComesFromMachine || hasSelectedCoin);
}

/**
 * Pool de rede independente (NFT exclusivas / `usdc_interno` / …).
 * Rede efectiva = só piso admin (`max(floor, MIN)`; ignora live/implied).
 * Não partilha hashrate com outros jogadores; não entra no comparativo GPU.
 */
export function isIndependentNetworkPoolMiningCoinRef(
  ref: { id?: unknown; symbol?: unknown; nft_room_only?: unknown; nftRoomOnly?: unknown } | string | null | undefined
): boolean {
  if (ref == null) return false;
  if (typeof ref === 'string') {
    if (isNftRoomNonExclusiveMiningCoinId(ref) || isNftRoomNonExclusiveMiningCoinSymbol(ref)) return true;
    return isNftRoomExclusiveMiningCoinRef(ref);
  }
  if (isNftRoomNonExclusiveMiningCoinId(ref.id) || isNftRoomNonExclusiveMiningCoinSymbol(ref.symbol)) {
    return true;
  }
  return isNftRoomExclusiveMiningCoinRef(ref);
}

/** Fora da Sala NFT uma moeda exclusiva não se persiste — limpa, não recusa o lote. */
export function coerceSelectedCoinOutsideNftRoom(
  coinId: string | null,
  isExclusive: boolean
): string | null {
  if (coinId == null || coinId.trim() === '') return null;
  return isExclusive ? null : coinId;
}

export type UpgradeMiningRow = {
  id?: unknown;
  type?: unknown;
  category?: unknown;
  base_production?: unknown;
  multiplier?: unknown;
  nft_mining_coin_id?: unknown;
};

// Faixa de acentos combinantes Unicode U+0300–U+036F, construída via fromCharCode
// pra evitar corrupção de escape \uXXXX em regex literal (achado ao migrar safe-text.ts).
const COMBINING_DIACRITICS_RANGE_START = 0x0300;
const COMBINING_DIACRITICS_RANGE_END = 0x036f;
const COMBINING_DIACRITICS_RE = new RegExp(
  `[${String.fromCharCode(COMBINING_DIACRITICS_RANGE_START)}-${String.fromCharCode(COMBINING_DIACRITICS_RANGE_END)}]`,
  'g'
);

function normalizeRigRoomPolicyNameKey(name: unknown): string {
  return String(name ?? '')
    .normalize('NFD')
    .replace(COMBINING_DIACRITICS_RE, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function isNftAutoRoomId(roomId: string | null | undefined): boolean {
  const id = normalizePlacedRackRoomId(roomId);
  return id === NFT_AUTO_ROOM_ID;
}

/** Salas NFT (id fixo + nomes «NFTs AUTO», etc.) — alinhado com `resolveNftAutoArmario1OnlyRoomIds`. */
export function isNftMiningRoomId(roomId: string | null | undefined, nftRoomIds: ReadonlySet<string>): boolean {
  const id = normalizePlacedRackRoomId(roomId);
  return nftRoomIds.has(id);
}

export async function resolveNftAutoArmario1OnlyRoomIds(q: {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<{ id?: unknown }> }>;
}): Promise<Set<string>> {
  const r = await q.query(
    `SELECT id FROM rig_rooms
     WHERE id = $1
        OR lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) = ANY($2::text[])`,
    [NFT_AUTO_ROOM_ID, NFT_AUTO_POLICY_ROOM_NAME_KEYS]
  );
  const ids = new Set<string>();
  for (const row of r.rows) {
    const id = row.id != null ? String(row.id).trim() : '';
    if (id) ids.add(normalizePlacedRackRoomId(id));
  }
  ids.add(normalizePlacedRackRoomId(NFT_AUTO_ROOM_ID));
  return ids;
}


/** @deprecated Importar de `mining-coin-price.js` — re-export para compat. */
export { resolveMiningCoinUsdRate } from './mining-coin-price.js';

export function isNftAutoArmario1OnlyRoomRow(row: { id?: unknown; name?: unknown }): boolean {
  const id = String(row.id ?? '').trim();
  if (id === NFT_AUTO_ROOM_ID) return true;
  const kn = normalizeRigRoomPolicyNameKey(row.name);
  return (NFT_AUTO_POLICY_ROOM_NAME_KEYS as readonly string[]).includes(kn);
}

export function isAsicMachineUpgradeRow(up: UpgradeMiningRow | null | undefined): boolean {
  if (!up || String(up.type ?? '') !== 'machine') return false;
  const id = String(up.id ?? '').trim().toLowerCase();
  if (id.startsWith('asic_')) return true;
  const cat = String(up.category ?? '').trim().toLowerCase();
  return cat.includes('asic');
}

export const NFT_ROOM_EXCLUDED_MACHINE_IDS = ['gpu_iceberg_v1', 'rally_v3'] as const;

/** O mesmo modelo aparece renomeado com/sem prefixo de família (`gpu_iceberg_v1` = `iceberg_v1`). */
const MACHINE_FAMILY_ID_PREFIXES = ['gpu_', 'asic_', 'nft_'] as const;

function machineIdExclusionKey(id: unknown): string {
  const low = String(id ?? '').trim().toLowerCase();
  const prefix = (MACHINE_FAMILY_ID_PREFIXES as readonly string[]).find((p) => low.startsWith(p));
  return prefix ? low.slice(prefix.length) : low;
}

function isNftRoomExcludedMachineId(id: unknown): boolean {
  const key = machineIdExclusionKey(id);
  if (!key) return false;
  return (NFT_ROOM_EXCLUDED_MACHINE_IDS as readonly string[]).some((excluded) => machineIdExclusionKey(excluded) === key);
}

/**
 * Colecionável NFT — id `nft_*` ou categoria com «nft».
 * Não inclui ASIC real (`asic_*` / category asic); esses vão para a Sala ASICs.
 */
export function isNftCollectibleMachineRow(up: UpgradeMiningRow | null | undefined): boolean {
  if (!up || String(up.type ?? '') !== 'machine') return false;
  const id = String(up.id ?? '').trim().toLowerCase();
  if (isNftRoomExcludedMachineId(id)) return false;
  if (isAsicMachineUpgradeRow(up)) return false;
  if (id.startsWith('nft_')) return true;
  return String(up.category ?? '')
    .trim()
    .toLowerCase()
    .includes('nft');
}

/**
 * Máquina com moeda fixada no admin (`nft_mining_coin_id`) sem ser ASIC nem colecionável
 * — ex. a GPU `dolar_f2p2`. Conta como catálogo NFT (validade/credit-catalog).
 */
export function isAdminMiningCoinMachineRow(up: UpgradeMiningRow | null | undefined): boolean {
  if (!up || String(up.type ?? '') !== 'machine') return false;
  if (isNftRoomExcludedMachineId(up.id)) return false;
  return nftMiningCoinIdFromUpgrade(up) != null;
}

/**
 * Catálogo legado: ASIC real, colecionável NFT **ou** máquina com moeda admin.
 * Mantido para timed-lease / credit-catalog / callers que ainda tratam todos;
 * gates da Sala NFT usam `isNftCollectibleMachineRow`.
 */
export function isNftRoomCatalogMachineRow(up: UpgradeMiningRow | null | undefined): boolean {
  if (isAsicMachineUpgradeRow(up)) return true;
  if (isNftCollectibleMachineRow(up)) return true;
  return isAdminMiningCoinMachineRow(up);
}

export function nftMiningCoinIdFromUpgrade(up: UpgradeMiningRow | null | undefined): string | null {
  if (!up) return null;
  const c = String(up.nft_mining_coin_id ?? '').trim();
  return c || null;
}

export function rackMultiplierFactor(multiplierSlots: string[], upgradesMap: Map<string, UpgradeMiningRow>, rackItemId?: string | null): number {
  let mult = 1;
  for (const sid of multiplierSlots) {
    if (!sid) continue;
    const up = upgradesMap.get(String(sid));
    if (!up) continue;
    const m = Number(up.multiplier);
    if (Number.isFinite(m)) mult += m;
  }
  const rid = rackItemId != null ? String(rackItemId).trim() : '';
  if (rid) {
    const rackUp = upgradesMap.get(rid);
    if (rackUp && String(rackUp.type ?? '') === 'infrastructure') {
      const m = Number(rackUp.multiplier);
      if (Number.isFinite(m) && m > 0) mult += m;
    }
  }
  return mult;
}

export type SlotMiningCredit = {
  coinId: string;
  /** Hashrate efectivo (base × multiplicadores da rig). */
  effectiveBaseProd: number;
  /** false = ASIC/NFT; não entra em ranking geral / totalHash; ainda aparece em hashByCoinId do header. */
  countsTowardGeneralPower: boolean;
};

export function creditCountsTowardGeneralPower(c: SlotMiningCredit): boolean {
  return c.countsTowardGeneralPower === true;
}

/** Gate estreito de propósito: máquina com moeda admin (ex. `dolar_f2p2`) continua no poder geral. */
function slotCountsTowardGeneralPower(up: UpgradeMiningRow): boolean {
  return !(isNftCollectibleMachineRow(up) || isAsicMachineUpgradeRow(up));
}

/** Sala ASICs canónica ou ids resolvidos em BD (`asicRoomIds`). Evita ciclo com room-kind. */
function isAsicRoomForMiningCredits(
  roomId: string | null | undefined,
  asicRoomIds?: ReadonlySet<string>
): boolean {
  const id = normalizePlacedRackRoomId(roomId);
  if (!id) return false;
  if (asicRoomIds?.has(id)) return true;
  return id === normalizePlacedRackRoomId(ASIC_ROOM_ID);
}

/**
 * Créditos de mineração por moeda:
 * - sala NFT: cada slot colecionável `nft_*` na moeda admin (`nft_mining_coin_id`);
 * - sala normal: se slots máquina têm `nft_mining_coin_id` (mesmo exclusiva, ex. PIONEIROS → GEMT),
 *   credita essa moeda fixa por slot; senão usa `selected_coin_id` da rig.
 * `countsTowardGeneralPower` é false para máquinas ASIC/NFT, toda a Sala NFT,
 * e toda a Sala ASICs (qualquer slot nessa room — yield continua; general power não).
 */
export function listSlotMiningCredits(
  roomId: string | null | undefined,
  slots: string[],
  multiplierSlots: string[],
  upgradesMap: Map<string, UpgradeMiningRow>,
  rackSelectedCoinId: string,
  nftRoomIds?: ReadonlySet<string>,
  rackItemId?: string | null,
  asicRoomIds?: ReadonlySet<string>
): SlotMiningCredit[] {
  const mult = rackMultiplierFactor(multiplierSlots, upgradesMap, rackItemId);
  const isNftRoom = nftRoomIds ? isNftMiningRoomId(roomId, nftRoomIds) : isNftAutoRoomId(roomId);
  const isAsicRoom = isAsicRoomForMiningCredits(roomId, asicRoomIds);
  const chassis = rackItemId != null ? String(rackItemId).trim() : '';

  // rack_armario_1 só minera em Sala NFT ou Sala ASICs (não em salas standard).
  if (!isNftRoom && !isAsicRoom && chassis === NFT_AUTO_ALLOWED_CHASSIS_ID) {
    return [];
  }

  if (!isNftRoom) {
    // Mixed rack: fixed-coin machines (ex. Dólar F2P → usdc_interno) + sibling GPUs
    // on selectedCoinId. Never early-return only fixedCredits (drops GPU power).
    // Sala ASICs inteira: tudo special (countsTowardGeneralPower false), como Sala NFT.
    const fixedCredits: SlotMiningCredit[] = [];
    let generalBase = 0;
    let specialBase = 0;
    for (const sid of slots) {
      if (!sid) continue;
      const up = upgradesMap.get(String(sid));
      if (!up) continue;
      const bp = Number(up.base_production);
      if (!Number.isFinite(bp) || bp <= 0) continue;

      if (String(up.type ?? '') === 'machine') {
        const fixedCoinId = nftMiningCoinIdFromUpgrade(up);
        if (fixedCoinId) {
          fixedCredits.push({
            coinId: fixedCoinId,
            effectiveBaseProd: bp * mult,
            countsTowardGeneralPower: isAsicRoom ? false : slotCountsTowardGeneralPower(up)
          });
          continue;
        }
      }

      if (!isAsicRoom && slotCountsTowardGeneralPower(up)) generalBase += bp;
      else specialBase += bp;
    }

    const cid = rackSelectedCoinId.trim();
    const selectedCoinCredits: SlotMiningCredit[] = [];
    if (cid && !isNftRoomExclusiveMiningCoinRef(cid)) {
      if (generalBase > 0) {
        selectedCoinCredits.push({ coinId: cid, effectiveBaseProd: generalBase * mult, countsTowardGeneralPower: true });
      }
      if (specialBase > 0) {
        selectedCoinCredits.push({ coinId: cid, effectiveBaseProd: specialBase * mult, countsTowardGeneralPower: false });
      }
    }
    return [...fixedCredits, ...selectedCoinCredits];
  }

  const out: SlotMiningCredit[] = [];
  for (const sid of slots) {
    if (!sid) continue;
    const up = upgradesMap.get(String(sid));
    if (!up || !isNftCollectibleMachineRow(up)) continue;
    const coinId = nftMiningCoinIdFromUpgrade(up);
    if (!coinId) continue;
    const bp = Number(up.base_production);
    if (!Number.isFinite(bp) || bp <= 0) continue;
    out.push({ coinId, effectiveBaseProd: bp * mult, countsTowardGeneralPower: false });
  }
  return out;
}

type DbQueryFn = (text: string) => Promise<unknown>;

/**
 * Moedas escolhidas em «Moeda na Sala NFT (por ASIC)» ficam exclusivas da sala NFT
 * e deixam de poder ser farmadas em rigs/GPUs normais.
 */
/** Na Sala NFT a moeda vem do ASIC (`nft_mining_coin_id`); `selectedCoinId` na rig confunde validação. */
export function stripSelectedCoinFromNftRoomRacks<T extends { roomId?: unknown; itemId?: unknown; selectedCoinId?: unknown }>(
  racks: readonly T[],
  nftRoomIds: ReadonlySet<string>
): T[] {
  return racks.map((r) => {
    const room = normalizePlacedRackRoomId(r.roomId);
    const isNftRig = nftRoomIds.has(room);
    if (!isNftRig) return r;
    if (r.selectedCoinId == null || String(r.selectedCoinId).trim() === '') return r;
    return { ...r, selectedCoinId: undefined };
  });
}

/** Sala ASICs: moeda fixa por modelo (`nft_mining_coin_id` → usdc_interno); rig coin selector desligado. */
export function stripSelectedCoinFromAsicRoomRacks<T extends { roomId?: unknown; selectedCoinId?: unknown }>(
  racks: readonly T[],
  asicRoomIds: ReadonlySet<string>
): T[] {
  return racks.map((r) => {
    const room = normalizePlacedRackRoomId(r.roomId);
    if (!asicRoomIds.has(room)) return r;
    if (r.selectedCoinId == null || String(r.selectedCoinId).trim() === '') return r;
    return { ...r, selectedCoinId: undefined };
  });
}

/** Leftover de moeda exclusiva em sala normal: limpa `selectedCoinId`, não recusa o lote. */
export function stripExclusiveSelectedCoinFromNonNftRacks<T extends { roomId?: unknown; selectedCoinId?: unknown }>(
  racks: readonly T[],
  nftRoomIds: ReadonlySet<string>
): T[] {
  return racks.map((r) => {
    const room = normalizePlacedRackRoomId(r.roomId);
    if (nftRoomIds.has(room)) return r;
    const raw = r.selectedCoinId == null ? null : String(r.selectedCoinId);
    const next = coerceSelectedCoinOutsideNftRoom(raw, raw != null && isNftRoomExclusiveMiningCoinRef(raw));
    if (next === raw) return r;
    return { ...r, selectedCoinId: next };
  });
}

export async function syncNftRoomOnlyFlagsFromAsicUpgrades(query: DbQueryFn): Promise<void> {
  await query(`
    UPDATE mining_coins SET nft_room_only = 1
    WHERE id IN (
      SELECT DISTINCT btrim(nft_mining_coin_id)
      FROM upgrades
      WHERE nft_mining_coin_id IS NOT NULL AND btrim(nft_mining_coin_id) <> ''
    )
      AND id NOT IN ('usdc_interno')
      AND upper(btrim(symbol)) NOT IN ('USDC_INT')
  `);
  await query(`
    UPDATE mining_coins SET nft_room_only = 0
    WHERE nft_room_only = 1
      AND id NOT IN (
        SELECT DISTINCT btrim(nft_mining_coin_id)
        FROM upgrades
        WHERE nft_mining_coin_id IS NOT NULL AND btrim(nft_mining_coin_id) <> ''
      )
      AND lower(btrim(id)) NOT IN ('usdt', 'cbbtc', 'dai', 'gho', 'gemt')
      AND upper(btrim(symbol)) NOT IN ('USDT', 'CBBTC', 'DAI', 'GHO', 'GEMT')
      AND NOT (lower(btrim(id)) ~ '(^|[_-])(usdt|cbbtc|dai|gho|gemt)([_-]|$)')
  `);
  // Dólar Free/Gênesis: sempre mineável fora da Sala NFT (mesmo com nft_mining_coin_id no ASIC).
  await query(`
    UPDATE mining_coins SET nft_room_only = 0
    WHERE id = 'usdc_interno'
       OR upper(btrim(symbol)) = 'USDC_INT'
  `);
}
