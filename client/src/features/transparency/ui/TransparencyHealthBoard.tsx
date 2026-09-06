import { useT } from '../../../shared/i18n';
import {
  HEALTH_WEIGHT_INFLOW,
  HEALTH_WEIGHT_LEDGER,
  HEALTH_WEIGHT_RENT,
  TRANSPARENCY_HEALTH_FLOOR,
  type HealthBand,
  type TransparencyHealthSnapshot
} from '../lib/health';

const ART = '/transparency-art';

const STREAM_ICONS: Record<string, string> = {
  deposits: `${ART}/chest.png`,
  withdrawals: `${ART}/expense.png`,
  pool: `${ART}/treasure.png`,
  trade: `${ART}/trade.png`,
  investment: `${ART}/invest.png`,
  expense: `${ART}/other.png`,
  other: `${ART}/heart.png`
};

type StreamRow = {
  id: string;
  label: string;
  amount: number;
  bar: string;
  glow: string;
};

function PixelImg({
  src,
  alt,
  className
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  return (
    <img
      src={src}
      alt={alt}
      className={`pointer-events-none shrink-0 select-none object-contain drop-shadow-[0_6px_10px_rgba(0,0,0,0.55)] [image-rendering:pixelated] ${className || ''}`}
      draggable={false}
    />
  );
}

function bandTone(band: HealthBand): { text: string; ring: string; glow: string; label: string } {
  if (band === 'excellent') {
    return {
      text: 'text-emerald-300',
      ring: 'ring-emerald-400/45',
      glow: 'shadow-[0_0_32px_rgba(52,211,153,0.28)]',
      label: 'from-emerald-300 to-cyan-200'
    };
  }
  if (band === 'healthy') {
    return {
      text: 'text-lime-300',
      ring: 'ring-lime-400/45',
      glow: 'shadow-[0_0_32px_rgba(163,230,53,0.25)]',
      label: 'from-lime-300 to-emerald-300'
    };
  }
  return {
    text: 'text-amber-300',
    ring: 'ring-amber-400/45',
    glow: 'shadow-[0_0_32px_rgba(251,191,36,0.22)]',
    label: 'from-amber-200 to-yellow-100'
  };
}

function Thermometer({ health }: { health: number }) {
  const pct = Math.min(100, Math.max(0, health));
  const ticks = [
    { at: 100, label: '100' },
    { at: 75, label: '75' },
    { at: 50, label: '50' }
  ];
  return (
    <div className="relative mx-auto h-[13.5rem] w-[5.75rem]">
      {ticks.map((tick) => (
        <div
          key={tick.at}
          className="absolute left-0 flex w-full items-center"
          style={{ bottom: `calc(${tick.at}% * 0.72 + 1.15rem)` }}
        >
          <span className="w-6 text-right font-mono text-[9px] font-black tabular-nums text-slate-400">
            {tick.label}
          </span>
          <span className="mx-1 h-px flex-1 bg-slate-600/80" />
        </div>
      ))}
      <div className="absolute bottom-2.5 left-1/2 h-[10.25rem] w-6 -translate-x-1/2 overflow-hidden rounded-full border-2 border-slate-400/40 bg-[#05080f] shadow-[inset_0_0_8px_rgba(0,0,0,0.65)]">
        <div
          className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-red-600 via-amber-400 to-emerald-400 transition-all duration-700"
          style={{ height: `${pct}%` }}
        />
        <div className="pointer-events-none absolute inset-y-0 left-0 w-[38%] bg-white/15" />
      </div>
      <div className="absolute bottom-0 left-1/2 h-8 w-8 -translate-x-1/2 rounded-full border-2 border-amber-300/80 bg-gradient-to-br from-orange-400 to-red-600 shadow-[0_0_12px_rgba(249,115,22,0.55)]" />
      <div
        className="absolute left-[calc(50%+0.95rem)] -translate-y-1/2"
        style={{ bottom: `calc(${pct}% * 0.72 + 1.15rem)` }}
      >
        <div className="flex items-center gap-0.5">
          <span className="h-0 w-0 border-y-[5px] border-r-[6px] border-y-transparent border-r-amber-300" />
          <span className="rounded border border-amber-400/50 bg-slate-950/95 px-1 py-0.5 font-mono text-[10px] font-black tabular-nums text-amber-100 shadow-lg">
            {health}
          </span>
        </div>
      </div>
    </div>
  );
}

export function TransparencyHealthBoard({
  snapshot,
  formatUsdc,
  variant = 'player'
}: {
  snapshot: TransparencyHealthSnapshot;
  formatUsdc: (n: number) => string;
  variant?: 'player' | 'admin';
}) {
  const t = useT();
  const tone = bandTone(snapshot.band);
  const streamMax = Math.max(
    snapshot.depositsUsdc ?? 0,
    snapshot.withdrawalsUsdc ?? 0,
    snapshot.poolUsdc,
    snapshot.tradeUsdc,
    snapshot.investmentUsdc,
    snapshot.expenseUsdc,
    1
  );

  const streams: StreamRow[] = [
    { id: 'deposits', label: t('transparency.health.stream.deposits'), amount: snapshot.depositsUsdc ?? 0, bar: 'bg-emerald-400', glow: 'shadow-[0_0_10px_rgba(52,211,153,0.5)]' },
    { id: 'withdrawals', label: t('transparency.health.stream.withdrawals'), amount: snapshot.withdrawalsUsdc ?? 0, bar: 'bg-red-400', glow: 'shadow-[0_0_10px_rgba(248,113,113,0.45)]' },
    { id: 'pool', label: t('transparency.health.stream.pool'), amount: snapshot.poolUsdc, bar: 'bg-lime-400', glow: 'shadow-[0_0_10px_rgba(163,230,53,0.4)]' },
    { id: 'trade', label: t('transparency.health.stream.trade'), amount: snapshot.tradeUsdc, bar: 'bg-sky-400', glow: 'shadow-[0_0_10px_rgba(56,189,248,0.45)]' },
    { id: 'investment', label: t('transparency.health.stream.investment'), amount: snapshot.investmentUsdc, bar: 'bg-slate-500', glow: '' },
    { id: 'expense', label: t('transparency.health.stream.expense'), amount: snapshot.expenseUsdc, bar: 'bg-orange-400', glow: 'shadow-[0_0_10px_rgba(251,146,60,0.45)]' },
    { id: 'other', label: t('transparency.health.stream.other'), amount: snapshot.otherUsdc, bar: 'bg-slate-500', glow: '' }
  ];

  const wrap =
    variant === 'admin'
      ? 'relative overflow-hidden rounded-xl border border-amber-700/40 bg-[#070b14] p-3.5 md:p-4'
      : 'relative mb-5 overflow-hidden rounded-xl border border-amber-500/25 bg-[#070b14] p-3.5 text-slate-100 shadow-xl md:p-4';

  return (
    <section className={wrap} aria-label={t('transparency.health.title')}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(251,191,36,0.09),transparent_46%),radial-gradient(ellipse_at_bottom_right,rgba(16,185,129,0.08),transparent_42%)]" />

      <div className="relative mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <PixelImg src={`${ART}/miner.png`} alt="" className="h-14 w-12 sm:h-16 sm:w-14" />
          <div>
            <p className="text-[9px] font-black uppercase tracking-[0.2em] text-amber-400/90">
              {t('transparency.health.kicker')}
            </p>
            <h2 className="bg-gradient-to-r from-amber-100 via-yellow-300 to-orange-300 bg-clip-text text-xl font-black tracking-tight text-transparent md:text-2xl">
              {t('transparency.health.title')}
            </h2>
            <p className="mt-0.5 max-w-md text-[11px] leading-snug text-slate-400">{t('transparency.health.subtitle')}</p>
          </div>
        </div>
        <div
          className={`inline-flex items-center gap-2 self-start rounded-xl border border-white/10 bg-slate-950/55 px-3 py-2 ring-1 ${tone.ring} ${tone.glow}`}
        >
          <PixelImg src={`${ART}/heart.png`} alt="" className="h-9 w-9" />
          <div>
            <span className={`block font-mono text-3xl font-black tabular-nums leading-none ${tone.text}`}>
              {snapshot.health}
            </span>
            <span className={`text-[10px] font-black uppercase tracking-wider bg-gradient-to-r ${tone.label} bg-clip-text text-transparent`}>
              {t(`transparency.health.band.${snapshot.band}`)}
            </span>
          </div>
        </div>
      </div>

      <div className="relative grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_7rem_minmax(0,1fr)] lg:items-start">
        <div className="space-y-1.5">
          {streams.map((row, i) => (
            <div
              key={row.id}
              className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${
                row.id === 'other' || row.id === 'investment'
                  ? 'border-white/5 bg-white/[0.015] opacity-70'
                  : 'border-white/5 bg-white/[0.03]'
              }`}
            >
              <PixelImg src={STREAM_ICONS[row.id]} alt="" className="h-8 w-8" />
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-end justify-between gap-2">
                  <span className="min-w-0 truncate text-[11px] font-bold uppercase tracking-wide text-slate-100">
                    <span className="mr-1 font-mono text-amber-400/80">{String(i + 1).padStart(2, '0')}</span>
                    {row.label}
                  </span>
                  <span className="shrink-0 font-mono text-xs font-black tabular-nums text-amber-50">
                    {formatUsdc(row.amount)}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-800/90">
                  <div
                    className={`h-full rounded-full ${row.bar} ${row.glow}`}
                    style={{ width: `${Math.min(100, (Math.abs(row.amount) / streamMax) * 100)}%` }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center justify-start pt-1">
          <Thermometer health={snapshot.health} />
          <p className="mt-0.5 max-w-[7rem] text-center text-[9px] font-bold uppercase leading-snug tracking-wider text-slate-500">
            {t('transparency.health.floorNote', { floor: TRANSPARENCY_HEALTH_FLOOR })}
          </p>
        </div>

        <div className="flex flex-col gap-2.5">
          <div className="rounded-xl border border-amber-500/20 bg-gradient-to-b from-amber-950/20 to-slate-950/40 p-3">
            <h3 className="mb-2 text-[10px] font-black uppercase tracking-[0.16em] text-amber-400/90">
              {t('transparency.health.summaryTitle')}
            </h3>
            <ul className="space-y-1.5 text-[13px]">
              <li className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-300">
                  <PixelImg src={`${ART}/chest.png`} alt="" className="h-6 w-6" />
                  {t('transparency.health.totalIn')}
                </span>
                <span className="font-mono text-sm font-black tabular-nums text-emerald-100">
                  {formatUsdc(snapshot.totalInUsdc)}
                </span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-semibold text-orange-300">
                  <PixelImg src={`${ART}/expense.png`} alt="" className="h-6 w-6" />
                  {t('transparency.health.totalOut')}
                </span>
                <span className="font-mono text-sm font-black tabular-nums text-orange-100">
                  {formatUsdc(snapshot.totalOutUsdc)}
                </span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-semibold text-amber-300">
                  <PixelImg src={`${ART}/heart.png`} alt="" className="h-6 w-6" />
                  {t('transparency.health.netProfit')}
                </span>
                <span className="font-mono text-sm font-black tabular-nums text-amber-100">
                  {formatUsdc(snapshot.netProfitUsdc)}
                </span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-semibold text-cyan-300">
                  <PixelImg src={`${ART}/trade.png`} alt="" className="h-6 w-6" />
                  {t('transparency.health.dayProfit')}
                </span>
                <span className="font-mono text-sm font-black tabular-nums text-cyan-100">
                  {formatUsdc(snapshot.dayProfitUsdc)}
                </span>
              </li>
              <li className="flex items-center justify-between gap-2 border-t border-white/10 pt-1.5">
                <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-200">
                  {t('transparency.health.inflowScore')}
                  <span className="ml-1 text-[9px] text-slate-500">
                    {Math.round(HEALTH_WEIGHT_INFLOW * 100)}%
                  </span>
                </span>
                <span className="font-mono text-xs font-black tabular-nums text-emerald-100">
                  {(snapshot.inflowScore ?? 0).toFixed(0)}
                </span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wide text-amber-200">
                  {t('transparency.health.rentScore')}
                  <span className="ml-1 text-[9px] text-slate-500">
                    {Math.round(HEALTH_WEIGHT_RENT * 100)}%
                  </span>
                </span>
                <span className="font-mono text-xs font-black tabular-nums text-amber-100">
                  {(snapshot.rentScore ?? 0).toFixed(0)}
                </span>
              </li>
              <li className="flex items-center justify-between gap-2 text-slate-400">
                <span className="text-[10px] font-bold uppercase tracking-wide">
                  {t('transparency.health.efficiency')}
                  <span className="ml-1 text-[9px] text-slate-500">
                    {Math.round(HEALTH_WEIGHT_LEDGER * 100)}%
                  </span>
                </span>
                <span className="font-mono text-xs font-black tabular-nums text-slate-100">
                  {snapshot.efficiencyPct.toFixed(2)}%
                </span>
              </li>
            </ul>
          </div>
          <div className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2 text-[11px] leading-snug text-slate-400">
            <p className="mb-0.5 text-[10px] font-black uppercase tracking-wide text-slate-200">
              {t('transparency.health.whatTitle')}
            </p>
            <p>{t('transparency.health.whatBody')}</p>
          </div>
        </div>
      </div>

      <div className="relative mt-3 flex items-center justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-950/10 px-3 py-2">
        <p className="min-w-0 font-mono text-[11px] leading-snug text-amber-50/90">
          {t('transparency.health.formula', {
            inn: formatUsdc(snapshot.totalInUsdc),
            out: formatUsdc(snapshot.totalOutUsdc),
            net: formatUsdc(snapshot.netProfitUsdc),
            health: String(snapshot.health)
          })}
        </p>
        <PixelImg src={`${ART}/treasure.png`} alt="" className="h-12 w-16" />
      </div>
    </section>
  );
}
