import { ChevronUp, Menu } from 'lucide-react';
import {
  GAME_NAV_SECTION_ORDER,
  getGameNavSectionLabels,
  gameNavTabClass,
  type GameNavItem,
  type GameView
} from '../nav/buildGameNavItems';
import { GAME_NAV_LABEL_KEYS, type GameNavLabelKey } from '../../../shared/constants/gameNavLabels';
import { useT } from '../../../shared/i18n';

type GameSidebarProps = {
  items: GameNavItem[];
  currentView: GameView;
  expanded: boolean;
  onToggleExpanded: () => void;
  onNavigate: (view: GameView) => void;
  /** Em gerência: mostra `checkin` na sidebar apesar de `mobileOnly`. */
  promoteMobileOnlyKeys?: ReadonlySet<string>;
};

function currentLabel(view: GameView, t: (key: string) => string): string {
  if ((GAME_NAV_LABEL_KEYS as readonly string[]).includes(view)) {
    return t(`nav.${view as GameNavLabelKey}`);
  }
  if (view === 'profile') return t('nav.profile');
  if (view === 'management') return t('nav.management');
  if (view === 'merge') return t('nav.merge');
  if (view === 'calculator') return t('nav.calculator');
  if (view === 'dashboard') return t('nav.dashboard');
  return t('nav.menu');
}

function navItemLabel(key: GameView, fallback: string, t: (key: string) => string): string {
  if ((GAME_NAV_LABEL_KEYS as readonly string[]).includes(key)) {
    return t(`nav.${key as GameNavLabelKey}`);
  }
  if (key === 'profile') return t('nav.profile');
  if (key === 'management') return t('nav.management');
  if (key === 'merge') return t('nav.merge');
  if (key === 'calculator') return t('nav.calculator');
  if (key === 'dashboard') return t('nav.dashboard');
  return fallback;
}

export function GameSidebar({
  items,
  currentView,
  expanded,
  onToggleExpanded,
  onNavigate,
  promoteMobileOnlyKeys
}: GameSidebarProps) {
  const t = useT();
  const sectionLabels = getGameNavSectionLabels(t);

  return (
    <aside
      className={`hidden h-full max-h-none shrink-0 flex-col self-stretch overflow-hidden border-r border-slate-800/90 bg-[#121212] transition-[width] duration-300 lg:flex ${
        expanded ? 'w-[300px]' : 'w-[92px]'
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-3">
        {expanded ? (
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-400/90">{t('nav.menu')}</p>
            <p className="truncate text-xs font-semibold text-slate-400">{currentLabel(currentView, t)}</p>
          </div>
        ) : (
          <span className="mx-auto text-[10px] font-black uppercase tracking-[0.2em] text-amber-400/90">{t('nav.navShort')}</span>
        )}
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-label={expanded ? t('shell.collapseSidebar') : t('shell.expandSidebar')}
          title={expanded ? t('shell.collapseSidebar') : t('shell.expandSidebar')}
          className={`shrink-0 rounded-lg border p-2 transition-all ${
            expanded
              ? 'border-amber-400/55 bg-amber-950/45 text-amber-200'
              : 'border-amber-500/65 bg-amber-500/15 text-amber-100 ring-1 ring-amber-400/25'
          }`}
        >
          {expanded ? <ChevronUp size={16} /> : <Menu size={16} />}
        </button>
      </div>
      <div className="custom-scrollbar flex-1 overflow-x-hidden overflow-y-auto p-2">
        <div className="space-y-3">
          {GAME_NAV_SECTION_ORDER.map((section) => {
            const sectionItems = items.filter((item) => {
              if (item.section !== section) return false;
              if (!item.mobileOnly) return true;
              return !!promoteMobileOnlyKeys?.has(item.key);
            });
            if (sectionItems.length === 0) return null;
            return (
              <div key={section} className="space-y-2">
                {expanded ? (
                  <div className="px-2 text-[10px] font-black uppercase tracking-[0.2em] text-amber-400/80">
                    {sectionLabels[section]}
                  </div>
                ) : null}
                <div className="flex flex-col gap-2">
                  {sectionItems.map((item) => {
                    const Icon = item.icon;
                    const label = navItemLabel(item.key, item.label, t);
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => onNavigate(item.key)}
                        className={`${gameNavTabClass(currentView === item.key, item.accent)} w-full justify-start ${
                          expanded ? '' : 'justify-center px-0'
                        }`}
                        title={label}
                      >
                        <Icon size={16} className="shrink-0 opacity-90" />
                        {expanded ? <span className="truncate uppercase">{label}</span> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
