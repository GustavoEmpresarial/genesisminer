/**
 * DTO público de `GET /api/servers/state` — sem campos internos de utilizador.
 * Valores numéricos já normalizados (sem BigInt).
 *
 * Migrado de legacy/backend/modules/servers/servers.types.ts, verbatim.
 */
export type ServersStatePlacedRackDto = {
  id: string;
  itemId: string;
  slots: unknown[];
  /** Lease IDs alinhados a `slots` (ASIC NFT timed). */
  slotLeaseIds?: (string | null)[];
  multiplierSlots: unknown[];
  wiringId: string | null;
  batteryId: string | null;
  isOn: boolean;
  selectedCoinId: string | null;
  roomId: string;
  slotIndex: number;
  batteryCatalogItemId?: string | null;
  batteryDisplayName?: string | null;
  batteryImageUrl?: string | null;
};

export type ServersStateStoredBatteryDto = {
  id: string;
  itemId: string;
  displayName: string | null;
  imageUrl: string | null;
};

export type ServersStateAsicLeaseDetailDto = {
  leaseId: string;
  itemId: string;
  expiresAt: number;
  status: 'stock' | 'equipped';
  rackId: string | null;
  slotIndex: number | null;
};

export type ServersAuthoritativeStateDto = {
  version: 1;
  usdc: number;
  serverUpdatedAt: number;
  /** Igual a `serverUpdatedAt` — controlo de versão para mutações idempotentes/optimistic lock. */
  stateVersion: number;
  stock: Record<string, number>;
  storedBatteries: ServersStateStoredBatteryDto[];
  placedRacks: ServersStatePlacedRackDto[];
  rigRooms: unknown[];
  miningCoins: unknown[];
  upgrades: unknown[];
  /** USD acumulado creditado a ASICs NFT (payback). */
  nftAsicMinedUsdTotal: number;
  asicLeaseDetails: ServersStateAsicLeaseDetailDto[];
};
