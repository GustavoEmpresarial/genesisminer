import React, { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { useT } from '../../../shared/i18n';
import {
  fallbackPartnerGamesConfig,
  getPartnerGamesConfig,
  type PartnerGame,
  type PartnerGameSection,
  type PartnerGamesConfig
} from '../../../shared/api/partner-games';

export type PartnerGamesPageProps = {
  onPlayGame?: (slug: string) => void;
};

function GameRow({
  game,
  onPlay
}: {
  game: PartnerGame;
  onPlay?: (slug: string) => void;
}) {
  const t = useT();
  const lead =
    game.section === 'official'
      ? t('partnerGames.gameLeadOfficial')
      : t('partnerGames.gameLeadPartner');

  return (
    <li className="partner-games-hub-fade flex flex-col sm:flex-row sm:items-center gap-4 rounded-2xl border border-slate-700/80 bg-slate-900/80 p-4 sm:p-5 ring-1 ring-amber-600/10">
      <div className="flex items-center gap-4 min-w-0 flex-1">
        {game.imageUrl ? (
          <img
            src={game.imageUrl}
            alt=""
            className="h-16 w-16 sm:h-20 sm:w-20 rounded-xl object-cover bg-slate-950 ring-1 ring-slate-600/60 shrink-0"
          />
        ) : (
          <div
            className="h-16 w-16 sm:h-20 sm:w-20 rounded-xl bg-gradient-to-br from-amber-800/50 to-slate-950 ring-1 ring-slate-600/60 shrink-0"
            aria-hidden
          />
        )}
        <div className="min-w-0">
          <h3 className="text-lg sm:text-xl font-black tracking-tight text-slate-50 truncate">
            {game.name}
          </h3>
          <p className="mt-1 text-sm text-slate-400 leading-relaxed">{lead}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => onPlay?.(game.slug)}
        className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-600 to-orange-700 px-5 py-3 text-sm font-black uppercase tracking-wide text-amber-50 shadow-lg shadow-amber-950/40 ring-1 ring-amber-400/20 hover:brightness-110 active:scale-[0.99] transition-transform shrink-0"
      >
        <Play size={18} className="fill-amber-50 shrink-0" aria-hidden />
        {t('partnerGames.playCta')}
      </button>
    </li>
  );
}

function GameSection({
  section,
  title,
  games,
  onPlay
}: {
  section: PartnerGameSection;
  title: string;
  games: PartnerGame[];
  onPlay?: (slug: string) => void;
}) {
  if (games.length === 0) return null;
  return (
    <div className="partner-games-hub-fade space-y-3 sm:space-y-4">
      <h2 className="text-xs sm:text-sm font-bold uppercase tracking-widest text-amber-400/90">
        {title}
      </h2>
      <ul className="flex flex-col gap-3 sm:gap-4 list-none p-0 m-0" data-section={section}>
        {games.map((game) => (
          <GameRow key={game.slug} game={game} onPlay={onPlay} />
        ))}
      </ul>
    </div>
  );
}

/**
 * Partner Games hub — official + partner sections (iframe play for all).
 * Clean Offerwall-style slate cards; no full-page overlay shells.
 */
export const PartnerGamesPage: React.FC<PartnerGamesPageProps> = ({ onPlayGame }) => {
  const t = useT();
  const [config, setConfig] = useState<PartnerGamesConfig>(() => fallbackPartnerGamesConfig());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfgRes = await getPartnerGamesConfig();
      const cfg = cfgRes.ok ? cfgRes.data : fallbackPartnerGamesConfig();
      if (cancelled) return;
      setConfig(cfg);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (config.maintenance) {
    return (
      <div className="flex w-full flex-col gap-8 pb-8 text-slate-100">
        <div className="mx-auto w-full max-w-xl px-3 pt-8 sm:px-4 sm:pt-10 text-center">
          <section aria-label={t('partnerGames.maintenanceAria')} className="space-y-3">
            <p className="text-[11px] font-bold uppercase tracking-widest text-amber-400/90">
              {t('partnerGames.brand')}
            </p>
            <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-50">
              {t('partnerGames.maintenanceTitle')}
            </h1>
            <p className="text-sm sm:text-base text-slate-400 leading-relaxed">
              {t('partnerGames.maintenanceBody')}
            </p>
          </section>
        </div>
      </div>
    );
  }

  const official = config.games.filter((g) => g.section === 'official');
  const partner = config.games.filter((g) => g.section === 'partner');

  return (
    <div className="flex w-full flex-col gap-8 pb-8 text-slate-100">
      <div className="mx-auto w-full max-w-7xl space-y-8 px-3 pt-4 sm:px-4 sm:pt-5">
        <section
          aria-label={t('partnerGames.hubAria')}
          className="space-y-2 rounded-2xl border border-slate-700/80 bg-gradient-to-br from-slate-900/90 via-slate-900/70 to-amber-950/20 px-4 py-5 sm:px-6 sm:py-6"
        >
          <p className="partner-games-hub-fade text-[11px] font-bold uppercase tracking-widest text-amber-400/90">
            {t('partnerGames.hubEyebrow')}
          </p>
          <h1 className="partner-games-hub-fade text-2xl sm:text-4xl font-black tracking-tight text-slate-50">
            {t('partnerGames.title')}
          </h1>
          <p className="partner-games-hub-fade max-w-3xl text-sm text-slate-400 leading-relaxed">
            {t('partnerGames.hubLead')}
          </p>
        </section>

        {config.games.length === 0 ? (
          <p className="partner-games-hub-fade text-sm text-slate-500">{t('partnerGames.hubEmpty')}</p>
        ) : (
          <div className="mx-auto w-full max-w-4xl space-y-8 sm:space-y-10">
            <GameSection
              section="official"
              title={t('partnerGames.sectionOfficial')}
              games={official}
              onPlay={onPlayGame}
            />
            <GameSection
              section="partner"
              title={t('partnerGames.sectionPartner')}
              games={partner}
              onPlay={onPlayGame}
            />
          </div>
        )}
      </div>

      <style>{`
        @keyframes partnerGamesHubFadeIn {
          from { opacity: 0; transform: translateY(0.5rem); }
          to { opacity: 1; transform: translateY(0); }
        }
        .partner-games-hub-fade {
          animation: partnerGamesHubFadeIn 700ms ease-out both;
        }
      `}</style>
    </div>
  );
};
