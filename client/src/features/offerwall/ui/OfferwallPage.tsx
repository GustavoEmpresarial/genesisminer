/**
 * Offerwall Hub — provider catalog + ZERads panel.
 * Layout aligned with `legacy/frontend/components/OfferwallPage.tsx`.
 * API: `shared/api/zerads.ts` · DECISIONS #100.
 */
import { useState, type ElementType, type ReactNode } from 'react';
import { ArrowLeft, ChevronRight, Coins, Sparkles } from 'lucide-react';
import { useT } from '../../../shared/i18n';
import { ACCENT_CLASSES, OFFERWALL_PROVIDERS, type ProviderDef } from '../lib/providers';
import { ZeradsCard } from './ZeradsCard';

type Provider = ProviderDef & { render?: () => ReactNode };

const PROVIDERS: Provider[] = OFFERWALL_PROVIDERS.map((p) =>
  p.id === 'zerads' ? { ...p, render: () => <ZeradsCard /> } : p
);

export function OfferwallPage() {
  const t = useT();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? PROVIDERS.find((p) => p.id === selectedId) ?? null : null;

  if (selected?.render) {
    return (
      <div className="flex w-full flex-col gap-4 pb-8 text-slate-100">
        <div className="mx-auto w-full max-w-4xl px-3 pt-4 sm:px-4 sm:pt-5">
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400 transition hover:text-slate-200"
          >
            <ArrowLeft size={14} />
            {t('offerwall.backToList')}
          </button>
        </div>
        <div className="px-3 sm:px-4">{selected.render()}</div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-8 pb-8 text-slate-100">
      <div className="mx-auto w-full max-w-7xl space-y-6 px-3 pt-4 sm:px-4 sm:pt-5">
        <div className="space-y-2 rounded-2xl border border-slate-700/80 bg-gradient-to-br from-slate-900/90 via-slate-900/70 to-emerald-950/20 px-4 py-5 sm:px-6 sm:py-6">
          <div className="text-[11px] font-bold uppercase tracking-widest text-emerald-400/90">
            {t('offerwall.eyebrow')}
          </div>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-black tracking-tight sm:text-4xl">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-600/90 text-white shadow-lg shadow-emerald-900/30">
              <Sparkles className="shrink-0" size={24} />
            </span>
            <span className="bg-gradient-to-r from-white to-slate-300 bg-clip-text text-transparent">
              {t('offerwall.title')}
            </span>
          </h1>
          <p className="max-w-3xl text-sm text-slate-400">
            {t('offerwall.subtitleBefore')}{' '}
            <span className="font-bold text-emerald-300">{t('offerwall.subtitleHighlight')}</span>
            {t('offerwall.subtitleAfter')}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
          {PROVIDERS.map((p) => {
            const a = ACCENT_CLASSES[p.accent];
            const isLive = p.status === 'live';
            const Wrapper: ElementType = isLive ? 'button' : 'div';
            return (
              <Wrapper
                key={p.id}
                type={isLive ? 'button' : undefined}
                onClick={isLive ? () => setSelectedId(p.id) : undefined}
                disabled={!isLive}
                className={`group rounded-2xl border bg-gradient-to-br p-4 text-left transition sm:p-5 ${a.ring} ${a.gradient} ${
                  isLive ? 'cursor-pointer hover:shadow-lg hover:shadow-black/30' : 'opacity-60'
                }`}
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <span
                    className={`inline-flex h-11 w-11 items-center justify-center rounded-xl text-white shadow-lg shadow-black/30 ${a.iconBg}`}
                  >
                    <Coins size={20} />
                  </span>
                  <span
                    className={`rounded border px-2 py-1 text-[10px] font-bold uppercase tracking-widest ${a.chip}`}
                  >
                    {isLive ? t('offerwall.statusLive') : t('offerwall.statusSoon')}
                  </span>
                </div>
                <h2 className="text-lg font-black tracking-tight text-white sm:text-xl">{t(p.nameKey)}</h2>
                <p className="mt-0.5 text-xs font-bold uppercase tracking-wider text-slate-400">{t(p.taglineKey)}</p>
                <p className="mt-2 text-sm leading-snug text-slate-300">{t(p.descriptionKey)}</p>

                {isLive ? (
                  <div className="mt-4 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-emerald-300 transition group-hover:text-emerald-200">
                    {t('offerwall.openPanel')} <ChevronRight size={14} />
                  </div>
                ) : (
                  <div className="mt-4 text-xs font-bold uppercase tracking-wider text-slate-500">
                    {t('offerwall.unavailable')}
                  </div>
                )}
              </Wrapper>
            );
          })}
        </div>

        <p className="max-w-3xl text-[11px] text-slate-500">{t('offerwall.footerHint')}</p>
      </div>
    </div>
  );
}
