import { useEffect, useRef, useState } from 'react';
import { formatHashrateDisplay } from '../models/serverRoomModel';
import type { Upgrade } from '../types';
import { normalizePublicAssetUrl } from '../utils/publicUrl';

export type FxLayoutSlot = {
  id?: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

function slotCenter(s: FxLayoutSlot) {
  return { x: s.x + s.w / 2, y: s.y + s.h / 2 };
}

/** CSS extra das animações da baía / rack (inject no ServerRoom). */
export const SERVER_ROOM_EXTRA_FX_CSS = `
  .srv-bay-parallax-layer {
    transform: translate3d(var(--parallax-x, 0px), var(--parallax-y, 0px), 0);
    transition: transform 0.28s ease-out;
    will-change: transform;
  }
  .srv-rack-card {
    contain: layout style;
  }
  .srv-status-offline {
    background: repeating-linear-gradient(
      -12deg,
      transparent,
      transparent 10px,
      rgba(239,68,68,0.06) 10px,
      rgba(239,68,68,0.06) 20px
    );
    animation: srv-offline-scan 4.8s linear infinite;
  }
  @keyframes srv-offline-scan {
    from { background-position: 0 0; }
    to { background-position: 40px 40px; }
  }
  .srv-status-online {
    box-shadow: inset 0 0 36px rgba(34,197,94,0.12), inset 0 0 64px rgba(245,158,11,0.07);
    animation: srv-online-pulse 3.4s ease-in-out infinite;
  }
  @keyframes srv-online-pulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 1; }
  }
  .srv-boot-flash {
    animation: srv-boot-flash 0.45s ease-out forwards;
  }
  @keyframes srv-boot-flash {
    0% { opacity: 0; box-shadow: 0 0 0 rgba(34,197,94,0); }
    35% { opacity: 1; box-shadow: 0 0 18px rgba(34,197,94,0.75); }
    100% { opacity: 0; box-shadow: 0 0 0 rgba(34,197,94,0); }
  }
  .srv-fan {
    border-radius: 50%;
    border: 1px solid rgba(45,226,230,0.35);
    background: radial-gradient(circle at 50% 50%, rgba(45,226,230,0.35), rgba(0,0,0,0.55) 62%);
    box-shadow: 0 0 10px rgba(45,226,230,0.3), inset 0 0 8px rgba(0,0,0,0.65);
  }
  .srv-fan-blade {
    position: absolute;
    inset: 12%;
    border-radius: 50%;
    background:
      conic-gradient(from 0deg, transparent 0 18deg, rgba(255,255,255,0.55) 18deg 36deg, transparent 36deg 54deg,
        rgba(45,226,230,0.65) 54deg 72deg, transparent 72deg 90deg,
        rgba(255,255,255,0.45) 90deg 108deg, transparent 108deg 126deg,
        rgba(45,226,230,0.55) 126deg 144deg, transparent 144deg 180deg,
        rgba(255,255,255,0.4) 180deg 198deg, transparent 198deg 216deg,
        rgba(45,226,230,0.55) 216deg 234deg, transparent 234deg 270deg,
        rgba(255,255,255,0.4) 270deg 288deg, transparent 288deg 306deg,
        rgba(45,226,230,0.55) 306deg 324deg, transparent 324deg 360deg);
    animation: srv-fan-spin var(--fan-dur, 1.1s) linear infinite;
  }
  @keyframes srv-fan-spin {
    to { transform: rotate(360deg); }
  }
  .srv-exhaust {
    position: absolute;
    width: 3px;
    height: 3px;
    border-radius: 999px;
    background: rgba(45,226,230,0.7);
    animation: srv-exhaust-rise var(--ex-dur, 2.2s) ease-out infinite;
    animation-delay: var(--ex-delay, 0s);
  }
  @keyframes srv-exhaust-rise {
    0% { transform: translateY(0) scale(0.6); opacity: 0; }
    15% { opacity: 0.8; }
    100% { transform: translateY(-36px) scale(1.3); opacity: 0; }
  }
  .srv-heat {
    pointer-events: none;
    position: absolute;
    inset: -2px;
    border-radius: inherit;
    background: linear-gradient(180deg, transparent 35%, rgba(251,146,60,0.22) 100%);
    animation: srv-heat-wobble var(--heat-dur, 2.4s) ease-in-out infinite;
    opacity: var(--heat-op, 0.45);
  }
  @keyframes srv-heat-wobble {
    0%, 100% { transform: translateY(0) scaleY(1); opacity: var(--heat-op, 0.45); }
    50% { transform: translateY(-1px) scaleY(1.03); opacity: calc(var(--heat-op, 0.45) * 1.2); }
  }
  .srv-cable-dash {
    stroke-dasharray: 5 7;
    animation: srv-cable-flow 1.6s linear infinite;
  }
  @keyframes srv-cable-flow {
    to { stroke-dashoffset: -24; }
  }
  .srv-hash-pulse {
    animation: srv-hash-blink 2.2s ease-in-out infinite;
  }
  @keyframes srv-hash-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.78; }
  }
  .srv-merge-burst {
    pointer-events: none;
    position: absolute;
    inset: -4px;
    border-radius: inherit;
    background: radial-gradient(circle at 50% 50%, rgba(251,191,36,0.55), transparent 62%);
    animation: srv-merge-burst 2.2s ease-out forwards;
  }
  @keyframes srv-merge-burst {
    0% { opacity: 0; transform: scale(0.65); }
    18% { opacity: 1; transform: scale(1.12); }
    100% { opacity: 0; transform: scale(1.4); }
  }
  .srv-ghost-slot {
    animation: srv-ghost-pulse 1.8s ease-in-out infinite;
  }
  @keyframes srv-ghost-pulse {
    0%, 100% { opacity: 0.28; }
    50% { opacity: 0.55; }
  }
  .srv-empty-plus-pulse {
    animation: srv-plus-pulse 1.6s ease-in-out infinite;
  }
  @keyframes srv-plus-pulse {
    0%, 100% { transform: scale(1); opacity: 0.85; }
    50% { transform: scale(1.1); opacity: 1; }
  }
  /* Pulse só no wash (opacity) — evita filter:brightness em cada GPU */
  .srv-rarity-pulse {
    animation: srv-rarity-glow 2.8s ease-in-out infinite;
  }
  @keyframes srv-rarity-glow {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 1; }
  }
  .srv-rarity-shimmer {
    background: linear-gradient(115deg, transparent 30%, rgba(255,255,255,0.35) 48%, transparent 62%);
    animation: srv-shimmer 3.2s ease-in-out infinite;
  }
  @keyframes srv-shimmer {
    0% { transform: translateX(-130%); opacity: 0; }
    20% { opacity: 0.65; }
    55% { opacity: 0.3; }
    100% { transform: translateX(130%); opacity: 0; }
  }
  .srv-spark {
    animation: srv-spark 2s ease-in-out infinite;
  }
  @keyframes srv-spark {
    0%, 100% { opacity: 0.15; transform: scale(0.7); }
    50% { opacity: 1; transform: scale(1.2); }
  }
  .srv-slot-live {
    background: rgba(251,191,36,0.05);
  }
  .srv-bay.is-scrolling .srv-bay-grid,
  .srv-bay.is-scrolling .srv-bay-scan,
  .srv-bay.is-scrolling .srv-orb,
  .srv-bay.is-scrolling .srv-rarity-pulse,
  .srv-bay.is-scrolling .srv-heat,
  .srv-bay.is-scrolling .srv-fan-blade,
  .srv-bay.is-scrolling .srv-exhaust,
  .srv-bay.is-scrolling .srv-hash-pulse,
  .srv-bay.is-scrolling .srv-status-online,
  .srv-bay.is-scrolling .srv-status-offline,
  .srv-bay.is-scrolling .srv-ghost-slot,
  .srv-bay.is-scrolling .srv-empty-plus-pulse,
  .srv-bay.is-scrolling .srv-cable-dash {
    animation-play-state: paused !important;
  }
  @media (prefers-reduced-motion: reduce) {
    .srv-bay-grid, .srv-bay-scan, .srv-orb,
    .srv-rarity-pulse, .srv-heat, .srv-fan-blade,
    .srv-exhaust, .srv-hash-pulse, .srv-status-online,
    .srv-cable-dash, .srv-ghost-slot, .srv-empty-plus-pulse {
      animation: none !important;
    }
  }
`;

export function HashrateTicker({
  value,
  operational
}: {
  value: number;
  operational: boolean;
}) {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  useEffect(() => {
    shownRef.current = shown;
  }, [shown]);
  useEffect(() => {
    const start = shownRef.current;
    const delta = value - start;
    if (Math.abs(delta) < 0.0001) {
      setShown(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const dur = 650;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(start + delta * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <span
      className={`truncate text-[10px] font-mono font-black tabular-nums leading-tight sm:text-xs ${
        operational ? 'text-amber-400 srv-hash-pulse' : 'text-slate-500'
      }`}
    >
      {formatHashrateDisplay(shown)} H/s
    </span>
  );
}

export function RackEnergyCables({
  slots,
  active,
  boot
}: {
  slots: FxLayoutSlot[];
  active: boolean;
  boot: boolean;
}) {
  if (!active && !boot) return null;
  const battery = slots.find((s) => s.type === 'battery');
  const wiring = slots.find((s) => s.type === 'wiring');
  const machines = slots.filter((s) => s.type === 'machine');
  if (!battery || !wiring || machines.length === 0) return null;
  const b = slotCenter(battery);
  const w = slotCenter(wiring);
  const stroke = boot ? 'rgba(34,197,94,0.9)' : 'rgba(45,226,230,0.75)';

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 z-[28] h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <path
        d={`M ${b.x} ${b.y} C ${b.x} ${(b.y + w.y) / 2}, ${w.x} ${(b.y + w.y) / 2}, ${w.x} ${w.y}`}
        fill="none"
        stroke={stroke}
        strokeWidth="0.55"
        className="srv-cable-dash"
        opacity={boot ? 1 : 0.85}
      />
      {machines.map((m, i) => {
        const c = slotCenter(m);
        return (
          <path
            key={m.id || i}
            d={`M ${w.x} ${w.y} Q ${(w.x + c.x) / 2} ${w.y - 6}, ${c.x} ${c.y}`}
            fill="none"
            stroke={stroke}
            strokeWidth="0.4"
            className="srv-cable-dash"
            style={{ animationDelay: `${i * 90}ms` }}
            opacity={0.7}
          />
        );
      })}
    </svg>
  );
}

export function RackFanBank({
  active,
  hashrate
}: {
  active: boolean;
  hashrate: number;
}) {
  if (!active) return null;
  const dur = Math.max(0.32, 1.85 - Math.log10(Math.max(1, hashrate)) * 0.42);
  const fans = [
    { left: '18%', top: '38%' },
    { left: '44%', top: '38%' },
    { left: '70%', top: '38%' }
  ];
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[18]">
      {fans.map((f, i) => (
        <div
          key={i}
          className="srv-fan absolute"
          style={{
            left: f.left,
            top: f.top,
            width: '12%',
            aspectRatio: '1',
            ['--fan-dur' as string]: `${dur}s`
          }}
        >
          <div className="srv-fan-blade" />
          <div className="absolute inset-[38%] rounded-full bg-cyan-300/80" />
          <span
            className="srv-exhaust"
            style={{
              left: '44%',
              top: '8%',
              ['--ex-dur' as string]: `${2 + i * 0.2}s`,
              ['--ex-delay' as string]: `${i * 0.2}s`
            }}
          />
        </div>
      ))}
    </div>
  );
}

export function RackStatusAura({
  operational,
  hasPowerIntent
}: {
  operational: boolean;
  /** Rack marked on but maybe missing parts */
  hasPowerIntent: boolean;
}) {
  if (operational) {
    return (
      <div
        aria-hidden
        className="srv-status-online pointer-events-none absolute inset-0 z-[12] rounded-[inherit]"
      />
    );
  }
  if (hasPowerIntent) {
    return (
      <div
        aria-hidden
        className="srv-status-offline pointer-events-none absolute inset-0 z-[12] rounded-[inherit]"
      />
    );
  }
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-[12] rounded-[inherit] opacity-40"
      style={{
        background:
          'repeating-linear-gradient(-12deg, transparent, transparent 12px, rgba(100,116,139,0.05) 12px, rgba(100,116,139,0.05) 24px)'
      }}
    />
  );
}

export function RackBootCascade({
  slots,
  active
}: {
  slots: FxLayoutSlot[];
  active: boolean;
}) {
  if (!active) return null;
  const order = [
    ...slots.filter((s) => s.type === 'power'),
    ...slots.filter((s) => s.type === 'battery'),
    ...slots.filter((s) => s.type === 'wiring'),
    ...slots.filter((s) => s.type === 'machine'),
    ...slots.filter((s) => s.type === 'multiplier')
  ];
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[40]">
      {order.map((s, i) => (
        <div
          key={`${s.type}-${s.id || i}`}
          className="srv-boot-flash absolute rounded-md"
          style={{
            left: `${s.x}%`,
            top: `${s.y}%`,
            width: `${s.w}%`,
            height: `${s.h}%`,
            animationDelay: `${i * 110}ms`,
            border: '1px solid rgba(74,222,128,0.8)',
            background: 'rgba(34,197,94,0.18)'
          }}
        />
      ))}
    </div>
  );
}

export function MachineGhostPreview({
  preview,
  visible
}: {
  preview: Upgrade | null;
  visible: boolean;
}) {
  if (!visible || !preview) return null;
  const img = normalizePublicAssetUrl(preview.image);
  return (
    <div
      aria-hidden
      className="srv-ghost-slot pointer-events-none absolute inset-[3px] overflow-hidden rounded-[3px] border border-amber-400/40"
      style={
        img
          ? {
              backgroundImage: `url(${img})`,
              backgroundSize: '100% 100%',
              backgroundRepeat: 'no-repeat',
              filter: 'grayscale(0.4) brightness(0.85)'
            }
          : { background: 'rgba(245,158,11,0.12)' }
      }
    />
  );
}

export function heatIntensityForRarity(rarity: string | undefined): { dur: string; op: number } {
  const r = String(rarity || 'common').toLowerCase();
  if (r === 'supreme') return { dur: '1.4s', op: 0.9 };
  if (r === 'legendary') return { dur: '1.6s', op: 0.8 };
  if (r === 'epic') return { dur: '1.9s', op: 0.65 };
  if (r === 'rare') return { dur: '2.2s', op: 0.5 };
  if (r === 'uncommon') return { dur: '2.5s', op: 0.4 };
  return { dur: '2.8s', op: 0.28 };
}
