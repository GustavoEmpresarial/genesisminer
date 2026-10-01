import React, { useState, useMemo } from 'react';
import {
  ArrowLeft,
  User as UserIcon,
  Shield,
  ShieldAlert,
  Building,
  Package,
  Cpu,
  Coins,
  Gift,
  Wallet,
  History,
  Save,
  Trash2,
  LogIn,
  CalendarCheck,
  Copy,
  Check,
  AlertTriangle,
  Loader2,
  DollarSign,
  Power,
  Sparkles,
  Info,
  CheckCircle2,
  Ban
} from 'lucide-react';
import type { User } from '../../../../shared/types/auth';
import type { Upgrade, LootBox, AccessLevel } from '../../lib/adminTypes';
import { AUTH_USERNAME_MAX } from '../../../../shared/constants/authLimits';
import { formatMinedCoinAmount, formatUsdcAmount } from '../../../../shared/utils/locale-format';
import { pathForGameView } from '../../../../app/pathRouting';
import { apiFetch } from '../../../../shared/api/http';
import {
  impersonateUser,
  grantPremiumCheckin,
  type ReinvestmentHistoryEntry,
  type AdminUserWalletHistoryEntry,
  type AdminUserWalletCurrent
} from '../api';
import {
  resolveStreamerRoomId,
  isActiveRoomId,
  ROOM_INITIAL_ID,
  type AdminRoomOption
} from '../lib/roomCatalog';
import { ASIC_ROOM_ID, EXTRA_ROOM_ID } from '../../../servers/types';
import { UserStockEditor } from './UserStockEditor';
import { AdminUserPurchasesHub } from '../../ui/AdminUserPurchasesHub';
import { AdminUserAuditPanel } from '../../ui/AdminUserAuditPanel';

const ALWAYS_OWNED_ROOM_IDS = [ROOM_INITIAL_ID, ASIC_ROOM_ID, EXTRA_ROOM_ID] as const;

function isAlwaysOwnedRoomId(roomId: string): boolean {
  return (ALWAYS_OWNED_ROOM_IDS as readonly string[]).includes(roomId as any);
}

