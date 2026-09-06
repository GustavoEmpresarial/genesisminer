import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  BarChart as BarChartIcon,
  BarChart2,
  Bell,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Cog,
  Combine,
  Database,
  Gamepad2,
  Gift,
  Layers,
  Layout,
  Map,
  MessageCircle,
  Scale,
  Shield,
  Skull,
  Store,
  Users,
  Wallet,
  Wrench
} from 'lucide-react';
import type { User } from '../../../shared/types/auth';
import {
  getAccessLevels,
  getAdminUserMap,
  getLootBoxes,
  getSeasonPasses,
  getSystemNews,
  getUpgradesCatalog,
  setAccessLevels,
  setLootBoxes,
  setUpgrades
} from '../../../shared/api/admin-legacy';
import type { AccessLevel, LootBox, SystemNews, Upgrade } from '../lib/adminTypes';
import { filterMembershipAccessLevels } from '../lib/membershipAccessLevels';
import { AdminDashboard } from './AdminDashboard';
import { AdminMetrics } from './AdminMetrics';
import { AdminUsers, type AdminUsersJumpTarget } from '../users';
import { AdminEditor } from './AdminEditor';
import { AdminLootBoxes } from './AdminLootBoxes';
import { AdminNews } from './AdminNews';
import { AdminInAppAnnouncements } from './AdminInAppAnnouncements';
import { AdminWeb3Menu } from './AdminWeb3Menu';
import { AdminSettingsPageVisibility } from './AdminSettingsPageVisibility';
import { AdminSettingsNavLabels } from './AdminSettingsNavLabels';
import { AdminRigRooms } from './AdminRigRooms';
import { AdminRigLayoutEditor } from './AdminRigLayoutEditor';
import { AdminBlackMarket } from './AdminBlackMarket';
import { AdminGames } from './AdminGames';
import { AdminBackup } from './AdminBackup';
import { AdminSupport } from './AdminSupport';
import { AdminMonetization } from './AdminMonetization';
import { AdminReports } from './AdminReports';
import { AdminSecurity } from './AdminSecurity';
import { AdminSeasonPasses } from './AdminSeasonPasses';
import { AdminTransparency } from './AdminTransparency';
import { AdminPartnerVideos } from './AdminPartnerVideos';
import { AdminGuide } from './AdminGuide';
import { AdminRoadmap } from './AdminRoadmap';
import { AdminMergeSettings } from './AdminMergeSettings';
import { AdminSiteMaintenance } from './AdminSiteMaintenance';

export type AdminTab =
  | 'dashboard'
  | 'metrics'
  | 'users'
  | 'shops'
  | 'lootboxes'
  | 'web3'
  | 'settings'
  | 'popupAnnouncements'
  | 'reports'
  | 'transparency'
  | 'games'
  | 'security'
  | 'backup'
  | 'support'
  | 'partners';

const ADMIN_URL_TAB_SET = new Set<AdminTab>([
  'dashboard',
  'metrics',
  'users',
  'shops',
  'lootboxes',
  'web3',
  'settings',
  'popupAnnouncements',
  'reports',
  'transparency',
  'games',
  'security',
  'backup',
  'support',
  'partners'
]);

const NAV_ITEMS: Array<{ id: AdminTab; label: string; icon: ReactNode }> = [
  { id: 'dashboard', icon: <Activity size={18} />, label: 'Dashboard' },
  { id: 'metrics', icon: <BarChart2 size={18} />, label: 'Métricas' },
  { id: 'users', icon: <Users size={18} />, label: 'Usuários' },
  { id: 'shops', icon: <Store size={18} />, label: 'Lojas' },
  { id: 'lootboxes', icon: <Gift size={18} />, label: 'Caixas' },
  { id: 'web3', icon: <Wallet size={18} />, label: 'Web3' },
  { id: 'settings', icon: <Cog size={18} />, label: 'Configurações' },
  { id: 'popupAnnouncements', icon: <Bell size={18} />, label: 'Avisos popup' },
  { id: 'reports', icon: <BarChartIcon size={18} />, label: 'Relatórios' },
  { id: 'transparency', icon: <Scale size={18} />, label: 'Transparência' },
  { id: 'games', icon: <Gamepad2 size={18} />, label: 'Games' },
  { id: 'security', icon: <Shield size={18} />, label: 'Segurança' },
  { id: 'backup', icon: <Database size={18} />, label: 'Backup' },
  { id: 'support', icon: <MessageCircle size={18} />, label: 'Suporte' },
  { id: 'partners', icon: <Clapperboard size={18} />, label: 'Parceiros' }
];

