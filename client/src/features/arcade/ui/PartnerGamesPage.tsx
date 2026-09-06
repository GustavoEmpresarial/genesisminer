import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ExternalLink,
  Play,
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
  postPartnerGamesHeartbeat,
  postPartnerGamesStop,
  postPartnerGamesVisit,
  type PartnerGamesConfig
} from '../../../shared/api/partner-games';

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / PARTNER_GAMES_MS_PER_SECOND));
  const m = Math.floor(totalSec / PARTNER_GAMES_SECONDS_PER_MINUTE);
  const s = totalSec % PARTNER_GAMES_SECONDS_PER_MINUTE;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export type PartnerGamesPageProps = {
  /** Sai da sessão de jogo (ex.: voltar ao dashboard / servers). */
  onExit?: () => void;
  onPlayGame?: (slug: string) => void;
};

/**
 * Lobby BlockMiner próprio; iframe só após CTA.
 * Tema dark mining / amber-copper — sem violet genérico.
 */
export const PartnerGamesPage: React.FC<PartnerGamesPageProps> = ({ onExit }) => {
  const t = useT();
  const [config, setConfig] = useState<PartnerGamesConfig>(() => fallbackPartnerGamesConfig());
  const [gameStarted, setGameStarted] = useState(false);
  const [iframeSrc, setIframeSrc] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creditedMinutes, setCreditedMinutes] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const shellRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const sessionStartedAtRef = useRef<number | null>(null);
  /** True after stop was sent (stopGame or unmount) — avoids double POST /stop. */
  const stoppedRef = useRef(false);
  /** Mirrors whether a live session should emit stop on leave. */
  const sessionActiveRef = useRef(false);

  const runGame = useCallback((embedPath: string) => {
    stoppedRef.current = false;
    sessionActiveRef.current = true;
    setGameStarted(true);
    setIframeSrc(embedPath);
    sessionStartedAtRef.current = Date.now();
    setElapsedMs(0);
  }, []);

  const stopGame = useCallback(() => {
    setGameStarted(false);
    setIframeSrc('');
    sessionStartedAtRef.current = null;
    sessionActiveRef.current = false;
    setSettingsOpen(false);
    if (!stoppedRef.current) {
      stoppedRef.current = true;
      void postPartnerGamesStop();
    }
  }, []);

  const handleExit = useCallback(() => {
    stopGame();
    if (onExit) {
      onExit();
      return;
    }
  }, [onExit, stopGame]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfgRes = await getPartnerGamesConfig();
      const cfg = cfgRes.ok ? cfgRes.data : fallbackPartnerGamesConfig();
      if (cancelled) return;
      setConfig(cfg);
      if (!cfg.maintenance) {
        void postPartnerGamesVisit();
      }
    })();
    return () => {
      cancelled = true;
      if (sessionActiveRef.current && !stoppedRef.current) {
        stoppedRef.current = true;
        sessionActiveRef.current = false;
        void postPartnerGamesStop();
      }
    };
  }, []);

  useEffect(() => {
    if (!gameStarted || config.maintenance) return;
    const intervalMs = config.heartbeatIntervalMs;
    const id = window.setInterval(() => {
      void (async () => {
        const res = await postPartnerGamesHeartbeat();
        if (res.ok && res.data.accepted) {
          setCreditedMinutes((n) => n + res.data.creditedMinutes);
        }
      })();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [gameStarted, config.heartbeatIntervalMs, config.maintenance]);

  useEffect(() => {
    if (!gameStarted) return;
    const id = window.setInterval(() => {
      const start = sessionStartedAtRef.current;
      if (start == null) return;
      setElapsedMs(Date.now() - start);
    }, PARTNER_GAMES_ELAPSED_TICK_MS);
    return () => window.clearInterval(id);
  }, [gameStarted]);

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
      /* ignorar — política do browser / iframe */
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

  if (config.maintenance) {
    return (
      <div className="relative w-full min-h-[min(70vh,640px)] flex flex-col text-stone-100 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-stone-950 via-stone-900 to-amber-950"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.14]"
          style={{
            backgroundImage:
              'radial-gradient(rgba(251,191,36,0.45) 1px, transparent 1px), radial-gradient(ellipse 70% 45% at 15% 10%, rgba(180,83,9,0.35), transparent 55%), radial-gradient(ellipse 55% 40% at 85% 90%, rgba(120,53,15,0.28), transparent 50%)',
            backgroundSize: '18px 18px, auto, auto'
          }}
          aria-hidden
        />
        <section
          aria-label={t('partnerGames.maintenanceAria')}
          className="relative z-[1] w-full max-w-xl mx-auto flex flex-1 flex-col justify-center px-4 sm:px-8 py-10 sm:py-14 text-center"
        >
          <p className="text-xs sm:text-sm font-semibold uppercase tracking-[0.28em] text-amber-500/90">
            {t('partnerGames.brand')}
          </p>
          <h1 className="mt-4 sm:mt-5 text-3xl sm:text-4xl font-black tracking-tight text-amber-50">
            {t('partnerGames.maintenanceTitle')}
          </h1>
          <p className="mt-3 sm:mt-4 text-sm sm:text-base text-stone-400 leading-relaxed">
            {t('partnerGames.maintenanceBody')}
          </p>
        </section>
      </div>
    );
  }

  if (!gameStarted) {
    return (
      <div className="relative w-full min-h-[min(70vh,640px)] flex flex-col text-stone-100 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-stone-950 via-stone-900 to-amber-950"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.14]"
          style={{
            backgroundImage:
              'radial-gradient(rgba(251,191,36,0.45) 1px, transparent 1px), radial-gradient(ellipse 70% 45% at 15% 10%, rgba(180,83,9,0.35), transparent 55%), radial-gradient(ellipse 55% 40% at 85% 90%, rgba(120,53,15,0.28), transparent 50%)',
            backgroundSize: '18px 18px, auto, auto'
          }}
          aria-hidden
        />

        <section
          aria-label={t('partnerGames.lobbyAria')}
          className="relative z-[1] w-full max-w-5xl mx-auto flex flex-1 flex-col justify-center px-4 sm:px-8 py-10 sm:py-14"
        >
          <p className="partner-games-lobby-fade text-xs sm:text-sm font-semibold uppercase tracking-[0.28em] text-amber-500/90">
            {t('partnerGames.lobbyEyebrow')}
          </p>

          <h1 className="partner-games-lobby-fade mt-4 sm:mt-5 text-5xl sm:text-7xl md:text-8xl font-black tracking-tight text-amber-50 leading-[0.95]">
            {t('partnerGames.brand')}
          </h1>

          <h2 className="partner-games-lobby-fade mt-4 sm:mt-5 text-xl sm:text-2xl md:text-3xl font-bold text-stone-200 tracking-tight max-w-2xl">
            {t('partnerGames.lobbyHeadline')}
          </h2>

          <p className="partner-games-lobby-fade mt-3 sm:mt-4 text-sm sm:text-base text-stone-400 max-w-xl leading-relaxed">
            {t('partnerGames.lobbyLead')}
          </p>

          <div className="partner-games-lobby-fade mt-8 sm:mt-10 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6">
            <button
              type="button"
              onClick={() => runGame(config.embedPath)}
              className="inline-flex items-center justify-center gap-3 rounded-2xl bg-gradient-to-r from-amber-600 to-orange-700 px-10 sm:px-14 py-4 sm:py-5 text-base sm:text-lg font-black uppercase tracking-wide text-amber-50 shadow-xl shadow-amber-950/60 ring-2 ring-amber-400/30 hover:brightness-110 active:scale-[0.99] transition-transform animate-pulse"
            >
              <Play size={28} className="fill-amber-50 shrink-0" aria-hidden />
              {t('partnerGames.openHubCta')}
            </button>
            <a
              href={config.publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 text-sm font-bold text-amber-200/90 hover:text-amber-100 underline-offset-4 hover:underline transition-colors"
            >
              <ExternalLink size={16} className="shrink-0" aria-hidden />
              {t('partnerGames.openExternalCta')}
            </a>
          </div>

          <p className="partner-games-lobby-fade mt-8 text-xs sm:text-sm text-stone-500">
            {t('partnerGames.lobbyReadyStatus')}
          </p>
        </section>

        <style>{`
          @keyframes partnerGamesLobbyFadeIn {
            from { opacity: 0; transform: translateY(0.5rem); }
            to { opacity: 1; transform: translateY(0); }
          }
          .partner-games-lobby-fade {
            animation: partnerGamesLobbyFadeIn 700ms ease-out both;
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col gap-3 text-slate-100 pb-6 px-2 sm:px-4 pt-1 min-h-0">
      <section
        aria-label={t('partnerGames.sessionAria')}
        ref={shellRef}
        className="relative w-full max-w-5xl mx-auto flex flex-col overflow-hidden rounded-2xl border border-amber-800/50 bg-stone-950 shadow-2xl shadow-black/60 ring-1 ring-amber-600/25"
      >
        <header className="relative z-[1] flex flex-wrap items-center justify-between gap-3 px-3 sm:px-4 py-2.5 bg-gradient-to-r from-amber-800 via-amber-700 to-orange-800 border-b border-amber-950/40">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3 min-w-0">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-black/25 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-emerald-300 ring-1 ring-emerald-400/30">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden />
              {t('partnerGames.liveBadge')}
            </span>
            <div className="inline-flex items-center gap-1.5 text-amber-50">
              <Timer size={14} className="shrink-0 opacity-90" aria-hidden />
              <span className="text-[10px] uppercase font-bold opacity-80">
                {t('partnerGames.elapsedLabel')}
              </span>
              <span className="text-sm font-mono font-bold tabular-nums">
                {formatElapsed(elapsedMs)}
              </span>
            </div>
            <div className="inline-flex items-center gap-1.5 text-amber-50">
              <span className="text-[10px] uppercase font-bold opacity-80">
                {t('partnerGames.creditedLabel')}
              </span>
              <span className="text-sm font-black tabular-nums">
                {creditedMinutes} {t('partnerGames.creditedMinutesUnit')}
              </span>
            </div>
          </div>
          <p className="text-xs font-black tracking-wide text-amber-50/95 truncate">
            {t('partnerGames.brand')}
          </p>
        </header>

        <div className="relative z-[1] w-full aspect-[16/10] min-h-[280px] max-h-[min(72vh,720px)] bg-black">
          {iframeSrc ? (
            <iframe
              title="BlockMiner"
              src={iframeSrc}
              className="absolute inset-0 h-full w-full border-0 bg-black"
              allow="fullscreen; clipboard-read; clipboard-write; payment"
              referrerPolicy="strict-origin-when-cross-origin"
            />
          ) : null}
        </div>

        <div className="relative z-[1] flex flex-wrap items-center justify-between gap-3 px-3 sm:px-4 py-3 border-t border-amber-900/40 bg-stone-950">
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={handleExit}
              className="inline-flex items-center gap-1.5 rounded-lg border border-stone-600 bg-stone-900/90 px-2.5 py-2 text-[11px] sm:text-xs font-bold text-stone-200 hover:bg-stone-800 transition-colors"
              title={onExit ? t('partnerGames.exitSessionTitle') : t('partnerGames.backToLobby')}
            >
              <LogOut size={16} className="shrink-0 opacity-90" />
              {onExit ? t('partnerGames.exit') : t('partnerGames.backToLobby')}
            </button>
            <button
              type="button"
              onClick={toggleFullscreen}
              className="inline-flex items-center gap-1.5 rounded-lg border border-stone-600 bg-stone-900/90 px-2.5 py-2 text-[11px] sm:text-xs font-bold text-stone-200 hover:bg-stone-800 transition-colors"
              title={fullscreen ? t('partnerGames.exitFullscreen') : t('partnerGames.enterFullscreen')}
            >
              {fullscreen ? <Minimize2 size={16} className="shrink-0" /> : <Maximize2 size={16} className="shrink-0" />}
              {fullscreen ? t('partnerGames.windowed') : t('partnerGames.fullscreen')}
            </button>
            <div className="relative" ref={settingsRef}>
              <button
                type="button"
                onClick={() => setSettingsOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-stone-600 bg-stone-900/90 px-2.5 py-2 text-[11px] sm:text-xs font-bold text-stone-200 hover:bg-stone-800 transition-colors"
                title={t('partnerGames.options')}
                aria-expanded={settingsOpen}
              >
                <Settings size={16} className="shrink-0" />
                {t('partnerGames.options')}
              </button>
              {settingsOpen && (
                <div className="absolute bottom-full left-0 mb-2 z-20 w-[min(92vw,280px)] rounded-xl border border-stone-600 bg-slate-900 p-3 shadow-xl text-xs text-stone-300 space-y-2">
                  <p>{t('partnerGames.settingsHint')}</p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <a
                      href={config.publicUrl}
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
                        stopGame();
                      }}
                      className="rounded-lg border border-stone-600 px-2 py-1.5 font-bold text-stone-300 hover:bg-stone-800"
                    >
                      {t('partnerGames.stopIframe')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        runGame(config.embedPath);
                        setSettingsOpen(false);
                      }}
                      className="rounded-lg border border-stone-600 px-2 py-1.5 font-bold text-stone-300 hover:bg-stone-800"
                    >
                      {t('partnerGames.reload')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <p className="text-center text-[11px] text-stone-500 max-w-xl mx-auto px-2">
        {t('partnerGames.heartbeatNote')} {t('partnerGames.footerNote')}
      </p>
    </div>
  );
};
