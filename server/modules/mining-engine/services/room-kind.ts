/**
 * Tipo de sala — a bifurcação do domínio, assumida em vez de disfarçada.
 *
 * Evitar usar exports de `nft-room-mining` no init de módulo (ciclo
 * room-kind ↔ nft-room-mining → TDZ em `NFT_AUTO_ALLOWED_CHASSIS_ID`).
 */
import { normalizePlacedRackRoomId } from './rack-room-id.js';
import { isNftMiningRoomId, NFT_AUTO_ROOM_ID } from './nft-room-mining.js';

/** `standard` = sala comum; `nft` = Sala NFT (regras próprias). */
export type RoomKind = 'standard' | 'nft';

/** Espelha `NFT_AUTO_ALLOWED_CHASSIS_ID` em nft-room-mining — literal para partir o ciclo ESM. */
const NFT_ROOM_ALLOWED_CHASSIS_ID = 'rack_armario_1';

export const ROOM_KIND_RULES = {
  standard: {
    allowedChassisId: null as string | null,
    asicMachinesOnly: false,
    coinComesFromMachine: false
  },
  nft: {
    allowedChassisId: NFT_ROOM_ALLOWED_CHASSIS_ID,
    asicMachinesOnly: true,
    coinComesFromMachine: true
  }
} as const satisfies Record<RoomKind, { allowedChassisId: string | null; asicMachinesOnly: boolean; coinComesFromMachine: boolean }>;

export function resolveRoomKind(roomId: unknown, nftRoomIds?: ReadonlySet<string> | null): RoomKind {
  const ids = nftRoomIds ?? new Set<string>([NFT_AUTO_ROOM_ID]);
  return isNftMiningRoomId(roomId == null ? null : String(roomId), ids) ? 'nft' : 'standard';
}

export function roomRules(roomId: unknown, nftRoomIds?: ReadonlySet<string> | null) {
  return ROOM_KIND_RULES[resolveRoomKind(roomId, nftRoomIds)];
}

/**
 * Sala NFT aceita só o chassis exclusivo; a Sala ASICs aceita-o além dos normais
 * (`listSlotMiningCredits` credita-o nas duas salas, logo montar tem de ser
 * permitido nas duas); salas standard rejeitam-no.
 */
export function isChassisAllowedInRoom(
  chassisId: string,
  roomId: unknown,
  nftRoomIds?: ReadonlySet<string> | null,
  asicRoomIds?: ReadonlySet<string> | null,
  roomName?: unknown
): boolean {
  const id = String(chassisId || '').trim();
  const exclusive = ROOM_KIND_RULES.nft.allowedChassisId;
  if (resolveRoomKind(roomId, nftRoomIds) === 'nft') return id === exclusive;
  if (id !== exclusive) return true;
  return isAsicMiningRoomId(roomId, asicRoomIds, roomName);
}

/** Salas onde o chassis exclusivo pode viver — Sala NFT + Sala ASICs. */
export function isExclusiveChassisRoom(
  roomId: unknown,
  nftRoomIds?: ReadonlySet<string> | null,
  asicRoomIds?: ReadonlySet<string> | null,
  roomName?: unknown
): boolean {
  if (resolveRoomKind(roomId, nftRoomIds) === 'nft') return true;
  return isAsicMiningRoomId(roomId, asicRoomIds, roomName);
}

/** Sala ASICs canónica (`SALA DAS ASICS`) — distinta da Sala NFT. */
export const ASIC_ROOM_ID = 'room_1775484506874';

export const ASIC_POLICY_ROOM_NAME_KEYS = ['sala das asics'] as const;

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

export function isAsicMiningRoomId(
  roomId: unknown,
  asicRoomIds?: ReadonlySet<string> | null,
  roomName?: unknown
): boolean {
  const id = normalizePlacedRackRoomId(roomId != null ? String(roomId) : '');
  if (asicRoomIds?.has(id)) return true;
  if (id === normalizePlacedRackRoomId(ASIC_ROOM_ID)) return true;
  const kn = normalizeRigRoomPolicyNameKey(roomName);
  return (ASIC_POLICY_ROOM_NAME_KEYS as readonly string[]).includes(kn);
}

type DbQueryFn = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<{ id?: unknown }> }>;
};

export async function resolveAsicRoomIds(q: DbQueryFn): Promise<Set<string>> {
  const r = await q.query(
    `SELECT id FROM rig_rooms
     WHERE id = $1
        OR lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) = ANY($2::text[])`,
    [ASIC_ROOM_ID, ASIC_POLICY_ROOM_NAME_KEYS]
  );
  const ids = new Set<string>();
  for (const row of r.rows) {
    const id = row.id != null ? String(row.id).trim() : '';
    if (id) ids.add(normalizePlacedRackRoomId(id));
  }
  ids.add(normalizePlacedRackRoomId(ASIC_ROOM_ID));
  return ids;
}
