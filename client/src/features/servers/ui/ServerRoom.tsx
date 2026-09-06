import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import {
    PlacedRack,
    StoredBattery,
    Upgrade,
    RigRoom,
    MiningCoin,
    type AsicLeaseDetail,
    normalizePlacedRackRoomId,
    miningCoinsSelectableOnRig,
    resolveClientRoomKind,
    findUsdcInternoMiningCoin,
    findNftRackDisplayCoin,
    findAsicRackDisplayCoin,
    listAsicRackDisplayCoins,
    listAsicRackBaseProductionByCoin,
    isAsicMachineUpgrade
} from '../types';
import { NftRoomPaybackCard } from './NftRoomPaybackCard';
import { AsicRoomPaybackCard } from './AsicRoomPaybackCard';
import { catalogTypeLabelKey, orphanCatalogUpgrade } from '../models/orphanCatalogItem';
import { normalizePublicAssetUrl } from '../utils/publicUrl';
import { bulkBatteryWillApplyCount, totalBatteryInstances } from '../models/roomBatteryModel';
import {
  calculatePlacedRacksProductionHashrate,
  formatHashrateDisplay,
  getDefaultRackLayout,
  mergeBatteryWidgetsIfAbsent,
  resolvePlacedRackBatteryCatalogId,
  listBatteryPickerRows,
  listItemsForSelection,
  DEFAULT_MACHINE_PICKER_SORT,
  nextHorizontalScrollLeft,
  type MachinePickerSortMode,
  type ServerRoomSelectionContext
} from '../models/serverRoomModel';
import { runValidatedItemSelection } from '../controllers/serverRoomController';
import { isCompatibleWithRack } from '../lib/upgradeRackCompat';
import { useT } from '../../../shared/i18n';
import {
    cssSafeBackgroundUrl,
    isValidRigRoomId,
    isValidUserEmailForRoomsFetch,
    sanitizeEmailForRoomsFetch,
    MAX_RIG_SLOTS_PURCHASE_PER_REQUEST,
    parseRigSlotPurchaseQuantity,
    previewRigSlotBulkPurchase,
    roomEffectiveCapacity,
    roomPurchasableSlotsRemaining
} from '../validation/serverRoomValidation';
import { getMyRigRooms, getServersState, purchaseRoomSlot } from '../api/servers';
import type { BulkRoomBatteryRunOptions } from '../controllers/roomBatteryController';
import { MiningCoinSelect, miningCoinIconSrc } from './MiningCoinSelect';
import {
    HashrateTicker,
    MachineGhostPreview,
    RackBootCascade,
    RackStatusAura,
    SERVER_ROOM_EXTRA_FX_CSS,
    heatIntensityForRarity
} from './serverRoomFx';
import {
    Server,
    XCircle,
    Zap,
    Power,
    Plus,
    Cog,
    X,
    Box,
    Save,
    Activity,
    Calculator,
    Coins,
    Battery,
    LayoutGrid
} from 'lucide-react';

const roomQuickStripClass =
    'flex w-full flex-wrap items-center gap-2 rounded-lg border border-slate-200/90 bg-slate-50/90 px-2.5 py-1.5 dark:border-slate-700 dark:bg-slate-900/70 sm:w-auto sm:gap-1.5 sm:px-2 sm:py-1';

function sameRigRoom(a: string | null | undefined, b: string | null | undefined): boolean {
    return normalizePlacedRackRoomId(a) === normalizePlacedRackRoomId(b);
}

/** Offset do botão relativamente ao conteúdo da strip (nunca usa scrollIntoView). */
function childOffsetInStrip(
    strip: HTMLElement,
    child: HTMLElement
): { offsetLeft: number; width: number } {
    if (child.offsetParent === strip) {
        return { offsetLeft: child.offsetLeft, width: child.offsetWidth };
    }
    const stripRect = strip.getBoundingClientRect();
    const childRect = child.getBoundingClientRect();
    return {
        offsetLeft: childRect.left - stripRect.left + strip.scrollLeft,
        width: child.offsetWidth
    };
}

const NO_BATTERY_CATALOG_HINTS: Readonly<Record<string, string>> = Object.freeze({});

/** Capacidade de bateria para UI — sem glyph quebrado; `-1` = ilimitada. */
function formatBatteryCapacityLabel(
  powerCapacity: number | undefined | null,
  unlimitedLabel = 'Unlimited'
): string {
  const n = Number(powerCapacity);
  if (n === -1) return unlimitedLabel;
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `${n} Wh`;
}

interface ServerRoomProps {
    stock: Record<string, number>;
    storedBatteries: StoredBattery[];
    placedRacks: PlacedRack[];
    onPlaceRack: (
        rackTypeId: string,
        roomId: string,
        slotIndex: number,
        ctx?: { roomName?: string; nftAutoArmario1Only?: boolean; roomKind?: string; rackRoomAffinity?: import('../types').RackRoomAffinity }
    ) => void;
    onRemoveRack: (id: string) => void;
    onEquipMiner: (rackId: string, slotIndex: number, minerId: string) => void;
    onUnequipMiner: (rackId: string, slotIndex: number) => void;
    onEquipAux: (
      rackId: string,
      itemId: string,
      type: 'battery' | 'wiring' | 'multiplier',
      storedBatteryId?: string,
      slotIndex?: number
    ) => void | Promise<void>;
    onUnequipAux: (rackId: string, type: 'battery' | 'wiring' | 'multiplier', slotIndex?: number) => void | Promise<void>;
    onTogglePower: (rackId: string) => void;
    upgrades: Upgrade[];
    miningCoins?: MiningCoin[];
    onSetRackCoin?: (rackId: string, coinId: string) => void;
    /** Define a mesma moeda (ou limpa) em todas as rigs da sala de uma vez. */
    onSetRoomRacksCoin?: (roomId: string, coinId: string) => void;
    /** Equipa bateria em massa, remove todas (id vazio) ou preenchimento inteligente (opts.smartFill). */
    onSetRoomRacksBattery?: (roomId: string, batteryUpgradeId: string, opts?: BulkRoomBatteryRunOptions) => void;
    userEmail?: string;
    /** Saldo USDC (para validar compra de slots no modal). */
    usdc?: number;
    onRoomPurchase?: (newUsdc: number) => void;
    onOpenCalculator?: () => void;
    /** UUID de instância na rig → id de catálogo (bateria montada a partir de stock). */
    rackBatteryCatalogHints?: Readonly<Record<string, string>>;
    /** USD recuperado por mineração de ASICs na Sala NFT (payback). */
    nftAsicMinedUsdTotal?: number;
    /** USD recuperado por mineração de ASICs na Sala ASICs (payback). */
    asicRoomMinedUsdTotal?: number;
    /** Leases activos (validade / tempo restante por slot). */
    asicLeaseDetails?: AsicLeaseDetail[];
}

/** Cores de raridade — fundo suave (sem tubo neon). */
const RARITY_SLOT_FX: Record<
  string,
  { bg: string; border: string; glow: string; wash: string; spark: string; accent: string }
> = {
  common: {
    bg: 'linear-gradient(160deg, rgba(148,163,184,0.22) 0%, rgba(15,23,42,0.55) 100%)',
    border: 'rgba(148,163,184,0.35)',
    glow: '0 0 8px rgba(148,163,184,0.18)',
    wash: 'rgba(148,163,184,0.12)',
    spark: '#e2e8f0',
    accent: '#cbd5e1'
  },
  uncommon: {
    bg: 'linear-gradient(160deg, rgba(52,211,153,0.22) 0%, rgba(6,40,30,0.55) 100%)',
    border: 'rgba(52,211,153,0.4)',
    glow: '0 0 9px rgba(52,211,153,0.24)',
    wash: 'rgba(52,211,153,0.14)',
    spark: '#a7f3d0',
    accent: '#6ee7b7'
  },
  rare: {
    bg: 'linear-gradient(160deg, rgba(56,189,248,0.22) 0%, rgba(8,30,50,0.55) 100%)',
    border: 'rgba(56,189,248,0.4)',
    glow: '0 0 9px rgba(56,189,248,0.24)',
    wash: 'rgba(56,189,248,0.14)',
    spark: '#bae6fd',
    accent: '#7dd3fc'
  },
  epic: {
    bg: 'linear-gradient(160deg, rgba(232,121,249,0.24) 0%, rgba(40,10,50,0.55) 100%)',
    border: 'rgba(232,121,249,0.42)',
    glow: '0 0 9px rgba(232,121,249,0.26)',
    wash: 'rgba(232,121,249,0.15)',
    spark: '#f5d0fe',
    accent: '#e879f9'
  },
  legendary: {
    bg: 'linear-gradient(160deg, rgba(251,191,36,0.26) 0%, rgba(50,30,8,0.55) 100%)',
    border: 'rgba(251,191,36,0.45)',
    glow: '0 0 10px rgba(251,191,36,0.28)',
    wash: 'rgba(251,191,36,0.16)',
    spark: '#fef3c7',
    accent: '#fbbf24'
  },
  supreme: {
    bg: 'linear-gradient(160deg, rgba(251,113,133,0.26) 0%, rgba(50,10,22,0.55) 100%)',
    border: 'rgba(251,113,133,0.45)',
    glow: '0 0 10px rgba(251,113,133,0.28)',
    wash: 'rgba(251,113,133,0.16)',
    spark: '#ffe4e6',
    accent: '#fb7185'
  }
};

function resolveUpgradeRarity(item: Upgrade | null | undefined): string {
  const raw = String(item?.rarity || '')
    .trim()
    .toLowerCase();
  if (raw && RARITY_SLOT_FX[raw]) return raw;
  const id = String(item?.id || '');
  const fromId = id.match(
    /(?:^merge_.+_|_)(common|uncommon|rare|epic|legendary|supreme)(?:_[a-f0-9]{6,})?$/i
  );
  if (fromId && RARITY_SLOT_FX[fromId[1].toLowerCase()]) {
    return fromId[1].toLowerCase();
  }
  return 'common';
}

const AnimatedMiner = ({ src, isOperational, className, style, item }: { src: string, isOperational: boolean, className: string, style?: React.CSSProperties, item: Upgrade | undefined }) => {
    const [staticImage, setStaticImage] = useState<string | null>(null);

    useEffect(() => {
        if (!isOperational && src && !staticImage) {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    ctx.drawImage(img, 0, 0);
                    try {
                        setStaticImage(canvas.toDataURL());
                    } catch (e) {
                        console.error("Failed to freeze GIF:", e);
                    }
                }
            };
            img.src = src;
        } else if (isOperational && staticImage) {
            setStaticImage(null);
        }
    }, [isOperational, src, staticImage]);

    const bgSrc = !isOperational && staticImage ? staticImage : src;
    const finalStyle = {
        ...style,
        backgroundImage: item && src ? (cssSafeBackgroundUrl(bgSrc) || 'none') : 'none',
        backgroundSize: '100% 100%',
        backgroundRepeat: 'no-repeat'
    };

    return <div className={className} style={finalStyle} />;
};

/**
 * Miniatura na lista de equipamento: `upgrades.icon` no catálogo é string slug (ex. "battery"),
 * não componente React — nunca renderizar como texto cru (ficava cortado tipo ".tte").
 */
function UpgradeSelectionThumb({
    upgrade,
    normalizedImage,
    iconSize = 22
}: {
    upgrade: Upgrade;
    normalizedImage?: string;
    iconSize?: number;
}) {
    const [broken, setBroken] = useState(false);
    const src = (normalizedImage || '').trim();
    if (src && !broken) {
        return (
            <img
                src={src}
                alt=""
                className="h-full w-full object-contain"
                onError={() => setBroken(true)}
            />
        );
    }
    const ic = iconSize;
    const t = upgrade.type;
    if (t === 'battery') {
        return <Battery className="text-amber-600 dark:text-amber-400" size={ic} aria-hidden />;
    }
    if (t === 'machine') {
        return <Activity className="text-green-600 dark:text-green-400" size={ic} aria-hidden />;
    }
    if (t === 'wiring') {
        return <Zap className="text-sky-500 dark:text-sky-400" size={ic} aria-hidden />;
    }
    if (t === 'multiplier') {
        return <LayoutGrid className="text-orange-600 dark:text-orange-400" size={ic} aria-hidden />;
    }
    if (t === 'infrastructure') {
        return <Server className="text-slate-600 dark:text-slate-300" size={ic} aria-hidden />;
    }
    const raw = String(upgrade.icon || '').trim();
    if (raw && /^\p{Extended_Pictographic}+$/u.test(raw)) {
        return <span className="text-xl leading-none select-none">{raw}</span>;
    }
    return <Box className="text-slate-500 dark:text-slate-400" size={ic} aria-hidden />;
}

