import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { MiningCoinGlyph, miningCoinIconSrc } from '../../../shared/ui/MiningCoinGlyph';
import { useT } from '../../../shared/i18n';
import type { MiningCoin } from '../types';

export { miningCoinIconSrc };

export type MiningCoinOption = Pick<MiningCoin, 'id' | 'name' | 'isActive' | 'symbol' | 'color'>;

/**
 * Lista de moedas com ícone (cryptocurrency-icons) + texto; menu em `position: fixed` para não ser cortado por modais.
 */
export const MiningCoinSelect: React.FC<{
  value: string;
  onChange: (coinId: string) => void;
  coins: MiningCoinOption[];
  noneLabel?: string;
  /** Classes do botão que mostra o valor atual */
  buttonClassName?: string;
  id?: string;
  disabled?: boolean;
  /** Slot pequeno na rig (texto e ícone menores). */
  compact?: boolean;
  /** Evita que o clique na moeda dispare o handler do chassis da rig. */
  stopPointerPropagation?: boolean;
}> = ({
  value,
  onChange,
  coins,
  noneLabel: noneLabelProp,
  buttonClassName = '',
  id,
  disabled = false,
  compact = false,
  stopPointerPropagation = false
}) => {
  const t = useT();
  const noneLabel = noneLabelProp ?? t('servers.coinSelect.none');
  const unavailableSuffix = t('servers.coinSelect.unavailable');
  const [open, setOpen] = useState(false);
  const [fixedStyle, setFixedStyle] = useState<{ top: number; left: number; width: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = value ? coins.find((c) => c.id === value) : undefined;
  const displayNone = !value;
  const glyphSize = compact ? 16 : 24;
  const chevronSize = compact ? 14 : 18;
  /** Compact: rótulo curto (evita “None (powers off…)” / hardcoded “Moeda”). */
  const emptyLabel = compact
    ? noneLabel.length > 14
      ? noneLabel.split(/\s|\(/)[0] || t('servers.room.coin')
      : noneLabel
    : noneLabel;

  const updateMenuPosition = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setFixedStyle({ top: r.bottom + 6, left: r.left, width: Math.max(r.width, 200) });
  }, []);

  useEffect(() => {
    if (!open) return;
    updateMenuPosition();
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && listRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onResize = () => updateMenuPosition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (coinId: string, allowed: boolean) => {
    if (!allowed) return;
    onChange(coinId);
    setOpen(false);
  };

  return (
    <div
      ref={wrapRef}
      className="relative w-full"
      onMouseDown={(e) => {
        if (stopPointerPropagation) e.stopPropagation();
      }}
    >
      <button
        ref={btnRef}
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => {
          if (stopPointerPropagation) e.stopPropagation();
          if (disabled) return;
          if (!open) updateMenuPosition();
          setOpen((o) => !o);
        }}
        className={`flex w-full items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2 py-2 text-left text-sm text-slate-900 transition hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:hover:border-slate-600 ${disabled ? 'cursor-not-allowed opacity-50' : ''} ${compact ? 'py-0.5 pl-0.5 pr-0.5' : ''} ${buttonClassName}`}
      >
        {displayNone ? (
          <span
            className={`flex shrink-0 items-center justify-center rounded-full bg-slate-200 font-bold text-slate-500 dark:bg-slate-800 dark:text-slate-400 ${compact ? 'h-4 w-4 text-[7px]' : 'h-6 w-6 text-[10px]'}`}
          >
            —
          </span>
        ) : selected ? (
          <MiningCoinGlyph coin={selected} size={glyphSize} />
        ) : (
          <span className={`shrink-0 rounded-full bg-amber-500/20 ${compact ? 'h-4 w-4' : 'h-6 w-6'}`} aria-hidden />
        )}
        <span className={`min-w-0 flex-1 truncate font-medium ${compact ? 'text-[8px] leading-tight' : ''}`}>
          {displayNone
            ? emptyLabel
            : selected
              ? `${compact ? (selected.symbol || selected.name).slice(0, 4) : selected.name}${!selected.isActive ? ` ${unavailableSuffix}` : ''}`
              : value}
        </span>
        <ChevronDown size={chevronSize} className={`shrink-0 text-slate-400 transition ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>

      {open && fixedStyle && (
        <ul
          ref={listRef}
          role="listbox"
          onMouseDown={(e) => {
            if (stopPointerPropagation) e.stopPropagation();
          }}
          onWheel={(e) => {
            e.stopPropagation();
          }}
          className="fixed z-[100] max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-600 dark:bg-slate-900"
          style={{
            top: fixedStyle.top,
            left: fixedStyle.left,
            width: fixedStyle.width,
            maxWidth: 'min(100vw - 16px, 24rem)'
          }}
        >
          <li role="option" aria-selected={displayNone}>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              onClick={() => pick('', true)}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-500 dark:bg-slate-800">
                —
              </span>
              <span className="truncate">{noneLabel}</span>
            </button>
          </li>
          {coins.map((c) => (
            <li key={c.id} role="option" aria-selected={value === c.id}>
              <button
                type="button"
                disabled={!c.isActive}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                  c.isActive ? 'hover:bg-slate-100 dark:hover:bg-slate-800' : 'cursor-not-allowed opacity-45'
                } ${value === c.id ? 'bg-amber-50 dark:bg-amber-950/40' : ''}`}
                onClick={() => pick(c.id, c.isActive)}
              >
                <MiningCoinGlyph coin={c} size={glyphSize} />
                <span className="min-w-0 flex-1 truncate">
                  {c.name}
                  {!c.isActive ? <span className="text-slate-400"> {unavailableSuffix}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
