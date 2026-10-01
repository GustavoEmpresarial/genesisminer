import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ExternalLink,
  LogOut,
  Maximize2,
  Minimize2,
  Settings,
  Timer
} from 'lucide-react';
import { useT } from '../../../shared/i18n';
import {
  fallbackPartnerGamesConfig,
  getPartnerGamesConfig,
  PARTNER_GAMES_ELAPSED_TICK_MS,
  PARTNER_GAMES_MS_PER_SECOND,
  PARTNER_GAMES_SECONDS_PER_MINUTE,
  partnerGameBySlug,
  postPartnerGamesHeartbeat,
  postPartnerGamesStop,
  postPartnerGamesVisit,
  type PartnerGame,
  type PartnerGamesConfig
} from '../../../shared/api/partner-games';

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / PARTNER_GAMES_MS_PER_SECOND));
  const m = Math.floor(totalSec / PARTNER_GAMES_SECONDS_PER_MINUTE);
  const s = totalSec % PARTNER_GAMES_SECONDS_PER_MINUTE;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

type Props = {
  slug?: string;
  onBackToHub?: () => void;
  onExit?: () => void;
};

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-full flex-col gap-8 pb-8 text-slate-100">
      <div className="mx-auto w-full max-w-xl px-3 pt-8 sm:px-4 sm:pt-10">{children}</div>
    </div>
  );
}

function NotFoundView({ onBack }: { onBack?: () => void }) {
  const t = useT();
  return (
    <Panel>
      <section aria-label={t('partnerGames.notFoundAria')} className="space-y-3 text-center">
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-50">
          {t('partnerGames.notFoundTitle')}
        </h1>
        <p className="text-sm sm:text-base text-slate-400 leading-relaxed">
          {t('partnerGames.notFoundBody')}
        </p>
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="mt-6 inline-flex items-center justify-center gap-2 self-center rounded-xl border border-slate-600 bg-slate-900/90 px-5 py-3 text-sm font-bold text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <ArrowLeft size={16} className="shrink-0 opacity-90" />
            {t('partnerGames.backToHub')}
          </button>
        ) : null}
      </section>
    </Panel>
  );
}

/** Unreachable for current catalog (both games have embedPath); kept as fallback. */
function ExternalGameView({
  game,
  onBack
}: {
  game: PartnerGame;
  onBack?: () => void;
}) {
  const t = useT();
  const visitedRef = useRef(false);

  const openSite = useCallback(() => {
    if (!visitedRef.current) {
      visitedRef.current = true;
      void postPartnerGamesVisit(game.slug);
    }
    window.open(game.publicUrl, '_blank', 'noopener,noreferrer');
  }, [game.publicUrl, game.slug]);

  return (
    <Panel>
      <section aria-label={t('partnerGames.externalAria')} className="space-y-3 text-center">
        <p className="text-[11px] font-bold uppercase tracking-widest text-amber-400/90">
          {t('partnerGames.brand')}
        </p>
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-50">{game.name}</h1>
        <h2 className="text-lg sm:text-xl font-bold text-slate-200">
          {t('partnerGames.externalHeadline')}
        </h2>
        <p className="text-sm sm:text-base text-slate-400 leading-relaxed">
          {t('partnerGames.externalLead')}
        </p>
        <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4">
          <button
            type="button"
            onClick={openSite}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-600 to-orange-700 px-8 py-4 text-sm font-black uppercase tracking-wide text-amber-50 shadow-lg shadow-amber-950/40 ring-1 ring-amber-400/20 hover:brightness-110"
          >
            <ExternalLink size={18} className="shrink-0" aria-hidden />
            {t('partnerGames.visitAndOpenCta')}
          </button>
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-600 bg-slate-900/90 px-5 py-3 text-sm font-bold text-slate-200 hover:bg-slate-800 transition-colors"
            >
              <ArrowLeft size={16} className="shrink-0 opacity-90" />
              {t('partnerGames.backToHub')}
            </button>
          ) : null}
        </div>
      </section>
    </Panel>
  );
}

