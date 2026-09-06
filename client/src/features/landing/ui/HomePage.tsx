import React from 'react';
import { TrendingUp, ShieldCheck, Zap, ArrowRight, Server, Lock, Info } from 'lucide-react';
import { useT, type TranslateFn } from '../../../shared/i18n';

interface HomePageProps {
    onNavigate: (view: 'auth' | 'docs', opts?: { mode?: 'login' | 'register' }) => void;
}

const HIGHLIGHT_CLASS = 'text-amber-700 dark:text-amber-300';

function richT(
    t: TranslateFn,
    templateKey: string,
    highlights: Record<string, { labelKey: string; className?: string }>
): React.ReactNode {
    const markers: Record<string, string> = {};
    Object.keys(highlights).forEach((k, i) => {
        markers[k] = `\uE000${i}\uE001`;
    });
    const text = t(templateKey, markers);
    const pattern = new RegExp(
        `(${Object.values(markers)
            .map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('|')})`
    );
    const parts = text.split(pattern);
    const markerToKey = Object.fromEntries(Object.entries(markers).map(([k, m]) => [m, k]));
    return parts.map((part, i) => {
        const hk = markerToKey[part];
        if (hk) {
            const h = highlights[hk];
            return (
                <strong key={i} className={h.className ?? HIGHLIGHT_CLASS}>
                    {t(h.labelKey)}
                </strong>
            );
        }
        return part ? <React.Fragment key={i}>{part}</React.Fragment> : null;
    });
}