function adminPathFromTab(tab: AdminTab): string {
  return `/admin/${tab}`;
}

function adminTabFromPath(pathname: string): AdminTab | null {
  const normalized = String(pathname || '').toLowerCase().replace(/\/+$/, '') || '/';
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts[0] !== 'admin') return null;
  if (parts.length === 1) return 'dashboard';
  const rawTab = parts[1] as AdminTab;
  if (!ADMIN_URL_TAB_SET.has(rawTab)) return 'dashboard';
  return rawTab;
}

type AdminPanelProps = {
  user: User;
};

export function AdminPanel({ user }: AdminPanelProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>(() => {
    const pathTab = typeof window !== 'undefined' ? adminTabFromPath(window.location.pathname) : null;
    if (pathTab) return pathTab;
    try {
      return (localStorage.getItem('adminActiveTab') as AdminTab) || 'dashboard';
    } catch {
      return 'dashboard';
    }
  });

  const [accessLevels, setAccessLevelsState] = useState<AccessLevel[]>([]);
  const [gameUpgrades, setGameUpgrades] = useState<Upgrade[]>([]);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [lootBoxes, setLootBoxesState] = useState<LootBox[]>([]);
  const [newsList, setNewsList] = useState<SystemNews[]>([]);
  const [seasonPasses, setSeasonPasses] = useState<unknown[]>([]);
  const [userMap, setUserMap] = useState<Array<{ id: number; username: string; polygonWallet?: string; email: string }>>([]);
  const [jumpToUser, setJumpToUser] = useState<AdminUsersJumpTarget | null>(null);
  const handleJumpToUserHandled = useCallback(() => {
    setJumpToUser(null);
  }, []);
  const [shopsSubtab, setShopsSubtab] = useState<'hardware' | 'blackmarket' | 'layout'>('hardware');
  const [settingsSubtab, setSettingsSubtab] = useState<
    | 'pages'
    | 'navlabels'
    | 'rigrooms'
    | 'news'
    | 'popupAnnouncements'
    | 'monetization'
    | 'merge'
    | 'passes'
    | 'guide'
    | 'roadmap'
    | 'maintenance'
  >('pages');

  const persistAccessLevels = useCallback(async (levels: AccessLevel[]) => {
    try {
      const membershipOnly = filterMembershipAccessLevels(levels);
      await setAccessLevels(membershipOnly);
      setAccessLevelsState(membershipOnly);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Falha ao gravar níveis.');
    }
  }, []);

  const persistGameUpgrades = useCallback(async (upgrades: Upgrade[]): Promise<boolean> => {
    try {
      const result = await setUpgrades(upgrades, catalogRevision);
      if (!result.ok) {
        if (result.code === 'CATALOG_VERSION_CONFLICT' || result.forceReload) {
          const reload = window.confirm(
            `${result.error}\n\nO catálogo no servidor mudou (ex.: merge criou um SKU novo).\n` +
              `As suas edições locais NÃO serão aplicadas.\n\nRecarregar o catálogo do servidor agora?`
          );
          if (reload) {
            const pack = await getUpgradesCatalog();
            setGameUpgrades(pack.upgrades);
            setCatalogRevision(pack.catalogRevision);
          }
          return false;
        }
        window.alert(result.error);
        return false;
      }
      setGameUpgrades(upgrades);
      setCatalogRevision(result.catalogRevision);
      try {
        const pack = await getUpgradesCatalog();
        setGameUpgrades(pack.upgrades);
        setCatalogRevision(pack.catalogRevision);
      } catch {
        // Save já ok; state local + revision do POST mantêm-se se o reload falhar.
      }
      return true;
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Falha ao gravar upgrades.');
      return false;
    }
  }, [catalogRevision]);

  const persistLootBoxes = useCallback(async (boxes: LootBox[]) => {
    try {
      await setLootBoxes(boxes);
      setLootBoxesState(boxes);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Falha ao gravar caixas.');
    }
  }, []);

  const loadPasses = useCallback(async () => {
    try {
      const list = await getSeasonPasses();
      setSeasonPasses(list || []);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('adminSidebarCollapsed') === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    localStorage.setItem('adminActiveTab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    void (async () => {
      const [levels, catalog, map, boxes] = await Promise.all([
        getAccessLevels(),
        getUpgradesCatalog(),
        getAdminUserMap(),
        getLootBoxes()
      ]);
      if (Array.isArray(levels) && levels.length) {
        setAccessLevelsState(filterMembershipAccessLevels(levels));
      }
      if (Array.isArray(catalog.upgrades)) {
        setGameUpgrades(catalog.upgrades);
        setCatalogRevision(catalog.catalogRevision);
      }
      if (Array.isArray(map)) {
        setUserMap(
          map.map((u) => ({
            id: u.id,
            username: u.username,
            email: u.email,
            polygonWallet: u.polygonWallet ?? undefined
          }))
        );
      }
      if (Array.isArray(boxes)) setLootBoxesState(boxes);
    })();
  }, []);

  useEffect(() => {
    if (activeTab === 'settings' && settingsSubtab === 'passes') void loadPasses();
  }, [activeTab, settingsSubtab, loadPasses]);

  useEffect(() => {
    if (activeTab !== 'settings' && activeTab !== 'popupAnnouncements') return;
    if (activeTab === 'popupAnnouncements' || settingsSubtab === 'news') {
      void getSystemNews().then((news) => {
        if (Array.isArray(news)) setNewsList(news);
      });
    }
  }, [activeTab, settingsSubtab]);

  useEffect(() => {
    if (activeTab !== 'settings' || !user) return;
    const tabAllowed = (tab: string) => {
      if (user.isSuperAdmin) return true;
      if (user.adminPermissions === null || user.adminPermissions === undefined) return true;
      if (!Array.isArray(user.adminPermissions)) return true;
      return user.adminPermissions.includes(tab) || user.adminPermissions.some((p) => p.startsWith(`${tab}:`));
    };
    const subtabs: Array<{ id: typeof settingsSubtab; perm: string }> = [
      { id: 'pages', perm: 'settings:pages' },
      { id: 'navlabels', perm: 'settings:pages' },
      { id: 'rigrooms', perm: 'settings:rigrooms' },
      { id: 'news', perm: 'settings:news' },
      { id: 'popupAnnouncements', perm: 'settings:news' },
      { id: 'monetization', perm: 'settings:monetization' },
      { id: 'merge', perm: 'settings:monetization' },
      { id: 'passes', perm: 'settings:passes' },
      { id: 'guide', perm: 'settings:pages' },
      { id: 'roadmap', perm: 'settings:pages' },
      { id: 'maintenance', perm: 'settings' }
    ];
    const current = subtabs.find((s) => s.id === settingsSubtab);
    if (current && tabAllowed(current.perm)) return;
    const first = subtabs.find((s) => tabAllowed(s.perm));
    if (first && first.id !== settingsSubtab) setSettingsSubtab(first.id);
  }, [activeTab, user, settingsSubtab]);

  useEffect(() => {
    localStorage.setItem('adminSidebarCollapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const next = adminPathFromTab(activeTab);
    const current = (window.location.pathname || '').replace(/\/+$/, '') || '/';
    if (current !== next) {
      window.history.replaceState(null, '', next);
    }
  }, [activeTab]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPopState = () => {
      const tabFromPath = adminTabFromPath(window.location.pathname);
      if (tabFromPath && tabFromPath !== activeTab) setActiveTab(tabFromPath);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [activeTab]);

  const adminTabAllowed = useCallback(
    (tab: AdminTab, perms: string[] | null | undefined): boolean => {
      if (!user) return false;
      if (user.isSuperAdmin) return true;
      if (perms === null || perms === undefined) return true;
      if (!Array.isArray(perms)) return true;
      const mapped = tab === 'popupAnnouncements' ? 'settings:news' : tab;
      if (perms.includes(mapped) || perms.includes(tab)) return true;
      const colon = mapped.indexOf(':');
      if (colon > 0 && perms.includes(mapped.slice(0, colon))) return true;
      if (!mapped.includes(':')) return perms.some((p) => p.startsWith(`${mapped}:`));
      return false;
    },
    [user]
  );

  useEffect(() => {
    if (!user) return;
    if (user.isSuperAdmin) return;
    if (user.adminPermissions === null || user.adminPermissions === undefined) return;
    if (!Array.isArray(user.adminPermissions)) return;
    if (adminTabAllowed(activeTab, user.adminPermissions)) return;
    const allowed = user.adminPermissions;
    if (allowed.length > 0) setActiveTab(allowed[0] as AdminTab);
    else setActiveTab('dashboard');
  }, [user, activeTab, adminTabAllowed]);

  const visibleNav = NAV_ITEMS.filter((item) => {
    if (!user) return false;
    if (user.isSuperAdmin) return true;
    if (user.adminPermissions === null || user.adminPermissions === undefined) return true;
    if (!Array.isArray(user.adminPermissions)) return true;
    if (item.id === 'settings') {
      return (
        user.adminPermissions.includes('settings') ||
        user.adminPermissions.some((p) => p.startsWith('settings:'))
      );
    }
    if (item.id === 'popupAnnouncements') {
      return (
        user.adminPermissions.includes('settings') ||
        user.adminPermissions.includes('settings:news') ||
        user.adminPermissions.some((p) => p.startsWith('settings:'))
      );
    }
    if (item.id === 'metrics') {
      return user.adminPermissions.includes('metrics') || user.adminPermissions.includes('dashboard');
    }
    return user.adminPermissions.includes(item.id);
  });

  const isAllowed = (tab: string) => {
    if (!user) return false;
    if (user.isSuperAdmin) return true;
    if (user.adminPermissions === null || user.adminPermissions === undefined) return true;
    if (!Array.isArray(user.adminPermissions)) return true;
    return user.adminPermissions.includes(tab) || user.adminPermissions.some((p) => p.startsWith(`${tab}:`));
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 bg-slate-900 font-mono text-slate-200">
      <aside
        className={`flex h-full shrink-0 flex-col gap-4 overflow-hidden border-r border-red-900/50 bg-slate-950 p-4 transition-all duration-300 ease-in-out ${
          sidebarCollapsed ? 'w-20' : 'w-72'
        }`}
      >
        <div className="flex shrink-0 items-center justify-between">
          <div
            className={`flex items-center overflow-hidden transition-all duration-300 ${
              sidebarCollapsed ? 'w-full justify-center' : 'w-auto gap-3'
            }`}
          >
            <div className="shrink-0 rounded-lg bg-red-600 p-2 text-white shadow-lg shadow-red-600/20">
              <Shield size={24} />
            </div>
            <div
              className={`whitespace-nowrap transition-all duration-300 ${
                sidebarCollapsed ? 'w-0 opacity-0' : 'ml-3 w-auto opacity-100'
              }`}
            >
              <h1 className="text-xl font-bold tracking-widest text-white">BACKEND ADMIN</h1>
              <p className="text-[10px] uppercase text-red-500">Acesso Restrito • Nível 5</p>
            </div>
          </div>
          {!sidebarCollapsed && (
            <button
              type="button"
              onClick={() => setSidebarCollapsed((v) => !v)}
              className="shrink-0 rounded border border-slate-700 p-2 text-slate-400 hover:border-slate-500 hover:text-white"
            >
              <ChevronLeft size={16} />
            </button>
          )}
        </div>
        {sidebarCollapsed && (
          <button
            type="button"
            onClick={() => setSidebarCollapsed((v) => !v)}
            className="flex w-full shrink-0 justify-center rounded border border-slate-700 p-2 text-slate-400 hover:border-slate-500 hover:text-white"
          >
            <ChevronRight size={16} />
          </button>
        )}
        <nav className="custom-scrollbar min-h-0 flex-1 space-y-2 overflow-x-hidden overflow-y-auto">
          {visibleNav.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`group flex w-full items-center rounded border px-3 py-2.5 text-sm font-bold transition-all duration-200 ${
                activeTab === item.id
                  ? 'border-red-900/50 bg-red-600/10 text-white shadow-[0_0_15px_rgba(220,38,38,0.1)]'
                  : 'border-transparent text-slate-400 hover:bg-slate-800/50 hover:text-white'
              } ${sidebarCollapsed ? 'justify-center' : 'justify-start gap-3'}`}
              title={sidebarCollapsed ? item.label : ''}
            >
              <div
                className={`shrink-0 transition-transform duration-300 ${
                  activeTab === item.id ? 'scale-110' : 'group-hover:scale-110'
                }`}
              >
                {item.icon}
              </div>
              <span
                className={`overflow-hidden whitespace-nowrap transition-all duration-300 ${
                  sidebarCollapsed ? 'invisible w-0 opacity-0' : 'visible w-auto opacity-100'
                }`}
              >
                {item.label}
              </span>
            </button>
          ))}
        </nav>
      </aside>

      <div
        id="main-content"
        className="custom-scrollbar flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto"
      >
        <main className="min-w-0 flex-1">
          <div className="mx-auto min-w-0 max-w-7xl p-4 sm:p-6">
            {activeTab === 'dashboard' && <AdminDashboard />}
            {activeTab === 'metrics' && (isAllowed('metrics') || isAllowed('dashboard')) && <AdminMetrics />}
            {activeTab === 'users' && (
              <AdminUsers
                user={user}
                users={userMap as never}
                accessLevels={accessLevels}
                onUpdateAccessLevels={persistAccessLevels}
                gameUpgrades={gameUpgrades}
                jumpToUser={jumpToUser}
                onJumpToUserHandled={handleJumpToUserHandled}
                requestOpenUserInEditor={(t) => setJumpToUser(t)}
              />
            )}
            {activeTab === 'shops' && isAllowed('shops') && (
              <div className="space-y-6">
                <div className="mb-3 flex items-center gap-2 border-b border-slate-700 pb-3">
                  {isAllowed('shops:hardware') && (
                    <button
                      type="button"
                      onClick={() => setShopsSubtab('hardware')}
                      className={`flex items-center gap-2 rounded border px-4 py-2 text-sm font-bold transition-all ${shopsSubtab === 'hardware' ? 'border-red-600/50 bg-red-600/20 text-white shadow-[0_0_10px_rgba(220,38,38,0.1)]' : 'border-transparent text-slate-400 hover:border-slate-700 hover:text-white'}`}
                    >
                      <Layers size={16} />
                      Mercado de Hardware
                    </button>
                  )}
                  {isAllowed('shops:blackmarket') && (
                    <button
                      type="button"
                      onClick={() => setShopsSubtab('blackmarket')}
                      className={`flex items-center gap-2 rounded border px-4 py-2 text-sm font-bold transition-all ${shopsSubtab === 'blackmarket' ? 'border-red-600/50 bg-red-600/20 text-white shadow-[0_0_10px_rgba(220,38,38,0.1)]' : 'border-transparent text-slate-400 hover:border-slate-700 hover:text-white'}`}
                    >
                      <Skull size={16} />
                      Mercado Negro
                    </button>
                  )}
                  {isAllowed('shops:layout') && (
                    <button
                      type="button"
                      onClick={() => setShopsSubtab('layout')}
                      className={`flex items-center gap-2 rounded border px-4 py-2 text-sm font-bold transition-all ${shopsSubtab === 'layout' ? 'border-red-600/50 bg-red-600/20 text-white shadow-[0_0_10px_rgba(220,38,38,0.1)]' : 'border-transparent text-slate-400 hover:border-slate-700 hover:text-white'}`}
                    >
                      <Layout size={16} />
                      Estruturas
                    </button>
                  )}
                </div>
                {shopsSubtab === 'hardware' && isAllowed('shops:hardware') && (
                  <AdminEditor gameUpgrades={gameUpgrades} onUpdateGameUpgrades={persistGameUpgrades} />
                )}
                {shopsSubtab === 'blackmarket' && isAllowed('shops:blackmarket') && (
                  <AdminBlackMarket gameUpgrades={gameUpgrades} />
                )}
                {shopsSubtab === 'layout' && isAllowed('shops:layout') && (
                  <AdminRigLayoutEditor gameUpgrades={gameUpgrades} onUpdateGameUpgrades={persistGameUpgrades} />
                )}
              </div>
            )}
            {activeTab === 'lootboxes' && isAllowed('lootboxes') && (
              <AdminLootBoxes lootBoxes={lootBoxes} onUpdateLootBoxes={persistLootBoxes} gameUpgrades={gameUpgrades} />
            )}
            {activeTab === 'web3' && isAllowed('web3') && <AdminWeb3Menu currentUser={user} />}
            {activeTab === 'popupAnnouncements' && isAllowed('settings:news') && <AdminInAppAnnouncements />}
            {activeTab === 'settings' && isAllowed('settings') && (
              <div className="space-y-6">
                <div className="mb-3 flex items-center gap-2 border-b border-slate-700 pb-3">
                  {isAllowed('settings:pages') && (
                    <button
                      type="button"
                      onClick={() => setSettingsSubtab('pages')}
                      className={`rounded border px-3 py-2 text-xs font-bold ${settingsSubtab === 'pages' ? 'border-slate-700 bg-slate-800 text-white' : 'border-transparent text-slate-400 hover:border-slate-700 hover:text-white'}`}
                    >
                      Visibilidade de Páginas por Nível
                    </button>
                  )}
                  {isAllowed('settings:pages') && (
                    <button
                      type="button"
                      onClick={() => setSettingsSubtab('navlabels')}
                      className={`rounded border px-3 py-2 text-xs font-bold ${settingsSubtab === 'navlabels' ? 'border-slate-700 bg-slate-800 text-white' : 'border-transparent text-slate-400 hover:border-slate-700 hover:text-white'}`}
                    >
                      Nomes do menu (jogador)
                    </button>
                  )}
                  {isAllowed('settings:rigrooms') && (
                    <button
                      type="button"
                      onClick={() => setSettingsSubtab('rigrooms')}
                      className={`rounded border px-3 py-2 text-xs font-bold ${settingsSubtab === 'rigrooms' ? 'border-slate-700 bg-slate-800 text-white' : 'border-transparent text-slate-400 hover:border-slate-700 hover:text-white'}`}
                    >
                      Gerenciador de salas de Rigs
                    </button>
                  )}
                  {isAllowed('settings:news') && (
                    <button
                      type="button"
                      onClick={() => setSettingsSubtab('news')}
                      className={`rounded border px-3 py-2 text-xs font-bold ${settingsSubtab === 'news' ? 'border-slate-700 bg-slate-800 text-white' : 'border-transparent text-slate-400 hover:border-slate-700 hover:text-white'}`}
                    >
                      Gerenciar News
                    </button>
                  )}
                  {isAllowed('settings:news') && (
                    <button
                      type="button"
                      onClick={() => setSettingsSubtab('popupAnnouncements')}
                      className={`rounded border px-3 py-2 text-xs font-bold ${settingsSubtab === 'popupAnnouncements' ? 'border-slate-700 bg-slate-800 text-white' : 'border-transparent text-slate-400 hover:border-slate-700 hover:text-white'}`}
                    >
                      Avisos popup
                    </button>
                  )}
                  {isAllowed('settings:monetization') && (
                    <button
                      type="button"
                      onClick={() => setSettingsSubtab('monetization')}
                      className={`rounded border px-3 py-2 text-xs font-bold ${settingsSubtab === 'monetization' ? 'border-slate-700 bg-slate-800 text-white' : 'border-transparent text-slate-400 hover:border-slate-700 hover:text-white'}`}
                    >
                      Monetização
                    </button>
                  )}
                  {isAllowed('settings:monetization') && (
                    <button
                      type="button"
                      onClick={() => setSettingsSubtab('merge')}
                      className={`flex items-center gap-1 rounded border px-3 py-2 text-xs font-bold ${settingsSubtab === 'merge' ? 'border-slate-700 bg-slate-800 text-white' : 'border-transparent text-slate-400 hover:border-slate-700 hover:text-white'}`}
                    >
                      <Combine size={14} /> Merge
                    </button>
                  )}
                  {isAllowed('settings:passes') && (
                    <button
                      type="button"
                      onClick={() => setSettingsSubtab('passes')}
                      className={`rounded border px-3 py-2 text-xs font-bold ${settingsSubtab === 'passes' ? 'border-slate-700 bg-slate-800 text-white' : 'border-transparent text-slate-400 hover:border-slate-700 hover:text-white'}`}
                    >
                      Passes de Temporada
                    </button>
                  )}
                  {isAllowed('settings:pages') && (
                    <button
                      type="button"
                      onClick={() => setSettingsSubtab('guide')}
                      className={`flex items-center gap-1 rounded border px-3 py-2 text-xs font-bold ${settingsSubtab === 'guide' ? 'border-slate-700 bg-slate-800 text-white' : 'border-transparent text-slate-400 hover:border-slate-700 hover:text-white'}`}
                    >
                      <BookOpen size={14} /> Genesis Guide
                    </button>
                  )}
                  {isAllowed('settings:pages') && (
                    <button
                      type="button"
                      onClick={() => setSettingsSubtab('roadmap')}
                      className={`flex items-center gap-1 rounded border px-3 py-2 text-xs font-bold ${settingsSubtab === 'roadmap' ? 'border-slate-700 bg-slate-800 text-white' : 'border-transparent text-slate-400 hover:border-slate-700 hover:text-white'}`}
                    >
                      <Map size={14} /> Roadmap
                    </button>
                  )}
                  {isAllowed('settings') && (
                    <button
                      type="button"
                      onClick={() => setSettingsSubtab('maintenance')}
                      className={`flex items-center gap-1 rounded border px-3 py-2 text-xs font-bold ${settingsSubtab === 'maintenance' ? 'border-slate-700 bg-slate-800 text-white' : 'border-transparent text-slate-400 hover:border-slate-700 hover:text-white'}`}
                    >
                      <Wrench size={14} /> Manutenção
                    </button>
                  )}
                </div>
                {settingsSubtab === 'pages' && isAllowed('settings:pages') && (
                  <AdminSettingsPageVisibility accessLevels={accessLevels} onUpdateAccessLevels={persistAccessLevels} />
                )}
                {settingsSubtab === 'navlabels' && isAllowed('settings:pages') && <AdminSettingsNavLabels />}
                {settingsSubtab === 'rigrooms' && isAllowed('settings:rigrooms') && (
                  <AdminRigRooms />
                )}
                {settingsSubtab === 'news' && isAllowed('settings:news') && (
                  <AdminNews
                    newsList={newsList}
                    setNewsList={setNewsList}
                    accessLevels={accessLevels}
                    onUpdateAccessLevels={persistAccessLevels}
                  />
                )}
                {settingsSubtab === 'popupAnnouncements' && isAllowed('settings:news') && <AdminInAppAnnouncements />}
                {settingsSubtab === 'monetization' && isAllowed('settings:monetization') && <AdminMonetization />}
                {settingsSubtab === 'merge' && isAllowed('settings:monetization') && <AdminMergeSettings />}
                {settingsSubtab === 'passes' && isAllowed('settings:passes') && (
                  <AdminSeasonPasses seasonPasses={seasonPasses as never} onUpdatePasses={loadPasses} />
                )}
                {settingsSubtab === 'guide' && isAllowed('settings:pages') && <AdminGuide />}
                {settingsSubtab === 'roadmap' && isAllowed('settings:pages') && <AdminRoadmap />}
                {settingsSubtab === 'maintenance' && isAllowed('settings') && <AdminSiteMaintenance />}
              </div>
            )}
            {activeTab === 'backup' && isAllowed('backup') && <AdminBackup />}
            {activeTab === 'reports' && isAllowed('reports') && (
              <AdminReports users={userMap as never} currentUser={user} />
            )}
            {activeTab === 'transparency' && isAllowed('transparency') && <AdminTransparency />}
            {activeTab === 'games' && isAllowed('games') && <AdminGames gameUpgrades={gameUpgrades} />}
            {activeTab === 'security' && isAllowed('security') && <AdminSecurity />}
            {activeTab === 'support' && isAllowed('support') && (
              <AdminSupport
                canOpenPlayerProfile={isAllowed('users')}
                onOpenPlayerProfile={(p) => {
                  if (!isAllowed('users')) {
                    window.alert(
                      'Para gerir o perfil deste jogador (estoque, carteira, níveis de acesso, etc.) precisa da permissão Utilizadores no painel admin.'
                    );
                    return;
                  }
                  setJumpToUser({
                    key: Date.now(),
                    userId: p.userId,
                    email: p.email,
                    username: p.username
                  });
                  setActiveTab('users');
                }}
              />
            )}
            {activeTab === 'partners' && isAllowed('partners') && <AdminPartnerVideos />}
          </div>
        </main>
      </div>
    </div>
  );
}
