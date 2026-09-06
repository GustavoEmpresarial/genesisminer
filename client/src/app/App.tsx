import { useCallback, useEffect, useState } from 'react';
import { AuthPage } from '../features/auth';
import { HomePage, LandingHeader, MaintenancePage, PublicPagesOutlet } from '../features/landing';
import { AdminShell } from '../features/admin';
import { GameShell } from '../features/game';
import { PublicSupportPage } from '../features/support';
import { PublicFooter, type PublicView } from '../features/shell';
import type { User } from '../shared/types/auth';
import { getSession, logout } from '../shared/api/auth';
import { getSiteStatus } from '../shared/api/site-maintenance';
import { resolveMaintenanceFlag, shouldBlockGameAndLanding } from './siteMaintenanceGate';
import { stopImpersonate } from '../shared/api/admin-legacy';
import { AUTH_REQUIRED_EVENT, isAuthFailureHandling, setSessionHint } from '../shared/api/http';
import {
  ADMIN_AFTER_STOP_IMPERSONATE_PATH,
  adminPathFromLocation,
  classifyLocation,
  pathForAuthMode,
  pathForPublicView,
  pushPath,
  replacePath,
  resolveSessionBoot,
  type AppShellView,
  type AuthMode
} from './pathRouting';

type AppView = AppShellView;

const PUBLIC_CONTENT_VIEWS: ReadonlySet<AppView> = new Set([
  'docs',
  'roadmap',
  'terms',
  'privacy',
  'cookies',
  'aml',
  'web3_risk',
  'refunds',
  'community',
  'public_support'
]);

function bootFromLocation(): { view: AppView; authMode: AuthMode } {
  if (typeof window === 'undefined') return { view: 'home', authMode: 'login' };
  const loc = classifyLocation(window.location.pathname);
  if (loc.kind === 'auth') return { view: 'auth', authMode: loc.mode };
  if (loc.kind === 'public') return { view: loc.view, authMode: 'login' };
  // game/admin/unknown: home até SessionInit (auth gate)
  return { view: 'home', authMode: 'login' };
}