function selectedUserDbId(u: User | null): number | undefined {
  if (!u) return undefined;
  const raw = (u as { id?: unknown }).id;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export type PlayerDetailTab =
  | 'profile'
  | 'rooms'
  | 'stock'
  | 'racks'
  | 'balances'
  | 'boxes'
  | 'wallets'
  | 'shop'
  | 'logs';

export interface AdminUserDetailViewProps {
  user: User;
  selectedUser: User;
  selectedUserSave: any;
  setSelectedUser: React.Dispatch<React.SetStateAction<User | null>>;
  setSelectedUserSave: React.Dispatch<React.SetStateAction<any>>;
  effectiveUpgrades: Upgrade[];
  roomOptions: AdminRoomOption[];
  editOwnedRoomIds: string[];
  setEditOwnedRoomIds: React.Dispatch<React.SetStateAction<string[]>>;
  userBoxes: any[];
  setUserBoxes: React.Dispatch<React.SetStateAction<any[]>>;
  lootBoxes: LootBox[];
  miningCoins: Array<{ id: string; name: string }>;
  accessLevels: AccessLevel[];
  editProfileForm: {
    username: string;
    email: string;
    password: string;
    wallet: string;
    accessLevelId: string;
    accessLevelIds: string[];
  };
  setEditProfileForm: React.Dispatch<
    React.SetStateAction<{
      username: string;
      email: string;
      password: string;
      wallet: string;
      accessLevelId: string;
      accessLevelIds: string[];
    }>
  >;
  editProfileUsernameError: string | null;
  setEditProfileUsernameError: (err: string | null) => void;
  roomsSaveBusy: boolean;
  streamerRoomBusy: boolean;
  walletHistoryLoading: boolean;
  walletHistoryError: string | null;
  adminWalletCurrent: AdminUserWalletCurrent | null;
  adminWalletHistory: AdminUserWalletHistoryEntry[];
  adminReinvestmentHistory: ReinvestmentHistoryEntry[];
  adminReinvestmentError: string | null;
  onBackToList: () => void;
  onUpdateUserProfile: () => Promise<void>;
  onToggleOwnedRoom: (roomId: string, enable: boolean) => Promise<void>;
  onDeactivateStreamerRoom: () => Promise<void>;
  onToggleBlock: () => Promise<void>;
  onDeleteUser: () => Promise<void>;
  onSaveGameData: () => Promise<void>;
  onUpdateStock: (itemId: string, qty: number) => void;
  onAddItemToStock: (itemId: string, qty: number) => void;
  onRemapRackRoom: (rackId: string, targetRoomId: string) => void;
  onDeleteRack: (rackId: string) => void;
  onUpdateUsdc: (val: number) => void;
  onUpdateCoinBalance: (coinId: string, val: number) => void;
  onRefreshWalletHistory: () => Promise<void>;
  canManageAdminAccounts: boolean;
  actorIsSuperForCreds: boolean;
  countRacksInOwnedRoom: (roomId: string) => number;
}

export function AdminUserDetailView({
  user,
  selectedUser,
  selectedUserSave,
  setSelectedUser: _setSelectedUser,
  setSelectedUserSave,
  effectiveUpgrades,
  roomOptions,
  editOwnedRoomIds,
  setEditOwnedRoomIds: _setEditOwnedRoomIds,
  userBoxes,
  setUserBoxes,
  lootBoxes,
  miningCoins,
  accessLevels,
  editProfileForm,
  setEditProfileForm,
  editProfileUsernameError,
  setEditProfileUsernameError,
  roomsSaveBusy,
  streamerRoomBusy,
  walletHistoryLoading,
  walletHistoryError,
  adminWalletCurrent,
  adminWalletHistory,
  adminReinvestmentHistory,
  adminReinvestmentError,
  onBackToList,
  onUpdateUserProfile,
  onToggleOwnedRoom,
  onDeactivateStreamerRoom,
  onToggleBlock,
  onDeleteUser,
  onSaveGameData,
  onUpdateStock,
  onAddItemToStock,
  onRemapRackRoom,
  onDeleteRack,
  onUpdateUsdc,
  onUpdateCoinBalance,
  onRefreshWalletHistory,
  canManageAdminAccounts,
  actorIsSuperForCreds,
  countRacksInOwnedRoom
}: AdminUserDetailViewProps) {
  const [activeTab, setActiveTab] = useState<PlayerDetailTab>('profile');
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [copiedWallet, setCopiedWallet] = useState(false);
  const [rackRoomFilter, setRackRoomFilter] = useState<string>('all');
  const [isSavingData, setIsSavingData] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  const editingSelectedOther =
    String((selectedUser.email || '').trim().toLowerCase()) !==
    String((user?.email || '').trim().toLowerCase());
  const lockAdminEmail = !!selectedUser.isAdmin && editingSelectedOther && !actorIsSuperForCreds;
  const lockSuperAdminPassword =
    !!selectedUser.isSuperAdmin && editingSelectedOther && !actorIsSuperForCreds;

  const canDelete =
    !selectedUser.isAdmin ||
    canManageAdminAccounts ||
    selectedUserDbId(selectedUser) === selectedUserDbId(user ?? null);

  const placedRacks = (selectedUserSave?.placedRacks || []) as Array<{
    id: string;
    itemId: string;
    roomId?: string;
    isOn?: boolean;
    slots?: string[];
    multiplierSlots?: string[];
    batteryId?: string;
    wiringId?: string;
  }>;

  const totalRacks = placedRacks.length;
  const activeRoomsCount = roomOptions.filter(
    (r) => isAlwaysOwnedRoomId(r.id) || editOwnedRoomIds.includes(r.id)
  ).length;
  const unopenedBoxesCount = userBoxes.reduce(
    (acc, b) => acc + (Number(b.qty ?? b.quantity ?? 1) || 0),
    0
  );
  const inventoryTypesCount = Object.keys(selectedUserSave?.stock || {}).filter(
    (k) => (selectedUserSave?.stock?.[k] ?? 0) > 0
  ).length;

  const copyToClipboard = (text: string, type: 'email' | 'wallet') => {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      if (type === 'email') {
        setCopiedEmail(true);
        setTimeout(() => setCopiedEmail(false), 2000);
      } else {
        setCopiedWallet(true);
        setTimeout(() => setCopiedWallet(false), 2000);
      }
    });
  };

  const handleSaveProfileClick = async () => {
    setIsSavingProfile(true);
    try {
      await onUpdateUserProfile();
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleSaveGameDataClick = async () => {
    setIsSavingData(true);
    try {
      await onSaveGameData();
    } finally {
      setIsSavingData(false);
    }
  };

  const streamerRoomId = resolveStreamerRoomId(roomOptions);

  const filteredRacks = useMemo(() => {
    if (rackRoomFilter === 'all') return placedRacks;
    return placedRacks.filter((r) => {
      const rid = String(r.roomId || '').trim() || ROOM_INITIAL_ID;
      return rid === rackRoomFilter;
    });
  }, [placedRacks, rackRoomFilter]);

  const orphanRacksCount = useMemo(() => {
    return placedRacks.filter((r) => {
      const rid = String(r.roomId || '').trim() || ROOM_INITIAL_ID;
      return !isActiveRoomId(roomOptions, rid);
    }).length;
  }, [placedRacks, roomOptions]);

  const tabsConfig = [
    {
      id: 'profile' as const,
      label: 'Perfil & Acesso',
      icon: UserIcon,
      badge: null
    },
    {
      id: 'rooms' as const,
      label: 'Salas',
      icon: Building,
      badge: `${activeRoomsCount}/${roomOptions.length}`
    },
    {
      id: 'stock' as const,
      label: 'Estoque',
      icon: Package,
      badge: inventoryTypesCount > 0 ? `${inventoryTypesCount} itens` : null
    },
    {
      id: 'racks' as const,
      label: 'Rigs Instalados',
      icon: Cpu,
      badge: totalRacks > 0 ? `${totalRacks}` : null,
      alertBadge: orphanRacksCount > 0 ? `${orphanRacksCount} órfão(s)` : null
    },
    {
      id: 'balances' as const,
      label: 'Saldos & Moedas',
      icon: Coins,
      badge: null
    },
    {
      id: 'boxes' as const,
      label: 'Caixas',
      icon: Gift,
      badge: unopenedBoxesCount > 0 ? `${unopenedBoxesCount}` : null
    },
    {
      id: 'wallets' as const,
      label: 'Carteiras Web3',
      icon: Wallet,
      badge: null
    },
    {
      id: 'shop' as const,
      label: 'Gastos & Compras',
      icon: DollarSign,
      badge: null
    },
    {
      id: 'logs' as const,
      label: 'Atividade & Logs',
      icon: History,
      badge: null
    }
  ];

  const isGameSaveTab =
    activeTab === 'stock' ||
    activeTab === 'racks' ||
    activeTab === 'balances' ||
    activeTab === 'boxes';

  return (
    <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-right-4 pb-12">
      {/* Top Bar: Back button */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBackToList}
          className="group inline-flex items-center gap-2 rounded-lg bg-slate-800/80 px-3.5 py-2 text-sm font-semibold text-slate-300 transition-all hover:bg-amber-600 hover:text-white border border-slate-700/60 shadow-sm"
        >
          <ArrowLeft size={16} className="transition-transform group-hover:-translate-x-1" />
          Voltar para Lista de Jogadores
        </button>

        <div className="flex items-center gap-2">
          {isGameSaveTab && (
            <button
              type="button"
              onClick={handleSaveGameDataClick}
              disabled={isSavingData}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-2 text-xs font-black uppercase tracking-wide text-white shadow-lg shadow-emerald-950/40 transition-all hover:brightness-110 active:scale-95 disabled:opacity-50"
            >
              {isSavingData ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Save size={14} />
              )}
              {isSavingData ? 'Salvando Dados...' : 'Salvar Dados do Jogo'}
            </button>
          )}

          {activeTab === 'profile' && (
            <button
              type="button"
              onClick={handleSaveProfileClick}
              disabled={isSavingProfile || roomsSaveBusy}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-600 to-orange-600 px-4 py-2 text-xs font-black uppercase tracking-wide text-white shadow-lg shadow-amber-950/40 transition-all hover:brightness-110 active:scale-95 disabled:opacity-50"
            >
              {isSavingProfile ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Save size={14} />
              )}
              {isSavingProfile ? 'Salvando Perfil...' : 'Salvar Perfil'}
            </button>
          )}
        </div>
      </div>

      {/* Hero Banner: Player Overview Card */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-700/80 bg-gradient-to-br from-slate-900/95 via-slate-800/90 to-slate-900/95 p-5 shadow-xl shadow-black/25 backdrop-blur-md">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          {/* Identity & Metadata */}
          <div className="flex items-start gap-4">
            {/* Avatar Circle */}
            <div
              className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-2xl font-black shadow-inner ring-2 ${
                selectedUser.isSuperAdmin
                  ? 'bg-purple-950/80 text-purple-300 ring-purple-500/50 shadow-purple-900/30'
                  : selectedUser.isAdmin
                  ? 'bg-amber-950/80 text-amber-300 ring-amber-500/50 shadow-amber-900/30'
                  : 'bg-emerald-950/80 text-emerald-300 ring-emerald-500/50 shadow-emerald-900/30'
              }`}
            >
              {selectedUser.username ? selectedUser.username.substring(0, 2).toUpperCase() : 'U'}
            </div>

            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="truncate text-2xl font-black tracking-tight text-white">
                  {selectedUser.username}
                </h2>

                {/* Status Badges */}
                {selectedUser.isBlocked ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-red-950/80 px-2.5 py-0.5 text-[11px] font-bold text-red-400 border border-red-800/60 shadow-sm">
                    <Ban size={12} /> Bloqueado
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-950/80 px-2.5 py-0.5 text-[11px] font-bold text-emerald-400 border border-emerald-800/60 shadow-sm">
                    <CheckCircle2 size={12} /> Ativo
                  </span>
                )}

                {selectedUser.isSuperAdmin ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-purple-950/80 px-2.5 py-0.5 text-[11px] font-bold text-purple-300 border border-purple-800/60 shadow-sm">
                    <ShieldAlert size={12} /> Super Admin
                  </span>
                ) : selectedUser.isAdmin ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-950/80 px-2.5 py-0.5 text-[11px] font-bold text-amber-300 border border-amber-800/60 shadow-sm">
                    <Shield size={12} /> Administrador
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2.5 py-0.5 text-[11px] font-semibold text-slate-400 border border-slate-700 shadow-sm">
                    Jogador
                  </span>
                )}

                {editProfileForm.accessLevelId && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-sky-950/70 px-2.5 py-0.5 text-[11px] font-bold text-sky-300 border border-sky-800/60">
                    <Sparkles size={11} />
                    {accessLevels.find((l) => l.id === editProfileForm.accessLevelId)?.name ||
                      editProfileForm.accessLevelId}
                  </span>
                )}
              </div>

              {/* Sub-row: ID, Email, Wallet */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                {selectedUser.id && (
                  <span className="font-mono text-slate-500">ID #{selectedUser.id}</span>
                )}

                <div className="inline-flex items-center gap-1.5">
                  <span className="text-slate-300">{selectedUser.email}</span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(selectedUser.email, 'email')}
                    className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
                    title="Copiar email"
                  >
                    {copiedEmail ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                  </button>
                </div>

                <div className="inline-flex items-center gap-1.5 font-mono text-[11px]">
                  {selectedUser.polygonWallet ? (
                    <>
                      <span className="text-amber-400/90">
                        {selectedUser.polygonWallet.substring(0, 8)}...
                        {selectedUser.polygonWallet.substring(selectedUser.polygonWallet.length - 6)}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(selectedUser.polygonWallet || '', 'wallet')}
                        className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
                        title="Copiar carteira completa"
                      >
                        {copiedWallet ? (
                          <Check size={12} className="text-emerald-400" />
                        ) : (
                          <Copy size={12} />
                        )}
                      </button>
                    </>
                  ) : (
                    <span className="text-slate-600 italic">Sem carteira vinculada</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Quick Administrative Actions */}
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3 lg:border-t-0 lg:pt-0">
            {!selectedUser.isAdmin && (
              <button
                type="button"
                onClick={async () => {
                  if (
                    window.confirm(
                      `Deseja acessar a conta de ${selectedUser.username}? Você será redirecionado para o jogo.`
                    )
                  ) {
                    const res = await impersonateUser(selectedUser.email);
                    if (res.ok) {
                      window.location.assign(pathForGameView('servers'));
                    } else {
                      alert(res.error || 'Falha ao acessar conta');
                    }
                  }
                }}
                className="inline-flex items-center gap-1.5 rounded-xl bg-orange-700/80 hover:bg-orange-600 px-3 py-2 text-xs font-bold text-white transition-colors shadow-sm"
                title="Acessar Conta do Jogador"
              >
                <LogIn size={13} /> Acessar Conta
              </button>
            )}

            <button
              type="button"
              onClick={async () => {
                if (
                  !window.confirm(
                    `Conceder check-in premium de 7 dias a ${selectedUser.username}? Desbloqueia e ativa a janela de recompensas imediatamente.`
                  )
                ) {
                  return;
                }
                const uid = selectedUserDbId(selectedUser);
                if (!uid) {
                  alert('User id inválido.');
                  return;
                }
                const res = await grantPremiumCheckin(uid);
                if (res.ok) {
                  const days = res.intervalDays ?? 7;
                  alert(`Check-in premium concedido com sucesso! Ativo por ~${days} dias.`);
                } else {
                  alert(res.error || 'Falha ao conceder check-in premium');
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-xl bg-sky-700/80 hover:bg-sky-600 px-3 py-2 text-xs font-bold text-white transition-colors shadow-sm"
              title="Conceder check-in premium"
            >
              <CalendarCheck size={13} /> Check-in 7D
            </button>

            <button
              type="button"
              onClick={onToggleBlock}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold text-white transition-colors shadow-sm ${
                selectedUser.isBlocked
                  ? 'bg-emerald-700 hover:bg-emerald-600'
                  : 'bg-amber-700/80 hover:bg-amber-600'
              }`}
            >
              {selectedUser.isBlocked ? (
                <>
                  <CheckCircle2 size={13} /> Desbloquear
                </>
              ) : (
                <>
                  <Ban size={13} /> Bloquear
                </>
              )}
            </button>

            {canDelete && (
              <button
                type="button"
                onClick={onDeleteUser}
                className="inline-flex items-center gap-1.5 rounded-xl border border-red-800/60 bg-red-950/60 px-3 py-2 text-xs font-bold text-red-300 hover:bg-red-700 hover:text-white transition-colors shadow-sm"
                title="Excluir Usuário permanentemente"
              >
                <Trash2 size={13} /> Excluir
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Standardized Tab Strip */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 overflow-x-auto rounded-2xl border border-slate-700/70 bg-slate-900/80 p-1.5 shadow-md [-ms-overflow-style:none] [scrollbar-width:thin]">
          {tabsConfig.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`group flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-bold transition-all ${
                  isActive
                    ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-stone-950 shadow-md shadow-amber-500/20'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                }`}
              >
                <Icon size={14} className={isActive ? 'text-stone-950' : 'text-slate-400 group-hover:text-amber-400'} />
                <span>{tab.label}</span>
                {tab.badge && (
                  <span
                    className={`rounded-full px-1.5 py-0.2 text-[10px] font-black ${
                      isActive
                        ? 'bg-stone-950/30 text-stone-950'
                        : 'bg-slate-800 text-slate-400 border border-slate-700'
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
                {tab.alertBadge && (
                  <span className="rounded-full bg-red-900/80 text-red-200 px-1.5 py-0.2 text-[10px] font-black animate-pulse">
                    {tab.alertBadge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Informative Sub-banner for Read-only / Auto-save states */}
        {activeTab === 'rooms' && (
          <div className="flex items-center justify-between rounded-xl border border-emerald-800/40 bg-emerald-950/25 px-4 py-2 text-xs text-emerald-300">
            <span className="flex items-center gap-2">
              <Info size={14} className="shrink-0 text-emerald-400" />
              Cada alteração de sala grava instantaneamente no servidor. Desmarcar devolve os rigs ao estoque.
            </span>
            {roomsSaveBusy && (
              <span className="flex items-center gap-1.5 font-bold text-amber-300 animate-pulse">
                <Loader2 size={13} className="animate-spin" /> Gravando alterações...
              </span>
            )}
          </div>
        )}

        {(activeTab === 'wallets' || activeTab === 'shop' || activeTab === 'logs') && (
          <div className="flex items-center gap-2 rounded-xl border border-slate-700/60 bg-slate-800/50 px-4 py-2 text-xs text-slate-400">
            <Info size={14} className="text-amber-400" />
            <span>
              Aba em <strong>Modo Histórico (Somente Leitura)</strong>. As consultas refletem eventos e registros gravados no banco de dados.
            </span>
          </div>
        )}
      </div>

      {/* TAB CONTENT AREA */}
      <div className="min-h-[500px]">
        {/* TAB 1: PERFIL & ACESSO */}
        {activeTab === 'profile' && (
          <div className="rounded-2xl border border-slate-700/80 bg-slate-800/90 p-6 shadow-xl space-y-6">
            <div className="flex items-center justify-between border-b border-slate-700/80 pb-4">
              <div>
                <h3 className="text-base font-black uppercase tracking-wide text-white flex items-center gap-2">
                  <UserIcon size={18} className="text-amber-500" /> Dados Cadastrais & Credenciais
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Atualize nome de usuário, email, senha e vínculo de carteira Polygon.
                </p>
              </div>

              <button
                type="button"
                onClick={handleSaveProfileClick}
                disabled={isSavingProfile || roomsSaveBusy}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-600 to-orange-600 px-4 py-2 text-xs font-black uppercase text-white shadow-md shadow-amber-950/40 hover:brightness-110 active:scale-95 disabled:opacity-50"
              >
                {isSavingProfile ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {isSavingProfile ? 'Gravando...' : 'Salvar Perfil'}
              </button>
            </div>

            {(lockAdminEmail || lockSuperAdminPassword) && (
              <div className="rounded-xl border border-amber-800/60 bg-amber-950/30 p-3.5 text-xs text-amber-200 space-y-1">
                {lockAdminEmail && (
                  <p>
                    ⚠️ <strong>Restrição de Email:</strong> Apenas um <strong>super administrador</strong> pode alterar o email de outro admin.
                  </p>
                )}
                {lockSuperAdminPassword && (
                  <p>
                    ⚠️ <strong>Restrição de Senha:</strong> Apenas super administradores podem alterar a senha de contas com perfil super administrador.
                  </p>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Coluna 1: Username & Email */}
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-400 block mb-1.5">
                    Nome de Usuário (Username)
                  </label>
                  <input
                    type="text"
                    maxLength={AUTH_USERNAME_MAX}
                    value={editProfileForm.username}
                    onChange={(e) => {
                      setEditProfileUsernameError(null);
                      setEditProfileForm({ ...editProfileForm, username: e.target.value });
                    }}
                    className={`w-full rounded-xl border bg-slate-900 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 ${
                      editProfileUsernameError
                        ? 'border-red-500/80 focus:ring-red-500/50'
                        : 'border-slate-700 focus:ring-amber-500/50'
                    }`}
                  />
                  {editProfileUsernameError && (
                    <p className="mt-1.5 text-xs text-red-400" role="alert">
                      {editProfileUsernameError}
                    </p>
                  )}
                </div>

                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-400 block mb-1.5">
                    Endereço de Email
                  </label>
                  <input
                    type="email"
                    readOnly={lockAdminEmail}
                    value={editProfileForm.email}
                    onChange={(e) =>
                      setEditProfileForm({ ...editProfileForm, email: e.target.value })
                    }
                    className={`w-full rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50 ${
                      lockAdminEmail ? 'opacity-60 cursor-not-allowed' : ''
                    }`}
                  />
                  {lockAdminEmail && (
                    <p className="mt-1 text-[11px] text-slate-500">Bloqueado para administradores normais.</p>
                  )}
                </div>

                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-400 block mb-1.5">
                    Nível de Acesso (Plano / Membership)
                  </label>
                  <select
                    value={editProfileForm.accessLevelId || ''}
                    onChange={(e) =>
                      setEditProfileForm({ ...editProfileForm, accessLevelId: e.target.value })
                    }
                    className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                  >
                    <option value="">Nenhum / Padrão</option>
                    {accessLevels.map((lvl) => (
                      <option key={lvl.id} value={lvl.id}>
                        {lvl.name} ({lvl.id})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Coluna 2: Senha & Carteira Polygon */}
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-400 block mb-1.5">
                    Nova Senha (deixe em branco para manter a atual)
                  </label>
                  <input
                    type="password"
                    autoComplete="new-password"
                    readOnly={lockSuperAdminPassword}
                    value={editProfileForm.password}
                    onChange={(e) =>
                      setEditProfileForm({ ...editProfileForm, password: e.target.value })
                    }
                    placeholder={lockSuperAdminPassword ? '—' : 'Digite a nova senha...'}
                    className={`w-full rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-sm text-white font-mono placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50 ${
                      lockSuperAdminPassword ? 'opacity-60 cursor-not-allowed' : ''
                    }`}
                  />
                </div>

                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-400 block mb-1.5">
                    Carteira Polygon
                  </label>
                  <input
                    type="text"
                    value={editProfileForm.wallet}
                    onChange={(e) =>
                      setEditProfileForm({ ...editProfileForm, wallet: e.target.value })
                    }
                    placeholder="0x..."
                    className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-sm text-white font-mono placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                  />
                </div>

                <div className="rounded-xl border border-slate-700/60 bg-slate-900/40 p-3.5">
                  <div className="text-xs font-semibold text-slate-300 mb-1">
                    Permissões Administrativas
                  </div>
                  <p className="text-[11px] text-slate-500">
                    O gerenciamento de privilégios de administrador ou super administrador é feito na sub-aba <strong>Staff Admin</strong> na tela de listagem de usuários.
                  </p>
                </div>
              </div>
            </div>

            <div className="border-t border-slate-700/80 pt-4 flex justify-end">
              <button
                type="button"
                onClick={handleSaveProfileClick}
                disabled={isSavingProfile || roomsSaveBusy}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-600 to-orange-600 px-6 py-2.5 text-sm font-bold text-white shadow-lg shadow-amber-950/40 hover:brightness-110 active:scale-95 disabled:opacity-50"
              >
                {isSavingProfile ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                {isSavingProfile ? 'Salvando...' : 'Salvar Alterações de Perfil'}
              </button>
            </div>
          </div>
        )}

        {/* TAB 2: SALAS DO JOGADOR */}
        {activeTab === 'rooms' && (
          <div className="space-y-6">
            <div className="rounded-2xl border border-slate-700/80 bg-slate-800/90 p-6 shadow-xl">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-700/80 pb-4 mb-5">
                <div>
                  <h3 className="text-base font-black uppercase tracking-wide text-white flex items-center gap-2">
                    <Building size={18} className="text-emerald-500" /> Salas Ativas do Jogador
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Habilite ou desabilite salas para este usuário. Salas obrigatórias (Inicial, ASICs e Extra) permanecem sempre ativas.
                  </p>
                </div>

                <span className="rounded-full bg-slate-900 px-3 py-1 text-xs font-bold text-slate-300 border border-slate-700">
                  {activeRoomsCount} de {roomOptions.length} ativas
                </span>
              </div>

              {/* Grid of Room Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
                {roomOptions.map((room) => {
                  const isAlwaysOwned = isAlwaysOwnedRoomId(room.id);
                  const on = isAlwaysOwned || editOwnedRoomIds.includes(room.id);
                  const rackN = countRacksInOwnedRoom(room.id);

                  return (
                    <div
                      key={room.id}
                      className={`relative flex flex-col justify-between rounded-xl border p-4 transition-all ${
                        on
                          ? 'border-emerald-500/60 bg-emerald-950/20 shadow-md shadow-emerald-950/30'
                          : 'border-slate-700/70 bg-slate-900/60 opacity-75'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <span className="text-sm font-bold text-white block">{room.name}</span>
                          <span className="text-[10px] text-slate-500 font-mono block mt-0.5">
                            {room.id}
                          </span>
                        </div>

                        {isAlwaysOwned ? (
                          <span className="rounded-md bg-slate-800 px-2 py-0.5 text-[9px] font-bold text-slate-400 border border-slate-700">
                            Sempre Ativa
                          </span>
                        ) : (
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={isAlwaysOwned || roomsSaveBusy}
                              onChange={(e) => onToggleOwnedRoom(room.id, e.target.checked)}
                              className="sr-only peer"
                            />
                            <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
                          </label>
                        )}
                      </div>

                      <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs">
                        <span className="text-slate-400">Rigs instalados:</span>
                        <span
                          className={`font-mono font-bold px-2 py-0.5 rounded text-[11px] ${
                            rackN > 0
                              ? 'bg-amber-950/80 text-amber-300 border border-amber-800/60'
                              : 'text-slate-500'
                          }`}
                        >
                          {rackN} rig(s)
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {roomOptions.length === 0 && (
                <div className="py-8 text-center text-sm text-slate-500">
                  Nenhuma sala cadastrada no catálogo.
                </div>
              )}
            </div>

            {/* Streamer Room Deactivation Box */}
            {streamerRoomId && (
              <div className="rounded-2xl border border-red-900/40 bg-red-950/20 p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <h4 className="text-sm font-bold text-red-300 flex items-center gap-2">
                    <Trash2 size={16} /> Desativar Sala Streamer
                  </h4>
                  <p className="text-xs text-slate-400 mt-1 max-w-2xl">
                    Remove o acesso à Sala Streamer para este usuário e envia todos os equipamentos e rigs instalados nela de volta ao estoque.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={onDeactivateStreamerRoom}
                  disabled={streamerRoomBusy || !selectedUserSave}
                  className="shrink-0 inline-flex items-center gap-2 rounded-xl bg-red-700 hover:bg-red-600 disabled:opacity-50 px-4 py-2.5 text-xs font-bold text-white shadow-md transition-all active:scale-95"
                >
                  {streamerRoomBusy ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Trash2 size={14} />
                  )}
                  {streamerRoomBusy ? 'Desativando Sala...' : 'Desativar Sala Streamer'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* TAB 3: ESTOQUE / INVENTÁRIO */}
        {activeTab === 'stock' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-2xl border border-slate-700/80 bg-slate-800/90 px-6 py-4 shadow-xl">
              <div>
                <h3 className="text-base font-black uppercase tracking-wide text-white flex items-center gap-2">
                  <Package size={18} className="text-amber-500" /> Estoque & Concessão de Itens
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Pesquise itens do catálogo e conceda ao jogador, ou ajuste quantidades do estoque atual.
                </p>
              </div>

              <button
                type="button"
                onClick={handleSaveGameDataClick}
                disabled={isSavingData}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-2 text-xs font-black uppercase text-white shadow-md shadow-emerald-950/40 hover:brightness-110 active:scale-95 disabled:opacity-50"
              >
                {isSavingData ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {isSavingData ? 'Salvando...' : 'Salvar Dados do Jogo'}
              </button>
            </div>

            <UserStockEditor
              stock={selectedUserSave?.stock}
              gameUpgrades={effectiveUpgrades}
              onUpdateQty={onUpdateStock}
              onAddItem={onAddItemToStock}
            />
          </div>
        )}

        {/* TAB 4: RIGS INSTALADOS */}
        {activeTab === 'racks' && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-2xl border border-slate-700/80 bg-slate-800/90 px-6 py-4 shadow-xl">
              <div>
                <h3 className="text-base font-black uppercase tracking-wide text-white flex items-center gap-2">
                  <Cpu size={18} className="text-amber-500" /> Rigs Instalados ({totalRacks})
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Gerencie chassi, componentes, slots de mineração e remapeamento de salas.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <label className="text-xs font-semibold text-slate-400">Filtrar por Sala:</label>
                  <select
                    value={rackRoomFilter}
                    onChange={(e) => setRackRoomFilter(e.target.value)}
                    className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                  >
                    <option value="all">Todas as Salas ({totalRacks})</option>
                    {roomOptions.map((room) => {
                      const count = countRacksInOwnedRoom(room.id);
                      return (
                        <option key={room.id} value={room.id}>
                          {room.name} ({count})
                        </option>
                      );
                    })}
                  </select>
                </div>

                <button
                  type="button"
                  onClick={handleSaveGameDataClick}
                  disabled={isSavingData}
                  className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-2 text-xs font-black uppercase text-white shadow-md shadow-emerald-950/40 hover:brightness-110 active:scale-95 disabled:opacity-50"
                >
                  {isSavingData ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  {isSavingData ? 'Salvando...' : 'Salvar Rigs'}
                </button>
              </div>
            </div>

            {orphanRacksCount > 0 && (
              <div className="rounded-xl border border-red-700/80 bg-red-950/30 p-3.5 text-xs text-red-300 flex items-center gap-2.5">
                <AlertTriangle size={16} className="shrink-0 text-red-400" />
                <span>
                  Existem <strong>{orphanRacksCount} rig(s)</strong> alocados em salas inválidas ou desativadas. O jogo exige que todos os rigs estejam em salas ativas antes de salvar.
                </span>
              </div>
            )}

            {/* Grid of Installed Rigs */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredRacks.map((rack) => {
                const rackDef = effectiveUpgrades.find((u) => u.id === rack.itemId);
                const rid = String(rack.roomId || '').trim() || ROOM_INITIAL_ID;
                const roomOk = isActiveRoomId(roomOptions, rid);

                return (
                  <div
                    key={rack.id}
                    className={`rounded-2xl border p-4 shadow-lg transition-all ${
                      roomOk
                        ? 'border-slate-700/80 bg-slate-900/80'
                        : 'border-red-600/80 bg-red-950/20 shadow-red-950/30'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-800 text-2xl border border-slate-700">
                          {rackDef?.icon || '🗄️'}
                        </div>
                        <div>
                          <h4 className="text-sm font-black text-white">
                            {rackDef?.name || 'Rig Desconhecido'}
                          </h4>
                          <div className="flex items-center gap-2 mt-1">
                            <span
                              className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-bold ${
                                rack.isOn
                                  ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800/60'
                                  : 'bg-slate-800 text-slate-500 border border-slate-700'
                              }`}
                            >
                              <Power size={10} /> {rack.isOn ? 'LIGADO' : 'DESLIGADO'}
                            </span>
                            <span className="text-[10px] text-slate-500 font-mono">
                              ID: {rack.id.substring(0, 10)}...
                            </span>
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => onDeleteRack(rack.id)}
                        className="rounded-xl border border-red-800/50 bg-red-950/40 p-2 text-red-400 hover:bg-red-700 hover:text-white transition-colors"
                        title="Desmontar Rig (devolver ao estoque)"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    {/* Room Mapping Selector */}
                    <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-slate-950/60 p-2.5 border border-slate-800">
                      <span className="text-xs font-semibold text-slate-400">Sala do Rig:</span>
                      <div className="flex items-center gap-2">
                        <select
                          value={roomOk ? rid : ''}
                          onChange={(e) => onRemapRackRoom(rack.id, e.target.value)}
                          className={`rounded-lg border px-2.5 py-1 text-xs text-white focus:outline-none ${
                            roomOk
                              ? 'border-slate-700 bg-slate-900'
                              : 'border-red-500 bg-red-950 text-red-200'
                          }`}
                        >
                          {!roomOk && <option value="">Inválida ({rid})</option>}
                          {roomOptions.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                        {!roomOk && (
                          <span className="text-[10px] font-bold text-red-400">Remapear!</span>
                        )}
                      </div>
                    </div>

                    {/* Slots Breakdown */}
                    <div className="mt-3 space-y-1.5 text-[11px] text-slate-400 bg-slate-950/30 p-2.5 rounded-xl border border-slate-800/60">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Slots Mineração:</span>
                        <span className="text-slate-300 font-medium truncate max-w-[200px]">
                          {(rack.slots || []).filter(Boolean).length > 0
                            ? (rack.slots || [])
                                .filter(Boolean)
                                .map((s) => effectiveUpgrades.find((u) => u.id === s)?.name || s)
                                .join(', ')
                            : 'Vazio'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Multiplicadores:</span>
                        <span className="text-slate-300 font-medium truncate max-w-[200px]">
                          {(rack.multiplierSlots || []).filter(Boolean).length > 0
                            ? (rack.multiplierSlots || [])
                                .filter(Boolean)
                                .map((s) => effectiveUpgrades.find((u) => u.id === s)?.name || s)
                                .join(', ')
                            : 'Vazio'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Bateria:</span>
                        <span className="text-slate-300 font-medium">
                          {rack.batteryId
                            ? effectiveUpgrades.find((u) => u.id === rack.batteryId)?.name ||
                              rack.batteryId
                            : 'Padrão'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Fiação:</span>
                        <span className="text-slate-300 font-medium">
                          {rack.wiringId
                            ? effectiveUpgrades.find((u) => u.id === rack.wiringId)?.name ||
                              rack.wiringId
                            : 'Padrão'}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {filteredRacks.length === 0 && (
              <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-12 text-center text-slate-500">
                Nenhum rig encontrado nesta sala.
              </div>
            )}
          </div>
        )}

        {/* TAB 5: SALDOS & ECONOMIA */}
        {activeTab === 'balances' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between rounded-2xl border border-slate-700/80 bg-slate-800/90 px-6 py-4 shadow-xl">
              <div>
                <h3 className="text-base font-black uppercase tracking-wide text-white flex items-center gap-2">
                  <Coins size={18} className="text-amber-500" /> Saldos em Carteira do Jogo
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Ajuste diretamente os valores de USDC e de criptomoedas mineradas pelo jogador.
                </p>
              </div>

              <button
                type="button"
                onClick={handleSaveGameDataClick}
                disabled={isSavingData}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-2 text-xs font-black uppercase text-white shadow-md shadow-emerald-950/40 hover:brightness-110 active:scale-95 disabled:opacity-50"
              >
                {isSavingData ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {isSavingData ? 'Salvando...' : 'Salvar Saldos'}
              </button>
            </div>

            {/* USDC Hero Card */}
            <div className="rounded-2xl border border-slate-700 bg-slate-900/90 p-6 shadow-xl">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-950 text-emerald-400 border border-emerald-800/60 text-2xl shadow-inner">
                    <DollarSign size={28} />
                  </div>
                  <div>
                    <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
                      Saldo Principal
                    </div>
                    <div className="text-xl font-black text-white">USDC (Dólar Digital)</div>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-400">Valor Atual:</span>
                  <input
                    type="number"
                    step="0.01"
                    value={selectedUserSave?.usdc ?? 0}
                    onChange={(e) => onUpdateUsdc(parseFloat(e.target.value))}
                    className="w-36 rounded-xl border border-slate-600 bg-slate-800 p-2.5 text-right text-base font-bold text-white font-mono focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                  />
                </div>
              </div>
            </div>

            {/* Mining Coins Grid */}
            <div className="rounded-2xl border border-slate-700/80 bg-slate-800/90 p-6 shadow-xl">
              <h4 className="text-sm font-bold uppercase tracking-wide text-slate-300 mb-4 flex items-center gap-2">
                <Coins size={16} className="text-amber-400" /> Criptomoedas Mineradas
              </h4>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {miningCoins.map((coin) => {
                  const val = (selectedUserSave?.coinBalances || {})[coin.id] || 0;
                  return (
                    <div
                      key={coin.id}
                      className="rounded-xl border border-slate-700 bg-slate-900/80 p-4 flex items-center justify-between gap-3 shadow-md"
                    >
                      <div>
                        <div className="text-sm font-bold text-white">{coin.name}</div>
                        <div className="text-[10px] text-slate-500 font-mono">{coin.id}</div>
                      </div>

                      <input
                        type="number"
                        step="any"
                        value={val}
                        onChange={(e) => onUpdateCoinBalance(coin.id, parseFloat(e.target.value))}
                        className="w-28 rounded-lg border border-slate-600 bg-slate-800 px-2.5 py-1.5 text-right text-xs font-bold text-white font-mono focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                      />
                    </div>
                  );
                })}
              </div>

              {miningCoins.length === 0 && (
                <div className="py-6 text-center text-sm text-slate-500">
                  Nenhuma moeda de mineração configurada.
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 6: CAIXAS DE RECOMPENSA */}
        {activeTab === 'boxes' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-2xl border border-slate-700/80 bg-slate-800/90 px-6 py-4 shadow-xl">
              <div>
                <h3 className="text-base font-black uppercase tracking-wide text-white flex items-center gap-2">
                  <Gift size={18} className="text-amber-500" /> Caixas Não Abertas ({unopenedBoxesCount})
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Gerencie caixas de recompensas guardadas no inventário do jogador.
                </p>
              </div>

              <button
                type="button"
                onClick={handleSaveGameDataClick}
                disabled={isSavingData}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-2 text-xs font-black uppercase text-white shadow-md shadow-emerald-950/40 hover:brightness-110 active:scale-95 disabled:opacity-50"
              >
                {isSavingData ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {isSavingData ? 'Salvando...' : 'Salvar Dados'}
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {userBoxes.map((box, idx) => {
                const boxId = String(box.box_id || box.boxId || '');
                const boxDef = lootBoxes.find((lb) => lb.id === boxId);
                const hasItems = boxDef && (boxDef.items || []).length > 0;
                const qty = Number(box.qty ?? box.quantity ?? 1) || 0;

                return (
                  <div
                    key={idx}
                    className={`rounded-2xl border p-4 flex items-center justify-between gap-4 shadow-lg ${
                      hasItems
                        ? 'border-slate-700/80 bg-slate-900/80'
                        : 'border-red-900/60 bg-red-950/20'
                    }`}
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-800 text-2xl border border-slate-700">
                        {boxDef?.icon || '🎁'}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-white truncate">
                            {boxDef?.name || 'Caixa Desconhecida'}
                          </span>
                          {!hasItems && (
                            <span className="rounded bg-red-950 text-red-400 px-1.5 py-0.5 text-[9px] font-bold border border-red-800">
                              SEM ITENS
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          Quantidade: <strong className="text-amber-400">{qty}x</strong> • ID:{' '}
                          <span className="font-mono text-[10px] text-slate-500">
                            {boxId.substring(0, 10)}...
                          </span>
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={async () => {
                        if (!selectedUser) return;
                        if (
                          !window.confirm(
                            `Deletar ${qty}x "${boxDef?.name || 'Caixa'}" do inventário de ${
                              selectedUser.username
                            }?`
                          )
                        ) {
                          return;
                        }

                        try {
                          const res = await apiFetch('/api/admin/delete-user-box', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              email: selectedUser.email,
                              boxId
                            })
                          });
                          const data = await res.json();
                          if (data.ok) {
                            alert('Caixa deletada com sucesso!');
                            if (selectedUserSave && selectedUserSave.unopenedBoxes) {
                              const updated = { ...selectedUserSave.unopenedBoxes };
                              delete updated[boxId];
                              setSelectedUserSave({ ...selectedUserSave, unopenedBoxes: updated });
                            }
                            const boxesRes = await apiFetch(
                              `/api/admin/user-boxes?email=${encodeURIComponent(
                                selectedUser.email
                              )}&t=${Date.now()}`
                            );
                            const boxesData = await boxesRes.json();
                            setUserBoxes(boxesData.boxes || []);
                          } else {
                            alert('Erro ao deletar: ' + (data.error || 'Erro'));
                          }
                        } catch {
                          alert('Erro de rede ao deletar caixa.');
                        }
                      }}
                      className="rounded-xl border border-red-800/50 bg-red-950/40 p-2 text-red-400 hover:bg-red-700 hover:text-white transition-colors"
                      title="Deletar Caixa do Usuário"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
            </div>

            {userBoxes.length === 0 && (
              <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-12 text-center text-slate-500">
                Nenhuma caixa de recompensa pendente para este jogador.
              </div>
            )}
          </div>
        )}

        {/* TAB 7: CARTEIRAS WEB3 */}
        {activeTab === 'wallets' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between rounded-2xl border border-slate-700/80 bg-slate-800/90 px-6 py-4 shadow-xl">
              <div>
                <h3 className="text-base font-black uppercase tracking-wide text-white flex items-center gap-2">
                  <Wallet size={18} className="text-amber-500" /> Histórico de Carteira & Reinvestimentos
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Registros append-only de vínculos de carteira e liquidações do desk em USDC.
                </p>
              </div>

              <button
                type="button"
                onClick={onRefreshWalletHistory}
                className="inline-flex items-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 px-4 py-2 text-xs font-bold text-slate-200 transition-colors"
              >
                <History size={14} /> Atualizar Histórico
              </button>
            </div>

            {/* Carteira Conectada */}
            <div className="rounded-2xl border border-slate-700 bg-slate-900/90 p-5 shadow-xl">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
                Carteira Atual Vinculada
              </h4>

              {walletHistoryLoading ? (
                <div className="flex items-center gap-2 py-4 text-sm text-slate-400">
                  <Loader2 size={16} className="animate-spin" /> Carregando carteira...
                </div>
              ) : walletHistoryError ? (
                <div className="text-sm text-amber-300 py-2">{walletHistoryError}</div>
              ) : adminWalletCurrent ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800/60 px-2.5 py-0.5 text-[10px] font-bold">
                      CONECTADA
                    </span>
                    <span className="text-[11px] text-slate-500 uppercase">Rede Polygon</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-mono font-bold text-amber-200 break-all">
                      {adminWalletCurrent.address}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(adminWalletCurrent.address, 'wallet')}
                      className="rounded p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300"
                      title="Copiar endereço"
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-slate-500 italic">Nenhuma carteira conectada atualmente.</div>
              )}
            </div>

            {/* Histórico de Conexões */}
            <div className="rounded-2xl border border-slate-700 bg-slate-900/90 p-5 shadow-xl space-y-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Log de Alterações de Carteira
              </h4>

              {adminWalletHistory.length === 0 ? (
                <div className="py-6 text-center text-sm text-slate-500 italic">
                  Sem alterações registradas.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-left text-xs min-w-[800px]">
                    <thead className="bg-slate-950 text-slate-500 uppercase text-[10px] font-bold">
                      <tr>
                        <th className="px-3 py-2.5">Data</th>
                        <th className="px-3 py-2.5">Ação</th>
                        <th className="px-3 py-2.5">Anterior</th>
                        <th className="px-3 py-2.5">Nova</th>
                        <th className="px-3 py-2.5">IP</th>
                        <th className="px-3 py-2.5">Origem</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 font-mono text-[11px]">
                      {adminWalletHistory.map((row) => (
                        <tr key={row.id} className="hover:bg-slate-800/40">
                          <td className="px-3 py-2 text-slate-400 whitespace-nowrap">
                            {new Date(row.createdAt).toLocaleString('pt-PT')}
                          </td>
                          <td className="px-3 py-2">
                            <span className="rounded bg-amber-950 text-amber-300 px-2 py-0.5 text-[9px] font-bold border border-amber-800/50">
                              {row.action}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-slate-400 truncate max-w-[150px]">
                            {row.previousWalletAddress || '—'}
                          </td>
                          <td className="px-3 py-2 text-amber-300 truncate max-w-[150px]">
                            {row.newWalletAddress || row.walletAddress || '—'}
                          </td>
                          <td className="px-3 py-2 text-slate-500">{row.ipAddress || '—'}</td>
                          <td className="px-3 py-2 text-slate-400 font-sans">{row.actorType}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Histórico de Reinvestimento USDC */}
            <div className="rounded-2xl border border-slate-700 bg-slate-900/90 p-5 shadow-xl space-y-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Histórico de Reinvestimentos USDC (Desk)
              </h4>

              {adminReinvestmentError ? (
                <div className="text-sm text-amber-300 py-2">{adminReinvestmentError}</div>
              ) : adminReinvestmentHistory.length === 0 ? (
                <div className="py-6 text-center text-sm text-slate-500 italic">
                  Sem liquidações registradas no desk.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-left text-xs min-w-[700px]">
                    <thead className="bg-slate-950 text-slate-500 uppercase text-[10px] font-bold">
                      <tr>
                        <th className="px-3 py-2.5">Data</th>
                        <th className="px-3 py-2.5">Moeda</th>
                        <th className="px-3 py-2.5">Vendido</th>
                        <th className="px-3 py-2.5">Bruto USDC</th>
                        <th className="px-3 py-2.5">Taxa</th>
                        <th className="px-3 py-2.5">Líquido USDC</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 font-mono text-[11px]">
                      {adminReinvestmentHistory.map((row) => (
                        <tr key={row.id} className="hover:bg-slate-800/40">
                          <td className="px-3 py-2 text-slate-400 whitespace-nowrap">
                            {row.createdAt > 0
                              ? new Date(row.createdAt).toLocaleString('pt-PT')
                              : '—'}
                          </td>
                          <td className="px-3 py-2 text-amber-300 font-sans font-bold">
                            {row.coinSymbol.trim() || row.coinId}
                          </td>
                          <td className="px-3 py-2 text-slate-300">
                            {formatMinedCoinAmount(row.soldCrypto)}
                          </td>
                          <td className="px-3 py-2 text-slate-400">
                            {formatUsdcAmount(row.grossUsdc, 'pt-BR')}
                          </td>
                          <td className="px-3 py-2 text-amber-400">
                            {formatUsdcAmount(row.feeUsdc, 'pt-BR')}
                          </td>
                          <td className="px-3 py-2 text-emerald-400 font-bold">
                            {formatUsdcAmount(row.netUsdc, 'pt-BR')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 8: GASTOS & COMPRAS */}
        {activeTab === 'shop' && (
          <div className="rounded-2xl border border-slate-700/80 bg-slate-800/90 p-6 shadow-xl space-y-4">
            <AdminUserPurchasesHub
              userId={selectedUserDbId(selectedUser) ?? null}
              userEmail={selectedUser?.email || ''}
            />
          </div>
        )}

        {/* TAB 9: LOG DE ATIVIDADES */}
        {activeTab === 'logs' && (
          <div className="rounded-2xl border border-slate-700/80 bg-slate-800/90 p-6 shadow-xl space-y-4">
            <h3 className="text-base font-black uppercase tracking-wide text-white flex items-center gap-2 border-b border-slate-700/80 pb-3">
              <History size={18} className="text-amber-500" /> Registro de Atividades do Jogador
            </h3>
            <AdminUserAuditPanel
              userId={selectedUserDbId(selectedUser) ?? null}
              userEmail={selectedUser?.email || ''}
            />
          </div>
        )}
      </div>
    </div>
  );
}
