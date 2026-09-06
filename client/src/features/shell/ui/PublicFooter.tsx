import { DISCORD_COMMUNITY_URL, TELEGRAM_COMMUNITY_URL } from '../../../shared/constants/communityLinks';
import { DiscordIcon, TelegramIcon } from '../../../shared/icons/SocialBrandIcons';
import { useT } from '../../../shared/i18n';

export type PublicView =
  | 'home'
  | 'docs'
  | 'roadmap'
  | 'terms'
  | 'privacy'
  | 'cookies'
  | 'aml'
  | 'web3_risk'
  | 'refunds'
  | 'community'
  | 'auth'
  | 'game'
  | 'admin';

type PublicFooterProps = {
  onNavigate?: (view: PublicView) => void;
};

/** Footer público — cópia do legado (sem MarketNews na home). */
export function PublicFooter({ onNavigate }: PublicFooterProps) {
  const t = useT();

  return (
    <footer className="shrink-0 border-t border-slate-200 bg-slate-50 transition-colors duration-300 dark:border-amber-900/35 dark:bg-[#0f0c08]">
      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="grid gap-8 text-sm md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <img
                src="/img/favicon/genesis-miner-logo.webp"
                alt={t('landing.brand')}
                className="h-12 w-12 rounded-xl border border-amber-200/70 bg-white p-1.5 shadow-sm dark:border-amber-900/50 dark:bg-slate-900"
              />
              <div>
                <p className="bg-gradient-to-r from-amber-500 to-orange-600 bg-clip-text text-xs font-semibold uppercase tracking-widest text-transparent dark:from-amber-300 dark:to-amber-500">
                  {t('landing.brand')}
                </p>
                <p className="font-semibold text-slate-900 dark:text-slate-100">Genesis DAO</p>
              </div>
            </div>
            <p className="max-w-md leading-relaxed text-slate-600 dark:text-slate-400">
              {t('footer.blurb')}
            </p>
            <p className="text-xs text-slate-500">{t('footer.rights', { year: new Date().getFullYear() })}</p>
          </div>

          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">{t('footer.platforms')}</h3>
            <div className="flex flex-col gap-2 text-slate-600 dark:text-slate-300">
              <a href={DISCORD_COMMUNITY_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 transition-colors hover:text-[#7289da]">
                <DiscordIcon size={16} /> Discord
              </a>
              <a href={TELEGRAM_COMMUNITY_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 transition-colors hover:text-[#26A5E4]">
                <TelegramIcon size={16} /> Telegram
              </a>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">{t('footer.resources')}</h3>
            <div className="flex flex-col gap-2 text-slate-600 dark:text-slate-300">
              <button type="button" onClick={() => onNavigate?.('docs')} className="text-left transition-colors hover:text-amber-500">
                {t('footer.guide')}
              </button>
              <button type="button" onClick={() => onNavigate?.('roadmap')} className="text-left transition-colors hover:text-amber-500">
                {t('footer.roadmap')}
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">{t('footer.legal')}</h3>
            <div className="flex flex-col gap-2 text-slate-600 dark:text-slate-300">
              <button type="button" onClick={() => onNavigate?.('terms')} className="text-left transition-colors hover:text-amber-500">
                {t('footer.terms')}
              </button>
              <button type="button" onClick={() => onNavigate?.('privacy')} className="text-left transition-colors hover:text-amber-500">
                {t('footer.privacy')}
              </button>
              <button type="button" onClick={() => onNavigate?.('cookies')} className="text-left transition-colors hover:text-amber-500">
                {t('footer.cookies')}
              </button>
              <button type="button" onClick={() => onNavigate?.('web3_risk')} className="text-left transition-colors hover:text-amber-500">
                {t('footer.web3Risk')}
              </button>
              <button type="button" onClick={() => onNavigate?.('community')} className="text-left transition-colors hover:text-amber-500">
                {t('footer.community')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