export function App() {
  const boot = bootFromLocation();
  const [view, setView] = useState<AppView>(boot.view);
  const [authMode, setAuthMode] = useState<AuthMode>(boot.authMode);
  const [user, setUser] = useState<User | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [siteMaintenance, setSiteMaintenance] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [sess, status] = await Promise.all([getSession(), getSiteStatus()]);
        if (cancelled) return;
        const path = window.location.pathname || '';
        const maintenanceOn = resolveMaintenanceFlag(sess?.siteMaintenance, status.maintenance);
        setSiteMaintenance(maintenanceOn);

        if (sess) setUser(sess);

        if (shouldBlockGameAndLanding(maintenanceOn, !!sess?.isAdmin)) {
          const loc = classifyLocation(path);
          if (!sess && loc.kind === 'auth') {
            setAuthMode(loc.mode);
            setView('auth');
          } else {
            setView('home');
          }
          return;
        }

        const decision = resolveSessionBoot(path, sess ? { isAdmin: !!sess.isAdmin } : null);

        switch (decision.action) {
          case 'auth':
            setAuthMode(decision.mode);
            if (decision.replacePath) replacePath(decision.replacePath);
            setView('auth');
            break;
          case 'public':
            setView(decision.view);
            break;
          case 'game':
            setView('game');
            if (decision.replacePath) replacePath(decision.replacePath);
            break;
          case 'admin':
            setView('admin');
            replacePath(decision.replacePath);
            break;
          case 'home':
            if (decision.replacePath) replacePath(decision.replacePath);
            setView('home');
            break;
        }
      } catch (e) {
        console.error('[SessionInit]', e);
      } finally {
        if (!cancelled) setSessionReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Central session-expired handler — listens to apiFetch AUTH_REQUIRED_EVENT (once). */
  useEffect(() => {
    const onAuthRequired = () => {
      // Already on login: only clear React user; flash already stashed by http.ts
      const path = window.location.pathname || '';
      const loc = classifyLocation(path);
      setUser(null);
      setSessionHint(false);
      void logout().catch(() => undefined);
      if (loc.kind === 'auth' && loc.mode === 'login') {
        setAuthMode('login');
        setView('auth');
        return;
      }
      setAuthMode('login');
      replacePath(pathForAuthMode('login'));
      setView('auth');
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const path = window.location.pathname || '';
      const loc = classifyLocation(path);

      if (user) {
        if (shouldBlockGameAndLanding(siteMaintenance, !!user.isAdmin)) {
          setView('home');
          return;
        }
        if (user.isAdmin && loc.kind === 'admin') {
          setView('admin');
          return;
        }
        if (loc.kind === 'public') {
          setView(loc.view);
          return;
        }
        if (loc.kind === 'auth' && (loc.mode === 'recovery' || loc.mode === 'register')) {
          setAuthMode(loc.mode);
          setView('auth');
          return;
        }
        // Back para home/login/unknown com sessão → hub
        setView('game');
        return;
      }

      if (loc.kind === 'auth') {
        setAuthMode(loc.mode);
        setView('auth');
        return;
      }
      if (loc.kind === 'public') {
        setView(loc.view);
        return;
      }
      if (loc.kind === 'home') {
        setView('home');
        return;
      }
      // game/admin/unknown sem auth
      if (loc.kind === 'game' || loc.kind === 'admin') {
        setAuthMode('login');
        replacePath('/login');
        setView('auth');
        return;
      }
      setView('home');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [user, siteMaintenance]);

  const goHome = useCallback(() => {
    pushPath('/');
    setView('home');
  }, []);

  const openAuth = useCallback((mode: AuthMode) => {
    setAuthMode(mode);
    pushPath(pathForAuthMode(mode));
    setView('auth');
  }, []);

  const onLandingNavigate = useCallback(
    (next: 'auth' | 'docs', opts?: { mode?: AuthMode }) => {
      if (next === 'auth') {
        openAuth(opts?.mode ?? 'login');
        return;
      }
      pushPath('/docs');
      setView('docs');
    },
    [openAuth]
  );

  const onFooterNavigate = useCallback(
    (next: PublicView) => {
      if (next === 'home') {
        goHome();
        return;
      }
      if (next === 'auth') {
        openAuth('login');
        return;
      }
      const path = pathForPublicView(next);
      if (path) pushPath(path);
      setView(next);
    },
    [goHome, openAuth]
  );

  const enterAdmin = useCallback(() => {
    pushPath(adminPathFromLocation(window.location.pathname || ''));
    setView('admin');
  }, []);

  /** ADMIN no jogo: entra no painel, ou sai da personificação se `isImpersonating`. */
  const onAdmin = useCallback(async () => {
    if (user?.isImpersonating) {
      const res = await stopImpersonate();
      if (!res.ok) {
        alert(res.error);
        return;
      }
      window.location.assign(ADMIN_AFTER_STOP_IMPERSONATE_PATH);
      return;
    }
    enterAdmin();
  }, [user?.isImpersonating, enterAdmin]);

  const enterGame = useCallback(() => {
    if (shouldBlockGameAndLanding(siteMaintenance, !!user?.isAdmin)) return;
    pushPath('/servers');
    setView('game');
  }, [siteMaintenance, user?.isAdmin]);

  const onLogin = useCallback((sessionUser: User) => {
    setUser(sessionUser);
    setSessionHint(true);
    const maintenanceOn = resolveMaintenanceFlag(sessionUser.siteMaintenance, siteMaintenance);
    setSiteMaintenance(maintenanceOn);
    if (shouldBlockGameAndLanding(maintenanceOn, !!sessionUser.isAdmin)) {
      setView('home');
      return;
    }
    if (sessionUser.isAdmin) {
      pushPath('/admin/dashboard');
      setView('admin');
    } else {
      pushPath('/servers');
      setView('game');
    }
    // Login payload may omit feature flags — enrich from GET /api/session (#106).
    void (async () => {
      try {
        const sess = await getSession();
        if (!sess) return;
        setUser(sess);
        // Se o login omitiu isAdmin e a session completa confirma admin → painel.
        setSiteMaintenance(resolveMaintenanceFlag(sess.siteMaintenance, maintenanceOn));
        if (shouldBlockGameAndLanding(resolveMaintenanceFlag(sess.siteMaintenance, maintenanceOn), !!sess.isAdmin)) {
          setView('home');
          return;
        }
        if (sess.isAdmin && !sessionUser.isAdmin) {
          replacePath(adminPathFromLocation(window.location.pathname || ''));
          setView('admin');
        }
      } catch {
        /* keep login user */
      }
    })();
  }, [siteMaintenance]);

  const onLogout = useCallback(async () => {
    try {
      await logout();
    } catch {
      /* ignore */
    }
    setSessionHint(false);
    setUser(null);
    goHome();
  }, [goHome]);

  const onSessionRefresh = useCallback(async (): Promise<boolean> => {
    try {
      const sess = await getSession();
      if (sess) {
        setUser(sess);
        setSessionHint(true);
        setSiteMaintenance(resolveMaintenanceFlag(sess.siteMaintenance, siteMaintenance));
        return true;
      }
      // Fail-closed: JWT/sessão inconsistente após enter/leave gestor.
      // If apiFetch already started session-expired handling, do not reload.
      if (isAuthFailureHandling()) return false;
      window.location.reload();
      return false;
    } catch (e) {
      console.error('[SessionRefresh]', e);
      if (isAuthFailureHandling()) return false;
      window.location.reload();
      return false;
    }
  }, [siteMaintenance]);

  const onUserUpdate = useCallback((partial: { username?: string; polygonWallet?: string | null }) => {
    setUser((prev) => {
      if (!prev) return prev;
      const next: User = { ...prev };
      if (partial.username !== undefined) next.username = partial.username;
      if (partial.polygonWallet === null) {
        delete next.polygonWallet;
      } else if (typeof partial.polygonWallet === 'string') {
        next.polygonWallet = partial.polygonWallet;
      }
      return next;
    });
  }, []);

  const openDocs = useCallback(() => {
    pushPath('/docs');
    setView('docs');
  }, []);

  const openSupport = useCallback(() => {
    pushPath('/support');
    setView('public_support');
  }, []);

  if (!sessionReady) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-slate-50 text-amber-600 dark:bg-[#0f0c08] dark:text-amber-400">
        <p className="font-mono text-sm uppercase tracking-[0.2em]">Loading…</p>
      </div>
    );
  }

  if (shouldBlockGameAndLanding(siteMaintenance, !!user?.isAdmin)) {
    if (view === 'auth' && !user) {
      return (
        <div className="flex min-h-[100dvh] flex-col bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-[#0f0c08] dark:text-slate-100">
          <LandingHeader
            onHome={goHome}
            onDocs={openDocs}
            onSupport={openSupport}
            onLogin={() => openAuth('login')}
          />
          <main id="main-content" className="custom-scrollbar flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
            <AuthPage onLogin={onLogin} initialMode={authMode} accessLevels={[]} />
          </main>
        </div>
      );
    }
    return <MaintenancePage onAdminLogin={() => openAuth('login')} showLogin={!user} />;
  }

  if (view === 'game' && user) {
    return (
      <GameShell
        user={user}
        onLogout={() => void onLogout()}
        onDocs={openDocs}
        onSessionRefresh={onSessionRefresh}
        onUserUpdate={onUserUpdate}
        onAdmin={user.isAdmin || user.isImpersonating ? () => void onAdmin() : undefined}
      />
    );
  }

  if (view === 'admin' && user?.isAdmin) {
    return (
      <AdminShell
        user={user}
        onLogout={() => void onLogout()}
        onOpenGame={enterGame}
        onDocs={openDocs}
      />
    );
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-slate-50 text-slate-900 transition-colors duration-300 dark:bg-[#0f0c08] dark:text-slate-100">
      <LandingHeader
        onHome={goHome}
        onDocs={openDocs}
        onSupport={openSupport}
        onLogin={() => openAuth('login')}
      />

      <main id="main-content" className="custom-scrollbar flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        {view === 'home' && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="min-w-0 flex-1">
              <HomePage onNavigate={onLandingNavigate} />
            </div>
            <PublicFooter onNavigate={onFooterNavigate} />
          </div>
        )}
        {view === 'auth' && (
          <>
            <AuthPage onLogin={onLogin} initialMode={authMode} accessLevels={[]} />
            <PublicFooter onNavigate={onFooterNavigate} />
          </>
        )}
        {view === 'public_support' && (
          <>
            <PublicSupportPage onBackHome={goHome} onGoLogin={() => openAuth('login')} />
            <PublicFooter onNavigate={onFooterNavigate} />
          </>
        )}
        {PUBLIC_CONTENT_VIEWS.has(view) && view !== 'public_support' && (
          <>
            <PublicPagesOutlet view={view as PublicView} />
            <PublicFooter onNavigate={onFooterNavigate} />
          </>
        )}
      </main>
    </div>
  );
}