export const HomePage: React.FC<HomePageProps> = ({ onNavigate }) => {
    const t = useT();

    return (
        <div className="flex flex-col min-h-full bg-slate-50 dark:bg-[#120e09] text-slate-800 dark:text-slate-200 animate-in fade-in duration-500 transition-colors">

            {/* Hero — ouro / âmbar Genesis DAO */}
            <div className="relative overflow-hidden py-20 lg:py-32 bg-gradient-to-b from-slate-50 via-white to-slate-100 dark:from-[#120e09] dark:via-[#1c140c] dark:to-[#0a0805]">
                <div
                    className="absolute inset-0 opacity-[0.07] dark:opacity-[0.12] pointer-events-none"
                    style={{
                        backgroundImage:
                            'repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(0,0,0,0.04) 2px, rgba(0,0,0,0.04) 4px)'
                    }}
                    aria-hidden
                />
                <div className="absolute top-1/4 left-0 w-1 h-48 md:h-64 bg-gradient-to-b from-amber-400 via-amber-500 to-orange-600 rounded-r-full opacity-90 hidden sm:block" aria-hidden />
                <div className="absolute top-0 right-0 -mr-24 -mt-24 w-[28rem] h-[28rem] bg-amber-500/[0.12] dark:bg-amber-400/15 rounded-full blur-3xl" />
                <div className="absolute bottom-0 left-0 -ml-24 -mb-24 w-[28rem] h-[28rem] bg-orange-600/[0.1] dark:bg-orange-500/15 rounded-full blur-3xl" />

                <div className="max-w-7xl mx-auto px-6 relative z-10 text-center">
                    <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-amber-500/10 dark:bg-amber-500/15 border border-amber-400/40 dark:border-amber-400/30 text-amber-700 dark:text-amber-300 text-[11px] font-black uppercase tracking-[0.2em] mb-8 shadow-[0_0_24px_rgba(251,191,36,0.2)]">
                        <span className="w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_10px_#fbbf24] animate-pulse" />
                        {t('landing.badge')}
                    </div>

                    <h1 className="text-5xl md:text-7xl font-black mb-6 tracking-tight text-slate-900 dark:text-white leading-[1.05]">
                        {t('landing.heroTitle1')} <br />
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-500 dark:from-amber-200 dark:via-amber-300 dark:to-orange-400 drop-shadow-[0_0_40px_rgba(251,191,36,0.35)]">{t('landing.heroTitle2')}</span>
                    </h1>

                    <p className="text-lg md:text-xl text-slate-600 dark:text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">
                        {richT(t, 'landing.heroBody', {
                            brand: { labelKey: 'landing.brand' },
                            tokenomics: { labelKey: 'landing.tokenomics' }
                        })}
                    </p>

                    <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                        <button
                            type="button"
                            onClick={() => onNavigate('auth', { mode: 'login' })}
                            aria-label={t('landing.openLogin')}
                            className="group w-full sm:w-auto bg-gradient-to-r from-amber-400 to-amber-600 hover:from-amber-300 hover:to-amber-500 text-stone-950 font-bold py-4 px-10 rounded-xl shadow-[0_0_32px_rgba(245,158,11,0.45)] border border-amber-300/50 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                        >
                            {t('common.login')} <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" aria-hidden />
                        </button>
                        <button
                            type="button"
                            onClick={() => onNavigate('auth', { mode: 'register' })}
                            aria-label={t('landing.openSignUp')}
                            className="w-full sm:w-auto bg-white/90 dark:bg-slate-900/80 hover:bg-white dark:hover:bg-slate-900 text-slate-800 dark:text-slate-100 font-bold py-4 px-10 rounded-xl border-2 border-amber-500/25 dark:border-amber-400/30 hover:border-orange-500/40 dark:hover:border-orange-400/40 transition-all shadow-md backdrop-blur-sm"
                        >
                            {t('common.signUp')}
                        </button>
                    </div>
                </div>
            </div>

            <div className="w-full flex justify-center px-4 my-8 bg-slate-50 dark:bg-[#120e09]">
                <iframe
                    src="https://zerads.com/ad/ad.php?width=728&ref=11294"
                    width={728}
                    height={90}
                    marginWidth={0}
                    marginHeight={0}
                    frameBorder={0}
                    scrolling="no"
                    title="ZerAds banner"
                    style={{ maxWidth: '100%', border: 0 }}
                />
            </div>

            <div className="bg-slate-100 dark:bg-[#15100a] py-20 border-y border-slate-200 dark:border-amber-950/50">
                <div className="max-w-7xl mx-auto px-6">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                        <div className="bg-white dark:bg-slate-950/80 p-8 rounded-xl border border-slate-200 dark:border-amber-900/40 hover:border-amber-500/50 dark:hover:border-amber-400/40 transition-colors group shadow-sm dark:shadow-[0_0_24px_rgba(245,158,11,0.06)]">
                            <div className="w-14 h-14 bg-slate-50 dark:bg-amber-950/50 rounded-lg flex items-center justify-center mb-6 group-hover:scale-110 transition-transform ring-1 ring-amber-500/20">
                                <Server className="text-amber-600 dark:text-amber-400" size={32} />
                            </div>
                            <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-3">{t('landing.feature1Title')}</h3>
                            <p className="text-slate-600 dark:text-slate-400">{t('landing.feature1Body')}</p>
                        </div>

                        <div className="bg-white dark:bg-slate-950/80 p-8 rounded-xl border border-slate-200 dark:border-orange-900/40 hover:border-orange-500/50 dark:hover:border-orange-400/40 transition-colors group shadow-sm dark:shadow-[0_0_24px_rgba(194,65,12,0.08)]">
                            <div className="w-14 h-14 bg-slate-50 dark:bg-orange-950/40 rounded-lg flex items-center justify-center mb-6 group-hover:scale-110 transition-transform ring-1 ring-orange-500/25">
                                <Zap className="text-orange-600 dark:text-orange-400" size={32} />
                            </div>
                            <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-3">{t('landing.feature2Title')}</h3>
                            <p className="text-slate-600 dark:text-slate-400">{t('landing.feature2Body')}</p>
                        </div>

                        <div className="bg-white dark:bg-slate-950 p-8 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-green-500/30 transition-colors group shadow-sm">
                            <div className="w-14 h-14 bg-slate-50 dark:bg-slate-900 rounded-lg flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                                <TrendingUp className="text-green-600 dark:text-green-400" size={32} />
                            </div>
                            <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-3">{t('landing.feature3Title')}</h3>
                            <p className="text-slate-600 dark:text-slate-400">{t('landing.feature3Body')}</p>
                        </div>
                    </div>
                </div>
            </div>

            <div className="py-20 bg-white dark:bg-[#120e09] relative overflow-hidden border-b border-slate-200 dark:border-amber-950/30">
                <div className="max-w-6xl mx-auto px-6 grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">

                    <div className="space-y-6">
                        <div className="inline-flex items-center gap-2 text-amber-600 dark:text-amber-500 font-bold uppercase tracking-widest text-sm">
                            <Info size={16} /> {t('landing.aboutLabel')}
                        </div>
                        <h2 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white">{t('landing.aboutTitle')}</h2>
                        <div className="space-y-4 text-slate-600 dark:text-slate-400 leading-relaxed">
                            <p>
                                {richT(t, 'landing.aboutP1', {
                                    tycoon: { labelKey: 'landing.tycoon', className: '' }
                                })}
                            </p>
                            <p>
                                {richT(t, 'landing.aboutP2', {
                                    balance: { labelKey: 'landing.balance', className: '' }
                                })}
                            </p>
                        </div>
                    </div>

                    <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-8 relative shadow-lg">
                        <div className="absolute top-0 right-0 p-4 opacity-10 dark:opacity-20">
                            <Lock size={64} className="text-green-500" />
                        </div>
                        <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                            <ShieldCheck className="text-green-600 dark:text-green-500" /> {t('landing.exchangeTitle')}
                        </h3>
                        <div className="space-y-4 text-sm text-slate-600 dark:text-slate-400">
                            <p>
                                {richT(t, 'landing.exchangeP1', {
                                    parity: { labelKey: 'landing.parity', className: '' }
                                })}
                            </p>
                            <div className="bg-white dark:bg-slate-950 p-4 rounded-lg border border-green-500/30 text-center shadow-inner">
                                <span className="text-xs uppercase text-slate-500">{t('landing.parityLabel')}</span>
                                <div className="text-2xl font-mono font-bold text-slate-800 dark:text-white my-1">
                                    {t('landing.parityAssets')} <span className="text-green-600 dark:text-green-400"><br />POL • WETH • WBTC</span>
                                </div>
                            </div>
                            <p>
                                {richT(t, 'landing.exchangeP2', {
                                    adjusted: { labelKey: 'landing.adjusted', className: '' },
                                    horizon: { labelKey: 'landing.horizon', className: '' }
                                })}
                            </p>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    );
};
