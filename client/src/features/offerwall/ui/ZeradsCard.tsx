/**
 * ZERads PTC panel — personal link + stats + recent callbacks.
 * Layout aligned with `legacy/frontend/components/ZeradsCard.tsx`.
 */
import { useCallback, useEffect, useState } from 'react';
import { Coins, Copy, ExternalLink, Loader2, MousePointerClick, RefreshCw, TrendingUp } from 'lucide-react';
import { getZeradsStats, getZeradsToken, type ZeradsStatsPayload, type ZeradsTokenPayload } from '../../../shared/api/zerads';
import { mapApiErrorToMessage } from '../../../shared/api/client-errors';
import { useI18n, useT } from '../../../shared/i18n';
import { isSafeHttpsLink } from '../../../shared/utils/safe-https-link';
import { ZeradsStatBlock } from './ZeradsStatBlock';
import { COPY_HINT_OK_MS, COPY_HINT_FAIL_MS } from '../lib/constants';
import { formatZeradsTs, formatZeradsUsdc, formatZeradsZer } from '../lib/zeradsFormat';

export function ZeradsCard() {
  const t = useT();
  const { locale } = useI18n();
  const [token, setToken] = useState<ZeradsTokenPayload | null>(null);
  const [stats, setStats] = useState<ZeradsStatsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (initial = false) => {
      if (!initial) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const [tok, st] = await Promise.all([getZeradsToken(), getZeradsStats()]);
        if (!tok.data) {
          setError(mapApiErrorToMessage(tok.error || 'LOAD_FAILED', t, 'offerwall'));
        }
        setToken(tok.data);
        setStats(st.data);
        if (tok.data && !st.data && st.error) {
          setError(mapApiErrorToMessage(st.error, t, 'offerwall'));
        }
      } finally {
        if (!initial) setRefreshing(false);
        else setLoading(false);
      }
    },
    [t]
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  async function copyLink(): Promise<void> {
    if (!token?.ptc_url) return;
    try {
      await navigator.clipboard.writeText(token.ptc_url);
      setCopyHint(t('offerwall.copyOk'));
      window.setTimeout(() => setCopyHint(null), COPY_HINT_OK_MS);
    } catch {
      setCopyHint(t('offerwall.copyFail'));
      window.setTimeout(() => setCopyHint(null), COPY_HINT_FAIL_MS);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-slate-700/80 bg-slate-900/60 p-6 text-slate-300">
        <Loader2 className="animate-spin" size={18} /> {t('offerwall.zeradsLoading')}
      </div>
    );
  }

  const totals = stats?.totals;
  const ptcSafe = token?.ptc_url && isSafeHttpsLink(token.ptc_url) ? token.ptc_url : null;

  return (
    <section className="mx-auto w-full max-w-4xl space-y-4">
      <div className="space-y-3 rounded-2xl border border-slate-700/80 bg-gradient-to-br from-slate-900/90 via-slate-900/70 to-emerald-950/20 px-4 py-5 sm:px-6 sm:py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-600/90 text-white shadow-lg shadow-emerald-900/30">
              <Coins className="shrink-0" size={22} />
            </span>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-widest text-emerald-400/90">
                {t('offerwall.zeradsEyebrow')}
              </div>
              <h2 className="bg-gradient-to-r from-white to-slate-300 bg-clip-text text-xl font-black tracking-tight text-transparent sm:text-2xl">
                {t('offerwall.zeradsTitle')}
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load(false)}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-bold uppercase tracking-wider hover:bg-slate-800 disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            {t('offerwall.refresh')}
          </button>
        </div>

        <p className="max-w-2xl text-sm text-slate-400">
          {t('offerwall.zeradsIntroBefore')}{' '}
          <span className="font-bold text-emerald-300">{t('offerwall.zeradsIntroHighlight')}</span>
          {t('offerwall.zeradsIntroAfter')}
        </p>

        {error ? (
          <div className="rounded-lg border border-rose-900/40 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
            {error}
          </div>
        ) : null}

        {ptcSafe ? (
          <div className="space-y-2 rounded-xl border border-slate-700 bg-slate-950/70 p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={ptcSafe}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-w-[200px] flex-1 items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-gradient-to-r from-emerald-600 to-emerald-700 px-5 py-3.5 text-sm font-black uppercase tracking-wide text-white shadow-lg shadow-emerald-900/40 transition hover:from-emerald-500 hover:to-emerald-600"
              >
                <ExternalLink size={18} />
                {t('offerwall.openPtc')}
              </a>
              <button
                type="button"
                onClick={() => void copyLink()}
                title={t('offerwall.copyTitle')}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-600 bg-slate-900 px-4 py-3.5 text-xs font-bold uppercase tracking-wider text-slate-300 hover:bg-slate-800"
              >
                <Copy size={16} />
                {t('offerwall.copy')}
              </button>
            </div>
            {copyHint ? <div className="text-[11px] text-emerald-300">{copyHint}</div> : null}
          </div>
        ) : token?.ptc_url ? (
          <div className="rounded-lg border border-amber-900/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
            {t('offerwall.ptcUrlUnsafe')}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-4 sm:gap-3">
          <ZeradsStatBlock
            label={t('offerwall.statUsdc')}
            value={formatZeradsUsdc(totals?.user_amount_usdc ?? 0)}
            icon={<TrendingUp size={16} />}
            tone="emerald"
          />
          <ZeradsStatBlock
            label={t('offerwall.statZer')}
            value={formatZeradsZer(totals?.amount_zer ?? 0)}
            icon={<Coins size={16} />}
            tone="amber"
          />
          <ZeradsStatBlock
            label={t('offerwall.statClicks')}
            value={String(totals?.clicks ?? 0)}
            icon={<MousePointerClick size={16} />}
            tone="sky"
          />
          <ZeradsStatBlock
            label={t('offerwall.statCallbacks')}
            value={String(totals?.callbacks ?? 0)}
            icon={<RefreshCw size={16} />}
            tone="slate"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-700/80 bg-slate-900/50">
        <div className="border-b border-slate-800 px-4 py-3 text-[11px] font-bold uppercase tracking-widest text-slate-400 sm:px-5">
          {t('offerwall.recentTitle')}
        </div>
        {!stats || stats.recent.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-500">{t('offerwall.recentEmpty')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-950/70 text-[10px] uppercase tracking-widest text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left font-bold">{t('offerwall.colDate')}</th>
                  <th className="px-3 py-2 text-right font-bold">{t('offerwall.colZer')}</th>
                  <th className="px-3 py-2 text-right font-bold">{t('offerwall.colUsdc')}</th>
                  <th className="px-3 py-2 text-right font-bold">{t('offerwall.colClicks')}</th>
                  <th className="px-3 py-2 text-right font-bold">{t('offerwall.colRate')}</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent.map((r, i) => (
                  <tr key={i} className="border-t border-slate-800/70">
                    <td className="whitespace-nowrap px-3 py-2 text-slate-300">
                      {formatZeradsTs(r.created_at, locale)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-amber-200">{formatZeradsZer(r.amount_zer)}</td>
                    <td className="px-3 py-2 text-right font-mono text-emerald-200">
                      {formatZeradsUsdc(r.user_amount_usdc)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-sky-200">{r.clicks}</td>
                    <td className="px-3 py-2 text-right font-mono text-slate-400">{r.zer_to_usdc_rate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
