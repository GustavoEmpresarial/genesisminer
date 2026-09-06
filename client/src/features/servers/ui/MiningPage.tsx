/**
 * Mining / servers Hub view — room intents + sticky daily check-in (desktop `lg+`).
 * Mobile uses dedicated `checkin` GameView. DECISIONS #81 / #97 · GAME_SHELL.md.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../../shared/i18n';
import { WalletRoomLockOverlay } from '../../wallet';
import { DailyCheckinBanner } from '../../checkin';
import { ServerRoom } from './ServerRoom';
import {
  getGlobalInventoryVersion,
  getGlobalLastLoadTime,
  getServersState,
  newServerIntentIdempotencyKey,
  postServerRoomRoomCoins,
  postServersPlaceRack,
  postServersRackAuxEquip,
  postServersRackAuxUnequip,
  postServersRackMinerEquip,
  postServersRackMinerUnequip,
  postServersRemoveRack,
  saveServersState,
  setGlobalLastLoadTime,
  type ServersRackAuxIntentOk
} from '../api/servers';
import type { AsicLeaseDetail, MiningCoin, PlacedRack, StoredBattery, Upgrade } from '../types';
import {
  isNftAutoArmario1OnlyRoom,
  isNftAutoArmario1OnlyRoomContext,
  isNftCollectibleMachine,
  isNftRoomExclusiveMiningCoin,
  isAsicSalaRoomContext,
  isAsicMachineUpgrade,
  normalizePlacedRackRoomId,
  isChassisAllowedForRoomAffinity,
  resolveChassisRackRoomAffinity,
  resolveClientRoomKind,
  chassisRoomAffinityRejectMessage,
  type RackRoomAffinity
} from '../types';

type MiningPageProps = {
  userEmail?: string;
  onOpenCalculator?: () => void;
  /** Push USDC balance to chrome (navbar). */
  onUsdcChange?: (usdc: number) => void;
  /** Refresh GameShell header snapshot (H/s, token powers) after check-in. */
  onHeaderRefresh?: () => void | Promise<void>;
  /** Gameplay wallet gate (see GameShell `useWalletGate`). Default true — never
   * gates the room unless the caller explicitly says the wallet is missing. */
  hasWallet?: boolean;
  onOpenWalletConnect?: () => void;
  /** Em gerência no mobile não há banner sticky por defeito — força o banner. */
  isManagingAccount?: boolean;
};

/** Viewport band below GameShell chrome — overlay is pinned here, not to full ServerRoom height. */
const MINING_GATE_VIEWPORT = 'h-[calc(100dvh-11rem)]';

function MiningWalletGate({
  hasWallet,
  onOpenWalletConnect,
  children
}: {
  hasWallet: boolean;
  onOpenWalletConnect?: () => void;
  children: ReactNode;
}) {
  if (hasWallet) {
    return <>{children}</>;
  }

  return (
    <div className={`relative overflow-hidden ${MINING_GATE_VIEWPORT}`}>
      <div
        className={`pointer-events-none select-none overflow-hidden blur-sm grayscale brightness-75 ${MINING_GATE_VIEWPORT}`}
      >
        {children}
      </div>
      <WalletRoomLockOverlay
        onConnect={onOpenWalletConnect}
        className={`absolute inset-x-0 top-0 z-20 ${MINING_GATE_VIEWPORT}`}
      />
    </div>
  );
}

function applyServerSnapshot(
  out: ServersRackAuxIntentOk,
  setters: {
    setStock: (v: Record<string, number>) => void;
    setStoredBatteries: (v: StoredBattery[]) => void;
    setPlacedRacks: (v: PlacedRack[]) => void;
  }
) {
  setters.setStock({ ...out.stock });
  setters.setStoredBatteries([...out.storedBatteries]);
  setters.setPlacedRacks([...out.placedRacks]);
}