function BatteryOptionRow({
    upgrade,
    selected,
    disabled,
    subtitle,
    onPick
}: {
    upgrade: Upgrade;
    selected: boolean;
    disabled: boolean;
    subtitle: string;
    onPick: () => void;
}) {
    const src = normalizePublicAssetUrl(upgrade.image);
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onPick}
            className={`flex w-full items-center gap-3 rounded-lg border px-2 py-2 text-left text-sm transition-colors ${
                selected
                    ? 'border-blue-500 bg-blue-600/20 text-white ring-1 ring-blue-400/60'
                    : 'border-slate-200 bg-white text-slate-900 hover:border-amber-500/50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:border-amber-600/40'
            } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
        >
            <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-slate-100 dark:bg-slate-800">
                <UpgradeSelectionThumb upgrade={upgrade} normalizedImage={src || ''} iconSize={22} />
            </div>
            <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{upgrade.name}</div>
                <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">{subtitle}</div>
            </div>
        </button>
    );
}

export const ServerRoom: React.FC<ServerRoomProps> = ({
    stock,
    storedBatteries,
    placedRacks,
    onPlaceRack,
    onRemoveRack,
    onEquipMiner,
    onUnequipMiner,
    onEquipAux,
    onUnequipAux,
    onTogglePower,
    upgrades,
    miningCoins = [],
    onSetRackCoin,
    onSetRoomRacksCoin,
    onSetRoomRacksBattery,
    userEmail,
    usdc = 0,
    onRoomPurchase,
    onOpenCalculator,
    rackBatteryCatalogHints,
    nftAsicMinedUsdTotal = 0,
    asicRoomMinedUsdTotal = 0,
    asicLeaseDetails = [],
}) => {
    const t = useT();
    const batteryUnlimitedLabel = t('mining.battery.unlimited');
    const batteryCatalogHints = rackBatteryCatalogHints ?? NO_BATTERY_CATALOG_HINTS;
    const [selectionContext, setSelectionContext] = useState<ServerRoomSelectionContext | null>(null);
    const [machinePickerSort, setMachinePickerSort] = useState<MachinePickerSortMode>(DEFAULT_MACHINE_PICKER_SORT);
    const [detailContext, setDetailContext] = useState<{ rackId: string; slotIndex: number | null; type: 'machine' | 'battery' | 'wiring' | 'multiplier'; item: Upgrade } | null>(null);
    const [configRackId, setConfigRackId] = useState<string | null>(null);
    const [myRooms, setMyRooms] = useState<RigRoom[]>([]);
    const [roomsLoading, setRoomsLoading] = useState(false);
    const [purchaseBusyId, setPurchaseBusyId] = useState<string | null>(null);
    const slotPurchaseIdemRef = useRef<string | null>(null);
    const [roomIndex, setRoomIndex] = useState(0);
    const [bulkRoomCoinId, setBulkRoomCoinId] = useState('');
    const [roomBulkBatteryModal, setRoomBulkBatteryModal] = useState<RigRoom | null>(null);
    const [roomBulkBatterySelect, setRoomBulkBatterySelect] = useState('');
    const [roomBulkBatterySmartFill, setRoomBulkBatterySmartFill] = useState(false);
    const [roomBulkBatteryRigSort, setRoomBulkBatteryRigSort] = useState<'slot_asc' | 'hashrate_desc'>('slot_asc');
    const [coinApplyBusy, setCoinApplyBusy] = useState(false);
    const [slotPurchaseModal, setSlotPurchaseModal] = useState<RigRoom | null>(null);
    const [slotPurchaseQty, setSlotPurchaseQty] = useState(1);
    /** FX: boot cascade até timestamp ms */
    const [bootUntilByRack, setBootUntilByRack] = useState<Record<string, number>>({});
    /** FX: burst merge por `rackId:slotIdx` até timestamp */
    const [mergeBurstUntil, setMergeBurstUntil] = useState<Record<string, number>>({});
    /** Última GPU equipada (ghost em slots vazios) */
    const [lastMachinePreviewId, setLastMachinePreviewId] = useState<string | null>(null);
    const [hoverGhostKey, setHoverGhostKey] = useState<string | null>(null);
    const bayRef = useRef<HTMLDivElement | null>(null);
    const roomTabStripRef = useRef<HTMLDivElement | null>(null);
    const roomButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const myRoomsRef = useRef(myRooms);
    myRoomsRef.current = myRooms;
    const prevOperationalRef = useRef<Record<string, boolean>>({});
    const prevMachineSlotsRef = useRef<Record<string, Array<string | null>>>({});
    const [, setFxTick] = useState(0);

    useEffect(() => {
        if (!userEmail || !isValidUserEmailForRoomsFetch(userEmail)) return;
        const emailParam = sanitizeEmailForRoomsFetch(userEmail);
        let cancelled = false;
        (async () => {
            if (myRoomsRef.current.length === 0) setRoomsLoading(true);
            try {
                const pack = await getServersState();
                if (!cancelled) {
                    if (pack != null && Array.isArray(pack.rigRooms)) setMyRooms(pack.rigRooms);
                    else setMyRooms(await getMyRigRooms(emailParam));
                }
            } finally {
                if (!cancelled) setRoomsLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [userEmail]);

    useEffect(() => {
        if (myRooms.length === 0) {
            setRoomIndex(0);
            return;
        }
        setRoomIndex((i) => Math.min(Math.max(0, i), myRooms.length - 1));
    }, [myRooms]);

    useEffect(() => {
        const strip = roomTabStripRef.current;
        const activeRoom = myRoomsRef.current[roomIndex];
        if (!strip || !activeRoom) return;
        const btn = roomButtonRefs.current[activeRoom.id];
        if (!btn) return;
        const { offsetLeft, width } = childOffsetInStrip(strip, btn);
        strip.scrollLeft = nextHorizontalScrollLeft(
            strip.scrollLeft,
            strip.clientWidth,
            offsetLeft,
            width
        );
    }, [roomIndex]);

    const currentRoom = myRooms.length > 0 ? myRooms[Math.min(roomIndex, myRooms.length - 1)] : null;

    useEffect(() => {
        setBulkRoomCoinId('');
    }, [currentRoom?.id]);

    const currentRoomRacks = useMemo(() => {
        if (!currentRoom) return [];
        return placedRacks.filter((r) => sameRigRoom(r.roomId, currentRoom.id));
    }, [placedRacks, currentRoom]);

    /** Detecta power ON → boot cascade; troca de GPU merge_* → burst. */
    useEffect(() => {
        const now = Date.now();
        const nextBoot: Record<string, number> = {};
        const nextBurst: Record<string, number> = {};
        let bootChanged = false;
        let burstChanged = false;
        let previewId: string | null = null;

        for (const rack of currentRoomRacks) {
            const operational = !!(rack.isOn && rack.wiringId && rack.batteryId);
            const was = prevOperationalRef.current[rack.id];
            if (was === false && operational) {
                nextBoot[rack.id] = now + 1900;
                bootChanged = true;
            }
            prevOperationalRef.current[rack.id] = operational;

            const prevSlots = prevMachineSlotsRef.current[rack.id] || [];
            const curSlots = (rack.slots || []).map((s) => (s == null ? null : String(s)));
            curSlots.forEach((id, idx) => {
                const prev = prevSlots[idx] ?? null;
                if (id && id !== prev) {
                    previewId = id;
                    if (id.startsWith('merge_') || /_merge_/i.test(id)) {
                        nextBurst[`${rack.id}:${idx}`] = now + 2800;
                        burstChanged = true;
                    }
                }
            });
            prevMachineSlotsRef.current[rack.id] = curSlots;
        }

        if (bootChanged) {
            setBootUntilByRack((prev) => ({ ...prev, ...nextBoot }));
        }
        if (burstChanged) {
            setMergeBurstUntil((prev) => ({ ...prev, ...nextBurst }));
        }
        if (previewId) setLastMachinePreviewId(previewId);
    }, [currentRoomRacks]);

    /** Re-render só no fim de boot/burst (sem poll agressivo). */
    useEffect(() => {
        const ends = [
            ...Object.values(bootUntilByRack),
            ...Object.values(mergeBurstUntil)
        ].filter((t) => t > Date.now());
        if (ends.length === 0) return;
        const next = Math.min(...ends) - Date.now() + 30;
        const id = window.setTimeout(() => setFxTick((n) => n + 1), Math.max(50, next));
        return () => window.clearTimeout(id);
    }, [bootUntilByRack, mergeBurstUntil]);

    useEffect(() => {
        const bay = bayRef.current;
        if (!bay) return;
        let timer = 0;
        const onScroll = () => {
            bay.classList.add('is-scrolling');
            window.clearTimeout(timer);
            timer = window.setTimeout(() => bay.classList.remove('is-scrolling'), 200);
        };
        window.addEventListener('scroll', onScroll, { passive: true, capture: true });
        document.addEventListener('scroll', onScroll, { passive: true, capture: true });
        return () => {
            window.removeEventListener('scroll', onScroll, true);
            document.removeEventListener('scroll', onScroll, true);
            window.clearTimeout(timer);
        };
    }, []);

    const lastMachinePreview = useMemo(() => {
        if (!lastMachinePreviewId) return null;
        return upgrades.find((u) => u.id === lastMachinePreviewId) ?? null;
    }, [lastMachinePreviewId, upgrades]);

    const parallaxRaf = useRef(0);
    const handleBayPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const el = bayRef.current;
        if (!el) return;
        const clientX = e.clientX;
        const clientY = e.clientY;
        if (parallaxRaf.current) return;
        parallaxRaf.current = window.requestAnimationFrame(() => {
            parallaxRaf.current = 0;
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) return;
            const x = ((clientX - r.left) / r.width - 0.5) * 2;
            const y = ((clientY - r.top) / r.height - 0.5) * 2;
            el.style.setProperty('--parallax-x', `${(x * 10).toFixed(2)}px`);
            el.style.setProperty('--parallax-y', `${(y * 7).toFixed(2)}px`);
        });
    }, []);

    const handleBayPointerLeave = useCallback(() => {
        const el = bayRef.current;
        if (!el) return;
        if (parallaxRaf.current) {
            window.cancelAnimationFrame(parallaxRaf.current);
            parallaxRaf.current = 0;
        }
        el.style.setProperty('--parallax-x', '0px');
        el.style.setProperty('--parallax-y', '0px');
    }, []);

    const isNftSalaRoom = useMemo(
        () =>
            currentRoom
                ? resolveClientRoomKind({
                      roomId: currentRoom.id,
                      roomName: currentRoom.name,
                      roomKind: currentRoom.roomKind,
                      nftAutoArmario1Only: currentRoom.nftAutoArmario1Only
                  }) === 'nft'
                : false,
        [currentRoom]
    );

    const isAsicSalaRoom = useMemo(
        () =>
            currentRoom
                ? resolveClientRoomKind({
                      roomId: currentRoom.id,
                      roomName: currentRoom.name,
                      roomKind: currentRoom.roomKind,
                      nftAutoArmario1Only: currentRoom.nftAutoArmario1Only
                  }) === 'asic'
                : false,
        [currentRoom]
    );

    /** Painel payback NFT: só na sala NFT (`roomKind === 'nft'`), nunca na Sala ASICs/standard. */
    const showNftPaybackPanel = !!currentRoom && isNftSalaRoom;

    /** Rigs normais: moedas ligadas a ASICs na Sala NFT não aparecem no selector. */
    const rigCoinSelectOptions = useMemo(() => {
        const list = miningCoins || [];
        return isNftSalaRoom ? list : miningCoinsSelectableOnRig(list);
    }, [miningCoins, isNftSalaRoom]);

    const asicRoomDisplayCoin = useMemo(() => findUsdcInternoMiningCoin(miningCoins), [miningCoins]);

    const roomTotalProduction = useMemo(() => {
        return calculatePlacedRacksProductionHashrate(
            currentRoomRacks,
            upgrades,
            storedBatteries,
            batteryCatalogHints
        );
    }, [currentRoomRacks, upgrades, storedBatteries, batteryCatalogHints]);

    const roomPlacedCount = currentRoomRacks.length;

    const roomCapacity = currentRoom ? roomEffectiveCapacity(currentRoom, currentRoom.unlockedSlots) : 0;
    const currentRoomNextSlotPrice =
        currentRoom && roomCapacity < currentRoom.maxCapacity
            ? currentRoom.baseSlotPrice * Math.pow(1 + currentRoom.slotPriceIncreasePercent / 100, currentRoom.unlockedSlots || 0)
            : null;

    const openSlotPurchaseModal = (room: RigRoom) => {
        if (!userEmail || !isValidUserEmailForRoomsFetch(userEmail)) return;
        if (!isValidRigRoomId(room.id)) {
            alert(t('servers.room.invalidRoomId'));
            return;
        }
        setSlotPurchaseQty(1);
        setSlotPurchaseModal(room);
    };

    const closeSlotPurchaseModal = useCallback(() => {
        setSlotPurchaseModal(null);
        setSlotPurchaseQty(1);
        slotPurchaseIdemRef.current = null;
    }, []);

    useEffect(() => {
        if (!slotPurchaseModal) return;
        const onEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeSlotPurchaseModal();
        };
        window.addEventListener('keydown', onEsc);
        return () => window.removeEventListener('keydown', onEsc);
    }, [slotPurchaseModal, closeSlotPurchaseModal]);

    const slotPurchasePreview = useMemo(() => {
        if (!slotPurchaseModal) return null;
        const q = parseRigSlotPurchaseQuantity(slotPurchaseQty) ?? 1;
        return previewRigSlotBulkPurchase(slotPurchaseModal, q, usdc);
    }, [slotPurchaseModal, slotPurchaseQty, usdc]);

    const confirmPurchaseSlots = async () => {
        if (!slotPurchaseModal || !userEmail || !isValidUserEmailForRoomsFetch(userEmail)) return;
        const roomId = slotPurchaseModal.id;
        if (!isValidRigRoomId(roomId) || purchaseBusyId) return;
        const qtyParsed = parseRigSlotPurchaseQuantity(slotPurchaseQty) ?? 1;
        const preview = previewRigSlotBulkPurchase(slotPurchaseModal, qtyParsed, usdc);
        if (!preview.ok || preview.appliedQty < 1) {
            alert(preview.message || t('servers.room.cannotPurchaseQty'));
            return;
        }
        if (!slotPurchaseIdemRef.current) {
            slotPurchaseIdemRef.current =
                typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
                    ? crypto.randomUUID()
                    : `room_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
        }
        const idem = slotPurchaseIdemRef.current;
        setPurchaseBusyId(roomId);
        const resp = await purchaseRoomSlot(
            sanitizeEmailForRoomsFetch(userEmail),
            roomId,
            preview.appliedQty,
            idem
        );
        if (!resp.ok) {
            if (resp.error === 'Insufficient USDC') {
              alert(
                typeof resp.missing === 'number'
                  ? t('servers.room.insufficientBalanceShort', { amount: resp.missing.toFixed(2) })
                  : t('servers.room.insufficientBalance')
              );
            }
            else if (
              resp.error === 'Level not allowed' ||
              resp.code === 'ROOM_ACCESS_DENIED' ||
              /exclusive|season pass|does not unlock|ROOM_ACCESS/i.test(String(resp.error || ''))
            ) {
              alert(t('servers.room.roomExclusive'));
            }
            else if (resp.error === 'Already owned') alert(t('servers.room.alreadyOwnRoom'));
            else if (resp.error === 'Max capacity reached') alert(t('servers.room.roomMaxCapacity'));
            else alert(resp.error || t('servers.room.purchaseFailed'));
            setPurchaseBusyId(null);
            return;
        }
        slotPurchaseIdemRef.current = null;
        closeSlotPurchaseModal();
        if (typeof resp.newUsdc === 'number' && onRoomPurchase) onRoomPurchase(resp.newUsdc);
        if (userEmail) {
            const pack = await getServersState();
            if (pack != null && Array.isArray(pack.rigRooms)) setMyRooms(pack.rigRooms);
            else setMyRooms(await getMyRigRooms(sanitizeEmailForRoomsFetch(userEmail)));
        }
        setPurchaseBusyId(null);
    };

    const handleSlotClick = (rackId: string | null, slotIndex: number, currentItemId: string | null, isRoomSlot: boolean = false) => {
        if (isRoomSlot) {
            if (!currentItemId) {
                setSelectionContext({
                    rackId: null,
                    slotIndex,
                    type: 'rack',
                    roomId: currentRoom?.id,
                    roomName: currentRoom?.name,
                    nftAutoArmario1Only: currentRoom?.nftAutoArmario1Only,
                    roomKind: currentRoom?.roomKind
                });
            }
            return;
        }
        if (!rackId) return;
        if (currentItemId) {
            const item = upgrades.find((u) => u.id === currentItemId) ?? orphanCatalogUpgrade(currentItemId, 'machine', t);
            setDetailContext({ rackId, slotIndex, type: 'machine', item });
        } else {
            setSelectionContext({
                rackId,
                slotIndex,
                type: 'machine',
                roomId: currentRoom?.id,
                roomName: currentRoom?.name,
                nftAutoArmario1Only: currentRoom?.nftAutoArmario1Only,
                roomKind: currentRoom?.roomKind
            });
        }
    };

    const handleAuxClick = (rackId: string, currentItemId: string | null, type: 'battery' | 'wiring' | 'multiplier', slotIndex?: number) => {
        if (!currentItemId) {
            setSelectionContext({ rackId, slotIndex: slotIndex ?? null, type });
            return;
        }
        let item: Upgrade | undefined = upgrades.find((u) => u.id === currentItemId);
        if (!item && type === 'battery') {
            const sb = storedBatteries.find((b) => String(b.id) === String(currentItemId));
            const cat = sb?.itemId != null ? String(sb.itemId).trim() : '';
            if (cat) item = upgrades.find((u) => u.id === cat);
        }
        if (item) {
            setDetailContext({ rackId, slotIndex: slotIndex ?? null, type, item });
            return;
        }
        if (type === 'battery') {
            const rack = placedRacks.find((r) => r.id === rackId);
            const catFromRack =
                rack != null
                    ? resolvePlacedRackBatteryCatalogId(
                          rack,
                          storedBatteries,
                          upgrades,
                          batteryCatalogHints
                      )
                    : null;
            const fromCat = catFromRack ? upgrades.find((u) => u.id === catFromRack && u.type === 'battery') : undefined;
            if (fromCat) {
                setDetailContext({ rackId, slotIndex: slotIndex ?? null, type: 'battery', item: fromCat });
                return;
            }
            setDetailContext({
                rackId,
                slotIndex: slotIndex ?? null,
                type: 'battery',
                item: orphanCatalogUpgrade(String(currentItemId), 'battery', t)
            });
            return;
        }
        if (type === 'wiring' || type === 'multiplier') {
            setDetailContext({
                rackId,
                slotIndex: slotIndex ?? null,
                type,
                item: orphanCatalogUpgrade(String(currentItemId), type, t)
            });
            return;
        }
        setSelectionContext({ rackId, slotIndex: slotIndex ?? null, type });
    };

    const handleItemSelect = (itemId: string, storedBatteryId?: string) => {
        if (!selectionContext) return;
        const up = upgrades.find((u) => u.id === itemId);
        const result = runValidatedItemSelection(
            selectionContext,
            itemId,
            storedBatteryId,
            {
                onPlaceRack,
                onEquipMiner,
                onEquipAux
            },
            up?.rackRoomAffinity
        );
        if (!result.ok) {
            alert('message' in result ? result.message : t('servers.room.invalidAction'));
            return;
        }
        setSelectionContext(null);
    };

    const getAvailableItems = () => {
        if (!selectionContext) return [];
        return listItemsForSelection(selectionContext, placedRacks, upgrades, stock, machinePickerSort);
    };

    const getBatteryPickerRows = () => {
        if (!selectionContext || selectionContext.type !== 'battery') return [];
        return listBatteryPickerRows(selectionContext, placedRacks, storedBatteries, upgrades, stock);
    };

    const selectionTypeTitle =
        selectionContext?.type === 'machine'
            ? t('mining.inventory.gpu')
            : selectionContext?.type === 'battery'
              ? t('mining.inventory.battery')
              : selectionContext?.type === 'multiplier'
                ? t('mining.inventory.aiModule')
                : selectionContext?.type === 'rack'
                  ? t('mining.inventory.rack')
                  : t('mining.inventory.wiring');

    const openRoomBulkBatteryModal = (room: RigRoom) => {
        if (!onSetRoomRacksBattery) return;
        const racksHere = placedRacks.filter((r) => sameRigRoom(r.roomId, room.id));
        if (racksHere.length === 0) return;
        const firstBatt = racksHere.find((r) => r.batteryId)?.batteryId ?? '';
        const canPickManual = firstBatt && (stock[firstBatt] || 0) > 0;
        setRoomBulkBatterySelect(canPickManual ? firstBatt : '');
        setRoomBulkBatterySmartFill(false);
        setRoomBulkBatteryRigSort('slot_asc');
        setRoomBulkBatteryModal(room);
    };

    const closeRoomBulkBatteryModal = () => {
        setRoomBulkBatteryModal(null);
        setRoomBulkBatterySelect('');
        setRoomBulkBatterySmartFill(false);
        setRoomBulkBatteryRigSort('slot_asc');
    };

    const handleApplyRoomCoin = async () => {
        if (!currentRoom || !onSetRoomRacksCoin || coinApplyBusy || currentRoomRacks.length === 0) return;
        setCoinApplyBusy(true);
        try {
            await onSetRoomRacksCoin(currentRoom.id, bulkRoomCoinId);
        } finally {
            setCoinApplyBusy(false);
        }
    };

    const showQuickControlRow = Boolean(onSetRoomRacksCoin || onSetRoomRacksBattery || userEmail);

    return (
        <div className="flex flex-col gap-4 relative sm:gap-6">
            <div className="space-y-2 border-b border-slate-200 pb-3 dark:border-slate-800">
                {userEmail && !roomsLoading && myRooms.length > 0 ? (
                    <div className={`${roomQuickStripClass} w-full sm:w-full`}>
                        <LayoutGrid size={14} className="shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                            {t('servers.room.roomLabel')}
                        </span>
                        <div ref={roomTabStripRef} className="min-w-0 flex-1 overflow-x-auto custom-scrollbar">
                            <div className="flex flex-nowrap gap-1.5">
                                {myRooms.map((room, idx) => (
                                    <button
                                        key={room.id}
                                        ref={(el) => {
                                            roomButtonRefs.current[room.id] = el;
                                        }}
                                        type="button"
                                        aria-current={idx === roomIndex ? 'true' : undefined}
                                        title={room.name}
                                        onClick={() => setRoomIndex(idx)}
                                        className={`inline-flex min-h-9 shrink-0 items-center whitespace-nowrap rounded-md border px-2 py-1.5 text-xs font-semibold sm:min-h-0 sm:px-1.5 sm:py-1 sm:text-[10px] ${
                                            idx === roomIndex
                                                ? 'border-amber-500/40 bg-amber-500/20 text-amber-600 dark:text-amber-400'
                                                : 'border-slate-300 bg-white text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200'
                                        }`}
                                    >
                                        {room.name}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                ) : null}
                <div className="flex flex-col gap-2.5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                        <h3 className="text-slate-700 dark:text-slate-300 font-bold flex items-center gap-2">
                            <Server size={18} /> {currentRoom?.name || t('servers.room.defaultTitle')}
                        </h3>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <div className="flex items-center gap-1.5 bg-amber-500/10 text-amber-500 px-2.5 py-1 rounded-full text-[11px] font-bold border border-amber-500/20">
                                <Activity size={12} />
                                {formatHashrateDisplay(roomTotalProduction)} H/s
                            </div>
                            {onOpenCalculator && (
                                <button
                                    onClick={onOpenCalculator}
                                    className="flex min-h-8 items-center gap-1.5 bg-orange-500/10 text-orange-500 px-2.5 py-1 rounded-full text-[11px] font-bold border border-orange-500/20 hover:bg-orange-500/20 transition-colors"
                                >
                                    <Calculator size={12} /> {t('servers.room.calculator')}
                                </button>
                            )}
                            <div className="text-[11px] text-slate-500 font-mono leading-snug">
                                {t('servers.room.capacityLine', { placed: roomPlacedCount, capacity: roomCapacity })}{' '}
                                {currentRoom && roomCapacity < currentRoom.maxCapacity && t('servers.room.maxHint', { max: currentRoom.maxCapacity })}
                            </div>
                        </div>
                    </div>
                {showQuickControlRow ? (
                    <div className="flex w-full flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center lg:w-auto lg:justify-end">
                        {onSetRoomRacksCoin && currentRoom && currentRoomRacks.length > 0 && !isAsicSalaRoom && !isNftSalaRoom ? (
                            <div className={`${roomQuickStripClass} min-w-0 max-w-full flex-1 sm:max-w-md`}>
                                <Coins size={14} className="shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                                <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                    {t('servers.room.coin')}
                                </span>
                                <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
                                    <MiningCoinSelect
                                        value={bulkRoomCoinId}
                                        onChange={setBulkRoomCoinId}
                                        coins={rigCoinSelectOptions}
                                        noneLabel={t('servers.room.coin')}
                                        buttonClassName="w-full min-h-9 rounded-md px-2 py-1.5 text-xs sm:min-h-0 sm:rounded sm:px-1.5 sm:py-1 sm:text-[10px]"
                                        disabled={coinApplyBusy}
                                        compact
                                    />
                                </div>
                                <button
                                    type="button"
                                    disabled={coinApplyBusy}
                                    onClick={() => void handleApplyRoomCoin()}
                                    className="min-h-10 w-full shrink-0 rounded-md border border-amber-500/50 bg-amber-600 px-3 py-2 text-[11px] font-bold uppercase text-white hover:bg-amber-500 disabled:opacity-60 sm:min-h-0 sm:w-auto sm:rounded sm:px-2 sm:py-1 sm:text-[9px]"
                                >
                                    {coinApplyBusy ? '…' : t('servers.room.applyRigs', { count: currentRoomRacks.length })}
                                </button>
                            </div>
                        ) : null}
                        {onSetRoomRacksBattery && currentRoom && currentRoomRacks.length > 0 ? (
                            <button
                                type="button"
                                onClick={() => openRoomBulkBatteryModal(currentRoom)}
                                className="inline-flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-yellow-600/50 bg-yellow-600/15 px-3 py-2 text-[11px] font-bold uppercase text-yellow-800 hover:bg-yellow-600/25 dark:text-yellow-300 sm:min-h-0 sm:w-auto sm:gap-1 sm:px-2 sm:py-1 sm:text-[9px]"
                            >
                                <Battery size={14} aria-hidden />
                                {t('servers.room.batteries')}
                            </button>
                        ) : null}
                        {userEmail && currentRoom && currentRoomNextSlotPrice != null ? (
                            <button
                                type="button"
                                onClick={() => openSlotPurchaseModal(currentRoom)}
                                disabled={!!purchaseBusyId}
                                className={`inline-flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[11px] font-bold uppercase sm:min-h-0 sm:w-auto sm:gap-1 sm:px-2 sm:py-1 sm:text-[9px] ${
                                    purchaseBusyId
                                        ? 'border-slate-600 bg-slate-700 text-slate-400'
                                        : 'border-amber-500/50 bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-300'
                                }`}
                                title={t('servers.room.buySlotTitle', {
                                    amount: currentRoomNextSlotPrice.toLocaleString('en-US', {
                                        minimumFractionDigits: 2,
                                        maximumFractionDigits: 2
                                    })
                                })}
                            >
                                <Plus size={14} aria-hidden />
                                {t('servers.room.newSlot')}
                                <span className="font-mono">
                                    USDC{' '}
                                    {currentRoomNextSlotPrice.toLocaleString('en-US', {
                                        minimumFractionDigits: 2,
                                        maximumFractionDigits: 2
                                    })}
                                </span>
                            </button>
                        ) : null}
                    </div>
                ) : null}
                </div>
            </div>

            {showNftPaybackPanel && currentRoom ? (
                <NftRoomPaybackCard
                    racks={placedRacks}
                    roomId={currentRoom.id}
                    upgrades={upgrades}
                    miningCoins={miningCoins}
                    minedUsdTotal={nftAsicMinedUsdTotal}
                    asicLeaseDetails={asicLeaseDetails}
                />
            ) : null}

            {isAsicSalaRoom && currentRoom ? (
                <AsicRoomPaybackCard
                    racks={placedRacks}
                    roomId={currentRoom.id}
                    upgrades={upgrades}
                    miningCoins={miningCoins}
                    minedUsdTotal={asicRoomMinedUsdTotal}
                    asicLeaseDetails={asicLeaseDetails}
                />
            ) : null}

            {slotPurchaseModal && slotPurchasePreview && (
                <div
                    className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50 dark:bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200"
                    onClick={closeSlotPurchaseModal}
                    role="presentation"
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="slot-purchase-title"
                        className="max-w-md w-full rounded-xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h2 id="slot-purchase-title" className="text-lg font-bold text-slate-900 dark:text-white uppercase tracking-wide">
                            {t('servers.room.purchaseTitle')}
                        </h2>
                        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                            {t('servers.room.purchaseRoom', { name: slotPurchaseModal.name })}
                        </p>
                        {(() => {
                            const maxSelectable = Math.min(
                                MAX_RIG_SLOTS_PURCHASE_PER_REQUEST,
                                Math.max(
                                    1,
                                    roomPurchasableSlotsRemaining(
                                        slotPurchaseModal,
                                        slotPurchaseModal.unlockedSlots
                                    )
                                )
                            );
                            return (
                                <div className="mt-4 space-y-3">
                                    <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                        {t('servers.room.slotsQtyLabel', { max: maxSelectable })}
                                    </label>
                                    <input
                                        type="number"
                                        min={1}
                                        max={maxSelectable}
                                        value={slotPurchaseQty}
                                        onChange={(e) => {
                                            const v = Math.floor(Number(e.target.value));
                                            if (!Number.isFinite(v)) {
                                                setSlotPurchaseQty(1);
                                                return;
                                            }
                                            setSlotPurchaseQty(Math.min(Math.max(1, v), maxSelectable));
                                        }}
                                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-slate-900 dark:border-slate-600 dark:bg-slate-950 dark:text-white"
                                    />
                                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-950/80">
                                        <div className="flex justify-between text-slate-600 dark:text-slate-400">
                                            <span>{t('servers.room.totalToCharge')}</span>
                                            <span className="font-mono font-bold text-amber-600 dark:text-amber-400">
                                                USDC{' '}
                                                {slotPurchasePreview.totalUsdc.toLocaleString('en-US', {
                                                    minimumFractionDigits: 2,
                                                    maximumFractionDigits: 2
                                                })}
                                            </span>
                                        </div>
                                        <div className="mt-1 flex justify-between text-slate-600 dark:text-slate-400">
                                            <span>{t('servers.room.slotsToAdd')}</span>
                                            <span className="font-mono font-bold text-slate-900 dark:text-white">{slotPurchasePreview.appliedQty}</span>
                                        </div>
                                        <div className="mt-1 flex justify-between text-slate-600 dark:text-slate-400">
                                            <span>{t('servers.room.currentBalance')}</span>
                                            <span className="font-mono">USDC {usdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</span>
                                        </div>
                                        <div className="mt-1 flex justify-between text-slate-800 dark:text-slate-200">
                                            <span>{t('servers.room.balanceAfter')}</span>
                                            <span
                                                className={`font-mono font-bold ${slotPurchasePreview.saldoApos < 0 ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`}
                                            >
                                                USDC{' '}
                                                {slotPurchasePreview.saldoApos.toLocaleString('en-US', {
                                                    minimumFractionDigits: 2,
                                                    maximumFractionDigits: 4
                                                })}
                                            </span>
                                        </div>
                                    </div>
                                    {!slotPurchasePreview.ok && slotPurchasePreview.message && (
                                        <p className="text-sm text-red-600 dark:text-red-400">{slotPurchasePreview.message}</p>
                                    )}
                                    <div className="mt-4 flex gap-2 justify-end">
                                        <button
                                            type="button"
                                            onClick={closeSlotPurchaseModal}
                                            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                                        >
                                            {t('servers.room.cancel')}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void confirmPurchaseSlots()}
                                            disabled={!slotPurchasePreview.ok || !!purchaseBusyId}
                                            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-bold text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {purchaseBusyId ? t('servers.room.processing') : t('servers.room.confirmPurchase')}
                                        </button>
                                    </div>
                                </div>
                            );
                        })()}
                    </div>
                </div>
            )}

            <div
                ref={bayRef}
                className="srv-bay relative overflow-x-clip overflow-y-visible rounded-2xl border border-cyan-400/15 bg-[#05070f] p-2 shadow-[inset_0_0_60px_rgba(0,0,0,0.65)] sm:overflow-hidden sm:p-4"
                onPointerMove={handleBayPointerMove}
                onPointerLeave={handleBayPointerLeave}
            >
                <style>{`
                  .srv-bay-grid {
                    background-image:
                      linear-gradient(rgba(45,226,230,0.06) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(245,158,11,0.05) 1px, transparent 1px);
                    background-size: 28px 28px;
                    mask-image: radial-gradient(ellipse 70% 65% at 50% 45%, #000 35%, transparent 85%);
                    animation: srv-grid-drift 28s linear infinite;
                  }
                  @keyframes srv-grid-drift {
                    from { background-position: 0 0, 0 0; }
                    to { background-position: 28px 28px, 28px 28px; }
                  }
                  .srv-bay-scan {
                    background: linear-gradient(180deg, transparent 0%, rgba(45,226,230,0.06) 50%, transparent 100%);
                    height: 28%;
                    animation: srv-scan 9s ease-in-out infinite;
                  }
                  @keyframes srv-scan {
                    0%, 100% { transform: translateY(-30%); opacity: 0.12; }
                    50% { transform: translateY(220%); opacity: 0.38; }
                  }
                  /* Orbs sem filter:blur — radial-gradient já suaviza */
                  .srv-orb {
                    animation: srv-orb-pulse 6.5s ease-in-out infinite;
                    transform: translateZ(0);
                  }
                  .srv-orb-b { animation-delay: -2.2s; }
                  .srv-orb-c { animation-delay: -3.8s; }
                  @keyframes srv-orb-pulse {
                    0%, 100% { opacity: 0.4; transform: scale(1); }
                    50% { opacity: 0.72; transform: scale(1.12); }
                  }
                  .srv-corner {
                    width: 28%;
                    height: 28%;
                    border-color: inherit;
                    opacity: 0.95;
                  }
                  ${SERVER_ROOM_EXTRA_FX_CSS}
                `}</style>
                <div aria-hidden className="srv-bay-parallax-layer pointer-events-none absolute inset-0">
                <div aria-hidden className="pointer-events-none absolute inset-0 srv-bay-grid opacity-70" />
                <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
                    <div
                      className="srv-orb absolute -left-10 top-8 h-44 w-44 rounded-full"
                      style={{ background: 'radial-gradient(circle, rgba(45,226,230,0.32) 0%, transparent 70%)' }}
                    />
                    <div
                      className="srv-orb srv-orb-b absolute -right-8 top-1/3 h-52 w-52 rounded-full"
                      style={{ background: 'radial-gradient(circle, rgba(251,191,36,0.26) 0%, transparent 70%)' }}
                    />
                    <div
                      className="srv-orb srv-orb-c absolute bottom-0 left-1/3 h-40 w-40 rounded-full"
                      style={{ background: 'radial-gradient(circle, rgba(217,70,239,0.2) 0%, transparent 70%)' }}
                    />
                    <div className="srv-bay-scan absolute left-0 right-0 top-0" />
                    <div className="absolute inset-x-8 top-3 h-px bg-gradient-to-r from-transparent via-cyan-300/40 to-transparent" />
                    <div className="absolute inset-x-8 bottom-3 h-px bg-gradient-to-r from-transparent via-amber-300/35 to-transparent" />
                    <div className="absolute left-3 inset-y-8 w-px bg-gradient-to-b from-transparent via-cyan-300/30 to-transparent" />
                    <div className="absolute right-3 inset-y-8 w-px bg-gradient-to-b from-transparent via-amber-300/25 to-transparent" />
                </div>
                </div>
            <div className="relative z-10 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-4 justify-items-center sm:gap-x-8 sm:gap-y-12">
                {Array.from({ length: roomCapacity }).map((_, slotIdx) => {
                    const rack = currentRoomRacks.find(r => r.slotIndex === slotIdx);

                    if (!rack) {
                        return (
                            <div
                                key={`empty-${slotIdx}`}
                                className="flex w-full max-w-[240px] flex-col animate-in fade-in zoom-in duration-500 sm:max-w-[360px] md:max-w-[500px]"
                                style={{
                                    aspectRatio: '1 / 1'
                                }}
                            >
                                <button
                                    type="button"
                                    onClick={() => handleSlotClick(null, slotIdx, null, true)}
                                    className="group flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-white p-4 transition-all hover:border-amber-400 hover:bg-amber-50 dark:border-slate-800 dark:bg-slate-900/10 dark:hover:border-amber-800/50 dark:hover:bg-amber-900/5 sm:gap-4 sm:p-8"
                                >
                                    <div className="srv-empty-plus-pulse flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 shadow-inner transition-all group-hover:scale-110 group-hover:bg-amber-100 dark:bg-slate-800 dark:group-hover:bg-amber-900/30 sm:h-20 sm:w-20">
                                        <Plus size={28} className="text-slate-400 group-hover:text-amber-600 dark:text-slate-600 dark:group-hover:text-amber-400 sm:hidden" />
                                        <Plus size={40} className="hidden text-slate-400 group-hover:text-amber-600 dark:text-slate-600 dark:group-hover:text-amber-400 sm:block" />
                                    </div>
                                    <div className="text-center">
                                        <div className="font-extrabold text-slate-400 dark:text-slate-500 group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors uppercase tracking-[0.2em] text-[10px]">{t('servers.room.structureSlot', { number: slotIdx + 1 })}</div>
                                        <div className="text-[10px] text-slate-400 dark:text-slate-600 mt-2 font-mono uppercase opacity-60">{t('servers.room.emptyInstall')}</div>
                                    </div>
                                </button>
                            </div>
                        );
                    }

                    // RACK EXISTE NO SLOT
                    const rackDef =
                        upgrades.find((u) => u.id === rack.itemId) ??
                        (rack.itemId ? orphanCatalogUpgrade(String(rack.itemId), 'infrastructure', t) : undefined);
                    const rackSkin = normalizePublicAssetUrl(rackDef?.image);

                    const finalProd = calculatePlacedRacksProductionHashrate(
                        [rack],
                        upgrades,
                        storedBatteries,
                        batteryCatalogHints
                    );

                    const batteryCatalogId = resolvePlacedRackBatteryCatalogId(
                        rack,
                        storedBatteries,
                        upgrades,
                        batteryCatalogHints
                    );
                    const battery = batteryCatalogId ? upgrades.find((u) => u.id === batteryCatalogId) : null;

                    const isOperational = !!(rack.isOn && rack.wiringId && rack.batteryId);
                    const bootActive = (bootUntilByRack[rack.id] || 0) > Date.now();

                    const layoutToUse = mergeBatteryWidgetsIfAbsent(
                      rackDef?.layout || (rackDef ? getDefaultRackLayout(rackDef) : { canvasWidth: 500, canvasHeight: 600, slots: [] })
                    );
                    const canvasW = layoutToUse.canvasWidth || 500;
                    const canvasH = layoutToUse.canvasHeight || 600;

                    return (
                        <div
                            key={rack.id}
                            className="srv-rack-card relative flex w-full max-w-[240px] flex-col animate-in fade-in zoom-in duration-500 sm:max-w-[360px] md:max-w-[min(100%,500px)]"
                            style={{
                                aspectRatio: `${canvasW} / ${canvasH}`
                            }}
                        >
                            <div
                                className={`relative z-[1] flex-1 flex flex-col transition-all duration-500
                                    ${isOperational ? '' : 'grayscale-[0.3] brightness-90'}
                                    ${rackSkin ? '' : 'bg-slate-800 dark:bg-slate-900 border border-white/5 rounded-none'}
                                `}
                                style={{
                                    ...(rackSkin ? {
                                        backgroundImage: cssSafeBackgroundUrl(rackSkin),
                                        backgroundSize: '100% 100%',
                                        backgroundRepeat: 'no-repeat',
                                        border: 'none',
                                    } : {}),
                                    ...(canvasW && canvasH ? {
                                        aspectRatio: `${canvasW} / ${canvasH}`,
                                        width: '100%',
                                    } : {
                                        minHeight: '500px',
                                        aspectRatio: '400 / 285'
                                    })
                                }}
                            >
                                <div className="relative w-full h-full flex-1">
                                    <RackStatusAura operational={isOperational} hasPowerIntent={!!rack.isOn} />
                                    <RackBootCascade slots={layoutToUse.slots} active={bootActive} />
                                    {(() => {
                                        const layoutToUse = rackDef
                                          ? mergeBatteryWidgetsIfAbsent(rackDef.layout || getDefaultRackLayout(rackDef))
                                          : null;
                                        if (!layoutToUse) return null;

                                        return (
                                            <>
                                                <div className="absolute top-0 right-0 z-20 p-1.5 sm:p-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => onRemoveRack(rack.id)}
                                                        className="rounded-full bg-black/70 p-2 text-white/70 transition-all hover:scale-110 hover:text-red-500 active:scale-95 sm:bg-black/60 sm:p-1 sm:text-white/40"
                                                        title={t('servers.room.dismountRig')}
                                                    >
                                                        <XCircle size={20} className="sm:h-[18px] sm:w-[18px]" />
                                                    </button>
                                                </div>

                                                <div className="absolute inset-0 z-10 p-1.5 sm:p-2">
                                                    {layoutToUse.slots.map((slot, i) => {
                                                        const rawIdx = parseInt(String(slot.id || '').split('_')[1], 10);
                                                        const idx = Number.isFinite(rawIdx)
                                                            ? rawIdx
                                                            : layoutToUse.slots
                                                                .slice(0, i + 1)
                                                                .filter((s) => s.type === slot.type).length - 1;
                                                        const slotContent = slot.type === 'machine' ? rack.slots[idx] :
                                                            slot.type === 'multiplier' ? rack.multiplierSlots[idx] :
                                                                slot.type === 'wiring' ? rack.wiringId :
                                                                    slot.type === 'battery' ? rack.batteryId : null;

                                                        const catalogForBatterySlot =
                                                            slot.type === 'battery' ? batteryCatalogId : null;
                                                        const item =
                                                            slot.type === 'battery'
                                                                ? catalogForBatterySlot
                                                                    ? upgrades.find((u) => u.id === catalogForBatterySlot) ??
                                                                      orphanCatalogUpgrade(String(catalogForBatterySlot), 'battery', t)
                                                                    : null
                                                                : slotContent
                                                                  ? upgrades.find((u) => u.id === slotContent) ??
                                                                    orphanCatalogUpgrade(
                                                                        String(slotContent),
                                                                        slot.type === 'machine'
                                                                            ? 'machine'
                                                                            : slot.type === 'multiplier'
                                                                              ? 'multiplier'
                                                                              : 'wiring',
                                                                        t
                                                                    )
                                                                  : null;
                                                        const itemImg = normalizePublicAssetUrl(item?.image);

                                                        const handleClick = () => {
                                                            if (slot.type === 'machine') handleSlotClick(rack.id, idx, slotContent);
                                                            else if (slot.type === 'multiplier') handleAuxClick(rack.id, slotContent, 'multiplier', idx);
                                                            else if (slot.type === 'wiring') handleAuxClick(rack.id, rack.wiringId, 'wiring');
                                                            else if (slot.type === 'battery') handleAuxClick(rack.id, rack.batteryId, 'battery');
                                                        };

                                                        if (slot.type === 'power') {
                                                            const selectedCoin = isAsicSalaRoom
                                                                ? findAsicRackDisplayCoin(rack, upgrades, miningCoins) ?? asicRoomDisplayCoin
                                                                : miningCoins?.find(c => c.id === rack.selectedCoinId);
                                                            const missing = [];
                                                            if (!isNftSalaRoom && !isAsicSalaRoom && !rack.selectedCoinId) missing.push(t('servers.room.coin'));
                                                            else if (!isNftSalaRoom && !isAsicSalaRoom && selectedCoin && !selectedCoin.isActive) missing.push(t('servers.room.coinSuspended'));

                                                            if (!battery) missing.push(t('servers.room.battery'));
                                                            if (!rack.wiringId) missing.push(t('servers.room.circuit'));
                                                            if (!rack.slots.some(s => s !== null)) {
                                                                missing.push(
                                                                    isNftSalaRoom || isAsicSalaRoom
                                                                        ? t('servers.room.asic')
                                                                        : t('servers.room.gpu')
                                                                );
                                                            }
                                                            const isReady = missing.length === 0;

                                                            return (
                                                                <button
                                                                    key={i}
                                                                    onClick={(e) => { e.stopPropagation(); onTogglePower(rack.id); }}
                                                                    title={!rack.isOn && !isReady ? t('servers.room.missingTitle', { list: missing.join(', ') }) : (rack.isOn ? t('servers.room.powerOff') : t('servers.room.powerOn'))}
                                                                    className={`absolute overflow-hidden rounded-full flex items-center justify-center border-2 shadow-2xl active:scale-90 transition-all z-20 group
                                                                        ${rack.isOn
                                                                            ? 'bg-green-500 border-green-300 text-white shadow-green-500/40'
                                                                            : (isReady
                                                                                ? 'bg-slate-800 border-slate-600 text-slate-400 hover:text-white hover:border-slate-400'
                                                                                : 'bg-red-950/60 border-red-700/50 text-red-500 animate-pulse')}
                                                                    `}
                                                                    style={{ left: `${slot.x}%`, top: `${slot.y}%`, width: `${slot.w}%`, height: `${slot.h}%` }}
                                                                >
                                                                    <Power size={slot.w > 10 ? 16 : 12} className={!rack.isOn && !isReady ? "opacity-30" : "drop-shadow-sm"} />
                                                                </button>
                                                            );
                                                        }

                                                        if (slot.type === 'config') {
                                                            return (
                                                                <button
                                                                    key={i}
                                                                    onClick={(e) => { e.stopPropagation(); setConfigRackId(rack.id); }}
                                                                    className="absolute overflow-hidden rounded-full flex items-center justify-center border-2 border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-white hover:border-slate-500 active:scale-90 transition-all z-20"
                                                                    style={{ left: `${slot.x}%`, top: `${slot.y}%`, width: `${slot.w}%`, height: `${slot.h}%` }}
                                                                >
                                                                    <Cog size={slot.w > 10 ? 16 : 12} />
                                                                </button>
                                                            );
                                                        }

                                                        if (slot.type === 'coin_selector') {
                                                            if (isAsicSalaRoom || isNftSalaRoom) {
                                                                const asicCoins = isAsicSalaRoom
                                                                    ? listAsicRackDisplayCoins(rack, upgrades, miningCoins)
                                                                    : [];
                                                                const fixedCoin = isAsicSalaRoom
                                                                    ? (asicCoins[0] ?? asicRoomDisplayCoin)
                                                                    : findNftRackDisplayCoin(rack, upgrades, miningCoins);
                                                                const fallbackLabel = isAsicSalaRoom ? 'USDC_INT' : '—';
                                                                const coinLabel = isAsicSalaRoom
                                                                    ? (asicCoins.length > 0
                                                                        ? asicCoins
                                                                              .map((c) => (c.symbol || c.name || fallbackLabel).toUpperCase())
                                                                              .join(' + ')
                                                                        : fallbackLabel)
                                                                    : fixedCoin
                                                                      ? (fixedCoin.symbol || fixedCoin.name || fallbackLabel).toUpperCase()
                                                                      : fallbackLabel;
                                                                const showSingleIcon = !isAsicSalaRoom || asicCoins.length <= 1;
                                                                const coinIcon =
                                                                    showSingleIcon && fixedCoin ? miningCoinIconSrc(fixedCoin) : '';
                                                                return (
                                                                    <div
                                                                        key={i}
                                                                        className="pointer-events-none absolute z-20 flex min-h-0 items-center justify-center gap-0.5 overflow-hidden rounded-md border border-emerald-500/40 bg-black/95 px-0.5"
                                                                        style={{ left: `${slot.x}%`, top: `${slot.y}%`, width: `${slot.w}%`, height: `${slot.h}%` }}
                                                                    >
                                                                        {showSingleIcon && coinIcon ? (
                                                                            <img src={coinIcon} alt="" className="h-3 w-3 shrink-0 rounded-full object-cover sm:h-4 sm:w-4" />
                                                                        ) : showSingleIcon && fixedCoin?.color ? (
                                                                            <span className="h-3 w-3 shrink-0 rounded-full sm:h-4 sm:w-4" style={{ backgroundColor: fixedCoin.color }} aria-hidden />
                                                                        ) : null}
                                                                        <span className="truncate text-[8px] font-black uppercase tracking-tight text-emerald-100 sm:text-[9px]">
                                                                            {coinLabel}
                                                                        </span>
                                                                    </div>
                                                                );
                                                            }
                                                            return (
                                                                <div
                                                                    key={i}
                                                                    className={`absolute z-20 bg-black/95 border rounded-md overflow-hidden transition-all duration-300 ${!rack.selectedCoinId ? 'border-amber-500/50 animate-pulse' : 'border-white/10 hover:border-white/20'}`}
                                                                    style={{ left: `${slot.x}%`, top: `${slot.y}%`, width: `${slot.w}%`, height: `${slot.h}%` }}
                                                                >
                                                                    {onSetRackCoin ? (
                                                                        <MiningCoinSelect
                                                                            value={rack.selectedCoinId || ''}
                                                                            onChange={(id) => {
                                                                                onSetRackCoin(rack.id, id);
                                                                            }}
                                                                            coins={rigCoinSelectOptions}
                                                                            noneLabel={t('servers.room.coin')}
                                                                            compact
                                                                            stopPointerPropagation
                                                                            buttonClassName="h-full min-h-0 border-0 bg-transparent px-0.5 py-0 text-center font-black tracking-tighter shadow-none ring-0 focus:ring-0"
                                                                        />
                                                                    ) : null}
                                                                </div>
                                                            );
                                                        }

                                                        if (slot.type === 'battery_bar') {
                                                            return null;
                                                        }

                                                        if (
                                                            slot.type === 'production_display' ||
                                                            slot.type === 'stat_monitor'
                                                        ) {
                                                            const asicCoins = isAsicSalaRoom
                                                                ? listAsicRackDisplayCoins(rack, upgrades, miningCoins)
                                                                : [];
                                                            const selectedCoin = isAsicSalaRoom
                                                                ? (asicCoins[0] ?? asicRoomDisplayCoin)
                                                                : isNftSalaRoom
                                                                    ? findNftRackDisplayCoin(rack, upgrades, miningCoins)
                                                                    : miningCoins?.find((c) => c.id === rack.selectedCoinId);
                                                            const coinLabel = isAsicSalaRoom
                                                                ? (asicCoins.length > 0
                                                                    ? asicCoins
                                                                          .map((c) => (c.symbol || c.name || '—').toUpperCase())
                                                                          .join(' + ')
                                                                    : (selectedCoin?.symbol || selectedCoin?.name || '—').toUpperCase())
                                                                : selectedCoin
                                                                  ? (selectedCoin.symbol || selectedCoin.name || '—').toUpperCase()
                                                                  : '—';
                                                            const showSingleIcon = !isAsicSalaRoom || asicCoins.length <= 1;
                                                            const coinIcon =
                                                                showSingleIcon && selectedCoin ? miningCoinIconSrc(selectedCoin) : '';
                                                            return (
                                                                <div
                                                                    key={i}
                                                                    className="pointer-events-none absolute z-[45] flex min-h-0 flex-col items-center justify-center gap-0.5 overflow-hidden rounded-sm border border-amber-500/30 bg-black/90 px-1 py-0.5 shadow-[inset_0_0_16px_rgba(0,0,0,0.65)]"
                                                                    style={{
                                                                        left: `${slot.x}%`,
                                                                        top: `${slot.y}%`,
                                                                        width: `${slot.w}%`,
                                                                        height: `${slot.h}%`
                                                                    }}
                                                                >
                                                                    <div className="flex min-w-0 max-w-full items-center justify-center gap-1">
                                                                        {showSingleIcon && coinIcon ? (
                                                                            <img
                                                                                src={coinIcon}
                                                                                alt=""
                                                                                className="h-4 w-4 shrink-0 rounded-full object-cover sm:h-5 sm:w-5"
                                                                            />
                                                                        ) : showSingleIcon && selectedCoin?.color ? (
                                                                            <span
                                                                                className="h-4 w-4 shrink-0 rounded-full sm:h-5 sm:w-5"
                                                                                style={{ backgroundColor: selectedCoin.color }}
                                                                                aria-hidden
                                                                            />
                                                                        ) : null}
                                                                        <span className="truncate text-[9px] font-black uppercase tracking-wide text-amber-100 sm:text-[11px]">
                                                                            {coinLabel}
                                                                        </span>
                                                                    </div>
                                                                    <HashrateTicker
                                                                        value={isOperational ? finalProd : 0}
                                                                        operational={isOperational}
                                                                    />
                                                                </div>
                                                            );
                                                        }

                                                        const rarityTint =
                                                            item && (slot.type === 'machine' || slot.type === 'multiplier')
                                                                ? RARITY_SLOT_FX[resolveUpgradeRarity(item)]
                                                                : null;
                                                        const ghostKey =
                                                            slot.type === 'machine' && !item
                                                                ? `${rack.id}:m:${idx}`
                                                                : null;
                                                        const showGhost =
                                                            !!ghostKey &&
                                                            hoverGhostKey === ghostKey &&
                                                            !!lastMachinePreview;
                                                        const burstKey =
                                                            slot.type === 'machine' ? `${rack.id}:${idx}` : '';
                                                        const showMergeBurst =
                                                            slot.type === 'machine' &&
                                                            !!item &&
                                                            (mergeBurstUntil[burstKey] || 0) > Date.now();
                                                        const heat =
                                                            item &&
                                                            slot.type === 'machine' &&
                                                            isOperational
                                                                ? heatIntensityForRarity(resolveUpgradeRarity(item))
                                                                : null;

                                                        return (
                                                            <button
                                                                key={i}
                                                                type="button"
                                                                onClick={handleClick}
                                                                onMouseEnter={() => {
                                                                    if (ghostKey) setHoverGhostKey(ghostKey);
                                                                }}
                                                                onMouseLeave={() => {
                                                                    if (ghostKey) setHoverGhostKey(null);
                                                                }}
                                                                title={
                                                                    item && rarityTint
                                                                        ? `${item.name} · ${resolveUpgradeRarity(item)}`
                                                                        : undefined
                                                                }
                                                                className={`absolute z-[35] group transition-all overflow-hidden border shadow-inner
                                                                    ${item
                                                                        ? rarityTint
                                                                            ? 'scale-100 hover:scale-[1.03]'
                                                                            : itemImg
                                                                              ? 'border-none shadow-xl scale-100 hover:scale-[1.02]'
                                                                              : 'bg-slate-800/90 border-white/10'
                                                                        : (
                                                                        (slot.type === 'machine' && !rack.slots.some(s => s !== null)) ||
                                                                            (slot.type === 'battery' && !rack.batteryId) ||
                                                                            (slot.type === 'wiring' && !rack.wiringId)
                                                                            ? 'bg-red-500/10 border-red-500/30 animate-pulse border-dashed'
                                                                            : 'bg-amber-500/5 border-dashed border-amber-500/10 hover:bg-amber-500/10 hover:border-amber-500/30'
                                                                    )}
                                                                    ${slot.type === 'machine' ? 'rounded-md' : 'rounded-lg'}
                                                                    ${item && !isOperational ? 'grayscale opacity-70 contrast-125' : ''}
                                                                `}
                                                                style={{
                                                                    left: `${slot.x}%`,
                                                                    top: `${slot.y}%`,
                                                                    width: `${slot.w}%`,
                                                                    height: `${slot.h}%`,
                                                                    ...(rarityTint
                                                                        ? {
                                                                              background: rarityTint.bg,
                                                                              borderColor: rarityTint.border,
                                                                              boxShadow: rarityTint.glow
                                                                          }
                                                                        : {})
                                                                }}
                                                            >
                                                                {item && itemImg && (
                                                                    <AnimatedMiner
                                                                        src={itemImg}
                                                                        isOperational={isOperational}
                                                                        className="absolute inset-[2px] w-[calc(100%-4px)] h-[calc(100%-4px)] pointer-events-none rounded-[3px]"
                                                                        style={{}}
                                                                        item={item}
                                                                    />
                                                                )}

                                                                {!item && showGhost && (
                                                                    <MachineGhostPreview
                                                                        preview={lastMachinePreview}
                                                                        visible
                                                                    />
                                                                )}

                                                                {heat && (
                                                                    <div
                                                                        aria-hidden
                                                                        className="srv-heat"
                                                                        style={{
                                                                            ['--heat-dur' as string]: heat.dur,
                                                                            ['--heat-op' as string]: String(heat.op)
                                                                        }}
                                                                    />
                                                                )}

                                                                {showMergeBurst && <div aria-hidden className="srv-merge-burst" />}

                                                                {item && rarityTint && (
                                                                    <div
                                                                        aria-hidden
                                                                        className="srv-rarity-pulse pointer-events-none absolute inset-0 rounded-[inherit]"
                                                                        style={{
                                                                            background: `linear-gradient(180deg, ${rarityTint.wash} 0%, transparent 40%, transparent 60%, ${rarityTint.wash} 100%)`,
                                                                            boxShadow: `inset 0 0 0 1px ${rarityTint.border}`
                                                                        }}
                                                                    />
                                                                )}

                                                                {item && !itemImg && !isOperational && (
                                                                    <div className="pointer-events-none absolute inset-0 bg-slate-900/60" />
                                                                )}

                                                                {item && isOperational && (
                                                                    <>
                                                                        <div className="srv-slot-live pointer-events-none absolute inset-0" />
                                                                        <div className="pointer-events-none absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-green-500 shadow-[0_0_8px_#22c55e]" />
                                                                    </>
                                                                )}
                                                                {!item && (
                                                                    <div className="h-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-amber-500/10">
                                                                        <Plus
                                                                            size={10}
                                                                            className={`text-amber-400 ${
                                                                                showGhost ? 'srv-empty-plus-pulse rounded-full' : ''
                                                                            }`}
                                                                        />
                                                                    </div>
                                                                )}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </>
                                        );
                                    })()}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
            </div>


            {/* INVENTORY MODAL */}
            {
                selectionContext && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 dark:bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
                        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
                            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center bg-slate-50 dark:bg-slate-950">
                                <h3 className="font-bold text-slate-800 dark:text-white flex items-center gap-2 uppercase">
                                    <Box size={18} className="text-amber-600 dark:text-amber-400" />
                                    {selectionTypeTitle}
                                </h3>
                                <button onClick={() => setSelectionContext(null)} className="text-slate-500 hover:text-slate-800 dark:hover:text-white transition-colors">
                                    <X size={20} />
                                </button>
                            </div>

                            <div className="p-4 max-h-[60vh] overflow-y-auto custom-scrollbar">
                                <div className="flex flex-col gap-2">
                                    {selectionContext.type === 'battery' ? (
                                        <>
                                            <div className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 flex items-center gap-2">
                                                <Save size={10} /> {t('mining.inventory.compatibleBatteries')}
                                            </div>
                                            {getBatteryPickerRows().length === 0 ? (
                                                <div className="text-center py-4 text-slate-500 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-800/50 border-dashed">
                                                    <p className="text-sm">{t('mining.inventory.emptyStock')}</p>
                                                    <p className="text-xs mt-1">{t('mining.inventory.buyMore')}</p>
                                                </div>
                                            ) : (
                                                getBatteryPickerRows().map((row) => {
                                                    const listImg = normalizePublicAssetUrl(row.upgrade.image);
                                                    const total = row.stockCount;
                                                    return (
                                                        <button
                                                            key={row.itemId}
                                                            onClick={() =>
                                                                handleItemSelect(row.itemId)
                                                            }
                                                            className="flex items-center gap-4 p-3 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-white dark:hover:bg-slate-750 hover:border-amber-500/50 transition-all text-left group"
                                                        >
                                                            <div className="flex shrink-0 items-center justify-center overflow-hidden rounded border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 w-12 h-12 group-hover:border-amber-500/30">
                                                                <UpgradeSelectionThumb
                                                                    upgrade={row.upgrade}
                                                                    normalizedImage={listImg}
                                                                    iconSize={26}
                                                                />
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <div className="font-bold text-slate-800 dark:text-slate-200 text-sm truncate">
                                                                    {row.upgrade.name}
                                                                </div>
                                                                <div className="text-xs text-yellow-600 dark:text-yellow-400 mt-1">
                                                                    {formatBatteryCapacityLabel(
                                                                        row.upgrade.powerCapacity,
                                                                        batteryUnlimitedLabel
                                                                    )}
                                                                </div>
                                                            </div>
                                                            <div className="bg-slate-100 dark:bg-slate-950 px-2 py-1 rounded text-xs font-mono text-amber-700 dark:text-amber-500 border border-slate-200 dark:border-slate-800">
                                                                x{total}
                                                            </div>
                                                        </button>
                                                    );
                                                })
                                            )}
                                        </>
                                    ) : (
                                        <>
                                            <div className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">
                                                {t('mining.inventory.compatibleStock')}
                                            </div>

                                            {selectionContext.type === 'machine' && (
                                                <div className="flex flex-wrap gap-2 mb-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => setMachinePickerSort('power_desc')}
                                                        className={`px-2 py-1 text-[10px] font-bold uppercase rounded border ${
                                                            machinePickerSort === 'power_desc'
                                                                ? 'border-amber-600/50 text-amber-700 bg-amber-600/10 dark:text-amber-200'
                                                                : 'border-slate-300 text-slate-500 dark:border-slate-700 dark:text-slate-500'
                                                        }`}
                                                    >
                                                        {t('mining.inventory.sortPowerDesc')}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setMachinePickerSort('power_asc')}
                                                        className={`px-2 py-1 text-[10px] font-bold uppercase rounded border ${
                                                            machinePickerSort === 'power_asc'
                                                                ? 'border-amber-600/50 text-amber-700 bg-amber-600/10 dark:text-amber-200'
                                                                : 'border-slate-300 text-slate-500 dark:border-slate-700 dark:text-slate-500'
                                                        }`}
                                                    >
                                                        {t('mining.inventory.sortPowerAsc')}
                                                    </button>
                                                </div>
                                            )}

                                            {getAvailableItems().length === 0 ? (
                                                <div className="text-center py-4 text-slate-500 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-800/50 border-dashed">
                                                    <p className="text-sm">{t('mining.inventory.emptyStock')}</p>
                                                    <p className="text-xs mt-1">{t('mining.inventory.buyMore')}</p>
                                                </div>
                                            ) : (
                                                getAvailableItems().map((item) => {
                                                    const listImg = normalizePublicAssetUrl(item.image);
                                                    return (
                                                        <button
                                                            key={item.id}
                                                            onClick={() => handleItemSelect(item.id)}
                                                            className="flex items-center gap-4 p-3 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-white dark:hover:bg-slate-750 hover:border-amber-500/50 transition-all text-left group"
                                                        >
                                                            <div className="flex shrink-0 items-center justify-center overflow-hidden rounded border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 w-12 h-12 group-hover:border-amber-500/30">
                                                                <UpgradeSelectionThumb
                                                                    upgrade={item}
                                                                    normalizedImage={listImg}
                                                                    iconSize={26}
                                                                />
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <div className="font-bold text-slate-800 dark:text-slate-200 text-sm">
                                                                    {item.name}
                                                                </div>
                                                                <div className="flex gap-3 text-xs text-slate-500 dark:text-slate-400 mt-1">
                                                                    {item.type === 'machine' && (
                                                                        <span className="text-green-600 dark:text-green-400">
                                                                            +{formatHashrateDisplay(item.baseProduction)} H/s
                                                                        </span>
                                                                    )}
                                                                    {item.type === 'multiplier' && (
                                                                        <span className="text-orange-600 dark:text-orange-400">
                                                                            {t('servers.room.boostPct', { pct: ((item.multiplier || 0) * 100).toFixed(1) })}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            </div>
                                                            <div className="bg-slate-100 dark:bg-slate-950 px-2 py-1 rounded text-xs font-mono text-amber-700 dark:text-amber-500 border border-slate-200 dark:border-slate-800">
                                                                x{stock[item.id]}
                                                            </div>
                                                        </button>
                                                    );
                                                })
                                            )}
                                        </>
                                    )}
                                </div>
                            </div>

                            <div className="p-3 bg-slate-50 dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800 text-center">
                                <button onClick={() => setSelectionContext(null)} className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
                                    {t('common.cancel')}
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }

            {
                configRackId && (
                    <div
                        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 dark:bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200"
                        onClick={() => setConfigRackId(null)}
                        role="presentation"
                    >
                        <div
                            role="dialog"
                            aria-modal="true"
                            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl w-full max-w-lg max-h-[min(92vh,40rem)] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="shrink-0 p-4 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center bg-slate-50 dark:bg-slate-950">
                                <h3 className="font-bold text-slate-800 dark:text-white flex items-center gap-2 uppercase"><Cog size={18} className="text-amber-600 dark:text-amber-400" /> {t('servers.room.configTitle')}</h3>
                                <button type="button" onClick={() => setConfigRackId(null)} className="text-slate-500 hover:text-slate-800 dark:hover:text-white transition-colors" aria-label={t('servers.room.close')}>
                                    <X size={20} />
                                </button>
                            </div>
                            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 custom-scrollbar">
                                {(() => {
                                    const rack = placedRacks.find(r => r.id === configRackId)!;
                                    const wiring = rack.wiringId
                                        ? upgrades.find((u) => u.id === rack.wiringId) ??
                                          orphanCatalogUpgrade(String(rack.wiringId), 'wiring', t)
                                        : null;
                                    const battCat = resolvePlacedRackBatteryCatalogId(
                                        rack,
                                        storedBatteries,
                                        upgrades,
                                        batteryCatalogHints
                                    );
                                    const battery = battCat
                                        ? upgrades.find((u) => u.id === battCat) ??
                                          orphanCatalogUpgrade(String(battCat), 'battery', t)
                                        : null;
                                    const machineDefs = rack.slots
                                        .map((sid) =>
                                            sid
                                                ? upgrades.find((u) => u.id === sid) ?? orphanCatalogUpgrade(String(sid), 'machine', t)
                                                : null
                                        )
                                        .filter(Boolean) as Upgrade[];
                                    const baseProd = machineDefs.reduce((acc, u) => acc + (u.baseProduction || 0), 0);
                                    let mult = 1;
                                    rack.multiplierSlots?.forEach((sid) => {
                                        const up = sid
                                            ? upgrades.find((u) => u.id === sid) ?? orphanCatalogUpgrade(String(sid), 'multiplier', t)
                                            : null;
                                        if (up && up.multiplier) mult += up.multiplier;
                                    });
                                    const totalPower = baseProd * mult;
                                    const asicLockedCoins = isAsicSalaRoom
                                        ? listAsicRackDisplayCoins(rack, upgrades, miningCoins)
                                        : [];
                                    const lockedRoomCoin = isAsicSalaRoom
                                        ? (asicLockedCoins[0] ?? asicRoomDisplayCoin)
                                        : isNftSalaRoom
                                            ? findNftRackDisplayCoin(rack, upgrades, miningCoins)
                                            : undefined;
                                    const lockedRoomCoinFallback = isAsicSalaRoom ? 'USDC_INT' : '—';
                                    const lockedRoomCoinLabel = isAsicSalaRoom
                                        ? (asicLockedCoins.length > 0
                                            ? asicLockedCoins
                                                  .map((c) => (c.symbol || c.name || lockedRoomCoinFallback).toUpperCase())
                                                  .join(' + ')
                                            : lockedRoomCoinFallback)
                                        : lockedRoomCoin
                                          ? (lockedRoomCoin.symbol || lockedRoomCoin.name || lockedRoomCoinFallback).toUpperCase()
                                          : lockedRoomCoinFallback;
                                    const showLockedCoinIcon =
                                        !isAsicSalaRoom || asicLockedCoins.length <= 1;
                                    const asicHashByCoin =
                                        isAsicSalaRoom && asicLockedCoins.length > 1
                                            ? listAsicRackBaseProductionByCoin(rack, upgrades, miningCoins)
                                            : [];
                                    const asicHashBreakdown =
                                        asicHashByCoin.length > 1
                                            ? asicHashByCoin
                                                  .map(({ coin, baseProduction }) => {
                                                      const hs = formatHashrateDisplay(baseProduction * mult);
                                                      const sym = (coin.symbol || coin.name || '').toUpperCase();
                                                      return `${hs} ${sym}`.trim();
                                                  })
                                                  .join(' + ')
                                            : '';

                                    return (
                                        <>
                                            <div>
                                                <label className="text-xs uppercase font-bold text-slate-500">{t('servers.room.rigCrypto')}</label>
                                                {isAsicSalaRoom || isNftSalaRoom ? (
                                                    <div className="mt-1 flex items-center gap-2 rounded border border-emerald-500/30 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-100">
                                                        {lockedRoomCoin || asicLockedCoins.length > 0 ? (
                                                            <>
                                                                {showLockedCoinIcon && lockedRoomCoin && miningCoinIconSrc(lockedRoomCoin) ? (
                                                                    <img src={miningCoinIconSrc(lockedRoomCoin)} alt="" className="h-5 w-5 rounded-full object-cover" />
                                                                ) : null}
                                                                <span className="font-bold uppercase">
                                                                    {lockedRoomCoinLabel}
                                                                </span>
                                                            </>
                                                        ) : (
                                                            <span className="font-bold uppercase">{lockedRoomCoinFallback}</span>
                                                        )}
                                                    </div>
                                                ) : onSetRackCoin ? (
                                                    <MiningCoinSelect
                                                        value={rack.selectedCoinId || ''}
                                                        onChange={(id) => onSetRackCoin(rack.id, id)}
                                                        coins={rigCoinSelectOptions}
                                                        noneLabel={t('servers.room.none')}
                                                        buttonClassName={`rounded p-2 text-sm ${!rack.selectedCoinId ? 'border-amber-500 text-amber-500 font-bold' : 'border-slate-700 text-white'}`}
                                                    />
                                                ) : null}
                                                {!isAsicSalaRoom && !isNftSalaRoom ? (
                                                    <p className="text-[10px] text-slate-500 mt-1">{t('servers.room.inactiveCoinsHint')}</p>
                                                ) : null}
                                            </div>

                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                                <div className="bg-slate-100 dark:bg-slate-800 rounded p-3 border border-slate-200 dark:border-slate-700">
                                                    <div className="font-bold text-sm text-slate-800 dark:text-white mb-2">
                                                        {isNftSalaRoom || isAsicSalaRoom
                                                            ? t('servers.room.asic')
                                                            : t('servers.room.gpus')}
                                                    </div>
                                                    {machineDefs.length === 0 ? (
                                                        <div className="text-xs text-slate-500">{t('servers.room.noneInstalled')}</div>
                                                    ) : machineDefs.map((m, i) => {
                                                        const asicFixedCoin =
                                                            isAsicSalaRoom && isAsicMachineUpgrade(m) && m.nftMiningCoinId
                                                                ? miningCoins?.find((c) => c.id === m.nftMiningCoinId)
                                                                : undefined;
                                                        const asicCoinLabel = asicFixedCoin
                                                            ? (asicFixedCoin.symbol || asicFixedCoin.name || '').toUpperCase()
                                                            : '';
                                                        return (
                                                        <div key={i} className="text-xs text-slate-600 dark:text-slate-300">
                                                            <span className="font-bold text-slate-700 dark:text-white">{m.name}</span>
                                                            {asicCoinLabel ? (
                                                                <span className="ml-1 font-bold uppercase text-emerald-600 dark:text-emerald-400">
                                                                    {asicCoinLabel}
                                                                </span>
                                                            ) : null}
                                                            {!(isAsicSalaRoom || isNftSalaRoom) && m.description ? (
                                                                <span className="line-clamp-1"> — {m.description}</span>
                                                            ) : null}
                                                            <div className="text-[10px] text-green-600 dark:text-green-400">{t('servers.room.powerPlusHs', { hs: m.baseProduction })}</div>
                                                        </div>
                                                        );
                                                    })}
                                                </div>

                                                <div className="bg-slate-100 dark:bg-slate-800 rounded p-3 border border-slate-200 dark:border-slate-700">
                                                    <div className="font-bold text-sm text-slate-800 dark:text-white mb-2">{t('servers.room.battery')}</div>
                                                    {battery ? (
                                                        <>
                                                            <div className="text-xs text-slate-600 dark:text-slate-300"><span className="font-bold text-slate-700 dark:text-white">{battery.name}</span> — {battery.description}</div>
                                                            <div className="text-[10px] text-yellow-600 dark:text-yellow-400">
                                                                {t('servers.room.capacityLabel')} {formatBatteryCapacityLabel(battery.powerCapacity, batteryUnlimitedLabel)}
                                                            </div>
                                                            <div className="w-full h-2 bg-slate-300 dark:bg-black rounded-sm border border-slate-400 dark:border-slate-700 relative overflow-hidden mt-1">
                                                                <div className="h-full bg-yellow-500" style={{ width: '100%' }}></div>
                                                            </div>
                                                        </>
                                                    ) : (
                                                        <div className="text-xs text-slate-500">{t('servers.room.noneInstalled')}</div>
                                                    )}
                                                </div>

                                                <div className="bg-slate-100 dark:bg-slate-800 rounded p-3 border border-slate-200 dark:border-slate-700">
                                                    <div className="font-bold text-sm text-slate-800 dark:text-white mb-2">{t('servers.room.wiring')}</div>
                                                    {wiring ? (
                                                        <div className="text-xs text-slate-600 dark:text-slate-300"><span className="font-bold text-slate-700 dark:text-white">{wiring.name}</span> — {wiring.description}</div>
                                                    ) : (
                                                        <div className="text-xs text-slate-500">{t('servers.room.noneInstalled')}</div>
                                                    )}
                                                </div>

                                                <div className="bg-slate-100 dark:bg-slate-800 rounded p-3 border border-slate-200 dark:border-slate-700">
                                                    <div className="font-bold text-sm text-slate-800 dark:text-white mb-2">{t('servers.room.hashrateTotal')}</div>
                                                    <div className="text-xs text-slate-700 dark:text-slate-200">{totalPower.toFixed(2)} H/s</div>
                                                    {asicHashBreakdown ? (
                                                        <div className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                                                            {asicHashBreakdown}
                                                        </div>
                                                    ) : null}
                                                </div>
                                            </div>
                                        </>
                                    );
                                })()}
                            </div>
                        </div>
                    </div>
                )
            }

            {
                detailContext && (() => {
                    const detailImg = normalizePublicAssetUrl(detailContext.item.image);
                    return (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 dark:bg-slate-950/80 backdrop-blur-sm">
                        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
                            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center bg-slate-50 dark:bg-slate-950">
                                <h3 className="font-bold text-slate-800 dark:text-white text-sm">
                                    {detailContext.item.name}
                                </h3>
                                <button onClick={() => setDetailContext(null)} className="text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white">
                                    <X size={16} />
                                </button>
                            </div>
                            <div className="p-4 space-y-3">
                                <div className="flex items-center gap-3">
                                    <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800">
                                        <UpgradeSelectionThumb
                                            upgrade={detailContext.item}
                                            normalizedImage={detailImg}
                                            iconSize={28}
                                        />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-xs text-slate-500 dark:text-slate-400">
                                            {detailContext.item.status === 'legacy' || detailContext.item.category === 'legacy'
                                              ? t('servers.room.legacyItem')
                                              : t(catalogTypeLabelKey(detailContext.item.type))}
                                        </div>
                                    </div>
                                </div>
                                <div className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                                    {detailContext.item.description}
                                </div>
                                <div className="grid grid-cols-2 gap-2 text-xs text-slate-600 dark:text-slate-400">
                                    {typeof detailContext.item.baseProduction === 'number' && detailContext.item.baseProduction > 0 && (
                                        <div className="bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded p-2">
                                            <div className="font-bold text-slate-800 dark:text-slate-200">{t('servers.room.production')}</div>
                                            <div>{detailContext.item.baseProduction} N/s</div>
                                        </div>
                                    )}
                                    {typeof detailContext.item.powerCapacity === 'number' &&
                                      (detailContext.item.powerCapacity > 0 || detailContext.item.powerCapacity === -1) && (
                                        <div className="bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded p-2">
                                            <div className="font-bold text-slate-800 dark:text-slate-200">{t('servers.room.capacity')}</div>
                                            <div>{formatBatteryCapacityLabel(detailContext.item.powerCapacity, batteryUnlimitedLabel)}</div>
                                        </div>
                                    )}
                                    {typeof detailContext.item.multiplier === 'number' && detailContext.item.multiplier! > 0 && (
                                        <div className="bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded p-2">
                                            <div className="font-bold text-slate-800 dark:text-slate-200">{t('servers.room.multiplier')}</div>
                                            <div>{(detailContext.item.multiplier * 100).toFixed(1)}%</div>
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex gap-2">
                                <button onClick={() => setDetailContext(null)} className="bg-slate-700 text-white px-4 py-2 rounded font-bold">
                                    {t('servers.room.close')}
                                </button>
                                <button
                                    onClick={() => {
                                        if (!detailContext) return;
                                        if (detailContext.type === 'machine' && detailContext.slotIndex !== null) {
                                            onUnequipMiner(detailContext.rackId, detailContext.slotIndex);
                                        } else {
                                            onUnequipAux(detailContext.rackId, detailContext.type as 'battery' | 'wiring' | 'multiplier', detailContext.slotIndex ?? undefined);
                                        }
                                        setDetailContext(null);
                                    }}
                                    className="bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded font-bold flex-1"
                                >
                                    {t('servers.room.remove')}
                                </button>
                            </div>
                        </div>
                    </div>
                    );
                })()}

            {roomBulkBatteryModal && onSetRoomRacksBattery && (() => {
                const racksHere = placedRacks.filter((r) => sameRigRoom(r.roomId, roomBulkBatteryModal.id));
                const needForSelect = roomBulkBatterySelect
                    ? (() => {
                        const def = upgrades.find(u => u.id === roomBulkBatterySelect && u.type === 'battery');
                        if (!def) return 0;
                        return racksHere.filter(rack =>
                            !def.compatibleRacks?.length || isCompatibleWithRack(def.compatibleRacks || [], rack.itemId)
                        ).length;
                    })()
                    : 0;
                const availForSelect = roomBulkBatterySelect
                    ? totalBatteryInstances(roomBulkBatterySelect, stock, storedBatteries)
                    : 0;
                const modalWillApply =
                    roomBulkBatterySelect && needForSelect > 0
                        ? bulkBatteryWillApplyCount(needForSelect, roomBulkBatterySelect, stock, storedBatteries)
                        : 0;
                const batteryApplyInvalid =
                    roomBulkBatterySelect !== '' && (needForSelect === 0 || availForSelect < 1);
                const hasSmartFillPool =
                    racksHere.length > 0 &&
                    upgrades.some((u) => {
                        if (u.type !== 'battery') return false;
                        if (totalBatteryInstances(u.id, stock, storedBatteries) < 1) return false;
                        return racksHere.some(
                            (rack) => !u.compatibleRacks?.length || isCompatibleWithRack(u.compatibleRacks || [], rack.itemId)
                        );
                    });
                const applyDisabled = roomBulkBatterySmartFill ? !hasSmartFillPool : batteryApplyInvalid;
                return (
                    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 dark:bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
                        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl w-full max-w-lg max-h-[min(92vh,36rem)] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
                            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center bg-slate-50 dark:bg-slate-950">
                                <h3 className="font-bold text-slate-800 dark:text-white flex items-center gap-2 text-sm uppercase">
                                    <Battery size={18} className="text-yellow-600 dark:text-yellow-400 shrink-0" />
                                    {t('servers.room.bulkBatteryTitle')}
                                </h3>
                                <button type="button" onClick={closeRoomBulkBatteryModal} className="text-slate-500 hover:text-slate-800 dark:hover:text-white transition-colors" aria-label={t('servers.room.close')}>
                                    <X size={20} />
                                </button>
                            </div>
                            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 custom-scrollbar">
                                <p className="text-xs text-slate-600 dark:text-slate-400">
                                    <span className="font-bold text-slate-800 dark:text-slate-200">{roomBulkBatteryModal.name}</span>
                                    {' — '}{t('servers.room.bulkBatteryIntro')}
                                </p>
                                <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2 dark:border-slate-600 dark:bg-slate-950/80">
                                    <label className="text-[10px] uppercase font-bold text-slate-500 block">{t('servers.room.distributeOrder')}</label>
                                    <select
                                        value={roomBulkBatteryRigSort}
                                        onChange={(e) =>
                                            setRoomBulkBatteryRigSort(e.target.value === 'hashrate_desc' ? 'hashrate_desc' : 'slot_asc')
                                        }
                                        className="w-full rounded border border-slate-300 bg-white p-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
                                    >
                                        <option value="slot_asc">{t('servers.room.orderBySlot')}</option>
                                        <option value="hashrate_desc">{t('servers.room.orderByHashrate')}</option>
                                    </select>
                                    <label className="flex cursor-pointer items-start gap-2 text-xs text-slate-700 dark:text-slate-200">
                                        <input
                                            type="checkbox"
                                            checked={roomBulkBatterySmartFill}
                                            onChange={(e) => {
                                                const on = e.target.checked;
                                                setRoomBulkBatterySmartFill(on);
                                                if (on) setRoomBulkBatterySelect('');
                                            }}
                                            className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-400"
                                        />
                                        <span>
                                            {t('servers.room.smartFill')} — {t('servers.room.smartFillDetail')}
                                        </span>
                                    </label>
                                </div>
                                <div className={roomBulkBatterySmartFill ? 'pointer-events-none opacity-50' : ''}>
                                    <label className="text-[10px] uppercase font-bold text-slate-500 block mb-1">{t('servers.room.chooseAction')}</label>
                                    <div className="max-h-[min(52vh,20rem)] space-y-1.5 overflow-y-auto rounded-lg border border-slate-300 bg-slate-50 p-1.5 dark:border-slate-600 dark:bg-slate-950/80 custom-scrollbar">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setRoomBulkBatterySmartFill(false);
                                                setRoomBulkBatterySelect('');
                                            }}
                                            className={`flex w-full items-center gap-3 rounded-lg border px-2 py-2 text-left text-sm ${
                                                roomBulkBatterySelect === ''
                                                    ? 'border-blue-500 bg-blue-600/15 text-slate-900 dark:text-white'
                                                    : 'border-transparent hover:bg-slate-200 dark:hover:bg-slate-800'
                                            }`}
                                        >
                                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-slate-200 dark:bg-slate-800">
                                                <XCircle size={20} className="text-slate-600 dark:text-slate-300" aria-hidden />
                                            </div>
                                            <div className="min-w-0 flex-1 font-semibold">{t('servers.room.removeAll')}</div>
                                        </button>
                                        {/* Lista manual: só tipos com unidades no stock (x0 some). */}
                                        {upgrades
                                            .filter((u) => u.type === 'battery' && (stock[u.id] || 0) > 0)
                                            .map((u) => {
                                                const need = racksHere.filter(
                                                    (rack) =>
                                                        !u.compatibleRacks?.length ||
                                                        isCompatibleWithRack(u.compatibleRacks || [], rack.itemId)
                                                ).length;
                                                const have = totalBatteryInstances(u.id, stock, storedBatteries);
                                                const will = need > 0 ? Math.min(need, have) : 0;
                                                const subtitle =
                                                    need > 0
                                                        ? t('servers.room.compatibleSummary', { need, have, will })
                                                        : t('servers.room.noCompatibleRigs');
                                                return (
                                                    <BatteryOptionRow
                                                        key={u.id}
                                                        upgrade={u}
                                                        selected={roomBulkBatterySelect === u.id}
                                                        disabled={need === 0}
                                                        subtitle={subtitle}
                                                        onPick={() => {
                                                            setRoomBulkBatterySmartFill(false);
                                                            setRoomBulkBatterySelect(u.id);
                                                        }}
                                                    />
                                                );
                                            })}
                                    </div>
                                </div>
                            </div>
                            <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex gap-2 justify-end bg-slate-50 dark:bg-slate-950">
                                <button type="button" onClick={closeRoomBulkBatteryModal} className="px-4 py-2 rounded-md text-sm font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors">
                                    {t('servers.room.cancel')}
                                </button>
                                <button
                                    type="button"
                                    disabled={applyDisabled}
                                    title={
                                        applyDisabled
                                            ? roomBulkBatterySmartFill
                                                ? t('servers.room.noBatteriesStock')
                                                : t('servers.room.noCompatibleOrUnits')
                                            : undefined
                                    }
                                    onClick={() => {
                                        const opts: BulkRoomBatteryRunOptions = {
                                            rigSort: roomBulkBatteryRigSort
                                        };
                                        if (roomBulkBatterySmartFill) opts.smartFill = true;
                                        onSetRoomRacksBattery(
                                            roomBulkBatteryModal.id,
                                            roomBulkBatterySmartFill ? '' : roomBulkBatterySelect,
                                            opts
                                        );
                                        closeRoomBulkBatteryModal();
                                    }}
                                    className={`px-4 py-2 rounded-md text-sm font-bold uppercase tracking-wide border transition-colors ${applyDisabled ? 'bg-slate-600 text-slate-400 border-slate-600 cursor-not-allowed' : 'bg-yellow-700 text-white hover:bg-yellow-600 border-yellow-600/50'}`}
                                >
                                    {roomBulkBatterySmartFill
                                        ? t('servers.room.applySmartFill')
                                        : roomBulkBatterySelect
                                          ? t('servers.room.applyRigsCount', { count: modalWillApply })
                                          : t('servers.room.removeAll')}
                                </button>
                            </div>
                        </div>
                    </div>
                );
            })()}
        </div >
    );
};
