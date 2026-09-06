import React, { useState, useEffect, useMemo, useId, useRef } from 'react';
import { Sparkles, Gift } from 'lucide-react';
import type { WheelItem } from '../../../shared/api/wheel';
import { normalizePublicAssetUrl } from '../../../shared/utils/public-url';
import { useT } from '../../../shared/i18n';

interface WheelProps {
  items: WheelItem[];
  mustSpin: boolean;
  targetWinner: WheelItem | null;
  onStopSpinning: () => void;
}

/** Duração da animação de giro (ms). Ajustar aqui também muda `setTimeout` abaixo. */
const SPIN_DURATION_MS = 5000;
/** Voltas completas extra antes do prémio (sensação de peso/inércia). */
const SPIN_EXTRA_TURNS = 12;
/** Easing premium: rápido no início, desacelera devagar no final. */
const SPIN_EASING = 'cubic-bezier(0.12, 0.75, 0.08, 1)';

/** Pequeno componente de imagem com fallback automático para o ícone do prémio. */
const PrizeImage: React.FC<{
  src?: string | null;
  alt: string;
  size: number;
  className?: string;
}> = ({ src, alt, size, className }) => {
  const [broken, setBroken] = useState(false);
  const url = useMemo(() => (src ? normalizePublicAssetUrl(src) || src : undefined), [src]);
  if (!url || broken) {
    return (
      <div
        className={`flex shrink-0 items-center justify-center rounded-md bg-slate-900/80 ring-1 ring-white/20 ${className ?? ''}`}
        style={{ width: size, height: size }}
        aria-hidden
      >
        <Gift className="text-amber-300" style={{ width: size * 0.55, height: size * 0.55 }} />
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={alt}
      width={size}
      height={size}
      onError={() => setBroken(true)}
      className={`shrink-0 select-none object-contain ${className ?? ''}`}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
};

const Wheel: React.FC<WheelProps> = ({ items, mustSpin, targetWinner, onStopSpinning }) => {
  const t = useT();
  const ptrGradId = `wp-${useId().replace(/:/g, '')}`;
  const [rotation, setRotation] = useState(0);
  /** Marca o índice vencedor após o stop, para destacar visualmente o segmento. */
  const [winnerIdx, setWinnerIdx] = useState<number | null>(null);

  /**
   * Refs para o cálculo do giro: como o efeito de animação só pode reagir ao **início**
   * de um giro (alteração de `mustSpin`/`targetWinner.id`), precisamos ler `items` e
   * `onStopSpinning` no momento certo sem os colocar nas deps — caso contrário, qualquer
   * refetch de catálogo (`gameUpgrades` no App) repropagava nova referência de `items`
   * durante o giro, reiniciava o efeito e travava a roda em ~0,5 s.
   */
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onStopRef = useRef(onStopSpinning);
  onStopRef.current = onStopSpinning;

  const totalWeight = useMemo(
    () => Math.max(1e-9, items.reduce((a, b) => a + Math.max(0, Number(b.weight) || 0), 0)),
    [items]
  );

  const gradientParts: string[] = [];
  let currentDeg = 0;
  if (items.length > 0) {
    items.forEach((item) => {
      const deg = (Math.max(0, Number(item.weight) || 0) / totalWeight) * 360;
      const color = item.color || '#334155';
      gradientParts.push(`${color} ${currentDeg}deg ${currentDeg + deg}deg`);
      currentDeg += deg;
    });
  } else {
    gradientParts.push('#334155 0deg 360deg');
  }

  const backgroundStyle = `conic-gradient(${gradientParts.join(', ')})`;
  const n = Math.max(1, items.length);
  const sliceDeg = 360 / n;
  const sliceDividers =
    items.length > 0
      ? `repeating-conic-gradient(from 0deg at 50% 50%, transparent 0deg ${sliceDeg - 0.75}deg, rgba(15,23,42,0.65) ${sliceDeg - 0.75}deg ${sliceDeg}deg)`
      : undefined;

  /**
   * Efeito de **arranque** do giro: depende exclusivamente de `mustSpin` virar `true` +
   * id do `targetWinner`. `items`/`onStopSpinning` são lidos via ref para não reiniciar a
   * animação a cada refetch externo (ex.: saldo USDC atualiza e App re-renderiza com
   * nova ref de `gameUpgrades` → GameView refazia o `setItems`, o que antes invalidava
   * esta deps e cancelava o `setTimeout`).
   */
  useEffect(() => {
    if (!mustSpin || !targetWinner) {
      if (!mustSpin && !targetWinner) {
        setWinnerIdx(null);
      }
      return;
    }
    const currentItems = itemsRef.current;
    if (currentItems.length === 0) return;

    const totalW = Math.max(
      1e-9,
      currentItems.reduce((a, b) => a + Math.max(0, Number(b.weight) || 0), 0)
    );

    let winnerStart = 0;
    let winnerSize = 0;
    let foundIdx = -1;
    const targetId = targetWinner.id;
    const targetItemId = targetWinner.itemId;
    for (let i = 0; i < currentItems.length; i++) {
      const item = currentItems[i]!;
      const deg = (Math.max(0, Number(item.weight) || 0) / totalW) * 360;
      const matches =
        item.id === targetId || (targetItemId && item.itemId === targetItemId);
      if (matches) {
        winnerSize = deg;
        foundIdx = i;
        break;
      }
      winnerStart += deg;
    }

    const winnerCenter = winnerStart + winnerSize / 2;
    const extraDeg = SPIN_EXTRA_TURNS * 360;
    const targetRotation = extraDeg + (360 - winnerCenter);

    setWinnerIdx(null);
    setRotation((prev) => {
      const currentMod = ((prev % 360) + 360) % 360;
      const dist = ((targetRotation - currentMod) % 360 + 360) % 360;
      return prev + extraDeg + dist;
    });

    const timer = setTimeout(() => {
      setWinnerIdx(foundIdx >= 0 ? foundIdx : null);
      const fn = onStopRef.current;
      fn?.();
    }, SPIN_DURATION_MS);
    return () => clearTimeout(timer);
    // ATENÇÃO: deps mínimas; `items` e `onStopSpinning` lidos por ref para evitar
    // que refetches do catálogo no App reiniciem a animação a meio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mustSpin, targetWinner?.id, targetWinner?.itemId]);

  return (
    <div
      className="relative mx-auto aspect-square w-[min(28rem,calc(100vw-1rem))] max-w-lg flex items-center justify-center font-sans transition-all sm:w-[min(30rem,calc(100vw-2rem))]"
      role="img"
      aria-label={t('wheel.prizesWheel')}
    >
      {/* Halos exteriores cyber */}
      <div
        className={`pointer-events-none absolute -inset-6 rounded-full bg-gradient-to-br from-amber-500/30 via-orange-600/15 to-transparent blur-3xl transition-opacity duration-1000 ${mustSpin ? 'opacity-100' : 'opacity-50'}`}
        aria-hidden
      />
      <div
        className={`pointer-events-none absolute -inset-2 rounded-full bg-gradient-to-tr from-orange-500/20 via-amber-300/10 to-transparent blur-2xl transition-opacity duration-1000 ${winnerIdx != null ? 'opacity-100' : 'opacity-60'}`}
        aria-hidden
      />

      {/* Ponteiro fixo no topo */}
      <div
        className="absolute left-1/2 z-30 -translate-x-1/2 drop-shadow-[0_8px_20px_rgba(0,0,0,0.75)]"
        style={{ top: 'clamp(-2rem, -5.5vw, -1.25rem)' }}
        aria-hidden
      >
        <svg width="52" height="58" viewBox="0 0 52 58" className="mx-auto block">
          <defs>
            <linearGradient id={ptrGradId} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#fef3c7" />
              <stop offset="35%" stopColor="#fbbf24" />
              <stop offset="70%" stopColor="#d97706" />
              <stop offset="100%" stopColor="#78350f" />
            </linearGradient>
          </defs>
          <path
            d="M26 2 L48 50 Q26 42 4 50 Z"
            fill={`url(#${ptrGradId})`}
            stroke="rgba(15,23,42,0.85)"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          <circle cx="26" cy="42" r="5" fill="#0f172a" stroke="#fcd34d" strokeWidth="1.5" />
          <circle cx="26" cy="42" r="2" fill="#fef3c7" />
        </svg>
      </div>

      {/* Moldura metálica dupla */}
      <div
        className="absolute inset-0 rounded-full bg-gradient-to-br from-amber-300/60 via-amber-600/40 to-slate-950 p-[8px] shadow-[0_24px_60px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.18)] ring-1 ring-black/50 sm:p-[10px]"
        aria-hidden
      >
        <div className="h-full w-full rounded-full bg-gradient-to-b from-slate-900 via-slate-950 to-black p-[4px] shadow-inner">
          <div
            className="relative h-full w-full rounded-full border border-slate-800/90 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
            style={{
              transform: `rotate(${rotation}deg)`,
              transition: `transform ${SPIN_DURATION_MS}ms ${SPIN_EASING}`,
              willChange: 'transform'
            }}
          >
            {/* Disco de cor */}
            <div
              className="absolute inset-0 z-0 overflow-hidden rounded-full shadow-[inset_0_0_40px_rgba(0,0,0,0.6)]"
              style={{
                background: items.length > 0 ? backgroundStyle : '#1e293b'
              }}
            />
            {/* Vinheta + brilho interno */}
            <div
              className="pointer-events-none absolute inset-0 z-[1] rounded-full"
              style={{
                background:
                  'radial-gradient(circle at 32% 24%, rgba(255,255,255,0.18) 0%, transparent 44%), radial-gradient(circle at 50% 50%, transparent 46%, rgba(0,0,0,0.45) 100%)'
              }}
            />
            {/* Divisores */}
            {sliceDividers ? (
              <div
                className="pointer-events-none absolute inset-0 z-[2] rounded-full"
                style={{ background: sliceDividers }}
              />
            ) : null}

            {items.map((item, index) => {
              let startDeg = 0;
              for (let i = 0; i < index; i++) {
                const w = Math.max(0, Number(items[i].weight));
                startDeg += (w / totalWeight) * 360;
              }
              const wCur = Math.max(0, Number(item.weight));
              const sliceAngle = (wCur / totalWeight) * 360;
              const midDeg = startDeg + sliceAngle / 2;
              const halfSlice = Math.min(sliceAngle / 2, 89);
              const chordFactor = Math.sin((halfSlice * Math.PI) / 180);
              /** Largura útil do «cartão» do prémio em pixels (limitada pela corda do segmento). */
              const cardWidth = Math.min(180, Math.max(96, 70 + chordFactor * 150));
              const isWinner = winnerIdx === index;
              const imgSize = items.length <= 6 ? 38 : items.length <= 10 ? 32 : 26;

              return (
                <div
                  key={`${item.id}-${index}`}
                  className="pointer-events-none absolute z-[3] overflow-visible"
                  style={{
                    left: '50%',
                    bottom: '50%',
                    width: `${cardWidth}px`,
                    height: '50%',
                    transformOrigin: '50% 100%',
                    transform: `translateX(-50%) rotate(${midDeg}deg)`
                  }}
                >
                  <div className="absolute left-0 right-0 top-[4%] flex justify-center sm:top-[3%]">
                    <div
                      title={item.label}
                      className={`flex max-w-full flex-col items-center gap-1 rounded-xl border bg-slate-950/85 px-2 py-1.5 text-center backdrop-blur-md transition-all duration-500 sm:px-2.5 sm:py-2 ${
                        isWinner
                          ? 'border-amber-300 shadow-[0_0_24px_rgba(251,191,36,0.65)] ring-2 ring-amber-300/70'
                          : 'border-white/25 shadow-[0_4px_18px_rgba(0,0,0,0.55)]'
                      }`}
                      style={{
                        width: `${cardWidth}px`,
                        minWidth: `${cardWidth}px`,
                        maxWidth: `${cardWidth}px`,
                        transform: `rotate(${-midDeg}deg)`
                      }}
                    >
                      <PrizeImage
                        src={item.image}
                        alt={item.label}
                        size={imgSize}
                        className={isWinner ? 'drop-shadow-[0_0_10px_rgba(251,191,36,0.6)]' : undefined}
                      />
                      <span
                        className="line-clamp-2 font-sans text-[10px] font-bold leading-tight tracking-tight text-white sm:text-[11px]"
                        style={{
                          textShadow: '0 1px 3px rgba(0,0,0,0.95)',
                          overflowWrap: 'break-word',
                          wordBreak: 'normal'
                        }}
                      >
                        {item.label}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Centro com logótipo Genesis */}
      <div className="pointer-events-none absolute z-20 flex h-[5.5rem] w-[5.5rem] items-center justify-center sm:h-[6rem] sm:w-[6rem]">
        <div
          className={`absolute inset-0 rounded-full bg-gradient-to-br from-amber-500/35 to-orange-600/15 blur-md transition-opacity duration-700 ${mustSpin ? 'opacity-100' : winnerIdx != null ? 'opacity-100' : 'opacity-70'}`}
          aria-hidden
        />
        <div
          className={`relative flex h-full w-full items-center justify-center rounded-full border-2 border-amber-400/45 bg-gradient-to-br from-slate-500 via-slate-800 to-slate-950 shadow-[inset_0_2px_18px_rgba(0,0,0,0.6),0_12px_32px_rgba(0,0,0,0.6),0_0_0_1px_rgba(251,191,36,0.28)] ring-2 ring-slate-950/85 transition-transform duration-700 ${winnerIdx != null ? 'scale-110' : ''}`}
        >
          <Sparkles
            className={`h-9 w-9 text-amber-200 drop-shadow-[0_0_12px_rgba(251,191,36,0.55)] sm:h-10 sm:w-10 ${mustSpin ? 'animate-pulse' : ''}`}
            strokeWidth={2}
            aria-hidden
          />
        </div>
      </div>
    </div>
  );
};

export default Wheel;