export function MiningPage({
  userEmail,
  onOpenCalculator,
  onUsdcChange,
  onHeaderRefresh,
  hasWallet = true,
  onOpenWalletConnect,
  isManagingAccount = false
}: MiningPageProps) {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const [stock, setStock] = useState<Record<string, number>>({});
  const [storedBatteries, setStoredBatteries] = useState<StoredBattery[]>([]);
  const [placedRacks, setPlacedRacks] = useState<PlacedRack[]>([]);
  const [usdc, setUsdc] = useState(0);
  const [upgrades, setUpgrades] = useState<Upgrade[]>([]);
  const [miningCoins, setMiningCoins] = useState<MiningCoin[]>([]);
  const [nftAsicMinedUsdTotal, setNftAsicMinedUsdTotal] = useState(0);
  const [asicRoomMinedUsdTotal, setAsicRoomMinedUsdTotal] = useState(0);
  const [asicLeaseDetails, setAsicLeaseDetails] = useState<AsicLeaseDetail[]>([]);

  const placedRacksRef = useRef(placedRacks);
  const stockRef = useRef(stock);
  const storedBatteriesRef = useRef(storedBatteries);
  const rackPlaceBusyRef = useRef(false);
  const rackAuxIntentBusyRef = useRef(false);

  useEffect(() => {
    placedRacksRef.current = placedRacks;
  }, [placedRacks]);
  useEffect(() => {
    stockRef.current = stock;
  }, [stock]);
  useEffect(() => {
    storedBatteriesRef.current = storedBatteries;
  }, [storedBatteries]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const pack = await getServersState();
        if (cancelled) return;
        if (!pack) {
          setLoadError(t('mining.loadError'));
          setLoading(false);
          return;
        }
        const version = pack.stateVersion ?? pack.serverUpdatedAt;
        if (version > 0) setGlobalLastLoadTime(version);
        setStock({ ...pack.stock });
        setStoredBatteries([...pack.storedBatteries]);
        setPlacedRacks([...pack.placedRacks]);
        setUsdc(pack.usdc);
        onUsdcChange?.(pack.usdc);
        setUpgrades([...pack.upgrades]);
        setMiningCoins([...pack.miningCoins]);
        setNftAsicMinedUsdTotal(pack.nftAsicMinedUsdTotal ?? 0);
        setAsicRoomMinedUsdTotal(pack.asicRoomMinedUsdTotal ?? 0);
        setAsicLeaseDetails([...(pack.asicLeaseDetails ?? [])]);
        setLoading(false);
      } catch {
        if (!cancelled) {
          setLoadError(t('mining.unexpectedError'));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadNonce, t, onUsdcChange]);

  const bumpReload = useCallback(() => setReloadNonce((n) => n + 1), []);

  const handleRewardGranted = useCallback(() => {
    bumpReload();
    void onHeaderRefresh?.();
  }, [bumpReload, onHeaderRefresh]);

  const applySnapshot = useCallback((out: ServersRackAuxIntentOk) => {
    applyServerSnapshot(out, { setStock, setStoredBatteries, setPlacedRacks });
    void onHeaderRefresh?.();
  }, [onHeaderRefresh]);

  const persistPlacedRacks = useCallback(async (nextRacks: PlacedRack[]) => {
    const res = await saveServersState({
      placedRacks: nextRacks,
      stock: stockRef.current,
      storedBatteries: storedBatteriesRef.current
    });
    if (!res.ok) {
      if (res.forceReload) bumpReload();
      alert(res.error || t('mining.saveFailed'));
      return false;
    }
    if (res.placedRacks) setPlacedRacks([...res.placedRacks]);
    else setPlacedRacks(nextRacks);
    if (res.stock) setStock({ ...res.stock });
    if (res.storedBatteries) setStoredBatteries([...res.storedBatteries]);
    void onHeaderRefresh?.();
    return true;
  }, [bumpReload, t, onHeaderRefresh]);

  const handlePlaceRack = useCallback(
    async (
      typeId: string,
      roomId: string,
      slotIndex: number,
      ctx?: { roomName?: string; nftAutoArmario1Only?: boolean; roomKind?: string; rackRoomAffinity?: RackRoomAffinity }
    ) => {
      const kind = resolveClientRoomKind({
        roomId,
        roomName: ctx?.roomName,
        roomKind: ctx?.roomKind,
        nftAutoArmario1Only: ctx?.nftAutoArmario1Only
      });
      const affinity = resolveChassisRackRoomAffinity(typeId, ctx?.rackRoomAffinity);
      if (!isChassisAllowedForRoomAffinity(affinity, kind)) {
        alert(chassisRoomAffinityRejectMessage(affinity, kind));
        return;
      }
      if (!userEmail || rackPlaceBusyRef.current) return;
      rackPlaceBusyRef.current = true;
      const roomNorm = normalizePlacedRackRoomId(roomId);
      try {
        const out = await postServersPlaceRack({
          catalogItemId: typeId,
          roomId: roomNorm,
          slotIndex,
          idempotencyKey: newServerIntentIdempotencyKey(),
          clientStateVersion: getGlobalLastLoadTime(),
          inventoryVersion: getGlobalInventoryVersion()
        });
        if (out.ok !== true) {
          if (out.forceReload || out.code === 'STATE_VERSION_CONFLICT' || out.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH') {
            bumpReload();
          }
          alert(out.error || t('mining.placeFailed'));
          return;
        }
        applySnapshot(out);
      } finally {
        rackPlaceBusyRef.current = false;
      }
    },
    [userEmail, bumpReload, applySnapshot, t]
  );

  const handleRemoveRack = useCallback(
    async (rackId: string) => {
      if (!confirm(t('mining.removeConfirm'))) {
        return;
      }
      if (!userEmail || rackPlaceBusyRef.current) return;
      rackPlaceBusyRef.current = true;
      try {
        const out = await postServersRemoveRack(rackId);
        if (out.ok !== true) {
          if (out.forceReload || out.code === 'STATE_VERSION_CONFLICT' || out.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH') {
            bumpReload();
          }
          alert(out.error || t('mining.removeFailed'));
          return;
        }
        applySnapshot(out);
      } finally {
        rackPlaceBusyRef.current = false;
      }
    },
    [userEmail, bumpReload, applySnapshot, t]
  );

  const handleEquipMiner = useCallback(
    async (rid: string, idx: number, mid: string) => {
      if (!userEmail || rackAuxIntentBusyRef.current) return;
      rackAuxIntentBusyRef.current = true;
      try {
        const out = await postServersRackMinerEquip(rid, idx, mid);
        if (out.ok !== true) {
          if (out.status === 409 || out.forceReload) bumpReload();
          alert(out.error || t('mining.equipGpuFailed'));
          return;
        }
        applySnapshot(out);
      } catch {
        alert(t('mining.equipGpuFailed'));
      } finally {
        rackAuxIntentBusyRef.current = false;
      }
    },
    [userEmail, bumpReload, applySnapshot, t]
  );

  const handleUnequipMiner = useCallback(
    async (rid: string, idx: number) => {
      if (!userEmail || rackAuxIntentBusyRef.current) return;
      rackAuxIntentBusyRef.current = true;
      try {
        const out = await postServersRackMinerUnequip(rid, idx);
        if (out.ok !== true) {
          if (out.status === 409 || out.forceReload) bumpReload();
          alert(out.error || t('mining.unequipGpuFailed'));
          return;
        }
        applySnapshot(out);
      } catch {
        alert(t('mining.unequipGpuFailed'));
      } finally {
        rackAuxIntentBusyRef.current = false;
      }
    },
    [userEmail, bumpReload, applySnapshot, t]
  );

  const handleEquipAux = useCallback(
    async (rid: string, iid: string, type: string, _sbid?: string, idx?: number) => {
      if (!userEmail || rackAuxIntentBusyRef.current) return;
      rackAuxIntentBusyRef.current = true;
      try {
        if (type === 'battery') {
          const out = await postServersRackAuxEquip(rid, {
            kind: 'battery',
            catalogItemId: iid
          });
          if (out.ok !== true) {
            if (out.status === 409 || out.forceReload) bumpReload();
            alert(out.error);
            return;
          }
          applySnapshot(out);
        } else if (type === 'wiring') {
          const out = await postServersRackAuxEquip(rid, { kind: 'wiring', catalogItemId: iid });
          if (out.ok !== true) {
            if (out.status === 409 || out.forceReload) bumpReload();
            alert(out.error);
            return;
          }
          applySnapshot(out);
        } else if (type === 'multiplier' && idx !== undefined) {
          const out = await postServersRackAuxEquip(rid, {
            kind: 'multiplier',
            catalogItemId: iid,
            multiplierSlotIndex: idx
          });
          if (out.ok !== true) {
            if (out.status === 409 || out.forceReload) bumpReload();
            alert(out.error);
            return;
          }
          applySnapshot(out);
        }
      } finally {
        rackAuxIntentBusyRef.current = false;
      }
    },
    [userEmail, bumpReload, applySnapshot]
  );

  const handleUnequipAux = useCallback(
    async (rid: string, type: string, idx?: number) => {
      if (!userEmail || rackAuxIntentBusyRef.current) return;
      rackAuxIntentBusyRef.current = true;
      try {
        if (type === 'multiplier' && idx === undefined) return;
        const body =
          type === 'multiplier'
            ? ({ kind: 'multiplier' as const, multiplierSlotIndex: idx ?? 0 } as const)
            : type === 'wiring'
              ? ({ kind: 'wiring' as const } as const)
              : ({ kind: 'battery' as const } as const);
        const out = await postServersRackAuxUnequip(rid, body);
        if (out.ok !== true) {
          if (out.status === 409 || out.forceReload) bumpReload();
          alert(out.error);
          return;
        }
        applySnapshot(out);
      } finally {
        rackAuxIntentBusyRef.current = false;
      }
    },
    [userEmail, bumpReload, applySnapshot]
  );

  const handleTogglePower = useCallback(
    (rid: string) => {
      const cur = placedRacksRef.current;
      const ri = cur.findIndex((r) => r.id === rid);
      if (ri === -1) return;
      const rack = cur[ri];
      const roomNorm = normalizePlacedRackRoomId(rack.roomId);
      const nftRoom = isNftAutoArmario1OnlyRoom({ id: roomNorm });
      const asicRoom = isAsicSalaRoomContext(roomNorm);

      if (!rack.isOn) {
        const missing: string[] = [];
        if (!nftRoom && !asicRoom && !rack.selectedCoinId) missing.push(t('mining.needCoin'));
        if (!rack.batteryId) missing.push(t('mining.needBattery'));
        if (!rack.wiringId) missing.push(t('mining.needWiring'));
        const equipped = rack.slots.filter((s): s is string => Boolean(s));
        if (equipped.length === 0) {
          missing.push(nftRoom || asicRoom ? t('mining.needAsic') : t('mining.needGpu'));
        } else if (nftRoom) {
          for (const sid of equipped) {
            const up = upgrades.find((u) => u.id === sid);
            if (!up || !isNftCollectibleMachine(up)) {
              missing.push(t('mining.asicNftRoomOnly'));
              break;
            }
            if (!up.nftMiningCoinId) {
              missing.push(t('mining.asicMissingCoin', { name: up.name || sid }));
            }
          }
        } else if (asicRoom) {
          for (const sid of equipped) {
            const up = upgrades.find((u) => u.id === sid);
            if (!up || !isAsicMachineUpgrade(up)) {
              missing.push(t('mining.needAsic'));
              break;
            }
          }
        }
        if (missing.length > 0) {
          alert(t('mining.systemLocked', { list: missing.map((m) => '• ' + m).join('\n') }));
          return;
        }
      }

      const ur = [...cur];
      ur[ri] = { ...ur[ri], isOn: !ur[ri].isOn };
      setPlacedRacks(ur);
      void persistPlacedRacks(ur);
    },
    [upgrades, persistPlacedRacks, t]
  );

  const handleSetRackCoin = useCallback(
    (rid: string, coinId: string) => {
      const cur = placedRacksRef.current;
      const ri = cur.findIndex((r) => r.id === rid);
      if (ri === -1) return;
      const rack = cur[ri];
      const roomKind = resolveClientRoomKind({
        roomId: normalizePlacedRackRoomId(rack.roomId)
      });
      if (roomKind === 'nft' || roomKind === 'asic') return;
      const coin = coinId ? miningCoins.find((c) => c.id === coinId) : null;
      if (coinId && coin && !coin.isActive) return;
      if (
        coinId &&
        coin &&
        isNftRoomExclusiveMiningCoin(coin) &&
        !isNftAutoArmario1OnlyRoomContext(normalizePlacedRackRoomId(rack.roomId))
      ) {
        alert(t('mining.nftExclusiveCoin'));
        return;
      }
      const ur = [...cur];
      const selected = coinId && coin ? coinId : undefined;
      ur[ri] = { ...ur[ri], selectedCoinId: selected, isOn: selected ? ur[ri].isOn : false };
      setPlacedRacks(ur);
      void persistPlacedRacks(ur);
    },
    [miningCoins, persistPlacedRacks, t]
  );

  const handleSetRoomRacksCoin = useCallback(
    async (roomId: string, coinId: string) => {
      const roomNorm = normalizePlacedRackRoomId(roomId);
      const roomKind = resolveClientRoomKind({ roomId: roomNorm });
      if (roomKind === 'nft' || roomKind === 'asic') return;
      if (coinId) {
        const coin = miningCoins.find((c) => c.id === coinId);
        if (coin && isNftRoomExclusiveMiningCoin(coin) && !isNftAutoArmario1OnlyRoomContext(roomNorm)) {
          alert(t('mining.nftExclusiveCoin'));
          return;
        }
      }
      const res = await postServerRoomRoomCoins(roomNorm, coinId);
      if (!res.ok) {
        alert('error' in res ? res.error : t('mining.unknownError'));
        return;
      }
      setPlacedRacks([...res.placedRacks]);
    },
    [miningCoins, t]
  );

  const handleRoomPurchase = useCallback(
    (newUsdc: number) => {
      if (typeof newUsdc === 'number' && Number.isFinite(newUsdc)) {
        setUsdc(newUsdc);
        onUsdcChange?.(newUsdc);
      }
    },
    [onUsdcChange]
  );

  if (loading) {
    return (
      <MiningWalletGate hasWallet={hasWallet} onOpenWalletConnect={onOpenWalletConnect}>
        <div className="flex w-full flex-1 items-center justify-center rounded-xl border border-amber-900/20 bg-slate-900/80 font-mono text-amber-500">
          <div className="animate-pulse py-24 text-xl tracking-widest">{t('mining.loadingRoom')}</div>
        </div>
      </MiningWalletGate>
    );
  }

  if (loadError) {
    return (
      <MiningWalletGate hasWallet={hasWallet} onOpenWalletConnect={onOpenWalletConnect}>
        <div className="flex w-full flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-red-900/30 bg-slate-900/80 px-6 py-24 text-center font-mono text-slate-200">
          <p className="max-w-md text-sm text-red-300">{loadError}</p>
          <button
            type="button"
            onClick={bumpReload}
            className="rounded-lg border border-amber-500/60 bg-amber-600/20 px-4 py-2 text-sm font-bold text-amber-200 transition hover:bg-amber-600/30"
          >
            {t('mining.retryLoad')}
          </button>
        </div>
      </MiningWalletGate>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={isManagingAccount ? undefined : 'hidden lg:block'}>
        <DailyCheckinBanner
          saveLoaded={!loading && !loadError}
          onRewardGranted={handleRewardGranted}
        />
      </div>
      <div className="flex flex-1 animate-in fade-in zoom-in-95 flex-col space-y-3 p-2 duration-300 sm:space-y-6 sm:p-6">
        <MiningWalletGate hasWallet={hasWallet} onOpenWalletConnect={onOpenWalletConnect}>
          <ServerRoom
            stock={stock}
            storedBatteries={storedBatteries}
            placedRacks={placedRacks}
            usdc={usdc}
            upgrades={upgrades}
            miningCoins={miningCoins}
            userEmail={userEmail}
            onPlaceRack={handlePlaceRack}
            onRemoveRack={handleRemoveRack}
            onEquipMiner={handleEquipMiner}
            onUnequipMiner={handleUnequipMiner}
            onEquipAux={handleEquipAux}
            onUnequipAux={handleUnequipAux}
            onTogglePower={handleTogglePower}
            onSetRackCoin={handleSetRackCoin}
            onSetRoomRacksCoin={handleSetRoomRacksCoin}
            onRoomPurchase={handleRoomPurchase}
            onOpenCalculator={onOpenCalculator}
            nftAsicMinedUsdTotal={nftAsicMinedUsdTotal}
            asicRoomMinedUsdTotal={asicRoomMinedUsdTotal}
            asicLeaseDetails={asicLeaseDetails}
          />
        </MiningWalletGate>
      </div>
    </div>
  );
}