function EmbedSessionView({
  game,
  config,
  onExit
}: {
  game: PartnerGame;
  config: PartnerGamesConfig;
  onExit?: () => void;
}) {
  const t = useT();
  const embedPath = game.embedPath ?? '';
  const [iframeSrc, setIframeSrc] = useState(embedPath);
  const [iframeKey, setIframeKey] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creditedMinutes, setCreditedMinutes] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [sessionLive, setSessionLive] = useState(true);
  const shellRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const sessionStartedAtRef = useRef<number | null>(Date.now());
  const stoppedRef = useRef(false);
  const sessionActiveRef = useRef(true);

  const stopSession = useCallback(() => {
    sessionActiveRef.current = false;
    sessionStartedAtRef.current = null;
    setSessionLive(false);
    setSettingsOpen(false);
    if (!stoppedRef.current) {
      stoppedRef.current = true;
      void postPartnerGamesStop(game.slug);
    }
  }, [game.slug]);

  const handleExit = useCallback(() => {
    stopSession();
    onExit?.();
  }, [onExit, stopSession]);

  const reloadEmbed = useCallback(() => {
    stoppedRef.current = false;
    sessionActiveRef.current = true;
    sessionStartedAtRef.current = Date.now();
    setSessionLive(true);
    setElapsedMs(0);
    // Unique query so the browser cannot reuse a stale ML document (Turnstile bypass JS).
    const bustSep = embedPath.includes('?') ? '&' : '?';
    setIframeSrc(`${embedPath}${bustSep}r=${Date.now()}`);
    setIframeKey((k) => k + 1);
  }, [embedPath]);

  useEffect(() => {
    reloadEmbed();
  }, [embedPath, game.slug, reloadEmbed]);

  useEffect(() => {
    void postPartnerGamesVisit(game.slug);
    return () => {
      if (sessionActiveRef.current && !stoppedRef.current) {
        stoppedRef.current = true;
        sessionActiveRef.current = false;
        sessionStartedAtRef.current = null;
        void postPartnerGamesStop(game.slug);
      }
    };
  }, [game.slug]);

  useEffect(() => {
    if (config.maintenance || !sessionLive) return;
    const intervalMs = config.heartbeatIntervalMs;
    const id = window.setInterval(() => {
      if (!sessionActiveRef.current || stoppedRef.current) return;
      void (async () => {
        if (!sessionActiveRef.current || stoppedRef.current) return;
        const res = await postPartnerGamesHeartbeat(game.slug);
        if (!res.ok) {
          // Uma batida falhada é transitória (rede, 401 a meio de um refresh).
          // O próximo tick tenta de novo: nunca recarregar a sessão por isto.
          return;
        }
        if (res.data.accepted) {
          setCreditedMinutes((n) => n + res.data.creditedMinutes);
        }
      })();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [config.heartbeatIntervalMs, config.maintenance, game.slug, sessionLive]);

  useEffect(() => {
    if (!sessionLive) return;
    const id = window.setInterval(() => {
      if (!sessionActiveRef.current || sessionStartedAtRef.current == null) return;
      const start = sessionStartedAtRef.current;
      setElapsedMs(Date.now() - start);
    }, PARTNER_GAMES_ELAPSED_TICK_MS);
    return () => window.clearInterval(id);
  }, [sessionLive]);

  useEffect(() => {
    const onFs = () => {
      const el = shellRef.current;
      setFullscreen(!!document.fullscreenElement && document.fullscreenElement === el);
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const el = shellRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) {
        await el.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      /* browser / iframe policy */
    }
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [settingsOpen]);

  return (
    <div className="w-full flex flex-col gap-2 sm:gap-3 text-slate-100 pb-6 px-1 sm:px-4 pt-1 min-h-0">
      {onExit ? (
        <button
          type="button"
          onClick={handleExit}
          className="inline-flex items-center gap-2 self-start rounded-lg px-1.5 py-1.5 text-sm font-bold text-slate-300 hover:text-slate-50 hover:bg-slate-800/60 transition-colors"
          title={t('partnerGames.backToHub')}
        >
          <ArrowLeft size={18} className="shrink-0 opacity-90" aria-hidden />
          {t('partnerGames.backToHub')}
        </button>
      ) : null}

      <section
        aria-label={t('partnerGames.sessionAria')}
        ref={shellRef}
        className={
          fullscreen
            ? 'relative w-full h-full flex flex-col overflow-hidden rounded-none border-0 bg-slate-950 shadow-none ring-0'
            : 'relative w-full max-w-7xl mx-auto flex flex-col overflow-hidden rounded-2xl border border-slate-700/80 bg-slate-950 shadow-xl shadow-black/40 ring-1 ring-amber-600/15'
        }
      >
        <header className="relative z-[1] flex flex-wrap items-center gap-x-2 gap-y-1.5 sm:gap-x-3 px-2.5 sm:px-4 py-2 sm:py-2.5 border-b border-slate-700/80 bg-slate-900/95 shrink-0">
          <p className="text-sm font-black tracking-wide text-slate-50 truncate min-w-0 max-w-[10rem] sm:max-w-none">
            {game.name}
          </p>
          <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-950/60 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-emerald-300 ring-1 ring-emerald-400/30 shrink-0">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden />
            {t('partnerGames.liveBadge')}
          </span>
          <div className="inline-flex items-center gap-1 sm:gap-1.5 text-slate-200 shrink-0">
            <Timer size={14} className="shrink-0 opacity-90" aria-hidden />
            <span className="hidden sm:inline text-[10px] uppercase font-bold opacity-80">
              {t('partnerGames.elapsedLabel')}
            </span>
            <span className="text-sm font-mono font-bold tabular-nums">
              {formatElapsed(elapsedMs)}
            </span>
          </div>
          <div className="inline-flex items-center gap-1 sm:gap-1.5 text-slate-200 shrink-0">
            <span className="text-[10px] uppercase font-bold opacity-80">
              {t('partnerGames.creditedLabel')}
            </span>
            <span className="text-sm font-black tabular-nums">
              {creditedMinutes} {t('partnerGames.creditedMinutesUnit')}
            </span>
          </div>
        </header>

        <div
          className={
            fullscreen
              ? 'relative z-[1] w-full flex-1 h-full min-h-0 bg-black'
              : 'relative z-[1] w-full min-h-[min(70dvh,40rem)] h-[min(82dvh,56rem)] bg-black'
          }
        >
          {iframeSrc ? (
            <iframe
              key={iframeKey}
              title={game.name}
              src={iframeSrc}
              className="absolute inset-0 h-full w-full border-0 bg-black"
              allow="fullscreen; clipboard-read; clipboard-write; payment"
              referrerPolicy="strict-origin-when-cross-origin"
            />
          ) : null}
        </div>

        <div className="relative z-[1] flex flex-wrap items-center justify-between gap-2 sm:gap-3 px-2.5 sm:px-4 py-2.5 sm:py-3 border-t border-slate-700/80 bg-slate-950 shrink-0">
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={toggleFullscreen}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-900/90 px-2.5 py-2 text-[11px] sm:text-xs font-bold text-slate-200 hover:bg-slate-800 transition-colors"
              title={fullscreen ? t('partnerGames.exitFullscreen') : t('partnerGames.enterFullscreen')}
            >
              {fullscreen ? (
                <Minimize2 size={16} className="shrink-0" />
              ) : (
                <Maximize2 size={16} className="shrink-0" />
              )}
              {fullscreen ? t('partnerGames.windowed') : t('partnerGames.fullscreen')}
            </button>
            <div className="relative" ref={settingsRef}>
              <button
                type="button"
                onClick={() => setSettingsOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-900/90 px-2.5 py-2 text-[11px] sm:text-xs font-bold text-slate-200 hover:bg-slate-800 transition-colors"
                title={t('partnerGames.options')}
                aria-expanded={settingsOpen}
              >
                <Settings size={16} className="shrink-0" />
                {t('partnerGames.options')}
              </button>
              {settingsOpen && (
                <div className="absolute bottom-full left-0 mb-2 z-20 w-[min(92vw,280px)] rounded-xl border border-slate-600 bg-slate-900 p-3 shadow-xl text-xs text-slate-300 space-y-2">
                  <p>{t('partnerGames.settingsHint')}</p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <a
                      href={game.publicUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg bg-amber-700/35 px-2 py-1.5 font-bold text-amber-100 hover:bg-amber-700/50"
                    >
                      <ExternalLink size={12} />
                      {t('partnerGames.openSite')}
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        stopSession();
                        setIframeSrc('');
                      }}
                      className="rounded-lg border border-slate-600 px-2 py-1.5 font-bold text-slate-300 hover:bg-slate-800"
                    >
                      {t('partnerGames.stopIframe')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        reloadEmbed();
                        setSettingsOpen(false);
                      }}
                      className="rounded-lg border border-slate-600 px-2 py-1.5 font-bold text-slate-300 hover:bg-slate-800"
                    >
                      {t('partnerGames.reload')}
                    </button>
                  </div>
                </div>
              )}
            </div>
            {onExit ? (
              <button
                type="button"
                onClick={handleExit}
                className="inline-flex items-center gap-1 rounded-lg border border-transparent px-2 py-2 text-[10px] sm:text-[11px] font-bold text-slate-500 hover:text-slate-300 hover:bg-slate-800/50 transition-colors"
                title={t('partnerGames.exitSessionTitle')}
              >
                <LogOut size={14} className="shrink-0 opacity-80" />
                {t('partnerGames.exit')}
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <p className="hidden sm:block text-center text-[11px] text-slate-500 max-w-2xl mx-auto px-2 leading-snug">
        {t('partnerGames.footerNote')}
      </p>
    </div>
  );
}

export const PartnerGamePlayerPage: React.FC<Props> = ({ slug, onBackToHub, onExit }) => {
  const t = useT();
  const back = onBackToHub ?? onExit;
  const [config, setConfig] = useState<PartnerGamesConfig>(() => fallbackPartnerGamesConfig());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfgRes = await getPartnerGamesConfig();
      const cfg = cfgRes.ok ? cfgRes.data : fallbackPartnerGamesConfig();
      if (cancelled) return;
      setConfig(cfg);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <Panel>
        <div className="flex flex-1 items-center justify-center py-8">
          <p className="text-sm text-slate-400">{t('partnerGames.brand')}</p>
        </div>
      </Panel>
    );
  }

  if (config.maintenance) {
    return (
      <Panel>
        <section aria-label={t('partnerGames.maintenanceAria')} className="space-y-3 text-center">
          <p className="text-[11px] font-bold uppercase tracking-widest text-amber-400/90">
            {t('partnerGames.brand')}
          </p>
          <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-50">
            {t('partnerGames.maintenanceTitle')}
          </h1>
          <p className="text-sm sm:text-base text-slate-400 leading-relaxed">
            {t('partnerGames.maintenanceBody')}
          </p>
          {back ? (
            <button
              type="button"
              onClick={back}
              className="mt-6 inline-flex items-center justify-center gap-2 self-center rounded-xl border border-slate-600 bg-slate-900/90 px-5 py-3 text-sm font-bold text-slate-200 hover:bg-slate-800 transition-colors"
            >
              <ArrowLeft size={16} className="shrink-0 opacity-90" />
              {t('partnerGames.backToHub')}
            </button>
          ) : null}
        </section>
      </Panel>
    );
  }

  const game = slug ? partnerGameBySlug(config, slug) : null;
  if (!game) {
    return <NotFoundView onBack={back} />;
  }

  if (!game.embedPath) {
    return <ExternalGameView game={game} onBack={back} />;
  }

  return <EmbedSessionView game={game} config={config} onExit={back} />;
};
