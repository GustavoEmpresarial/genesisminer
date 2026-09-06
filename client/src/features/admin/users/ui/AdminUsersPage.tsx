// @ts-nocheck — markup legado; o client usa strict+noUnusedLocals.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AdminUpgrade, LootBox } from '../../lib/adminTypes';
import { getAdminUpgrades, createAdminUpgrade, deleteAdminUpgrade, getLootBoxes, setLootBoxes, getReferralModels, saveReferralModel, deleteReferralModel, getAccessLevelReferralAssignments, saveAccessLevelReferralAssignments, getSeasonPasses } from '../api';
import { AdminRanking } from '../../ui/AdminRanking';
import { AdminSuspiciousEmailsPanel } from '../../ui/AdminSuspiciousEmailsPanel';
import { User, AccessLevel, GameState, Upgrade, ReferralModel, SeasonPass } from '../../lib/adminTypes';
import {
    Users,
    Search,
    Edit,
    X,
    PlusCircle,
    Save,
    _Package,
    _Server,
    Trash2,
    Trophy,
    Gift,
    Cog,
    LogIn,
    ArrowUp,
    ArrowDown,
    CheckSquare,
    Square,
    Loader2,
    Shield,
    History,
    Pickaxe,
    Unplug,
    RefreshCw,
    ChevronLeft,
    ChevronRight,
    Lock,
    AtSign,
    Wallet,
    Copy
} from 'lucide-react';
import {
    getGameState,
    toggleUserBlocked,
    updateUser,
    _saveGameState,
    saveGameStateAdminOverride,
    getMiningCoins,
    deleteUser,
    _getSession,
    impersonateUser,
    bulkDeleteUsers,
    bulkGiftUsers,
    updateAdminPermissions,
    getUsers,
    getAdminDormantMiningAccounts,
    getAdminUserWalletHistory,
    deactivateStreamerRoomByAdmin,
    setAdminUserOwnedRooms,
    type AdminDormantMiningRow,
    type AdminUserWalletHistoryEntry,
    type AdminUserWalletCurrent
} from '../api';
import { getUpgradesCatalog } from '../../../../shared/api/admin-legacy';
import { validateAuthUsernameFormat } from '../../../../shared/utils/usernameValidation';
import { AUTH_USERNAME_MAX } from '../../../../shared/constants/authLimits';
import { AdminUserAuditPanel } from '../../ui/AdminUserAuditPanel';
import { apiFetch } from '../../../../shared/api/http';
import {
  resolveStreamerRoomId,
  roomNameById,
  isActiveRoomId,
  ROOM_INITIAL_ID,
  type AdminRoomOption
} from '../lib/roomCatalog';
import { ASIC_ROOM_ID, EXTRA_ROOM_ID } from '../../../servers/types';
import {
  sanitizeAdminStock,
  adminStockPayloadForSave,
  adminStockEntriesForEditor
} from '../lib/adminStock';
import {
  filterMembershipAccessLevels,
  stripRoomNamedIdsFromList
} from '../../lib/membershipAccessLevels';
import { AccessLevelsCatalog } from './AccessLevelsCatalog';
import { UserStockEditor } from './UserStockEditor';
import {
  buildAdminSaveOverrideDelta,
  findOrphanRackRoom,
  isUserSaveTabReadonly
} from './UserSaveEditor';

/** Inicial / ASICs / Extra — checkboxes always on; admin never revokes. */
const ALWAYS_OWNED_ROOM_IDS = [ROOM_INITIAL_ID, ASIC_ROOM_ID, EXTRA_ROOM_ID] as const;

function isAlwaysOwnedRoomId(roomId: string): boolean {
    return (ALWAYS_OWNED_ROOM_IDS as readonly string[]).includes(roomId);
}

function ensureAlwaysOwnedInList(owned: string[]): string[] {
    for (const alwaysId of ALWAYS_OWNED_ROOM_IDS) {
        if (!owned.includes(alwaysId)) owned.push(alwaysId);
    }
    return owned;
}

function formatAdminDormantMs(ms: string | null | undefined): string {
    if (ms == null || ms === '') return '—';
    const n = Number(ms);
    if (!Number.isFinite(n)) return String(ms);
    try {
        return new Date(n).toLocaleString('pt-PT');
    } catch {
        return String(ms);
    }
}

function selectedUserDbId(u: User | null): number | undefined {
  if (!u) return undefined;
  const raw = (u as { id?: unknown }).id;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function defaultAccessLevelId(accessLevels: AccessLevel[]): string {
    return accessLevels.find(l => l.isDefault)?.id ?? accessLevels[0]?.id ?? '';
}

function resolveEditorAccessLevels(
    u: Pick<User, 'accessLevelId' | 'accessLevelIds'>,
    accessLevels: AccessLevel[]
): { accessLevelId: string; accessLevelIds: string[] } {
    const catalogIds = new Set(accessLevels.map((l) => l.id));
    const fallbackPrimary = defaultAccessLevelId(accessLevels);

    const rawPrimary = typeof u.accessLevelId === 'string' ? u.accessLevelId.trim() : '';
    const rawIds = Array.isArray(u.accessLevelIds) ? u.accessLevelIds.map(String) : [];

    let accessLevelIds = stripRoomNamedIdsFromList(rawIds).filter((id) => catalogIds.has(id));
    let accessLevelId = rawPrimary && catalogIds.has(rawPrimary) ? rawPrimary : '';

    if (accessLevelId && !accessLevelIds.includes(accessLevelId)) {
        accessLevelIds = [accessLevelId, ...accessLevelIds];
    }
    if (!accessLevelId) {
        accessLevelId = accessLevelIds[0] || fallbackPrimary;
    }
    if (accessLevelId && !accessLevelIds.includes(accessLevelId)) {
        accessLevelIds = [accessLevelId, ...accessLevelIds];
    }
    if (!accessLevelId) {
        accessLevelId = fallbackPrimary;
    }

    return { accessLevelId, accessLevelIds };
}

export type AdminUsersJumpTarget = {
    key: number;
    userId: number;
    email: string;
    username: string;
};

interface AdminUsersPageProps {
    user: User | null;
    users: unknown[]; // Lightweight map from parent
    accessLevels: AccessLevel[];
    onUpdateAccessLevels?: (levels: AccessLevel[]) => void;
    gameUpgrades: Upgrade[];
    /** Ao definir (ex.: vindo do Suporte), abre o editor deste jogador uma vez. */
    jumpToUser?: AdminUsersJumpTarget | null;
    onJumpToUserHandled?: () => void;
    /** Abrir editor de jogador (ex.: a partir da aba Emails suspeitos). */
    requestOpenUserInEditor?: (target: AdminUsersJumpTarget) => void;
}

export const AdminUsersPage: React.FC<AdminUsersPageProps> = ({
    user,
    users: userMap,
    accessLevels: accessLevelsProp,
    onUpdateAccessLevels,
    gameUpgrades,
    jumpToUser,
    onJumpToUserHandled,
    requestOpenUserInEditor,
}) => {
    const accessLevels = filterMembershipAccessLevels(accessLevelsProp);
    const [localCatalog, setLocalCatalog] = useState<Upgrade[]>([]);
    const effectiveUpgrades = (gameUpgrades && gameUpgrades.length > 0) ? gameUpgrades : localCatalog;

    useEffect(() => {
        if (gameUpgrades && gameUpgrades.length > 0) return;
        let cancelled = false;
        void (async () => {
            try {
                const pack = await getUpgradesCatalog();
                if (!cancelled && Array.isArray(pack.upgrades)) setLocalCatalog(pack.upgrades);
            } catch {
                /* ignore */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [gameUpgrades]);
    const [paginatedUsers, setPaginatedUsers] = useState<User[]>([]);
    const [isLoadingUsers, setIsLoadingUsers] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [totalUsersCount, setTotalUsersCount] = useState(0);
    const [searchQuery, setSearchQuery] = useState('');
    const [limit] = useState(50);
    const [subTab, setSubTab] = useState<
        | 'users'
        | 'admin_staff'
        | 'access_levels'
        | 'admin_upgrades'
        | 'referrals'
        | 'ranking'
        | 'advanced_referrals'
        | 'dormant_no_mining'
        | 'dormant_mining_no_wallet'
        | 'suspicious_emails'
    >('users');
    const [sortBy, setSortBy] = useState<string>('creation');
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
    const [filterStatus, setFilterStatus] = useState<string>('all');
    const [filterLevel, setFilterLevel] = useState<string>('all');
    const [filterRoom, setFilterRoom] = useState<string>('all');
    const [roomOptions, setRoomOptions] = useState<Array<{ id: string; name: string }>>([]);
    const [_searchUser, _setSearchUser] = useState('');

    // User Edit State
    const [selectedUser, setSelectedUser] = useState<User | null>(null);
    const [selectedUserSave, setSelectedUserSave] = useState<GameState | null>(null);
    const jumpApplyEpochRef = useRef(0);
    const [editOwnedRoomIds, setEditOwnedRoomIds] = useState<string[]>([]);
    const [roomsSaveBusy, setRoomsSaveBusy] = useState(false);
    const [editProfileForm, setEditProfileForm] = useState({ username: '', email: '', password: '', wallet: '', accessLevelId: '', accessLevelIds: [] as string[] });
    const [editProfileUsernameError, setEditProfileUsernameError] = useState<string | null>(null);

    // Save Editor State
    const [saveTab, setSaveTab] = useState<'stock' | 'racks' | 'balances' | 'boxes' | 'logs' | 'wallets'>('stock');
    const [walletHistoryLoading, setWalletHistoryLoading] = useState(false);
    const [walletHistoryError, setWalletHistoryError] = useState<string | null>(null);
    const [adminWalletCurrent, setAdminWalletCurrent] = useState<AdminUserWalletCurrent | null>(null);
    const [adminWalletHistory, setAdminWalletHistory] = useState<AdminUserWalletHistoryEntry[]>([]);
    const [streamerRoomBusy, setStreamerRoomBusy] = useState(false);
    const [miningCoins, setMiningCoinsState] = useState<{ id: string; name: string }[]>([]);
    const [newItemId, setNewItemId] = useState<string>('');
    const [newItemQty, setNewItemQty] = useState<number>(1);
    const [userBoxes, setUserBoxes] = useState<unknown[]>([]);
    const [lootBoxes, setLootBoxesState] = useState<LootBox[]>([]);

    // Access Level Editor State
    const [editLevelMode, setEditLevelMode] = useState<boolean>(false);
    const [levelForm, setLevelForm] = useState<Partial<AccessLevel>>({
        id: '', name: '', description: '', isDefault: false, isActive: true, priceUsdc: 0, contractAddress: '', inactiveMessage: ''
    });

    const [adminUpgrades, setAdminUpgradesState] = useState<AdminUpgrade[]>([]);
    const [seasonPasses, setSeasonPassesState] = useState<SeasonPass[]>([]);
    const [editUpgradeMode, setEditUpgradeMode] = useState<boolean>(false);
    const [upgradeForm, setUpgradeForm] = useState<Partial<AdminUpgrade>>({ id: '', name: '', description: '', priceUsdc: 0, grantUsdc: 0, grantAccessLevelId: '', isActive: true, items: [], boxes: [], passes: [], coins: [], visibleToAccessLevelIds: [] });
    const [savingUpgrade, setSavingUpgrade] = useState<boolean>(false);
    const [upgradeError, setUpgradeError] = useState<string>('');
    const [referralSenderBoxForm, setReferralSenderBoxForm] = useState<Partial<LootBox>>({ id: '', name: 'Prêmio por Indicação', description: 'Recompensas para quem indicou', trigger: 'referral_sender', items: [], icon: '🎁', price: 0 });
    const [referralReceiverBoxForm, setReferralReceiverBoxForm] = useState<Partial<LootBox>>({ id: '', name: 'Prêmio de Indicado', description: 'Recompensas para novos indicados', trigger: 'referral_receiver', items: [], icon: '🎁', price: 0 });
    const [newSenderItem, setNewSenderItem] = useState<{ type: 'item' | 'currency' | 'coin'; id: string; minQty: number; maxQty: number; probability: number }>({ type: 'item', id: '', minQty: 1, maxQty: 1, probability: 50 });
    const [_newReceiverItem, _setNewReceiverItem] = useState<{ type: 'item' | 'currency' | 'coin'; id: string; minQty: number; maxQty: number; probability: number }>({ type: 'item', id: '', minQty: 1, maxQty: 1, probability: 50 });
    const [refPage, setRefPage] = useState(1);
    const [expandedEmail, setExpandedEmail] = useState<string | null>(null);
    const [excludeSelf, setExcludeSelf] = useState<boolean>(true);
    const [excludeSelfInDetails, setExcludeSelfInDetails] = useState<boolean>(true);

    // Sorting State
    const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' }>({ key: '', direction: 'asc' });

    // Bulk Management State
    const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set());
    const [showMassGiftModal, setShowMassGiftModal] = useState(false);
    const [massGiftForm, setMassGiftForm] = useState<{ type: 'usdc' | 'item' | 'box' | 'coin'; id: string; qty: number }>({ type: 'usdc', id: '', qty: 0 });
    const [isProcessingBulk, setIsProcessingBulk] = useState(false);

    // Admin Permissions State
    const [showPermissionsModal, setShowPermissionsModal] = useState(false);
    const [permissionsUser, setPermissionsUser] = useState<User | null>(null);
    const [adminPermsForm, setAdminPermsForm] = useState({
        isAdmin: false,
        isSuperAdmin: false,
        permissions: [] as string[]
    });
    const [isSavingPerms, setIsSavingPerms] = useState(false);

    // Advanced Referrals State
    const [referralModels, setReferralModels] = useState<ReferralModel[]>([]);
    const [levelAssignments, setLevelAssignments] = useState<Record<string, number>>({});
    const [editModelMode, setEditModelMode] = useState(false);
    const [modelForm, setModelForm] = useState<Partial<ReferralModel>>({ name: '', description: '', sender_reward_usdc: 0, receiver_reward_usdc: 0, sender_loot_box_id: '', receiver_loot_box_id: '', is_active: 1 });
    const [isSavingModel, setIsSavingModel] = useState(false);
    const [isSavingAssignments, setIsSavingAssignments] = useState(false);

    const [dormantDaysMin, setDormantDaysMin] = useState(30);
    const [dormantNoMining, setDormantNoMining] = useState<AdminDormantMiningRow[]>([]);
    const [dormantMiningNoWallet, setDormantMiningNoWallet] = useState<AdminDormantMiningRow[]>([]);
    const [dormantNote, setDormantNote] = useState<string | null>(null);
    const [dormantMeta, setDormantMeta] = useState<{
        limitEach: number;
        cutoffMs: string;
        noMiningTotal: number;
        miningNoWalletTotal: number;
    } | null>(null);
    const [dormantLoading, setDormantLoading] = useState(false);
    const [dormantError, setDormantError] = useState<string | null>(null);
    const [dormantNoMiningPage, setDormantNoMiningPage] = useState(1);
    const [dormantMiningNoWalletPage, setDormantMiningNoWalletPage] = useState(1);
    const [dormantSelectedEmails, setDormantSelectedEmails] = useState<Set<string>>(new Set());
    const [dormantBulkBusy, setDormantBulkBusy] = useState(false);

    const handleSort = (key: string) => {
        let direction: 'asc' | 'desc' = 'asc';
        if (sortConfig.key === key && sortConfig.direction === 'asc') {
            direction = 'desc';
        }
        setSortConfig({ key, direction });
    };

    const loadUsers = async (page: number, search: string) => {
        setIsLoadingUsers(true);
        try {
            const data = await getUsers(page, limit, search, sortBy, sortDir, filterStatus, filterLevel, subTab === 'admin_staff', filterRoom);
            if (data.error) {
                alert(data.error);
                setPaginatedUsers([]);
                setTotalPages(0);
                setTotalUsersCount(0);
                return;
            }
            setPaginatedUsers(data.users);
            setTotalPages(data.pages);
            setTotalUsersCount(data.total);
            setRoomOptions(Array.isArray(data.rooms) ? data.rooms : []);

            // Fetch Advanced Referral Data if needed
            if (subTab === 'advanced_referrals') {
                const [models, assignments] = await Promise.all([
                    getReferralModels(),
                    getAccessLevelReferralAssignments()
                ]);
                setReferralModels(models);
                setLevelAssignments(assignments);
            }
        } catch (e) {
            console.error('[AdminUsers] loadUsers failed', e);
        } finally {
            setIsLoadingUsers(false);
        }
    };

    const loadDormantMiningAccounts = useCallback(async () => {
        setDormantLoading(true);
        setDormantError(null);
        try {
            const data = await getAdminDormantMiningAccounts({
                daysMin: dormantDaysMin,
                limit: 500,
                noMiningPage: dormantNoMiningPage,
                miningNoWalletPage: dormantMiningNoWalletPage
            });
            if (data.error) {
                setDormantError(data.error);
                setDormantNoMining([]);
                setDormantMiningNoWallet([]);
                setDormantNote(null);
                setDormantMeta(null);
            } else {
                setDormantNoMining(data.noMining);
                setDormantMiningNoWallet(data.miningNoWallet);
                setDormantNote(data.note);
                setDormantMeta({
                    limitEach: data.limitEach,
                    cutoffMs: data.cutoffMs,
                    noMiningTotal: data.noMiningTotal,
                    miningNoWalletTotal: data.miningNoWalletTotal
                });
            }
        } catch {
            setDormantError('Erro de rede.');
            setDormantNoMining([]);
            setDormantMiningNoWallet([]);
            setDormantNote(null);
            setDormantMeta(null);
        }
        setDormantLoading(false);
    }, [dormantDaysMin, dormantNoMiningPage, dormantMiningNoWalletPage]);

    // Initial load and on page/search change
    React.useEffect(() => {
        if (
            subTab === 'dormant_no_mining' ||
            subTab === 'dormant_mining_no_wallet' ||
            subTab === 'suspicious_emails'
        )
            return;
        const delayDebounceFn = setTimeout(() => {
            loadUsers(currentPage, searchQuery);
        }, 500); // 500ms debounce for search

        return () => clearTimeout(delayDebounceFn);
    }, [currentPage, searchQuery, sortBy, sortDir, filterStatus, filterLevel, filterRoom, subTab]);
    React.useEffect(() => {
        const loadCoins = async () => {
            const list = await getMiningCoins();
            setMiningCoinsState(list.map(c => ({ id: c.id, name: c.name })));
        };
        loadCoins();
    }, []);

    useEffect(() => {
        setDormantNoMiningPage(1);
        setDormantMiningNoWalletPage(1);
    }, [dormantDaysMin]);

    useEffect(() => {
        if (subTab !== 'dormant_no_mining' && subTab !== 'dormant_mining_no_wallet') return;
        void loadDormantMiningAccounts();
    }, [subTab, dormantDaysMin, dormantNoMiningPage, dormantMiningNoWalletPage, loadDormantMiningAccounts]);

    useEffect(() => {
        setDormantSelectedEmails(new Set());
    }, [subTab]);

    useEffect(() => {
        setDormantSelectedEmails(new Set());
    }, [dormantDaysMin]);

    React.useEffect(() => {
        const loadAdminData = async () => {
            const list = await getAdminUpgrades();
            const boxes = await getLootBoxes();
            const passes = await getSeasonPasses();
            setAdminUpgradesState(list);
            setLootBoxesState(boxes);
            setSeasonPassesState(passes || []);
            const sender = boxes.find(b => b.trigger === 'referral_sender');
            const receiver = boxes.find(b => b.trigger === 'referral_receiver');
            setReferralSenderBoxForm(sender ? { ...sender } : { ...referralSenderBoxForm, id: 'referral_sender_box' });
            setReferralReceiverBoxForm(receiver ? { ...receiver } : { ...referralReceiverBoxForm, id: 'referral_receiver_box' });
        };
        loadAdminData();
    }, []);

    useEffect(() => {
        if (saveTab !== 'wallets' || !selectedUser) return;
        const dbId = selectedUserDbId(selectedUser);
        if (!dbId) {
            setWalletHistoryError('Sem ID numérico de utilizador (abra o perfil a partir da lista de Utilizadores).');
            setAdminWalletCurrent(null);
            setAdminWalletHistory([]);
            return;
        }
        let cancelled = false;
        setWalletHistoryLoading(true);
        setWalletHistoryError(null);
        void getAdminUserWalletHistory(dbId).then((r) => {
            if (cancelled) return;
            setWalletHistoryLoading(false);
            if (!r.ok) {
                setWalletHistoryError(r.error || 'Erro ao carregar histórico de carteiras.');
                setAdminWalletCurrent(null);
                setAdminWalletHistory([]);
            } else {
                setAdminWalletCurrent(r.currentWallet);
                setAdminWalletHistory(r.history);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [saveTab, selectedUser]);

    const applyUserToEditor = useCallback(async (u: User) => {
        setSelectedUser(u);
        setSaveTab('stock');
        setAdminWalletCurrent(null);
        setAdminWalletHistory([]);
        setWalletHistoryError(null);
        setWalletHistoryLoading(false);
        setEditProfileUsernameError(null);
        const { accessLevelId, accessLevelIds } = resolveEditorAccessLevels(u, accessLevels);
        setEditProfileForm({
            username: u.username,
            email: u.email,
            password: '',
            wallet: u.polygonWallet || '',
            accessLevelId,
            accessLevelIds,
        });
        const res = await getGameState(u.email, { adminOverride: true });
        if (!res.data) {
            alert(res.error || 'Não foi possível carregar o estado de jogo.');
            setSelectedUserSave(null);
            setEditOwnedRoomIds([]);
        } else {
            setSelectedUserSave({ ...res.data, stock: sanitizeAdminStock(res.data.stock) });
            const owned = Array.isArray((res.data as { ownedRoomIds?: string[] }).ownedRoomIds)
                ? (res.data as { ownedRoomIds: string[] }).ownedRoomIds.map(String)
                : [];
            setEditOwnedRoomIds(ensureAlwaysOwnedInList(owned));
        }

        try {
            const boxesRes = await apiFetch(`/api/admin/user-boxes?email=${encodeURIComponent(u.email)}&t=${Date.now()}`);
            const boxesData = await boxesRes.json();
            setUserBoxes(boxesData.boxes || []);

            const lootBoxesData = await getLootBoxes();
            setLootBoxesState(lootBoxesData);
        } catch (e) {
            console.error('Erro ao carregar caixas:', e);
            setUserBoxes([]);
        }
    }, [accessLevels]);

    useEffect(() => {
        if (!jumpToUser || !onJumpToUserHandled) return;

        const { userId, email, username } = jumpToUser;
        const em = email.trim().toLowerCase();
        const hasUserId = Number.isFinite(userId) && userId > 0;
        if (!em && !hasUserId) {
            onJumpToUserHandled();
            return;
        }

        // Clear pending jump before fetch so Voltar cannot race a 2nd apply.
        const jumpEpoch = ++jumpApplyEpochRef.current;
        onJumpToUserHandled();

        setSubTab('users');
        const JUMP_LOOKUP_PAGE = 1;
        const JUMP_LOOKUP_LIMIT = 50;
        void (async () => {
            try {
                /** Prefer exact id from ticket; email search only as fallback. */
                let data =
                    hasUserId
                        ? await getUsers(
                              JUMP_LOOKUP_PAGE,
                              JUMP_LOOKUP_LIMIT,
                              '',
                              'creation',
                              'asc',
                              'all',
                              'all',
                              false,
                              'all',
                              userId
                          )
                        : null;

                if (jumpEpoch !== jumpApplyEpochRef.current) return;

                if (data?.error) {
                    alert(data.error);
                    return;
                }

                let full =
                    data && hasUserId
                        ? data.users.find((u) => {
                              const raw = u.id as unknown;
                              const id = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
                              return Number.isFinite(id) && id === userId;
                          })
                        : undefined;

                if (!full && em) {
                    data = await getUsers(
                        JUMP_LOOKUP_PAGE,
                        JUMP_LOOKUP_LIMIT,
                        em,
                        'creation',
                        'asc',
                        'all',
                        'all',
                        false,
                        'all'
                    );
                    if (jumpEpoch !== jumpApplyEpochRef.current) return;
                    if (data.error) {
                        alert(data.error);
                        return;
                    }
                    const exactEmail = data.users.filter(
                        (u) => String(u.email || '').trim().toLowerCase() === em
                    );
                    const byId =
                        hasUserId
                            ? data.users.find((u) => {
                                  const raw = u.id as unknown;
                                  const id = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
                                  return Number.isFinite(id) && id === userId;
                              })
                            : undefined;
                    full = exactEmail.length > 0 ? exactEmail[0] : byId;
                }

                if (!full) {
                    alert(
                        'Não foi encontrado este jogador na lista de utilizadores (dados incompletos ou email do ticket diferente do registo). Abre o perfil pela pesquisa em Utilizadores.'
                    );
                    return;
                }
                if (jumpEpoch !== jumpApplyEpochRef.current) return;
                const normalized: User = {
                    ...full,
                    id: full.id != null && String(full.id).trim() !== '' ? String(full.id) : String(hasUserId ? userId : ''),
                    username: full.username || username || (em ? em.split('@')[0] : '') || 'jogador',
                    email: String(full.email || em).toLowerCase(),
                };
                await applyUserToEditor(normalized);
                // Voltar durante getGameState ainda pode ter setSelectedUser — desfaz se epoch mudou.
                if (jumpEpoch !== jumpApplyEpochRef.current) {
                    setSelectedUser(null);
                    setSelectedUserSave(null);
                }
            } catch (e) {
                console.error('[AdminUsers] jumpToUser failed', e);
                alert('Não foi possível abrir o perfil deste jogador.');
            }
        })();
    }, [jumpToUser, onJumpToUserHandled, applyUserToEditor]);

    /** Conceder/editar/remover admin — só super (API: POST /api/admin/update-permissions é rota `super`). */
    const canManageAdminAccounts = !!user?.isSuperAdmin;

    /** Email de outro admin e senha de conta super: só super (alinhado com PUT /api/user). */
    const actorIsSuperForCreds = !!user?.isSuperAdmin;

    const isAllowed = (perm: string) => {
        if (!user) return false;
        if (user.isSuperAdmin) return true;
        if (user.adminPermissions === null || user.adminPermissions === undefined) return true; // Default to allow if not explicitly restricted
        if (!Array.isArray(user.adminPermissions)) return true; // If not array, default to allow
        return !!user.isAdmin && user.adminPermissions.includes(perm);
    };

    // --- USER MANAGEMENT LOGIC ---
    const handleSelectUser = async (u: User) => {
        await applyUserToEditor(u);
    };

    const handleUpdateUserProfile = async () => {
        if (!selectedUser) return;
        const newEmail = editProfileForm.email.trim();
        if (!newEmail) {
            alert('Email não pode ficar vazio.');
            return;
        }

        const editingOther =
            String((selectedUser.email || '').trim().toLowerCase()) !== String((user?.email || '').trim().toLowerCase());
        const editingOtherAdmin = !!selectedUser.isAdmin && editingOther;
        const editingOtherSuperAdmin = !!selectedUser.isSuperAdmin && editingOther;
        if (editingOtherAdmin && !actorIsSuperForCreds) {
            const origEmail = (selectedUser.email || '').trim().toLowerCase();
            if (newEmail.toLowerCase() !== origEmail) {
                alert('Apenas super administradores podem alterar o email de outras contas administrador.');
                return;
            }
        }
        if (
            editingOtherSuperAdmin &&
            !actorIsSuperForCreds &&
            editProfileForm.password &&
            editProfileForm.password.trim().length > 0
        ) {
            alert('Apenas super administradores podem alterar a senha de contas super administrador.');
            return;
        }

        const userNameCheck = validateAuthUsernameFormat(editProfileForm.username);
        if (userNameCheck.ok === false) {
            setEditProfileUsernameError(userNameCheck.error);
            return;
        }
        setEditProfileUsernameError(null);

        const payload: User = {
            username: userNameCheck.username,
            email: newEmail.toLowerCase(),
            polygonWallet: editProfileForm.wallet.trim() || undefined,
            accessLevelId: editProfileForm.accessLevelId,
            accessLevelIds: editProfileForm.accessLevelIds
        };

        const sid = selectedUser.id != null && String(selectedUser.id).trim() !== ''
            ? parseInt(String(selectedUser.id).trim(), 10)
            : NaN;
        if (Number.isFinite(sid) && sid > 0) {
            payload.id = String(sid);
        }

        if (editProfileForm.password && editProfileForm.password.trim().length > 0) {
            payload.password = editProfileForm.password;
        }

        const res = await updateUser(payload as User);
        if (!res.ok) {
            alert(res.error || 'Falha ao atualizar perfil.');
            return;
        }

        await loadUsers(currentPage, searchQuery);
        const nextSelected: User = {
            ...selectedUser,
            id: selectedUser.id,
            username: payload.username!,
            email: newEmail.toLowerCase(),
            polygonWallet: payload.polygonWallet,
            accessLevelId: editProfileForm.accessLevelId,
            accessLevelIds: editProfileForm.accessLevelIds
        };
        setEditProfileForm((f) => ({ ...f, password: '' }));
        setSelectedUser(nextSelected);
        if (saveTab === 'wallets') {
            const dbId = selectedUserDbId(nextSelected);
            if (dbId) {
                setWalletHistoryLoading(true);
                const wr = await getAdminUserWalletHistory(dbId);
                setWalletHistoryLoading(false);
                if (wr.ok) {
                    setAdminWalletCurrent(wr.currentWallet);
                    setAdminWalletHistory(wr.history);
                }
            }
        }
        alert('Perfil atualizado com sucesso.');
    };

    const countRacksInOwnedRoom = (roomId: string): number => {
        const racks = (selectedUserSave as { placedRacks?: Array<{ roomId?: unknown }> } | null)?.placedRacks;
        if (!Array.isArray(racks)) return 0;
        return racks.filter((r) => {
            const raw = String(r?.roomId ?? '').trim();
            const rid = !raw || raw === 'main' ? ROOM_INITIAL_ID : raw;
            return rid === roomId;
        }).length;
    };

    const refreshSelectedUserGameState = async () => {
        if (!selectedUser) return;
        const refreshed = await getGameState(selectedUser.email, { adminOverride: true });
        if (!refreshed.data) return;
        setSelectedUserSave({ ...refreshed.data, stock: sanitizeAdminStock(refreshed.data.stock) });
        const owned = Array.isArray((refreshed.data as { ownedRoomIds?: string[] }).ownedRoomIds)
            ? (refreshed.data as { ownedRoomIds: string[] }).ownedRoomIds.map(String)
            : [];
        setEditOwnedRoomIds(ensureAlwaysOwnedInList(owned));
    };

    /** Grava salas de imediato (não depende de «Salvar perfil»). */
    const handleToggleOwnedRoom = async (roomId: string, enable: boolean) => {
        if (!selectedUser || roomsSaveBusy) return;
        if (isAlwaysOwnedRoomId(roomId)) return;

        const uid = selectedUserDbId(selectedUser);
        if (uid == null) {
            alert('ID do utilizador em falta — recarrega a lista e abre o jogador outra vez.');
            return;
        }

        if (!enable) {
            const n = countRacksInOwnedRoom(roomId);
            const label = roomNameById(roomOptions, roomId);
            const msg =
                n > 0
                    ? `Tirar «${label}»?\n\n${n} rig(s) nessa sala voltam ao estoque.`
                    : `Tirar «${label}» deste jogador?`;
            if (!window.confirm(msg)) return;
        }

        const prev = editOwnedRoomIds;
        const nextSet = new Set(prev);
        if (enable) nextSet.add(roomId);
        else nextSet.delete(roomId);
        for (const alwaysId of ALWAYS_OWNED_ROOM_IDS) nextSet.add(alwaysId);
        const nextIds = Array.from(nextSet);

        setEditOwnedRoomIds(nextIds);
        setRoomsSaveBusy(true);
        try {
            const roomsRes = await setAdminUserOwnedRooms(uid, nextIds);
            if (!roomsRes.ok) {
                setEditOwnedRoomIds(prev);
                alert(
                    `Falha ao actualizar salas: ${roomsRes.error || 'erro'}${
                        roomsRes.code ? ` [${roomsRes.code}]` : ''
                    }`
                );
                return;
            }
            if (roomsRes.ownedRoomIds) {
                setEditOwnedRoomIds(ensureAlwaysOwnedInList([...roomsRes.ownedRoomIds]));
            }
            await refreshSelectedUserGameState();
            if (!enable && (roomsRes.removedRackCount ?? 0) > 0) {
                alert(`Sala removida. ${roomsRes.removedRackCount} rig(s) devolvidos ao estoque.`);
            }
        } finally {
            setRoomsSaveBusy(false);
        }
    };

    const handleToggleBlock = async () => {
        if (!selectedUser) return;
        const res = await toggleUserBlocked(selectedUser.email, !selectedUser.isBlocked);
        if (!res.ok) {
            alert(res.error || 'Falha ao alterar bloqueio.');
            return;
        }
        await loadUsers(currentPage, searchQuery);
        setSelectedUser({ ...selectedUser, isBlocked: !selectedUser.isBlocked });
    };

    const handleDeleteUser = async () => {
        if (!selectedUser) return;
        if (
            selectedUser.isAdmin &&
            !canManageAdminAccounts &&
            selectedUserDbId(selectedUser) !== selectedUserDbId(user ?? null)
        ) {
            alert('Apenas super administradores podem excluir outras contas administrador.');
            return;
        }
        const ok = window.confirm(`Tem certeza que deseja excluir o usuário ${selectedUser.email}? Esta ação remove todos os dados vinculados.`);
        if (!ok) return;
        const res = await deleteUser(selectedUser.email);
        if (res && res.ok) {
            await loadUsers(currentPage, searchQuery);
            setSelectedUser(null);
            setSelectedUserSave(null);
            alert('Usuário excluído com sucesso.');
        } else {
            alert(res.error || 'Falha ao excluir usuário.');
        }
    };

    const handleDeactivateStreamerRoom = async () => {
        if (!selectedUser || !selectedUserSave) return;
        const uid = selectedUserDbId(selectedUser);
        if (!uid) return;
        const streamerRoomId = resolveStreamerRoomId(roomOptions);
        if (!streamerRoomId) {
            alert('Sala Streamer não está no catálogo activo de salas.');
            return;
        }
        const hasStreamerRoom = (selectedUserSave.placedRacks || []).some(
            (rack) => String(rack.roomId || '').trim() === streamerRoomId
        );
        if (!hasStreamerRoom) {
            alert('Este utilizador não tem itens colocados na Sala Streamer neste momento.');
            return;
        }
        if (!window.confirm(`Desativar a Sala Streamer de ${selectedUser.username} e enviar todos os itens dessa sala para o inventário?`)) {
            return;
        }
        setStreamerRoomBusy(true);
        try {
            const res = await deactivateStreamerRoomByAdmin(uid, selectedUserSave, streamerRoomId);
            if (!res.ok) {
                alert(res.error || 'Falha ao desativar a Sala Streamer.');
                return;
            }
            const refreshed = await getGameState(selectedUser.email, { adminOverride: true });
            if (refreshed.data) {
                setSelectedUserSave({ ...refreshed.data, stock: sanitizeAdminStock(refreshed.data.stock) });
            }
            alert(`Sala Streamer desativada. Itens devolvidos ao inventário. Rigs removidas da sala: ${res.removedRackCount ?? 0}.`);
        } finally {
            setStreamerRoomBusy(false);
        }
    };

    const handleToggleSelect = (email: string) => {
        const next = new Set(selectedEmails);
        if (next.has(email)) next.delete(email);
        else next.add(email);
        setSelectedEmails(next);
    };

    const handleSelectAll = (filteredEmails: string[]) => {
        if (selectedEmails.size === filteredEmails.length && filteredEmails.length > 0) {
            setSelectedEmails(new Set());
        } else {
            setSelectedEmails(new Set(filteredEmails));
        }
    };

    const handleBulkDelete = async () => {
        if (selectedEmails.size === 0) return;
        const ok = window.confirm(`Tem certeza que deseja excluir EM MASSA ${selectedEmails.size} usuários selecionados? Esta ação é IRREVERSÍVEL.`);
        if (!ok) return;

        setIsProcessingBulk(true);
        const emails = Array.from(selectedEmails);
        const res = await bulkDeleteUsers(emails);
        setIsProcessingBulk(false);

        if (res.ok) {
            await loadUsers(currentPage, searchQuery);
            setSelectedEmails(new Set());
            alert(`${res.count} usuários excluídos com sucesso.`);
        } else {
            alert(res.error || "Falha na exclusão em massa.");
        }
    };

    const handleDormantToggleSelect = (email: string) => {
        const next = new Set(dormantSelectedEmails);
        if (next.has(email)) next.delete(email);
        else next.add(email);
        setDormantSelectedEmails(next);
    };

    const handleDormantSelectAll = (pageEmails: string[]) => {
        if (pageEmails.length === 0) return;
        if (dormantSelectedEmails.size === pageEmails.length && pageEmails.length > 0) {
            setDormantSelectedEmails(new Set());
        } else {
            setDormantSelectedEmails(new Set(pageEmails));
        }
    };

    const handleDormantRowBlock = async (email: string) => {
        if (!window.confirm(`Bloquear a conta ${email}?`)) return;
        setDormantBulkBusy(true);
        const res = await toggleUserBlocked(email, true);
        setDormantBulkBusy(false);
        if (!res.ok) {
            alert(res.error || 'Falha ao bloquear.');
            return;
        }
        setDormantSelectedEmails((prev) => {
            const next = new Set(prev);
            next.delete(email);
            return next;
        });
        await loadDormantMiningAccounts();
    };

    const handleDormantRowDelete = async (email: string) => {
        if (!window.confirm(`Excluir permanentemente ${email}? Esta ação remove dados vinculados.`)) return;
        setDormantBulkBusy(true);
        const res = await deleteUser(email);
        setDormantBulkBusy(false);
        if (!res?.ok) {
            alert(res?.error || 'Falha ao excluir.');
            return;
        }
        setDormantSelectedEmails((prev) => {
            const next = new Set(prev);
            next.delete(email);
            return next;
        });
        await loadDormantMiningAccounts();
        alert('Conta excluída.');
    };

    const handleDormantBulkBlock = async () => {
        if (dormantSelectedEmails.size === 0) return;
        const emails = Array.from(dormantSelectedEmails);
        if (!window.confirm(`Bloquear ${emails.length} conta(s) seleccionada(s)?`)) return;
        setDormantBulkBusy(true);
        let ok = 0;
        const failed: string[] = [];
        for (const email of emails) {
            const r = await toggleUserBlocked(email, true);
            if (r.ok) ok += 1;
            else failed.push(email);
        }
        setDormantBulkBusy(false);
        await loadDormantMiningAccounts();
        setDormantSelectedEmails(new Set());
        if (failed.length > 0) {
            const sample = failed.slice(0, 5).join(', ');
            alert(
                `Bloqueados: ${ok}. Falharam: ${failed.length}${failed.length > 5 ? ` (ex.: ${sample}…)` : ` (${sample})`}.`
            );
        } else {
            alert(`${ok} conta(s) bloqueada(s).`);
        }
    };

    const handleDormantBulkDelete = async () => {
        if (dormantSelectedEmails.size === 0) return;
        if (
            !window.confirm(
                `Excluir EM MASSA ${dormantSelectedEmails.size} conta(s) seleccionada(s)? Esta ação é IRREVERSÍVEL.`
            )
        ) {
            return;
        }
        setDormantBulkBusy(true);
        const emails = Array.from(dormantSelectedEmails);
        const res = await bulkDeleteUsers(emails);
        setDormantBulkBusy(false);
        if (res.ok) {
            await loadDormantMiningAccounts();
            setDormantSelectedEmails(new Set());
            alert(`${res.count ?? emails.length} conta(s) excluída(s).`);
        } else {
            alert(res.error || 'Falha na exclusão em massa.');
        }
    };


    const handleBulkBlock = async () => {
        if (selectedEmails.size === 0) return;
        const emails = Array.from(selectedEmails);
        if (!window.confirm(`Bloquear ${emails.length} usuário(s) selecionado(s)?`)) return;
        setIsProcessingBulk(true);
        let ok = 0;
        const failed: string[] = [];
        for (const email of emails) {
            const r = await toggleUserBlocked(email, true);
            if (r.ok) ok += 1;
            else failed.push(email);
        }
        setIsProcessingBulk(false);
        await loadUsers(currentPage, searchQuery);
        setSelectedEmails(new Set());
        if (failed.length > 0) {
            const sample = failed.slice(0, 5).join(', ');
            alert(
                `Bloqueados: ${ok}. Falharam: ${failed.length}${failed.length > 5 ? ` (ex.: ${sample}…)` : ` (${sample})`}.`
            );
        } else {
            alert(`${ok} usuário(s) bloqueado(s).`);
        }
    };

    const handleBulkGift = async () => {
        if (selectedEmails.size === 0) return;
        if (!massGiftForm.type || (massGiftForm.type !== 'usdc' && !massGiftForm.id) || massGiftForm.qty < 0) {
            alert("Configure o presente corretamente.");
            return;
        }

        setIsProcessingBulk(true);
        const emails = Array.from(selectedEmails);
        const res = await bulkGiftUsers(emails, massGiftForm);
        setIsProcessingBulk(false);

        if (res.ok) {
            setShowMassGiftModal(false);
            setSelectedEmails(new Set());
            alert(`Presente enviado para ${res.count} usuários!`);
        } else {
            alert(res.error || "Falha ao enviar presentes.");
        }
    };

    const normalizeAdminPermissionsForForm = (p: unknown): string[] => {
        if (p == null) return [];
        if (Array.isArray(p)) return p.filter((x): x is string => typeof x === 'string');
        if (typeof p === 'object') {
            return Object.entries(p as Record<string, unknown>)
                .filter(([, v]) => v === true || v === 1)
                .map(([k]) => k);
        }
        return [];
    };

    const handleOpenPermissions = (u: User) => {
        if (!canManageAdminAccounts) {
            window.alert('Apenas super administradores podem conceder ou alterar contas de administrador.');
            return;
        }
        setPermissionsUser(u);
        setAdminPermsForm({
            isAdmin: !!u.isAdmin,
            isSuperAdmin: !!u.isSuperAdmin,
            permissions: normalizeAdminPermissionsForForm(u.adminPermissions)
        });
        setShowPermissionsModal(true);
    };

    const handleSavePermissions = async () => {
        if (!permissionsUser) return;
        setIsSavingPerms(true);
        const res = await updateAdminPermissions(
            permissionsUser.email,
            adminPermsForm.isAdmin,
            adminPermsForm.permissions,
            adminPermsForm.isAdmin ? adminPermsForm.isSuperAdmin : false
        );
        setIsSavingPerms(false);

        if (res.ok) {
            await loadUsers(currentPage, searchQuery);
            setShowPermissionsModal(false);
            alert("Permissões atualizadas com sucesso!");
        } else {
            alert(res.error || "Erro ao atualizar permissões.");
        }
    };

    const togglePermission = (permId: string) => {
        const next = [...adminPermsForm.permissions];
        const idx = next.indexOf(permId);
        if (idx >= 0) next.splice(idx, 1);
        else next.push(permId);
        setAdminPermsForm({ ...adminPermsForm, permissions: next });
    };

    // --- SAVE EDITOR LOGIC ---
    const handleUpdateStock = (itemId: string, newQty: number) => {
        if (!selectedUserSave) return;
        const qty = Number.isFinite(newQty) ? Math.max(0, Math.floor(newQty)) : 0;
        const updatedStock = { ...(selectedUserSave.stock || {}), [itemId]: qty };
        setSelectedUserSave({ ...selectedUserSave, stock: updatedStock });
    };

    const handleDeleteRack = (rackId: string) => {
        if (!selectedUserSave) return;
        if (!window.confirm('Tem certeza? O chassis volta ao estoque e equipamentos montados também.')) return;

        const rack = (selectedUserSave.placedRacks || []).find((r) => r.id === rackId);
        if (!rack) return;
        const updatedRacks = (selectedUserSave.placedRacks || []).filter((r) => r.id !== rackId);
        const stock = { ...(selectedUserSave.stock || {}) };
        const bump = (itemId: string | null | undefined) => {
            const id = String(itemId || '').trim();
            if (!id) return;
            stock[id] = (Number(stock[id]) || 0) + 1;
        };
        bump(rack.itemId);
        for (const s of rack.slots || []) bump(s);
        for (const s of rack.multiplierSlots || []) bump(s);
        bump(rack.batteryId);
        bump(rack.wiringId);
        setSelectedUserSave({ ...selectedUserSave, placedRacks: updatedRacks, stock });
    };

    const handleRemapRackRoom = (rackId: string, nextRoomId: string) => {
        if (!selectedUserSave) return;
        if (!isActiveRoomId(roomOptions, nextRoomId)) {
            alert('Escolha uma sala activa do catálogo.');
            return;
        }
        const updatedRacks = (selectedUserSave.placedRacks || []).map((r) =>
            r.id === rackId ? { ...r, roomId: nextRoomId } : r
        );
        setSelectedUserSave({ ...selectedUserSave, placedRacks: updatedRacks });
    };

    const handleUpdateUsdc = (newAmt: number) => {
        if (!selectedUserSave) return;
        const val = isNaN(newAmt) ? 0 : newAmt;
        setSelectedUserSave({ ...selectedUserSave, usdc: val });
    };

    const handleUpdateCoinBalance = (coinId: string, newAmt: number) => {
        if (!selectedUserSave) return;
        const cur = selectedUserSave.coinBalances || {};
        const next = { ...cur, [coinId]: isNaN(newAmt) ? (cur[coinId] || 0) : newAmt };
        setSelectedUserSave({ ...selectedUserSave, coinBalances: next });
    };

    const handleAddItemToStock = (itemId: string, addQty: number) => {
        if (!selectedUserSave || !itemId) return;
        const currentQty = (selectedUserSave.stock || {})[itemId] || 0;
        handleUpdateStock(itemId, currentQty + Math.max(1, Math.floor(addQty || 1)));
    };

    const handleSaveGameData = async () => {
        if (!selectedUser || !selectedUserSave) return;
        const uid = selectedUserDbId(selectedUser);
        if (uid == null) {
            alert('ID do utilizador em falta — não é possível gravar.');
            return;
        }
        const orphan = findOrphanRackRoom(selectedUserSave.placedRacks, roomOptions);
        if (orphan) {
            alert(
                `Há rigs em sala inválida (${orphan.roomId || '—'}). Remapeie para uma das ${roomOptions.length} salas activas antes de salvar.`
            );
            return;
        }
        const res = await saveGameStateAdminOverride(
            uid,
            buildAdminSaveOverrideDelta(selectedUserSave),
            { reason: 'admin_users_panel' }
        );
        if (res.ok) {
            const refreshed = await getGameState(selectedUser.email, { adminOverride: true });
            let nextSave = refreshed.data
                ? {
                    ...refreshed.data,
                    stock: sanitizeAdminStock(res.stock ?? refreshed.data.stock)
                }
                : {
                    ...selectedUserSave,
                    stock: sanitizeAdminStock(res.stock ?? adminStockPayloadForSave(selectedUserSave.stock)),
                    ...(res.placedRacks ? { placedRacks: res.placedRacks } : {})
                };
            try {
                const boxesRes = await apiFetch(
                    `/api/admin/user-boxes?email=${encodeURIComponent(selectedUser.email)}&t=${Date.now()}`
                );
                const boxesData = await boxesRes.json();
                const boxes = boxesData.boxes || [];
                setUserBoxes(boxes);
                const fromApi: Record<string, number> = {};
                for (const b of boxes) {
                    const id = String(b.boxId ?? b.box_id ?? b.id ?? '').trim();
                    const qty = Math.floor(Number(b.qty ?? b.quantity ?? 0));
                    if (id && Number.isFinite(qty) && qty > 0) fromApi[id] = qty;
                }
                if (Object.keys(fromApi).length > 0 || Array.isArray(boxes)) {
                    nextSave = { ...nextSave, unopenedBoxes: fromApi };
                }
            } catch {
                /* ignore */
            }
            setSelectedUserSave(nextSave);
            alert('Dados do jogo salvos com sucesso!');
        } else {
            const err = res.error || (res.forceReload ? 'Conflito de dados (Server restart required?)' : 'Erro desconhecido');
            const code = typeof res.code === 'string' && res.code.trim() ? res.code.trim() : '';
            alert(`Erro ao salvar: ${err}${code ? ` [${code}]` : ''}`);
        }
    };

    // --- ACCESS LEVEL LOGIC ---
    const handleNewLevel = () => {
        setLevelForm({
            id: '', name: '', description: '', isDefault: false, isActive: true, priceUsdc: 0, contractAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', inactiveMessage: ''
        });
        setEditLevelMode(true);
    };

    const handleEditLevel = (level: AccessLevel) => {
        setLevelForm({ ...level });
        setEditLevelMode(true);
    };

    const handleSaveLevel = () => {
        if (!onUpdateAccessLevels || !levelForm.id || !levelForm.name) return;

        const existingIndex = accessLevels.findIndex(l => l.id === levelForm.id);
        const newLevel = levelForm as AccessLevel;
        let updatedLevels = [...accessLevels];

        if (newLevel.isDefault) {
            updatedLevels = updatedLevels.map(l => ({ ...l, isDefault: false }));
        }

        if (existingIndex >= 0) {
            updatedLevels[existingIndex] = newLevel;
        } else {
            updatedLevels.push(newLevel);
        }

        if (!updatedLevels.some(l => l.isDefault)) {
            newLevel.isDefault = true;
            if (existingIndex >= 0) updatedLevels[existingIndex] = newLevel;
        }

        onUpdateAccessLevels(updatedLevels);
        setEditLevelMode(false);
    };

    const handleDeleteLevel = () => {
        if (!onUpdateAccessLevels || !levelForm.id) return;
        const targetId = levelForm.id!;
        let updatedLevels = accessLevels.filter(l => l.id !== targetId);
        if (updatedLevels.length === 0) {
            setEditLevelMode(false);
            return;
        }
        if (!updatedLevels.some(l => l.isDefault)) {
            updatedLevels = updatedLevels.map((l, i) => ({ ...l, isDefault: i === 0 }));
        }
        onUpdateAccessLevels(updatedLevels);
        setEditLevelMode(false);
    };

    const handleNewUpgrade = () => {
        const mkid = (crypto && typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : `up_${Math.random().toString(36).slice(2, 10)}`;
        setUpgradeForm({ id: mkid, name: '', description: '', priceUsdc: 0, grantUsdc: 0, grantAccessLevelId: '', isActive: true, items: [], boxes: [], passes: [], coins: [], visibleToAccessLevelIds: [] });
        setEditUpgradeMode(true);
        setUpgradeError('');
    };

    const handleEditUpgrade = (u: AdminUpgrade) => {
        setUpgradeForm({ ...u });
        setEditUpgradeMode(true);
        setUpgradeError('');
    };

    const handleSaveUpgrade = async () => {
        if (savingUpgrade) return;
        let id = upgradeForm.id || '';
        if (!id) id = (crypto && typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : `up_${Math.random().toString(36).slice(2, 10)}`;
        const name = (upgradeForm.name || '').trim();
        if (!name) {
            setUpgradeError('Preencha o nome do upgrade.');
            return;
        }
        setUpgradeError('');
        setSavingUpgrade(true);
        const payload: AdminUpgrade = {
            id,
            name,
            description: upgradeForm.description || '',
            priceUsdc: typeof upgradeForm.priceUsdc === 'number' ? upgradeForm.priceUsdc : parseFloat(String(upgradeForm.priceUsdc || 0)),
            grantUsdc: typeof upgradeForm.grantUsdc === 'number' ? upgradeForm.grantUsdc : parseFloat(String(upgradeForm.grantUsdc || 0)),
            grantAccessLevelId: (upgradeForm.grantAccessLevelId || '') || undefined,
            isActive: upgradeForm.isActive !== false,
            items: (upgradeForm.items || []).map(it => ({ itemId: it.itemId, qty: parseInt(String(it.qty || 0)) || 0 })).filter(x => x.itemId && x.qty > 0),
            boxes: (upgradeForm.boxes || []).map(b => ({ boxId: b.boxId, qty: parseInt(String(b.qty || 0)) || 0 })).filter(x => x.boxId && x.qty > 0),
            passes: Array.isArray(upgradeForm.passes) ? upgradeForm.passes : [],
            coins: (upgradeForm.coins || []).map(c => ({ coinId: c.coinId, amount: parseFloat(String(c.amount || 0)) || 0 })).filter(x => x.coinId && x.amount > 0),
            visibleToAccessLevelIds: Array.isArray(upgradeForm.visibleToAccessLevelIds) ? upgradeForm.visibleToAccessLevelIds : []
        };
        try {
            const res = await createAdminUpgrade(payload);
            if (res && res.ok) {
                const list = await getAdminUpgrades();
                setAdminUpgradesState(list);
                setEditUpgradeMode(false);
                setSavingUpgrade(false);
                alert('Upgrade criado/atualizado');
                return;
            }
            setSavingUpgrade(false);
            setUpgradeError('Falha ao salvar upgrade.');
        } catch {
            setSavingUpgrade(false);
        }
    };

    const handleDeleteUpgrade = async () => {
        if (!upgradeForm.id) return;
        if (!window.confirm(`Tem certeza que deseja excluir o upgrade "${upgradeForm.name}"?`)) return;

        setSavingUpgrade(true);
        try {
            const res = await deleteAdminUpgrade(upgradeForm.id);
            if (res.ok) {
                const list = await getAdminUpgrades();
                setAdminUpgradesState(list);
                setEditUpgradeMode(false);
                setSavingUpgrade(false);
                const isNew = adminUpgrades.findIndex(u => u.id === upgradeForm.id) === -1;
                alert(isNew ? 'Upgrade descartado.' : 'Upgrade excluído com sucesso.');
            } else {
                setSavingUpgrade(false);
                setUpgradeError(res.error || 'Falha ao excluir upgrade.');
            }
        } catch {
            setSavingUpgrade(false);
            setUpgradeError('Erro de rede ao excluir upgrade.');
        }
    };

    const handleSaveModel = async () => {
        setIsSavingModel(true);
        try {
            const res = await saveReferralModel(modelForm);
            if (res.ok) {
                const models = await getReferralModels();
                setReferralModels(models);
                setEditModelMode(false);
                alert('Modelo de indicação salvo!');
            } else {
                alert('Erro ao salvar modelo: ' + (res.error || 'Erro desconhecido'));
            }
        } catch (e) {
            console.error(e);
            alert('Erro de exceção ao salvar modelo.');
        }
        setIsSavingModel(false);
    };

    const handleDeleteModel = async (id: number) => {
        if (!window.confirm('Excluir este modelo?')) return;
        try {
            const res = await deleteReferralModel(id);
            if (res.ok) {
                const models = await getReferralModels();
                setReferralModels(models);
            }
        } catch (e) { console.error(e); }
    };

    const handleSaveAssignments = async () => {
        setIsSavingAssignments(true);
        try {
            const res = await saveAccessLevelReferralAssignments(levelAssignments);
            if (res.ok) {
                alert('Atribuições salvas com sucesso!');
            } else {
                alert('Erro ao salvar atribuições.');
            }
        } catch (e) { console.error(e); }
        setIsSavingAssignments(false);
    };



    if (selectedUser) {
        const editingSelectedOther =
            String((selectedUser.email || '').trim().toLowerCase()) !== String((user?.email || '').trim().toLowerCase());
        /** Email de outro admin: inalterável sem ser super (alinhado ao PUT /api/user). */
        const lockAdminEmail =
            !!selectedUser.isAdmin && editingSelectedOther && !actorIsSuperForCreds;
        /** Senha de outra conta super: só super (admin normal pode alterar senha de outros admins). */
        const lockSuperAdminPassword =
            !!selectedUser.isSuperAdmin && editingSelectedOther && !actorIsSuperForCreds;

        const canDeleteSelectedUser =
            !selectedUser.isAdmin ||
            canManageAdminAccounts ||
            selectedUserDbId(selectedUser) === selectedUserDbId(user ?? null);

        return (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 animate-in fade-in slide-in-from-right-4">
                <div className="lg:col-span-2">
                    <button
                        onClick={() => {
                            jumpApplyEpochRef.current += 1;
                            onJumpToUserHandled?.();
                            setSelectedUser(null);
                            setSelectedUserSave(null);
                        }}
                        className="text-slate-400 hover:text-white flex items-center gap-2 mb-4"
                    >
                        <X size={16} /> Voltar para Lista
                    </button>
                </div>

                {/* EDIT PROFILE */}
                <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 h-fit">
                    <div className="flex justify-between items-center mb-4 border-b border-slate-700 pb-2">
                        <h3 className="font-bold text-white flex items-center gap-2">
                            <Edit size={16} className="text-amber-500" /> Editar Perfil
                        </h3>
                        {selectedUser.isBlocked ? (
                            <button onClick={handleToggleBlock} className="bg-green-600 text-white px-3 py-1 rounded text-xs font-bold">DESBLOQUEAR</button>
                        ) : (
                            <button onClick={handleToggleBlock} className="bg-red-600 text-white px-3 py-1 rounded text-xs font-bold">BLOQUEAR</button>
                        )}
                        {canDeleteSelectedUser ? (
                            <button onClick={handleDeleteUser} className="bg-red-700 hover:bg-red-600 text-white px-3 py-1 rounded text-xs font-bold flex items-center gap-1 ml-2"><Trash2 size={12} /> EXCLUIR</button>
                        ) : (
                            <span className="text-[10px] text-slate-500 font-bold ml-2 max-w-[140px] text-right leading-tight">
                                Exclusão de admin: só super
                            </span>
                        )}
                    </div>
                    {(lockAdminEmail || lockSuperAdminPassword) && (
                        <p className="text-xs text-amber-500/90 bg-amber-950/40 border border-amber-800/50 rounded-lg px-3 py-2 mb-3">
                            {lockAdminEmail && (
                                <>
                                    Conta <strong>administrador</strong>: só um <strong>super administrador</strong> pode alterar o <strong>email</strong> de outro admin.
                                </>
                            )}
                            {lockAdminEmail && lockSuperAdminPassword ? ' ' : null}
                            {lockSuperAdminPassword && (
                                <>
                                    Conta <strong>super administrador</strong>: só super pode alterar a <strong>senha</strong> aqui.
                                </>
                            )}
                            {' '}
                            <span className="text-slate-400">Username e carteira continuam editáveis; senhas de admins que não são super podem ser alteradas por qualquer administrador.</span>
                        </p>
                    )}
                    <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                            <div className="col-span-2">
                                <label className="text-xs uppercase text-emerald-400/90 font-bold mb-2 block">
                                    Salas do jogador
                                    {roomsSaveBusy ? (
                                        <span className="ml-2 text-amber-400 normal-case font-semibold">a gravar…</span>
                                    ) : null}
                                </label>
                                <p className="text-[10px] text-slate-500 mb-2">
                                    Cada clique grava já (não precisa de «Salvar perfil»). Só as {roomOptions.length} salas
                                    activas. Desmarcar devolve os rigs dessa sala ao estoque. Inicial, ASICs e Extra
                                    são sempre.
                                </p>
                                <div className="flex flex-wrap gap-2 bg-slate-900 p-2 rounded border border-emerald-800/40">
                                    {roomOptions.map((room) => {
                                        const isAlwaysOwned = isAlwaysOwnedRoomId(room.id);
                                        const on = isAlwaysOwned || editOwnedRoomIds.includes(room.id);
                                        const rackN = countRacksInOwnedRoom(room.id);
                                        return (
                                            <label
                                                key={room.id}
                                                className={`flex items-center gap-2 px-2 py-1 rounded border ${
                                                    on
                                                        ? `bg-emerald-900/30 border-emerald-500 ${
                                                              isAlwaysOwned ? 'cursor-default' : 'cursor-pointer'
                                                          }`
                                                        : 'bg-slate-800 border-slate-700 cursor-pointer'
                                                } ${roomsSaveBusy && !isAlwaysOwned ? 'opacity-60 pointer-events-none' : ''}`}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={on}
                                                    disabled={isAlwaysOwned || roomsSaveBusy}
                                                    onChange={(e) => {
                                                        void handleToggleOwnedRoom(room.id, e.target.checked);
                                                    }}
                                                />
                                                <span className="text-xs text-white">
                                                    {room.name}
                                                    {isAlwaysOwned ? (
                                                        <span className="text-slate-500"> (sempre)</span>
                                                    ) : null}
                                                    {rackN > 0 ? (
                                                        <span className="text-amber-400/90"> · {rackN} rig(s)</span>
                                                    ) : null}
                                                </span>
                                            </label>
                                        );
                                    })}
                                    {roomOptions.length === 0 && (
                                        <span className="text-[10px] text-slate-500">Nenhuma sala activa no catálogo.</span>
                                    )}
                                </div>
                            </div>
                            <div>
                                <label className="text-xs uppercase text-slate-500 font-bold">Username</label>
                                <input
                                    type="text"
                                    maxLength={AUTH_USERNAME_MAX}
                                    value={editProfileForm.username}
                                    onChange={(e) => {
                                        setEditProfileUsernameError(null);
                                        setEditProfileForm({ ...editProfileForm, username: e.target.value });
                                    }}
                                    className={`w-full bg-slate-900 border rounded p-2 text-white text-sm ${editProfileUsernameError ? 'border-red-500/80' : 'border-slate-700'}`}
                                />
                                {editProfileUsernameError && (
                                    <p className="text-xs text-red-400 mt-1.5" role="alert">
                                        {editProfileUsernameError}
                                    </p>
                                )}
                            </div>
                        </div>
                        <div>
                            <label className="text-xs uppercase text-slate-500 font-bold">Email</label>
                            <input
                                type="text"
                                readOnly={lockAdminEmail}
                                value={editProfileForm.email}
                                onChange={e => setEditProfileForm({ ...editProfileForm, email: e.target.value })}
                                className={`w-full bg-slate-900 border border-slate-700 rounded p-2 text-white text-sm ${lockAdminEmail ? 'opacity-60 cursor-not-allowed' : ''}`}
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-xs uppercase text-slate-500 font-bold">Senha</label>
                                <input
                                    type="password"
                                    autoComplete="new-password"
                                    readOnly={lockSuperAdminPassword}
                                    value={editProfileForm.password}
                                    onChange={(e) => setEditProfileForm({ ...editProfileForm, password: e.target.value })}
                                    placeholder={lockSuperAdminPassword ? '—' : 'Nova senha (opcional)'}
                                    className={`w-full bg-slate-900 border border-slate-700 rounded p-2 text-white text-sm font-mono ${lockSuperAdminPassword ? 'opacity-60 cursor-not-allowed' : ''}`}
                                />
                            </div>
                            <div>
                                <label className="text-xs uppercase text-slate-500 font-bold">Carteira (Polygon)</label>
                                <input type="text" value={editProfileForm.wallet} onChange={e => setEditProfileForm({ ...editProfileForm, wallet: e.target.value })} className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white text-sm font-mono" placeholder="0x..." />
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={handleUpdateUserProfile}
                            disabled={roomsSaveBusy}
                            className="w-full bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white py-2 rounded font-bold text-sm mt-2 flex items-center justify-center gap-2"
                        >
                            <Save size={14} /> SALVAR PERFIL
                        </button>
                        {resolveStreamerRoomId(roomOptions) ? (
                        <button
                            type="button"
                            onClick={handleDeactivateStreamerRoom}
                            disabled={streamerRoomBusy || !selectedUserSave}
                            className="w-full bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white py-2 rounded font-bold text-sm mt-2 flex items-center justify-center gap-2"
                        >
                            <Trash2 size={14} /> {streamerRoomBusy ? 'DESATIVANDO SALA STREAMER...' : 'DESATIVAR SALA STREAMER'}
                        </button>
                        ) : null}
                    </div>
                </div>

                {/* GAME SAVE EDITOR — estoque ocupa a linha toda, altura natural */}
                <div
                    className={`bg-slate-800 border border-slate-700 rounded-xl p-6 flex flex-col ${
                        saveTab === 'stock' ? 'lg:col-span-2 h-auto min-h-[36rem]' : 'h-[500px]'
                    }`}
                >
                    <div className="flex flex-col gap-2 mb-3 border-b border-slate-700 pb-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 flex gap-2 overflow-x-auto pb-1 flex-nowrap [-ms-overflow-style:none] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1">
                            <button type="button" onClick={() => setSaveTab('stock')} className={`shrink-0 px-3 py-1 rounded text-xs font-bold ${saveTab === 'stock' ? 'bg-amber-600 text-white' : 'bg-slate-700 text-slate-400'}`}>Estoque</button>
                            <button type="button" onClick={() => setSaveTab('racks')} className={`shrink-0 px-3 py-1 rounded text-xs font-bold ${saveTab === 'racks' ? 'bg-amber-600 text-white' : 'bg-slate-700 text-slate-400'}`}>Rigs</button>
                            <button type="button" onClick={() => setSaveTab('balances')} className={`shrink-0 px-3 py-1 rounded text-xs font-bold ${saveTab === 'balances' ? 'bg-amber-600 text-white' : 'bg-slate-700 text-slate-400'}`}>Saldos</button>
                            <button type="button" onClick={() => setSaveTab('boxes')} className={`shrink-0 px-3 py-1 rounded text-xs font-bold ${saveTab === 'boxes' ? 'bg-amber-600 text-white' : 'bg-slate-700 text-slate-400'}`}>Caixas</button>
                            <button
                                type="button"
                                onClick={() => setSaveTab('wallets')}
                                className={`shrink-0 px-3 py-1 rounded text-xs font-bold inline-flex items-center gap-1 ${saveTab === 'wallets' ? 'bg-amber-600 text-white' : 'bg-slate-700 text-slate-400'}`}
                                title="Histórico append-only de ligação / troca / remoção da carteira Polygon."
                            >
                                <Wallet size={12} /> Carteiras
                            </button>
                            <button
                                type="button"
                                onClick={() => setSaveTab('logs')}
                                className={`shrink-0 px-3 py-1 rounded text-xs font-bold inline-flex items-center gap-1 ring-inset ${saveTab === 'logs' ? 'bg-amber-600 text-white ring-2 ring-amber-400/80' : 'bg-slate-700 text-slate-200 ring-1 ring-amber-600/40'}`}
                                title="Eventos gravados no MongoDB (coleção game_activity_logs): caixas, roleta, códigos, depósitos."
                            >
                                <History size={12} /> Atividade
                            </button>
                        </div>
                        <button
                            type="button"
                            onClick={handleSaveGameData}
                            disabled={isUserSaveTabReadonly(saveTab)}
                            title={
                                isUserSaveTabReadonly(saveTab)
                                    ? 'Esta aba é só leitura — não altera o save.'
                                    : 'Guardar estoque, rigs, etc.'
                            }
                            className={`shrink-0 text-xs font-bold flex items-center gap-1 self-end sm:self-auto ${
                                isUserSaveTabReadonly(saveTab) ? 'text-slate-500 cursor-not-allowed' : 'text-green-400 hover:text-green-300'
                            }`}
                        >
                            <Save size={14} /> SALVAR DADOS
                        </button>
                    </div>
                    {saveTab !== 'logs' && saveTab !== 'wallets' && (
                        <p className="text-[10px] text-slate-500 mb-2 -mt-1">
                            Histórico do jogador: abas <span className="font-bold text-amber-500/90">Carteiras</span> e{' '}
                            <span className="font-bold text-amber-500/90">Atividade</span> são só leitura; «Salvar dados» desliga-se nessas abas.
                        </p>
                    )}

                    {saveTab === 'logs' ? (
                        <div className="flex-1 overflow-y-auto custom-scrollbar">
                            <AdminUserAuditPanel
                                userId={selectedUserDbId(selectedUser) ?? null}
                                userEmail={selectedUser?.email || ''}
                            />
                        </div>
                    ) : saveTab === 'wallets' ? (
                        <div className="flex-1 overflow-y-auto custom-scrollbar space-y-4">
                            <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
                                <h4 className="text-xs font-bold uppercase text-slate-500 mb-2">Carteira actual</h4>
                                {walletHistoryLoading ? (
                                    <div className="flex items-center gap-2 text-slate-400 text-sm">
                                        <Loader2 className="animate-spin" size={16} /> A carregar…
                                    </div>
                                ) : walletHistoryError ? (
                                    <div className="text-sm text-amber-200">{walletHistoryError}</div>
                                ) : adminWalletCurrent ? (
                                    <div className="space-y-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="text-[10px] font-bold uppercase text-emerald-400 border border-emerald-700/60 rounded px-2 py-0.5">Conectada</span>
                                            <span className="text-[10px] text-slate-500 uppercase">Polygon</span>
                                        </div>
                                        <div className="flex flex-wrap items-center gap-2 min-w-0">
                                            <code className="text-sm text-amber-100 font-mono break-all">{adminWalletCurrent.address}</code>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    void navigator.clipboard
                                                        .writeText(adminWalletCurrent.address)
                                                        .then(() => alert('Endereço copiado.'))
                                                        .catch(() => alert('Falha ao copiar.'));
                                                }}
                                                className="shrink-0 p-1.5 rounded bg-slate-700 text-slate-200 hover:bg-slate-600"
                                                title="Copiar endereço"
                                            >
                                                <Copy size={14} />
                                            </button>
                                        </div>
                                        {adminWalletCurrent.connectedAt ? (
                                            <p className="text-[11px] text-slate-500">
                                                Última ligação registada: {new Date(adminWalletCurrent.connectedAt).toLocaleString('pt-PT')}
                                            </p>
                                        ) : null}
                                    </div>
                                ) : (
                                    <p className="text-sm text-slate-400">Nenhuma carteira conectada actualmente.</p>
                                )}
                            </div>
                            <div className="rounded-xl border border-slate-700 bg-slate-950/40 p-4">
                                <h4 className="text-xs font-bold uppercase text-slate-500 mb-2">Histórico</h4>
                                {!walletHistoryLoading && adminWalletHistory.length === 0 ? (
                                    <p className="text-sm text-slate-500 italic py-6 text-center">Sem alterações registadas.</p>
                                ) : !walletHistoryLoading ? (
                                    <div className="overflow-x-auto rounded-lg border border-slate-800">
                                        <table className="w-full text-left text-[11px] min-w-[960px]">
                                            <thead className="bg-slate-900 text-slate-500 uppercase text-[9px] font-bold">
                                                <tr>
                                                    <th className="px-2 py-2">Data</th>
                                                    <th className="px-2 py-2">Acção</th>
                                                    <th className="px-2 py-2">Anterior</th>
                                                    <th className="px-2 py-2">Nova</th>
                                                    <th className="px-2 py-2">Afectada</th>
                                                    <th className="px-2 py-2">Rede</th>
                                                    <th className="px-2 py-2">IP</th>
                                                    <th className="px-2 py-2">User-agent</th>
                                                    <th className="px-2 py-2">Origem</th>
                                                    <th className="px-2 py-2">Notas</th>
                                                    <th className="px-2 py-2 text-right">Copiar</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-slate-800">
                                                {adminWalletHistory.map((row) => {
                                                    const uaShort =
                                                        row.userAgent && row.userAgent.length > 72
                                                            ? `${row.userAgent.slice(0, 72)}…`
                                                            : row.userAgent || '—';
                                                    const actionPt =
                                                        row.action === 'connected'
                                                            ? 'Conectada'
                                                            : row.action === 'changed'
                                                              ? 'Trocada'
                                                              : row.action === 'removed'
                                                                ? 'Removida'
                                                                : row.action === 'admin_changed'
                                                                  ? 'Alterada (admin)'
                                                                  : row.action;
                                                    const origin =
                                                        row.actorType === 'admin'
                                                            ? 'admin'
                                                            : row.actorType === 'system'
                                                              ? 'sistema'
                                                              : row.source || 'utilizador';
                                                    return (
                                                        <tr key={row.id} className="hover:bg-slate-900/50 align-top">
                                                            <td className="px-2 py-2 text-slate-400 whitespace-nowrap font-mono text-[10px]">
                                                                {new Date(row.createdAt).toLocaleString('pt-PT')}
                                                            </td>
                                                            <td className="px-2 py-2">
                                                                <span className="inline-block rounded border border-amber-700/50 bg-amber-950/40 px-1.5 py-0.5 text-[9px] font-bold text-amber-100">
                                                                    {actionPt}
                                                                </span>
                                                            </td>
                                                            <td className="px-2 py-2 font-mono text-slate-300 break-all max-w-[140px]">{row.previousWalletAddress || '—'}</td>
                                                            <td className="px-2 py-2 font-mono text-slate-300 break-all max-w-[140px]">{row.newWalletAddress || '—'}</td>
                                                            <td className="px-2 py-2 font-mono text-amber-100/90 break-all max-w-[140px]">{row.walletAddress || '—'}</td>
                                                            <td className="px-2 py-2 text-slate-500">{row.network}</td>
                                                            <td className="px-2 py-2 text-slate-500 font-mono text-[10px]">{row.ipAddress || '—'}</td>
                                                            <td className="px-2 py-2 text-slate-500 text-[10px]" title={row.userAgent || ''}>
                                                                {uaShort}
                                                            </td>
                                                            <td className="px-2 py-2 text-slate-400">{origin}</td>
                                                            <td className="px-2 py-2 text-slate-500 max-w-[140px] break-words">{row.notes || '—'}</td>
                                                            <td className="px-2 py-2 text-right">
                                                                {row.walletAddress ? (
                                                                    <button
                                                                        type="button"
                                                                        className="p-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700"
                                                                        title="Copiar endereço afectado"
                                                                        onClick={() => {
                                                                            void navigator.clipboard
                                                                                .writeText(row.walletAddress as string)
                                                                                .then(() => alert('Copiado.'))
                                                                                .catch(() => alert('Falha ao copiar.'));
                                                                        }}
                                                                    >
                                                                        <Copy size={12} />
                                                                    </button>
                                                                ) : (
                                                                    '—'
                                                                )}
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                ) : null}
                                {selectedUserDbId(selectedUser) != null ? (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const id = selectedUserDbId(selectedUser);
                                            if (!id) return;
                                            setWalletHistoryLoading(true);
                                            setWalletHistoryError(null);
                                            void getAdminUserWalletHistory(id).then((r) => {
                                                setWalletHistoryLoading(false);
                                                if (r.ok) {
                                                    setAdminWalletCurrent(r.currentWallet);
                                                    setAdminWalletHistory(r.history);
                                                } else {
                                                    setWalletHistoryError(r.error || 'Erro');
                                                    setAdminWalletCurrent(null);
                                                    setAdminWalletHistory([]);
                                                }
                                            });
                                        }}
                                        className="mt-3 text-xs font-bold text-amber-500 hover:text-amber-400 uppercase"
                                    >
                                        Actualizar histórico
                                    </button>
                                ) : null}
                            </div>
                            <p className="text-[10px] text-slate-600">Registos append-only no PostgreSQL; alterações via perfil (assinatura) ou painel admin.</p>
                        </div>
                    ) : selectedUserSave ? (
                        <div className="flex-1 overflow-y-auto custom-scrollbar">
                            {saveTab === 'stock' && (
                                <UserStockEditor
                                    stock={selectedUserSave.stock}
                                    gameUpgrades={effectiveUpgrades}
                                    onUpdateQty={handleUpdateStock}
                                    onAddItem={handleAddItemToStock}
                                />
                            )}

                            {saveTab === 'racks' && (
                                <div className="space-y-2">
                                    {(selectedUserSave.placedRacks || []).map((rack, _idx) => {
                                        const rackDef = effectiveUpgrades.find(u => u.id === rack.itemId);
                                        const rid = String(rack.roomId || '').trim() || 'room_initial';
                                        const roomOk = isActiveRoomId(roomOptions, rid);
                                        return (
                                            <div key={rack.id} className={`flex justify-between items-start gap-2 bg-slate-900 p-2 rounded border ${roomOk ? 'border-slate-700' : 'border-red-700/80'}`}>
                                                <div className="flex items-start gap-2 min-w-0 flex-1">
                                                    <span className="text-lg">{rackDef?.icon || '🗄️'}</span>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="text-sm font-bold text-white">{rackDef?.name || 'Rig Desconhecido'}</div>
                                                        <div className="text-[10px] text-slate-500">
                                                            {rack.isOn ? 'LIGADO' : 'DESLIGADO'} • Bateria: ∞
                                                        </div>
                                                        <div className="mt-1 flex flex-wrap items-center gap-2">
                                                            <label className="text-[9px] uppercase text-slate-500 font-bold">Sala</label>
                                                            <select
                                                                value={roomOk ? rid : ''}
                                                                onChange={(e) => handleRemapRackRoom(rack.id, e.target.value)}
                                                                className="max-w-full bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-[11px] text-white"
                                                            >
                                                                {!roomOk ? (
                                                                    <option value="">Sala inválida: {rid}</option>
                                                                ) : null}
                                                                {roomOptions.map((room) => (
                                                                    <option key={room.id} value={room.id}>
                                                                        {room.name}
                                                                    </option>
                                                                ))}
                                                            </select>
                                                            {!roomOk ? (
                                                                <span className="text-[9px] font-bold text-red-400">Remapear obrigatório</span>
                                                            ) : (
                                                                <span className="text-[9px] text-slate-500">{roomNameById(roomOptions, rid)}</span>
                                                            )}
                                                        </div>
                                                        <div className="text-[9px] text-slate-400 mt-1 grid grid-cols-2 gap-x-2">
                                                            <div>Slots: {(rack.slots || []).filter(s => s).length > 0 ? (rack.slots || []).filter(s => s).map(s => effectiveUpgrades.find(u => u.id === s)?.name || s).join(', ') : 'Vazio'}</div>
                                                            <div>Mult: {(rack.multiplierSlots || []).filter(s => s).length > 0 ? (rack.multiplierSlots || []).filter(s => s).map(s => effectiveUpgrades.find(u => u.id === s)?.name || s).join(', ') : 'Vazio'}</div>
                                                            <div>Bat: {rack.batteryId ? (effectiveUpgrades.find(u => u.id === rack.batteryId)?.name || rack.batteryId) : '-'}</div>
                                                            <div>Fio: {rack.wiringId ? (effectiveUpgrades.find(u => u.id === rack.wiringId)?.name || rack.wiringId) : '-'}</div>
                                                        </div>
                                                    </div>
                                                </div>
                                                <button onClick={() => handleDeleteRack(rack.id)} className="text-red-500 hover:text-red-400 p-2 bg-red-900/20 rounded shrink-0">
                                                    <Trash2 size={14} />
                                                </button>
                                            </div>
                                        );
                                    })}
                                    {(selectedUserSave.placedRacks || []).length === 0 && <div className="text-slate-500 text-center text-sm p-4">Nenhum rig instalado.</div>}
                                </div>
                            )}

                            {saveTab === 'balances' && (
                                <div className="space-y-3">
                                    <div className="bg-slate-900 p-3 rounded border border-slate-700">
                                        <div className="flex items-center justify-between">
                                            <div className="text-sm font-bold text-white">USDC</div>
                                            <input
                                                type="number"
                                                value={selectedUserSave.usdc}
                                                onChange={(e) => handleUpdateUsdc(parseFloat(e.target.value))}
                                                className="w-24 bg-slate-800 border border-slate-600 rounded p-1 text-right text-white text-sm"
                                            />
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        {miningCoins.map(c => (
                                            <div key={c.id} className="bg-slate-900 p-3 rounded border border-slate-700 flex items-center justify-between">
                                                <div>
                                                    <div className="text-sm font-bold text-white">{c.name}</div>
                                                    <div className="text-[10px] text-slate-500">{c.id}</div>
                                                </div>
                                                <input
                                                    type="number"
                                                    value={(selectedUserSave.coinBalances || {})[c.id] || 0}
                                                    onChange={(e) => handleUpdateCoinBalance(c.id, parseFloat(e.target.value))}
                                                    className="w-24 bg-slate-800 border border-slate-600 rounded p-1 text-right text-white text-sm"
                                                />
                                            </div>
                                        ))}
                                        {miningCoins.length === 0 && (
                                            <div className="text-slate-500 text-center text-sm p-4">Nenhuma moeda configurada.</div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {saveTab === 'boxes' && (
                                <div className="space-y-4">
                                    <div className="bg-slate-900/50 p-2 rounded text-xs text-slate-400 mb-2">
                                        Gerencie as caixas não abertas do usuário. Você pode deletar caixas vazias ou inválidas.
                                    </div>
                                    <div className="space-y-2">
                                        {userBoxes.length > 0 ? (
                                            userBoxes.map((box, idx) => {
                                                const boxDef = lootBoxes.find(lb => lb.id === box.box_id);
                                                const hasItems = boxDef && (boxDef.items || []).length > 0;

                                                return (
                                                    <div key={idx} className={`bg-slate-900 p-3 rounded border ${hasItems ? 'border-slate-700' : 'border-red-900'} flex justify-between items-center`}>
                                                        <div className="flex items-center gap-3">
                                                            <div className="w-12 h-12 rounded bg-slate-800 flex items-center justify-center text-2xl border border-slate-700">
                                                                {boxDef?.icon || '🎁'}
                                                            </div>
                                                            <div>
                                                                <div className="font-bold text-white flex items-center gap-2">
                                                                    {boxDef?.name || 'Caixa Desconhecida'}
                                                                    {!hasItems && (
                                                                        <span className="text-[9px] bg-red-900/50 text-red-400 px-2 py-0.5 rounded border border-red-900 font-bold">
                                                                            SEM ITENS
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                <div className="text-[10px] text-slate-500">
                                                                    ID: {box.box_id.substring(0, 8)}... • Quantidade: {box.qty}
                                                                </div>
                                                                {hasItems && boxDef && (
                                                                    <div className="text-[9px] text-slate-400 mt-1">
                                                                        {(boxDef.items || []).length} item(ns) definido(s)
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                        <button
                                                            onClick={async () => {
                                                                if (!selectedUser) return;
                                                                if (!window.confirm(`Deletar ${box.qty}x "${boxDef?.name || 'Caixa'}" do inventário de ${selectedUser.username}?`)) return;

                                                                try {
                                                                    const res = await apiFetch('/api/admin/delete-user-box', {
                                                                        method: 'POST',
                                                                        headers: { 'Content-Type': 'application/json' },
                                                                        body: JSON.stringify({
                                                                            email: selectedUser.email,
                                                                            boxId: box.box_id
                                                                        })
                                                                    });
                                                                    const data = await res.json();

                                                                    if (data.ok) {
                                                                        alert('Caixa deletada com sucesso!');

                                                                        // Atualizar o estado principal (evita que a caixa "volte" ao clicar em Salvar Dados)
                                                                        if (selectedUserSave && selectedUserSave.unopenedBoxes) {
                                                                            const updatedBoxes = { ...selectedUserSave.unopenedBoxes };
                                                                            delete updatedBoxes[box.box_id];
                                                                            setSelectedUserSave({ ...selectedUserSave, unopenedBoxes: updatedBoxes });
                                                                        }

                                                                        // Recarregar caixas
                                                                        const boxesRes = await apiFetch(`/api/admin/user-boxes?email=${encodeURIComponent(selectedUser.email)}&t=${Date.now()}`);
                                                                        const boxesData = await boxesRes.json();
                                                                        setUserBoxes(boxesData.boxes || []);
                                                                    } else {
                                                                        alert('Erro ao deletar caixa: ' + (data.error || 'Erro desconhecido'));
                                                                    }
                                                                } catch (_e) {
                                                                    alert('Erro de rede ao deletar caixa.');
                                                                }
                                                            }}
                                                            className="text-red-500 hover:text-red-400 p-2 rounded hover:bg-red-900/20"
                                                            title="Deletar Caixa"
                                                        >
                                                            <Trash2 size={16} />
                                                        </button>
                                                    </div>
                                                );
                                            })
                                        ) : (
                                            <div className="text-slate-500 text-center text-sm p-4">
                                                Nenhuma caixa não aberta.
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="flex items-center justify-center h-full text-slate-500 italic">
                            Sem dados de jogo iniciados.
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <>
            <div className="animate-in fade-in slide-in-from-right-4">
                <div className="flex gap-2 mb-4 border-b border-slate-700 pb-2">
                    <button onClick={() => { setCurrentPage(1); setSubTab('users'); }} className={`px-3 py-2 text-sm font-bold uppercase rounded ${subTab === 'users' ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                        Gestão de Usuários
                    </button>
                    <button
                        onClick={() => { setCurrentPage(1); setSubTab('admin_staff'); }}
                        className={`px-3 py-2 text-sm font-bold uppercase rounded inline-flex items-center gap-1.5 ${subTab === 'admin_staff' ? 'bg-red-700 text-white' : 'text-slate-400 hover:text-white'}`}
                        title="Contas com acesso ao painel admin (operador ou super)"
                    >
                        <Shield size={14} className={subTab === 'admin_staff' ? 'text-white' : 'text-red-400'} />
                        Admins
                    </button>
                    {/* Planos/níveis ocultos do fluxo de salas — catálogo só via API se necessário */}
                    <button onClick={() => setSubTab('admin_upgrades')} className={`px-3 py-2 text-sm font-bold uppercase rounded ${subTab === 'admin_upgrades' ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                        Upgrades
                    </button>
                    <button onClick={() => setSubTab('referrals')} className={`px-3 py-2 text-sm font-bold uppercase rounded ${subTab === 'referrals' ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                        Indicação
                    </button>
                    <button onClick={() => setSubTab('advanced_referrals')} className={`px-3 py-2 text-sm font-bold uppercase rounded ${subTab === 'advanced_referrals' ? 'bg-orange-600 text-white' : 'text-slate-400 hover:text-white hover:bg-orange-900/10'}`}>
                        Indicação Avançada
                    </button>
                    <button onClick={() => setSubTab('ranking')} className={`px-3 py-2 text-sm font-bold uppercase rounded ${subTab === 'ranking' ? 'bg-amber-600 text-white' : 'text-orange-400 hover:text-orange-300 hover:bg-orange-900/20'} flex items-center gap-1`}>
                        <Trophy size={14} /> Ranking
                    </button>
                    <button
                        type="button"
                        onClick={() => setSubTab('dormant_no_mining')}
                        className={`px-3 py-2 text-sm font-bold uppercase rounded inline-flex items-center gap-1.5 ${subTab === 'dormant_no_mining' ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-white'}`}
                        title="Contas antigas sem nenhuma rig com mineração ligada (is_on=1)"
                    >
                        <Pickaxe size={14} className={subTab === 'dormant_no_mining' ? 'text-white' : 'text-amber-400'} />
                        Sem mineração
                    </button>
                    <button
                        type="button"
                        onClick={() => setSubTab('dormant_mining_no_wallet')}
                        className={`px-3 py-2 text-sm font-bold uppercase rounded inline-flex items-center gap-1.5 ${subTab === 'dormant_mining_no_wallet' ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-white'}`}
                        title="Contas antigas com rig ligada e sem carteira Polygon no perfil"
                    >
                        <Unplug size={14} className={subTab === 'dormant_mining_no_wallet' ? 'text-white' : 'text-amber-400'} />
                        Mineram sem carteira
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setCurrentPage(1);
                            setSubTab('suspicious_emails');
                        }}
                        className={`px-3 py-2 text-sm font-bold uppercase rounded inline-flex items-center gap-1.5 ${subTab === 'suspicious_emails' ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-white'}`}
                        title="Listar contas com emails inválidos, temporários ou duplicados (só leitura)"
                    >
                        <AtSign size={14} className={subTab === 'suspicious_emails' ? 'text-white' : 'text-amber-400'} />
                        Emails suspeitos
                    </button>
                </div>

                {subTab === 'suspicious_emails' && isAllowed('users') && requestOpenUserInEditor && (
                    <AdminSuspiciousEmailsPanel requestOpenUserInEditor={requestOpenUserInEditor} />
                )}

                {(subTab === 'users' || subTab === 'admin_staff') && isAllowed('users') && (
                    <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="text-white font-bold flex items-center gap-2">
                                {subTab === 'admin_staff' ? (
                                    <>
                                        <Shield size={20} className="text-red-500" /> Administradores
                                    </>
                                ) : (
                                    <>
                                        <Users size={20} className="text-amber-500" /> Lista de Usuários
                                    </>
                                )}
                            </h3>
                            <div className="flex items-center gap-3">
                                {selectedEmails.size > 0 && (
                                    <div className="flex items-center gap-2 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 animate-in slide-in-from-top-2">
                                        <span className="text-xs font-bold text-amber-500 mr-2">{selectedEmails.size} selecionados</span>
                                        <button
                                            onClick={() => setShowMassGiftModal(true)}
                                            className="bg-amber-600 hover:bg-amber-500 text-white text-[10px] font-bold py-1 px-3 rounded flex items-center gap-1"
                                        >
                                            <Gift size={12} /> PRESENTEAR
                                        </button>
                                        <button
                                            onClick={() => void handleBulkBlock()}
                                            disabled={isProcessingBulk}
                                            className="bg-red-800 hover:bg-red-700 text-white text-[10px] font-bold py-1 px-3 rounded flex items-center gap-1 disabled:opacity-50"
                                        >
                                            {isProcessingBulk ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />} BLOQUEAR
                                        </button>
                                        <button
                                            onClick={handleBulkDelete}
                                            disabled={isProcessingBulk}
                                            className="bg-red-600 hover:bg-red-500 text-white text-[10px] font-bold py-1 px-3 rounded flex items-center gap-1 disabled:opacity-50"
                                        >
                                            {isProcessingBulk ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} APAGAR
                                        </button>
                                        <button onClick={() => setSelectedEmails(new Set())} className="text-slate-500 hover:text-white ml-1">
                                            <X size={14} />
                                        </button>
                                    </div>
                                )}
                                <div className="flex flex-wrap items-center gap-2">
                                    <div className="relative">
                                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
                                        <input
                                            type="text"
                                            value={searchQuery}
                                            onChange={(e) => {
                                                setSearchQuery(e.target.value);
                                                setCurrentPage(1);
                                            }}
                                            placeholder="Buscar..."
                                            className="bg-slate-900 border border-slate-700 rounded-lg pl-10 pr-4 py-2 text-sm text-white focus:border-amber-500 outline-none w-48"
                                        />
                                    </div>

                                    <select
                                        value={sortBy}
                                        onChange={(e) => { setSortBy(e.target.value); setCurrentPage(1); }}
                                        className="bg-slate-900 border border-slate-700 text-white text-xs rounded p-2 outline-none"
                                    >
                                        <option value="creation">Criação</option>
                                        <option value="alpha">A-Z</option>
                                    </select>
                                    <button
                                        onClick={() => setSortDir(prev => prev === 'asc' ? 'desc' : 'asc')}
                                        className="bg-slate-900 border border-slate-700 text-white p-2 rounded hover:bg-slate-800"
                                        title={sortDir === 'asc' ? 'Crescente' : 'Decrescente'}
                                    >
                                        {sortDir === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
                                    </button>

                                    <select
                                        value={filterStatus}
                                        onChange={(e) => { setFilterStatus(e.target.value); setCurrentPage(1); }}
                                        className="bg-slate-900 border border-slate-700 text-white text-xs rounded p-2 outline-none"
                                    >
                                        <option value="all">Todos Status</option>
                                        <option value="online">Online</option>
                                        <option value="offline">Offline</option>
                                    </select>

                                    <select
                                        value={filterLevel}
                                        onChange={(e) => { setFilterLevel(e.target.value); setCurrentPage(1); }}
                                        className="bg-slate-900 border border-slate-700 text-white text-xs rounded p-2 outline-none"
                                    >
                                        <option value="all">Todos Níveis</option>
                                        {accessLevels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                                    </select>

                                    <select
                                        value={filterRoom}
                                        onChange={(e) => {
                                            const nextRoom = e.target.value;
                                            setFilterRoom(nextRoom);
                                            if (nextRoom !== 'all') {
                                                setSearchQuery('');
                                                setFilterStatus('all');
                                                setFilterLevel('all');
                                            }
                                            setCurrentPage(1);
                                        }}
                                        className="bg-slate-900 border border-slate-700 text-white text-xs rounded p-2 outline-none"
                                    >
                                        <option value="all">Todas Salas</option>
                                        {roomOptions.map((room) => (
                                            <option key={room.id} value={room.id}>{room.name}</option>
                                        ))}
                                    </select>

                                    {isLoadingUsers && <Loader2 size={16} className="text-amber-500 animate-spin" />}
                                </div>
                            </div>
                        </div>

                        <div className="overflow-x-auto">
                            <table className="w-full text-sm text-left">
                                <thead className="text-xs text-slate-500 uppercase bg-slate-900/50">
                                    <tr>
                                        <th className="px-4 py-3 w-10">
                                            <button
                                                onClick={() => handleSelectAll(paginatedUsers.map(u => u.email))}
                                                className="text-slate-500 hover:text-amber-500 transition-colors"
                                            >
                                                {selectedEmails.size === paginatedUsers.length && paginatedUsers.length > 0 ? <CheckSquare size={18} /> : <Square size={18} />}
                                            </button>
                                        </th>
                                        <th className="px-4 py-3 cursor-pointer hover:text-white" onClick={() => handleSort('status')}>
                                            <div className="flex items-center gap-1">Status {sortConfig.key === 'status' && (sortConfig.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</div>
                                        </th>
                                        <th className="px-4 py-3 cursor-pointer hover:text-white" onClick={() => handleSort('accessLevel')}>
                                            <div className="flex items-center gap-1">Nível {sortConfig.key === 'accessLevel' && (sortConfig.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</div>
                                        </th>
                                        {subTab === 'admin_staff' && (
                                            <th className="px-4 py-3 text-slate-500 uppercase text-xs font-bold">Função</th>
                                        )}
                                        <th className="px-4 py-3 cursor-pointer hover:text-white" onClick={() => handleSort('username')}>
                                            <div className="flex items-center gap-1">Username {sortConfig.key === 'username' && (sortConfig.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</div>
                                        </th>
                                        <th className="px-4 py-3 cursor-pointer hover:text-white" onClick={() => handleSort('email')}>
                                            <div className="flex items-center gap-1">Email {sortConfig.key === 'email' && (sortConfig.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</div>
                                        </th>
                                        <th className="px-4 py-3 text-right">Ações</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-700">
                                    {paginatedUsers.map((u, i) => (
                                        <tr key={i} className={`hover:bg-slate-700/50 ${selectedEmails.has(u.email) ? 'bg-amber-900/10' : ''}`}>
                                            <td className="px-4 py-3">
                                                <button
                                                    onClick={() => handleToggleSelect(u.email)}
                                                    className={`${selectedEmails.has(u.email) ? 'text-amber-500' : 'text-slate-600'} hover:text-amber-400 transition-colors`}
                                                >
                                                    {selectedEmails.has(u.email) ? <CheckSquare size={18} /> : <Square size={18} />}
                                                </button>
                                            </td>
                                            <td className="px-4 py-3">
                                                {u.isBlocked ? (
                                                    <span className="bg-red-900/50 text-red-400 px-2 py-1 rounded text-xs font-bold border border-red-900">BLOQUEADO</span>
                                                ) : (
                                                    <div className="flex flex-col gap-1">
                                                        <span className="bg-green-900/50 text-green-400 px-2 py-1 rounded text-xs font-bold border border-green-900 w-fit">ATIVO</span>
                                                        {u.lastActiveAt && (Date.now() - u.lastActiveAt) < 30000 && !u.isAdmin && (
                                                            <span className="flex items-center gap-1 text-[10px] text-green-500 font-bold animate-pulse">
                                                                <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span> ONLINE
                                                            </span>
                                                        )}
                                                    </div>
                                                )}
                                            </td>
                                            <td className="px-4 py-3 text-slate-300">{accessLevels.find(l => l.id === u.accessLevelId)?.name || 'N/A'}</td>
                                            {subTab === 'admin_staff' && (
                                                <td className="px-4 py-3">
                                                    {u.isSuperAdmin ? (
                                                        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-1 rounded border border-amber-600/60 text-amber-300 bg-amber-950/40">Super admin</span>
                                                    ) : (
                                                        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-1 rounded border border-red-800/60 text-red-300 bg-red-950/30">Admin</span>
                                                    )}
                                                </td>
                                            )}
                                            <td className="px-4 py-3 font-bold text-white">{u.username}</td>
                                            <td className="px-4 py-3 text-slate-400">{u.email}</td>
                                            <td className="px-4 py-3 text-right">
                                                <button
                                                    onClick={() => handleSelectUser(u)}
                                                    className="bg-slate-700 hover:bg-slate-600 text-white px-3 py-1 rounded text-xs font-bold inline-flex items-center justify-center"
                                                    title="Gerenciar"
                                                    aria-label="Gerenciar"
                                                >
                                                    <Cog size={14} />
                                                </button>
                                                {!u.isAdmin && (
                                                    <button
                                                        onClick={async () => {
                                                            if (window.confirm(`Deseja acessar a conta de ${u.username}? Você será redirecionado.`)) {
                                                                const res = await impersonateUser(u.email);
                                                                if (res.ok) {
                                                                    window.location.reload();
                                                                } else {
                                                                    alert(res.error || 'Falha ao acessar conta');
                                                                }
                                                            }
                                                        }}
                                                        className="bg-orange-700 hover:bg-orange-600 text-white px-3 py-1 rounded text-xs font-bold inline-flex items-center justify-center ml-2"
                                                        title="Acessar Conta"
                                                        aria-label="Acessar Conta"
                                                    >
                                                        <LogIn size={14} />
                                                    </button>
                                                )}
                                                {canManageAdminAccounts && (
                                                <button
                                                    onClick={() => handleOpenPermissions(u)}
                                                    className={`px-3 py-1 rounded text-xs font-bold inline-flex items-center justify-center ml-2 border transition-colors ${u.isAdmin ? 'bg-red-600/20 border-red-600 text-red-500 hover:bg-red-600/30' : 'bg-slate-700 hover:bg-slate-600 border-slate-600 text-white'}`}
                                                    title={
                                                        u.isAdmin
                                                            ? u.isSuperAdmin
                                                                ? 'Super admin — editar ou remover acesso'
                                                                : 'Operador admin — editar separadores ou remover acesso'
                                                            : 'Conceder acesso admin'
                                                    }
                                                >
                                                    <Shield size={14} className={u.isAdmin ? 'animate-pulse' : ''} />
                                                </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {/* Pagination Controls */}
                        <div className="flex justify-between items-center mt-6 pt-6 border-t border-slate-700">
                            <div className="text-sm text-slate-400">
                                Mostrando <span className="text-white font-bold">{paginatedUsers.length}</span> de <span className="text-white font-bold">{totalUsersCount}</span>{' '}
                                {subTab === 'admin_staff' ? 'administradores' : 'usuários'}
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                    disabled={currentPage === 1 || isLoadingUsers}
                                    className="bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white px-4 py-2 rounded font-bold text-xs transition-colors"
                                >
                                    Anterior
                                </button>
                                <div className="bg-slate-900 border border-slate-700 px-4 py-2 rounded text-xs text-white">
                                    Página <span className="text-amber-500 font-bold">{currentPage}</span> de <span className="text-white font-bold">{totalPages}</span>
                                </div>
                                <button
                                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                                    disabled={currentPage === totalPages || isLoadingUsers}
                                    className="bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white px-4 py-2 rounded font-bold text-xs transition-colors"
                                >
                                    Próxima
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {subTab === 'access_levels' && (
                    <AccessLevelsCatalog
                        accessLevels={accessLevels}
                        editLevelMode={editLevelMode}
                        levelForm={levelForm}
                        setLevelForm={setLevelForm}
                        setEditLevelMode={setEditLevelMode}
                        handleNewLevel={handleNewLevel}
                        handleEditLevel={handleEditLevel}
                        handleSaveLevel={handleSaveLevel}
                        handleDeleteLevel={handleDeleteLevel}
                    />
                )}

                {subTab === 'admin_upgrades' && (
                    <div className="grid grid-cols-1 gap-6">
                        <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 flex flex-col">
                            <div className="flex justify-between items-center mb-4">
                                <h3 className="font-bold text-white">Upgrades</h3>
                                <button onClick={handleNewUpgrade} className="bg-green-600 text-white text-xs px-2 py-1 rounded flex items-center gap-1">
                                    <PlusCircle size={12} /> NOVO
                                </button>
                            </div>
                            <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2">
                                {adminUpgrades.map(u => (
                                    <div key={u.id} onClick={() => handleEditUpgrade(u)} className={`p-3 rounded border cursor-pointer hover:border-yellow-500 ${u.isActive ? 'bg-slate-900 border-slate-700' : 'bg-slate-900/50 border-slate-800'}`}>
                                        <div className="flex justify-between items-start">
                                            <div className="font-bold text-white">{u.name}</div>
                                            <div className="text-xs text-yellow-400 font-mono">${u.priceUsdc} USDC</div>
                                        </div>
                                        <div className="text-xs text-slate-400 mt-1 whitespace-pre-wrap line-clamp-2">{u.description}</div>
                                    </div>
                                ))}
                                {adminUpgrades.length === 0 && <div className="text-slate-500 text-center text-sm p-4">Nenhum upgrade configurado.</div>}
                            </div>
                        </div>

                        <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 overflow-y-auto">
                            {editUpgradeMode ? (
                                <div className="space-y-4">
                                    <h3 className="font-bold text-white border-b border-slate-700 pb-2 mb-4">{upgradeForm.id ? `Editando: ${upgradeForm.name}` : 'Novo Upgrade'}</h3>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label className="text-xs font-bold text-slate-500 block mb-1">ID</label>
                                            <input type="text" value={upgradeForm.id} onChange={e => setUpgradeForm({ ...upgradeForm, id: e.target.value })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" />
                                        </div>
                                        <div>
                                            <label className="text-xs font-bold text-slate-500 block mb-1">Ativo</label>
                                            <label className="flex items-center gap-2 cursor-pointer">
                                                <input type="checkbox" checked={upgradeForm.isActive !== false} onChange={e => setUpgradeForm({ ...upgradeForm, isActive: e.target.checked })} />
                                                <span className="text-sm text-slate-300">Ativo</span>
                                            </label>
                                        </div>
                                        <div className="col-span-2">
                                            <label className="text-xs font-bold text-slate-500 block mb-1">Nome</label>
                                            <input type="text" value={upgradeForm.name || ''} onChange={e => setUpgradeForm({ ...upgradeForm, name: e.target.value })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" />
                                        </div>
                                        <div className="col-span-2">
                                            <label className="text-xs font-bold text-slate-500 block mb-1">Descrição</label>
                                            <textarea
                                                value={upgradeForm.description || ''}
                                                onChange={e => setUpgradeForm({ ...upgradeForm, description: e.target.value })}
                                                className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm min-h-[80px] resize-y"
                                                placeholder="Descreva o que este upgrade oferece..."
                                            />
                                        </div>
                                        <div>
                                            <label className="text-xs font-bold text-slate-500 block mb-1">Preço (USDC)</label>
                                            <input type="number" value={upgradeForm.priceUsdc ?? 0} onChange={e => setUpgradeForm({ ...upgradeForm, priceUsdc: parseFloat(e.target.value) })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" />
                                        </div>
                                        <div>
                                            <label className="text-xs font-bold text-slate-500 block mb-1">Crédito USDC</label>
                                            <input type="number" value={upgradeForm.grantUsdc ?? 0} onChange={e => setUpgradeForm({ ...upgradeForm, grantUsdc: parseFloat(e.target.value) })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" />
                                        </div>
                                        <div className="col-span-2">
                                            <label className="text-xs font-bold text-slate-500 block mb-1">Nível concedido ao comprar</label>
                                            <select value={upgradeForm.grantAccessLevelId || ''} onChange={e => setUpgradeForm({ ...upgradeForm, grantAccessLevelId: e.target.value })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm">
                                                <option value="">Nenhum</option>
                                                {accessLevels.map(l => (<option key={l.id} value={l.id}>{l.name}</option>))}
                                            </select>
                                        </div>
                                        <div className="col-span-2">
                                            <label className="text-xs font-bold text-slate-500 block mb-1">Visível para Planos / níveis</label>
                                            <div className="flex flex-wrap gap-2 bg-slate-900 p-2 rounded border border-slate-600">
                                                {accessLevels.map(l => {
                                                    const isChecked = (upgradeForm.visibleToAccessLevelIds || []).includes(l.id);
                                                    return (
                                                        <label key={l.id} className="flex items-center gap-2 cursor-pointer bg-slate-800 px-2 py-1 rounded border border-slate-700 hover:border-amber-500">
                                                            <input
                                                                type="checkbox"
                                                                checked={isChecked}
                                                                onChange={e => {
                                                                    const current = new Set(upgradeForm.visibleToAccessLevelIds || []);
                                                                    if (e.target.checked) current.add(l.id); else current.delete(l.id);
                                                                    setUpgradeForm({ ...upgradeForm, visibleToAccessLevelIds: Array.from(current) });
                                                                }}
                                                            />
                                                            <span className="text-xs font-bold text-white">{l.name}</span>
                                                        </label>
                                                    );
                                                })}
                                                {accessLevels.length === 0 && <span className="text-xs text-slate-500">Nenhum nível configurado.</span>}
                                            </div>
                                            <p className="text-[10px] text-slate-500 mt-1">Se nenhum for selecionado, será visível para TODOS.</p>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div className="bg-slate-900 p-3 rounded border border-slate-700">
                                            <div className="flex justify-between items-center mb-2">
                                                <div className="text-xs uppercase font-bold text-slate-400">Itens</div>
                                                <button onClick={() => setUpgradeForm({ ...upgradeForm, items: [...(upgradeForm.items || []), { itemId: gameUpgrades[0]?.id || '', qty: 1 }] })} className="text-xs bg-slate-700 text-white px-2 py-1 rounded">Adicionar</button>
                                            </div>
                                            <div className="space-y-2">
                                                {(upgradeForm.items || []).map((it, idx) => (
                                                    <div key={idx} className="flex items-center gap-2">
                                                        <select value={it.itemId} onChange={e => {
                                                            const arr = [...(upgradeForm.items || [])];
                                                            arr[idx] = { ...arr[idx], itemId: e.target.value };
                                                            setUpgradeForm({ ...upgradeForm, items: arr });
                                                        }} className="flex-1 bg-slate-800 border border-slate-600 rounded p-2 text-white text-sm">
                                                            {gameUpgrades.map(g => (<option key={g.id} value={g.id}>{g.name}</option>))}
                                                        </select>
                                                        <input type="number" min={1} step={1} value={Math.max(1, it.qty || 1)} onChange={e => {
                                                            const val = Math.max(1, parseInt(e.target.value || '1'));
                                                            const arr = [...(upgradeForm.items || [])];
                                                            arr[idx] = { ...arr[idx], qty: val };
                                                            setUpgradeForm({ ...upgradeForm, items: arr });
                                                        }} className="w-20 bg-slate-800 border border-slate-600 rounded p-2 text-white text-sm" />
                                                        <button onClick={() => {
                                                            const arr = [...(upgradeForm.items || [])];
                                                            arr.splice(idx, 1);
                                                            setUpgradeForm({ ...upgradeForm, items: arr });
                                                        }} className="text-red-400">Remover</button>
                                                    </div>
                                                ))}
                                                {(upgradeForm.items || []).length === 0 && <div className="text-slate-500 text-xs">Nenhum item.</div>}
                                            </div>
                                        </div>
                                        <div className="bg-slate-900 p-3 rounded border border-slate-700">
                                            <div className="flex justify-between items-center mb-2">
                                                <div className="text-xs uppercase font-bold text-slate-400">Caixas</div>
                                                <button onClick={() => setUpgradeForm({ ...upgradeForm, boxes: [...(upgradeForm.boxes || []), { boxId: lootBoxes[0]?.id || '', qty: 1 }] })} className="text-xs bg-slate-700 text-white px-2 py-1 rounded">Adicionar</button>
                                            </div>
                                            <div className="space-y-2">
                                                {(upgradeForm.boxes || []).map((b, idx) => (
                                                    <div key={idx} className="flex items-center gap-2">
                                                        <select value={b.boxId} onChange={e => {
                                                            const arr = [...(upgradeForm.boxes || [])];
                                                            arr[idx] = { ...arr[idx], boxId: e.target.value };
                                                            setUpgradeForm({ ...upgradeForm, boxes: arr });
                                                        }} className="flex-1 bg-slate-800 border border-slate-600 rounded p-2 text-white text-sm">
                                                            {lootBoxes.map(g => (<option key={g.id} value={g.id}>{g.name}</option>))}
                                                        </select>
                                                        <input type="number" min={1} step={1} value={Math.max(1, b.qty || 1)} onChange={e => {
                                                            const val = Math.max(1, parseInt(e.target.value || '1'));
                                                            const arr = [...(upgradeForm.boxes || [])];
                                                            arr[idx] = { ...arr[idx], qty: val };
                                                            setUpgradeForm({ ...upgradeForm, boxes: arr });
                                                        }} className="w-20 bg-slate-800 border border-slate-600 rounded p-2 text-white text-sm" />
                                                        <button onClick={() => {
                                                            const arr = [...(upgradeForm.boxes || [])];
                                                            arr.splice(idx, 1);
                                                            setUpgradeForm({ ...upgradeForm, boxes: arr });
                                                        }} className="text-red-400">Remover</button>
                                                    </div>
                                                ))}
                                                {(upgradeForm.boxes || []).length === 0 && <div className="text-slate-500 text-xs">Nenhuma caixa.</div>}
                                            </div>
                                        </div>
                                        <div className="bg-slate-900 p-3 rounded border border-slate-700">
                                            <div className="text-xs uppercase font-bold text-slate-400 mb-2">Passes</div>
                                            <div className="space-y-2">
                                                {seasonPasses.map(p => {
                                                    const checked = (upgradeForm.passes || []).includes(p.id);
                                                    return (
                                                        <label key={p.id} className="flex items-center gap-2 text-sm text-white">
                                                            <input type="checkbox" checked={checked} onChange={e => {
                                                                const set = new Set(upgradeForm.passes || []);
                                                                if (e.target.checked) set.add(p.id); else set.delete(p.id);
                                                                setUpgradeForm({ ...upgradeForm, passes: Array.from(set) });
                                                            }} />
                                                            <span>{p.name}</span>
                                                        </label>
                                                    );
                                                })}
                                                {seasonPasses.length === 0 && <div className="text-slate-500 text-xs">Nenhum passe.</div>}
                                            </div>
                                        </div>
                                        <div className="bg-slate-900 p-3 rounded border border-slate-700">
                                            <div className="flex justify-between items-center mb-2">
                                                <div className="text-xs uppercase font-bold text-slate-400">Criptos</div>
                                                <button onClick={() => setUpgradeForm({ ...upgradeForm, coins: [...(upgradeForm.coins || []), { coinId: miningCoins[0]?.id || '', amount: 0 }] })} className="text-xs bg-slate-700 text-white px-2 py-1 rounded">Adicionar</button>
                                            </div>
                                            <div className="space-y-2">
                                                {(upgradeForm.coins || []).map((c, idx) => (
                                                    <div key={idx} className="flex items-center gap-2">
                                                        <select value={c.coinId} onChange={e => {
                                                            const arr = [...(upgradeForm.coins || [])];
                                                            arr[idx] = { ...arr[idx], coinId: e.target.value };
                                                            setUpgradeForm({ ...upgradeForm, coins: arr });
                                                        }} className="flex-1 bg-slate-800 border border-slate-600 rounded p-2 text-white text-sm">
                                                            {miningCoins.map(g => (<option key={g.id} value={g.id}>{g.name}</option>))}
                                                        </select>
                                                        <input type="number" min={0} value={Math.max(0, c.amount || 0)} onChange={e => {
                                                            const val = Math.max(0, parseFloat(e.target.value || '0'));
                                                            const arr = [...(upgradeForm.coins || [])];
                                                            arr[idx] = { ...arr[idx], amount: val };
                                                            setUpgradeForm({ ...upgradeForm, coins: arr });
                                                        }} className="w-24 bg-slate-800 border border-slate-600 rounded p-2 text-white text-sm" />
                                                        <button onClick={() => {
                                                            const arr = [...(upgradeForm.coins || [])];
                                                            arr.splice(idx, 1);
                                                            setUpgradeForm({ ...upgradeForm, coins: arr });
                                                        }} className="text-red-400">Remover</button>
                                                    </div>
                                                ))}
                                                {(upgradeForm.coins || []).length === 0 && <div className="text-slate-500 text-xs">Nenhuma cripto.</div>}
                                            </div>
                                        </div>
                                    </div>

                                    {upgradeError && (
                                        <div className="text-red-400 text-xs font-bold mt-2">{upgradeError}</div>
                                    )}
                                    <div className="flex gap-4 pt-4">
                                        <button onClick={() => setEditUpgradeMode(false)} className="bg-slate-700 text-white px-4 py-2 rounded font-bold text-sm">CANCELAR</button>
                                        {upgradeForm.id && adminUpgrades.some(u => u.id === upgradeForm.id) && (
                                            <button onClick={handleDeleteUpgrade} disabled={savingUpgrade} className="bg-red-900 border border-red-700 text-red-200 hover:bg-red-800 px-4 py-2 rounded font-bold text-sm">
                                                EXCLUIR
                                            </button>
                                        )}
                                        <button onClick={handleSaveUpgrade} disabled={savingUpgrade} className={`px-4 py-2 rounded font-bold text-sm flex-1 ${savingUpgrade ? 'bg-yellow-800 text-yellow-200' : 'bg-yellow-600 text-white'}`}>{savingUpgrade ? 'SALVANDO...' : 'SALVAR UPGRADE'}</button>
                                    </div>
                                </div>
                            ) : (
                                <div className="h-full flex items-center justify-center text-slate-500">Selecione um upgrade para editar.</div>
                            )}
                        </div>
                    </div>
                )}

                {subTab === 'referrals' && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <div className="lg:col-span-2 bg-slate-800 border border-slate-700 rounded-xl p-6">
                            <h3 className="font-bold text-white mb-4">Prêmios para Quem Indica</h3>
                            <div className="grid grid-cols-2 gap-3 mb-4">
                                <div>
                                    <label className="text-xs text-slate-400 font-bold">Nome</label>
                                    <input type="text" value={referralSenderBoxForm.name || ''} onChange={e => setReferralSenderBoxForm({ ...referralSenderBoxForm, name: e.target.value })} className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white text-sm" />
                                </div>
                                <div>
                                    <label className="text-xs text-slate-400 font-bold">Ícone</label>
                                    <input type="text" value={referralSenderBoxForm.icon || '🎁'} onChange={e => setReferralSenderBoxForm({ ...referralSenderBoxForm, icon: e.target.value })} className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white text-sm" />
                                </div>
                                <div className="col-span-2">
                                    <label className="text-xs text-slate-400 font-bold">Descrição</label>
                                    <input type="text" value={referralSenderBoxForm.description || ''} onChange={e => setReferralSenderBoxForm({ ...referralSenderBoxForm, description: e.target.value })} className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white text-sm" />
                                </div>
                            </div>
                            <div className="bg-slate-900 rounded p-3 border border-slate-700">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="text-xs uppercase font-bold text-slate-400">Itens da Caixa</div>
                                    <button onClick={() => {
                                        const items = [...(referralSenderBoxForm.items || [])];
                                        items.push({ ...newSenderItem });
                                        setReferralSenderBoxForm({ ...referralSenderBoxForm, items });
                                        setNewSenderItem({ type: 'currency', id: 'usdc', minQty: 1, maxQty: 1, probability: 50 });
                                    }} className="text-xs bg-slate-700 text-white px-2 py-1 rounded">Adicionar</button>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                    <div className="flex items-center gap-2">
                                        <select value={newSenderItem.type} onChange={e => setNewSenderItem({ ...newSenderItem, type: e.target.value as unknown, id: '' })} className="bg-slate-800 border border-slate-600 rounded p-2 text-white text-sm">
                                            <option value="currency">USDC</option>
                                            <option value="coin">Criptomoeda Minerável</option>
                                        </select>
                                        {newSenderItem.type === 'currency' && (
                                            <select value={newSenderItem.id} onChange={e => setNewSenderItem({ ...newSenderItem, id: e.target.value })} className="flex-1 bg-slate-800 border border-slate-600 rounded p-2 text-white text-sm">
                                                <option value="">Selecione...</option>
                                                <option value="usdc">USDC</option>
                                            </select>
                                        )}
                                        {newSenderItem.type === 'coin' && (
                                            <select value={newSenderItem.id} onChange={e => setNewSenderItem({ ...newSenderItem, id: e.target.value })} className="flex-1 bg-slate-800 border border-slate-600 rounded p-2 text-white text-sm">
                                                <option value="">Selecione...</option>
                                                {miningCoins.map(c => (<option key={c.id} value={c.id}>{c.name}</option>))}
                                            </select>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <input type="number" min={1} value={newSenderItem.minQty} onChange={e => setNewSenderItem({ ...newSenderItem, minQty: Math.max(1, parseInt(e.target.value || '1')) })} className="w-24 bg-slate-800 border border-slate-600 rounded p-2 text-white text-sm" />
                                        <input type="number" min={newSenderItem.minQty} value={newSenderItem.maxQty} onChange={e => setNewSenderItem({ ...newSenderItem, maxQty: Math.max(newSenderItem.minQty, parseInt(e.target.value || String(newSenderItem.minQty))) })} className="w-24 bg-slate-800 border border-slate-600 rounded p-2 text-white text-sm" />
                                        <input type="number" min={0} max={100} value={newSenderItem.probability} onChange={e => setNewSenderItem({ ...newSenderItem, probability: Math.min(100, Math.max(0, parseFloat(e.target.value || '0'))) })} className="w-24 bg-slate-800 border border-slate-600 rounded p-2 text-white text-sm" />
                                    </div>
                                </div>
                                <div className="mt-3 space-y-2">
                                    {(referralSenderBoxForm.items || []).map((it, idx) => (
                                        <div key={idx} className="flex items-center justify-between bg-slate-800 p-2 rounded border border-slate-700">
                                            <div className="text-sm text-white">
                                                <span className="font-bold">{it.type.toUpperCase()}</span> • <span className="font-mono">{it.id}</span> • x{it.minQty}-{it.maxQty} • {it.probability}%
                                            </div>
                                            <button onClick={() => {
                                                const arr = [...(referralSenderBoxForm.items || [])];
                                                arr.splice(idx, 1);
                                                setReferralSenderBoxForm({ ...referralSenderBoxForm, items: arr });
                                            }} className="text-red-400 text-xs">Remover</button>
                                        </div>
                                    ))}
                                    {(referralSenderBoxForm.items || []).length === 0 && <div className="text-slate-500 text-xs">Nenhum item configurado.</div>}
                                </div>
                            </div>
                            <button
                                onClick={async () => {
                                    const senderBox: LootBox = { ...(referralSenderBoxForm as LootBox), trigger: 'referral_sender', price: 0 };
                                    const next = [...lootBoxes];
                                    const si = next.findIndex(b => b.trigger === 'referral_sender'); if (si >= 0) next[si] = senderBox; else next.push(senderBox);
                                    setLootBoxesState(next);
                                    const r = await setLootBoxes(next, { replaceCatalog: false });
                                    if (r.warnings?.length) {
                                        alert('Gravado. Aviso:\n\n' + r.warnings.join('\n\n'));
                                    } else {
                                        alert('Prêmios de Indicação salvos com sucesso!');
                                    }
                                }}
                                className="w-full bg-green-600 hover:bg-green-500 text-white py-3 rounded-lg font-bold text-sm mt-6 flex items-center justify-center gap-2 shadow-lg shadow-green-900/20 active:scale-[0.98] transition-all"
                            >
                                <Save size={16} /> SALVAR CONFIGURAÇÕES DE INDICAÇÃO
                            </button>
                        </div>

                        <div className="lg:col-span-2 bg-slate-800 border border-slate-700 rounded-xl p-6">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="font-bold text-white flex items-center gap-2"><Trophy size={18} className="text-yellow-400" /> Ranking de Indicações</h3>
                                <span className="text-xs text-slate-400">Top usuários por número de indicados</span>
                            </div>
                            {(() => {
                                const pageSize = 25;
                                const ranking = userMap
                                    .map(u => ({ username: u.username, email: u.email, count: (u.referrals || []).length, referrals: u.referrals || [] }))
                                    .filter(r => !(excludeSelf && user && r.email === user.email))
                                    .sort((a, b) => b.count - a.count);
                                const totalPages = Math.max(1, Math.ceil(ranking.length / pageSize));
                                const start = (refPage - 1) * pageSize;
                                const pageItems = ranking.slice(start, start + pageSize);
                                return (
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-3">
                                                <div className="text-xs text-slate-400">Página {refPage} de {totalPages}</div>
                                                <label className="flex items-center gap-2 text-xs text-slate-300">
                                                    <input type="checkbox" checked={excludeSelf} onChange={e => setExcludeSelf(e.target.checked)} disabled={!user} />
                                                    <span>Ocultar meu usuário</span>
                                                </label>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <button onClick={() => setRefPage(p => Math.max(1, p - 1))} className="px-3 py-1 text-xs rounded bg-slate-700 text-white disabled:opacity-50" disabled={refPage <= 1}>Anterior</button>
                                                <button onClick={() => setRefPage(p => Math.min(totalPages, p + 1))} className="px-3 py-1 text-xs rounded bg-slate-700 text-white disabled:opacity-50" disabled={refPage >= totalPages}>Próxima</button>
                                            </div>
                                        </div>
                                        <div className="overflow-x-auto">
                                            <table className="w-full text-sm text-left">
                                                <thead className="text-xs text-slate-400 uppercase bg-slate-900/40">
                                                    <tr>
                                                        <th className="px-4 py-2">Pos.</th>
                                                        <th className="px-4 py-2">Usuário</th>
                                                        <th className="px-4 py-2">Email</th>
                                                        <th className="px-4 py-2 text-right">Indicados</th>
                                                        <th className="px-4 py-2 text-right">Ações</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-slate-700">
                                                    {pageItems.map((r, idx) => {
                                                        const pos = start + idx + 1;
                                                        const isExpanded = expandedEmail === r.email;
                                                        const details = r.referrals
                                                            .map(name => {
                                                                const match = userMap.find(u => u.username === name);
                                                                return { username: name, email: match?.email || '—' };
                                                            })
                                                            .filter(d => !(excludeSelfInDetails && d.username === r.username));
                                                        return (
                                                            <React.Fragment key={r.email}>
                                                                <tr className="hover:bg-slate-700/40">
                                                                    <td className="px-4 py-2 text-slate-300">{pos}</td>
                                                                    <td className="px-4 py-2 font-bold text-white">{r.username}</td>
                                                                    <td className="px-4 py-2 text-slate-400">{r.email}</td>
                                                                    <td className="px-4 py-2 text-right font-mono text-yellow-400">{r.count}</td>
                                                                    <td className="px-4 py-2 text-right">
                                                                        <button onClick={() => setExpandedEmail(e => e === r.email ? null : r.email)} className="text-xs px-2 py-1 rounded bg-slate-700 text-white">
                                                                            {isExpanded ? 'Fechar' : 'Ver indicados'}
                                                                        </button>
                                                                    </td>
                                                                </tr>
                                                                {isExpanded && (
                                                                    <tr>
                                                                        <td colSpan={5} className="px-4 py-3 bg-slate-900/40">
                                                                            <div className="flex items-center justify-between mb-2">
                                                                                <div className="text-xs text-slate-400">Indicados por {r.username}</div>
                                                                                <label className="flex items-center gap-2 text-xs text-slate-300">
                                                                                    <input type="checkbox" checked={excludeSelfInDetails} onChange={e => setExcludeSelfInDetails(e.target.checked)} />
                                                                                    <span>Ocultar auto-indicação</span>
                                                                                </label>
                                                                            </div>
                                                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                                                                {details.length > 0 ? details.map((d, i) => (
                                                                                    <div key={i} className="bg-slate-900 border border-slate-700 rounded p-2 flex justify-between">
                                                                                        <span className="text-slate-200">{d.username}</span>
                                                                                        <span className="text-slate-400">{d.email}</span>
                                                                                    </div>
                                                                                )) : (
                                                                                    <div className="text-slate-500">Sem indicados.</div>
                                                                                )}
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                )}
                                                            </React.Fragment>
                                                        );
                                                    })}
                                                    {ranking.length === 0 && (
                                                        <tr>
                                                            <td colSpan={5} className="px-4 py-6 text-center text-slate-500">Nenhum usuário com indicados ainda.</td>
                                                        </tr>
                                                    )}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                );
                            })()}
                        </div>
                    </div>
                )}
                {subTab === 'advanced_referrals' && (
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in slide-in-from-right-4">
                        {/* Models List */}
                        <div className="lg:col-span-2 bg-slate-800 border border-slate-700 rounded-xl p-6">
                            <div className="flex justify-between items-center mb-6">
                                <h3 className="text-white font-bold flex items-center gap-2">
                                    <Trophy size={20} className="text-orange-500" /> Modelos de Indicação
                                </h3>
                                <button
                                    onClick={() => {
                                        setModelForm({ name: '', description: '', sender_reward_usdc: 0, receiver_reward_usdc: 0, sender_loot_box_id: '', receiver_loot_box_id: '', is_active: 1 });
                                        setEditModelMode(true);
                                    }}
                                    className="bg-green-600 hover:bg-green-500 text-white text-xs font-bold py-1.5 px-3 rounded flex items-center gap-2"
                                >
                                    <PlusCircle size={14} /> NOVO MODELO
                                </button>
                            </div>

                            <div className="space-y-4">
                                {referralModels.map(m => (
                                    <div key={m.id} className="bg-slate-900 border border-slate-700 rounded-lg p-4 flex justify-between items-center">
                                        <div>
                                            <div className="font-bold text-white flex items-center gap-2">
                                                {m.name}
                                                {m.is_active === 0 && <span className="text-[10px] bg-red-900/50 text-red-500 px-1.5 rounded">INATIVO</span>}
                                            </div>
                                            <div className="text-xs text-slate-400">{m.description}</div>
                                            <div className="flex gap-4 mt-2">
                                                <div className="text-[10px] text-slate-500 uppercase font-bold">Indicador (Sender): <span className="text-green-400">${m.sender_reward_usdc}</span> + {m.sender_loot_box_id || 'Nenhuma'}</div>
                                                <div className="text-[10px] text-slate-500 uppercase font-bold">Indicado (Receiver): <span className="text-amber-400">${m.receiver_reward_usdc}</span> + {m.receiver_loot_box_id || 'Nenhuma'}</div>
                                            </div>
                                        </div>
                                        <div className="flex gap-2">
                                            <button onClick={() => { setModelForm(m); setEditModelMode(true); }} className="p-2 bg-slate-800 hover:bg-slate-700 rounded text-amber-400"><Edit size={14} /></button>
                                            <button onClick={() => handleDeleteModel(m.id)} className="p-2 bg-slate-800 hover:bg-red-900/40 rounded text-red-400"><Trash2 size={14} /></button>
                                        </div>
                                    </div>
                                ))}
                                {referralModels.length === 0 && <div className="text-center py-12 text-slate-500 font-medium">Nenhum modelo criado.</div>}
                            </div>
                        </div>

                        {/* Level Assignments */}
                        <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
                            <h3 className="text-white font-bold mb-6 flex items-center gap-2">
                                <Shield size={18} className="text-amber-500" /> Atribuir por Nível
                            </h3>
                            <div className="space-y-4">
                                {accessLevels.map(lvl => (
                                    <div key={lvl.id} className="space-y-1.5">
                                        <label className="text-xs font-bold text-slate-500 uppercase">{lvl.name}</label>
                                        <select
                                            value={levelAssignments[lvl.id] || ''}
                                            onChange={e => setLevelAssignments({ ...levelAssignments, [lvl.id]: e.target.value ? parseInt(e.target.value) : (null as unknown) })}
                                            className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-sm text-white focus:border-orange-500 outline-none"
                                        >
                                            <option value="">Padrão do Sistema (Triggers)</option>
                                            {referralModels.map(m => (
                                                <option key={m.id} value={m.id}>{m.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                ))}
                                <button
                                    onClick={handleSaveAssignments}
                                    disabled={isSavingAssignments}
                                    className="w-full mt-4 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white font-bold py-2.5 rounded-lg flex items-center justify-center gap-2"
                                >
                                    {isSavingAssignments ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} SALVAR ATRIBUIÇÕES
                                </button>
                                <p className="text-[10px] text-slate-500 italic mt-2 text-center">
                                    O modelo é definido pelo nível de acesso de quem está INDICANDO.
                                </p>
                            </div>
                        </div>

                        {/* Edit Modal Overlay */}
                        {editModelMode && (
                            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                                <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-200">
                                    <div className="p-6 border-b border-slate-700 flex justify-between items-center">
                                        <h3 className="text-xl font-bold text-white">{modelForm.id ? 'Editar Modelo' : 'Novo Modelo'}</h3>
                                        <button onClick={() => setEditModelMode(false)} className="text-slate-500 hover:text-white"><X size={20} /></button>
                                    </div>
                                    <div className="p-6 space-y-4">
                                        <div>
                                            <label className="text-xs font-bold text-slate-500 uppercase block mb-1">Nome do Modelo</label>
                                            <input type="text" value={modelForm.name} onChange={e => setModelForm({ ...modelForm, name: e.target.value })} className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-sm text-white" />
                                        </div>
                                        <div>
                                            <label className="text-xs font-bold text-slate-500 uppercase block mb-1">Descrição</label>
                                            <textarea value={modelForm.description} onChange={e => setModelForm({ ...modelForm, description: e.target.value })} className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-sm text-white h-20" />
                                        </div>
                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <label className="text-xs font-bold text-slate-500 uppercase block mb-1">Prêmio Indicador ($)</label>
                                                <input type="number" step="0.01" value={modelForm.sender_reward_usdc} onChange={e => setModelForm({ ...modelForm, sender_reward_usdc: parseFloat(e.target.value) })} className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-sm text-white" />
                                            </div>
                                            <div>
                                                <label className="text-xs font-bold text-slate-500 uppercase block mb-1">Prêmio Indicado ($)</label>
                                                <input type="number" step="0.01" value={modelForm.receiver_reward_usdc} onChange={e => setModelForm({ ...modelForm, receiver_reward_usdc: parseFloat(e.target.value) })} className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-sm text-white" />
                                            </div>
                                        </div>
                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <label className="text-xs font-bold text-slate-500 uppercase block mb-1">Loot Box Indicador</label>
                                                <select value={modelForm.sender_loot_box_id || ''} onChange={e => setModelForm({ ...modelForm, sender_loot_box_id: e.target.value })} className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-sm text-white">
                                                    <option value="">Nenhuma</option>
                                                    {lootBoxes.map(lb => <option key={lb.id} value={lb.id}>{lb.name}</option>)}
                                                </select>
                                            </div>
                                            <div>
                                                <label className="text-xs font-bold text-slate-500 uppercase block mb-1">Loot Box Indicado</label>
                                                <select value={modelForm.receiver_loot_box_id || ''} onChange={e => setModelForm({ ...modelForm, receiver_loot_box_id: e.target.value })} className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-sm text-white">
                                                    <option value="">Nenhuma</option>
                                                    {lootBoxes.map(lb => <option key={lb.id} value={lb.id}>{lb.name}</option>)}
                                                </select>
                                            </div>
                                        </div>
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input type="checkbox" checked={modelForm.is_active === 1} onChange={e => setModelForm({ ...modelForm, is_active: e.target.checked ? 1 : 0 })} />
                                            <span className="text-sm text-slate-300 font-medium">Modelo Ativo</span>
                                        </label>
                                    </div>
                                    <div className="p-6 border-t border-slate-700 bg-slate-900/50 rounded-b-2xl flex gap-3">
                                        <button onClick={() => setEditModelMode(false)} className="flex-1 bg-slate-800 hover:bg-slate-700 text-white font-bold py-2.5 rounded-lg">CANCELAR</button>
                                        <button onClick={handleSaveModel} disabled={isSavingModel} className="flex-1 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white font-bold py-2.5 rounded-lg">
                                            {isSavingModel ? <Loader2 size={18} className="animate-spin mx-auto" /> : 'SALVAR'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
                {(subTab === 'dormant_no_mining' || subTab === 'dormant_mining_no_wallet') && isAllowed('users') && (
                    <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 space-y-6">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                            <div className="min-w-0 flex-1">
                                <h3 className="text-white font-bold flex items-center gap-2 text-lg">
                                    {subTab === 'dormant_no_mining' ? (
                                        <>
                                            <Pickaxe className="text-amber-500 shrink-0" size={22} />
                                            Sem mineração activa
                                        </>
                                    ) : (
                                        <>
                                            <Unplug className="text-amber-500 shrink-0" size={22} />
                                            Mineram sem carteira Polygon
                                        </>
                                    )}
                                </h3>
                                <p className="text-slate-400 text-sm mt-2 max-w-3xl leading-relaxed">
                                    {dormantNote ||
                                        (subTab === 'dormant_no_mining'
                                            ? 'Idade pela data do save no registo (game_states.start_time). Lista contas sem nenhuma rig com mineração ligada (is_on=1). Exclui bloqueados e admins.'
                                            : 'Mesma idade mínima. Lista contas com pelo menos uma rig ligada (is_on=1) e sem endereço Polygon em users.polygon_wallet.')}
                                </p>
                                {dormantMeta && (
                                    <p className="text-slate-500 text-xs mt-2 font-mono break-all">
                                        Corte (epoch ms): {dormantMeta.cutoffMs} — {dormantMeta.limitEach} contas por página em
                                        cada lista (paginação independente).
                                    </p>
                                )}
                            </div>
                            <div className="flex flex-wrap items-center gap-2 shrink-0">
                                <label className="text-xs text-slate-400 font-bold uppercase flex items-center gap-2">
                                    Idade mín.
                                    <select
                                        value={dormantDaysMin}
                                        onChange={(e) => setDormantDaysMin(Number(e.target.value))}
                                        className="bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-white text-sm font-medium normal-case"
                                    >
                                        <option value={30}>30+ dias</option>
                                        <option value={60}>60+ dias</option>
                                        <option value={90}>90+ dias</option>
                                        <option value={180}>180+ dias</option>
                                    </select>
                                </label>
                                <button
                                    type="button"
                                    onClick={() => void loadDormantMiningAccounts()}
                                    disabled={dormantLoading}
                                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm font-bold disabled:opacity-50"
                                >
                                    {dormantLoading ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
                                    Atualizar
                                </button>
                            </div>
                        </div>
                        {dormantError && (
                            <div className="rounded-lg border border-red-800 bg-red-950/40 text-red-200 text-sm px-4 py-3">{dormantError}</div>
                        )}
                        {dormantSelectedEmails.size > 0 && (
                            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-800/60 bg-amber-950/30 px-4 py-3">
                                <span className="text-xs font-bold text-amber-400">
                                    {dormantSelectedEmails.size} conta(s) seleccionada(s)
                                </span>
                                <button
                                    type="button"
                                    onClick={() => void handleDormantBulkBlock()}
                                    disabled={dormantBulkBusy}
                                    className="inline-flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-bold py-1.5 px-3 rounded disabled:opacity-50"
                                >
                                    {dormantBulkBusy ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />}
                                    BLOQUEAR
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleDormantBulkDelete()}
                                    disabled={dormantBulkBusy}
                                    className="inline-flex items-center gap-1.5 bg-red-600 hover:bg-red-500 text-white text-[10px] font-bold py-1.5 px-3 rounded disabled:opacity-50"
                                >
                                    {dormantBulkBusy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                                    EXCLUIR
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setDormantSelectedEmails(new Set())}
                                    className="text-slate-500 hover:text-white p-1"
                                    title="Limpar selecção"
                                >
                                    <X size={16} />
                                </button>
                            </div>
                        )}

                        {subTab === 'dormant_no_mining' && (
                            <section className="space-y-3">
                                <h4 className="text-white font-bold text-sm uppercase tracking-wide flex items-center gap-2 flex-wrap">
                                    <span className="w-2 h-2 rounded-full bg-slate-500 shrink-0" />
                                    Contas sem rig ligada
                                    <span className="text-slate-500 font-mono font-normal normal-case">
                                        (página: {dormantNoMining.length}
                                        {dormantMeta ? ` · total: ${dormantMeta.noMiningTotal.toLocaleString('pt-PT')}` : ''})
                                    </span>
                                </h4>
                                <div className="overflow-x-auto rounded-lg border border-slate-700">
                                    <table className="w-full text-sm text-left min-w-[720px]">
                                        <thead className="bg-slate-900 text-slate-400 uppercase text-xs">
                                            <tr>
                                                <th className="px-2 py-2 font-bold w-10">
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            handleDormantSelectAll(dormantNoMining.map((r) => r.email))
                                                        }
                                                        className="text-slate-500 hover:text-amber-500 transition-colors"
                                                        title="Seleccionar página"
                                                    >
                                                        {dormantSelectedEmails.size === dormantNoMining.length &&
                                                        dormantNoMining.length > 0 ? (
                                                            <CheckSquare size={18} />
                                                        ) : (
                                                            <Square size={18} />
                                                        )}
                                                    </button>
                                                </th>
                                                <th className="px-3 py-2 font-bold">ID</th>
                                                <th className="px-3 py-2 font-bold">Utilizador</th>
                                                <th className="px-3 py-2 font-bold">Email</th>
                                                <th className="px-3 py-2 font-bold">Início save</th>
                                                <th className="px-3 py-2 font-bold">Última actividade</th>
                                                <th className="px-3 py-2 font-bold">Ranking</th>
                                                <th className="px-3 py-2 font-bold text-right">Acções</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-700 text-slate-200">
                                            {dormantNoMining.map((r) => (
                                                <tr
                                                    key={r.id}
                                                    className={`hover:bg-slate-900/40 ${dormantSelectedEmails.has(r.email) ? 'bg-amber-900/10' : ''}`}
                                                >
                                                    <td className="px-2 py-2">
                                                        <button
                                                            type="button"
                                                            onClick={() => handleDormantToggleSelect(r.email)}
                                                            className={`${dormantSelectedEmails.has(r.email) ? 'text-amber-500' : 'text-slate-600'} hover:text-amber-400 transition-colors`}
                                                        >
                                                            {dormantSelectedEmails.has(r.email) ? (
                                                                <CheckSquare size={18} />
                                                            ) : (
                                                                <Square size={18} />
                                                            )}
                                                        </button>
                                                    </td>
                                                    <td className="px-3 py-2 font-mono text-xs">{r.id}</td>
                                                    <td className="px-3 py-2 font-medium text-white">{r.username}</td>
                                                    <td className="px-3 py-2 text-slate-300 break-all max-w-[220px]">{r.email}</td>
                                                    <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{formatAdminDormantMs(r.startTimeMs)}</td>
                                                    <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{formatAdminDormantMs(r.lastActiveAt)}</td>
                                                    <td className="px-3 py-2">
                                                        {r.rankingExcluded ? (
                                                            <span className="text-xs bg-orange-900/50 text-orange-200 px-2 py-0.5 rounded">excluído</span>
                                                        ) : (
                                                            <span className="text-slate-600">—</span>
                                                        )}
                                                    </td>
                                                    <td className="px-3 py-2 text-right whitespace-nowrap">
                                                        <div className="inline-flex items-center gap-1 justify-end">
                                                            <button
                                                                type="button"
                                                                title="Bloquear"
                                                                disabled={dormantBulkBusy}
                                                                onClick={() => void handleDormantRowBlock(r.email)}
                                                                className="p-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-white disabled:opacity-40"
                                                            >
                                                                <Lock size={14} />
                                                            </button>
                                                            <button
                                                                type="button"
                                                                title="Excluir"
                                                                disabled={dormantBulkBusy}
                                                                onClick={() => void handleDormantRowDelete(r.email)}
                                                                className="p-1.5 rounded-md bg-red-900/70 hover:bg-red-800 text-white disabled:opacity-40"
                                                            >
                                                                <Trash2 size={14} />
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))}
                                            {dormantNoMining.length === 0 && !dormantLoading && (
                                                <tr>
                                                    <td colSpan={8} className="px-3 py-8 text-center text-slate-500 text-sm">
                                                        Nenhuma conta nestes critérios.
                                                    </td>
                                                </tr>
                                            )}
                                            {dormantLoading && dormantNoMining.length === 0 && (
                                                <tr>
                                                    <td colSpan={8} className="px-3 py-8 text-center text-slate-400 text-sm">
                                                        <Loader2 className="inline animate-spin mr-2" size={16} /> A carregar…
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                                {dormantMeta && (
                                    <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-700/50 text-sm text-slate-400">
                                        <span>
                                            Página {dormantNoMiningPage} de{' '}
                                            {Math.max(
                                                1,
                                                Math.ceil(dormantMeta.noMiningTotal / Math.max(1, dormantMeta.limitEach))
                                            )}
                                        </span>
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                disabled={dormantLoading || dormantNoMiningPage <= 1}
                                                onClick={() => setDormantNoMiningPage((p) => Math.max(1, p - 1))}
                                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                                            >
                                                <ChevronLeft size={16} /> Anterior
                                            </button>
                                            <button
                                                type="button"
                                                disabled={
                                                    dormantLoading ||
                                                    dormantNoMiningPage * dormantMeta.limitEach >= dormantMeta.noMiningTotal
                                                }
                                                onClick={() => setDormantNoMiningPage((p) => p + 1)}
                                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                                            >
                                                Seguinte <ChevronRight size={16} />
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </section>
                        )}
                        {subTab === 'dormant_mining_no_wallet' && (
                            <section className="space-y-3">
                                <h4 className="text-white font-bold text-sm uppercase tracking-wide flex items-center gap-2 flex-wrap">
                                    <Unplug size={16} className="text-amber-500 shrink-0" />
                                    Contas com rig ligada e sem carteira
                                    <span className="text-slate-500 font-mono font-normal normal-case">
                                        (página: {dormantMiningNoWallet.length}
                                        {dormantMeta ? ` · total: ${dormantMeta.miningNoWalletTotal.toLocaleString('pt-PT')}` : ''})
                                    </span>
                                </h4>
                                <div className="overflow-x-auto rounded-lg border border-slate-700">
                                    <table className="w-full text-sm text-left min-w-[720px]">
                                        <thead className="bg-slate-900 text-slate-400 uppercase text-xs">
                                            <tr>
                                                <th className="px-2 py-2 font-bold w-10">
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            handleDormantSelectAll(dormantMiningNoWallet.map((r) => r.email))
                                                        }
                                                        className="text-slate-500 hover:text-amber-500 transition-colors"
                                                        title="Seleccionar página"
                                                    >
                                                        {dormantSelectedEmails.size === dormantMiningNoWallet.length &&
                                                        dormantMiningNoWallet.length > 0 ? (
                                                            <CheckSquare size={18} />
                                                        ) : (
                                                            <Square size={18} />
                                                        )}
                                                    </button>
                                                </th>
                                                <th className="px-3 py-2 font-bold">ID</th>
                                                <th className="px-3 py-2 font-bold">Utilizador</th>
                                                <th className="px-3 py-2 font-bold">Email</th>
                                                <th className="px-3 py-2 font-bold">Início save</th>
                                                <th className="px-3 py-2 font-bold">Última actividade</th>
                                                <th className="px-3 py-2 font-bold">Ranking</th>
                                                <th className="px-3 py-2 font-bold text-right">Acções</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-700 text-slate-200">
                                            {dormantMiningNoWallet.map((r) => (
                                                <tr
                                                    key={r.id}
                                                    className={`hover:bg-slate-900/40 ${dormantSelectedEmails.has(r.email) ? 'bg-amber-900/10' : ''}`}
                                                >
                                                    <td className="px-2 py-2">
                                                        <button
                                                            type="button"
                                                            onClick={() => handleDormantToggleSelect(r.email)}
                                                            className={`${dormantSelectedEmails.has(r.email) ? 'text-amber-500' : 'text-slate-600'} hover:text-amber-400 transition-colors`}
                                                        >
                                                            {dormantSelectedEmails.has(r.email) ? (
                                                                <CheckSquare size={18} />
                                                            ) : (
                                                                <Square size={18} />
                                                            )}
                                                        </button>
                                                    </td>
                                                    <td className="px-3 py-2 font-mono text-xs">{r.id}</td>
                                                    <td className="px-3 py-2 font-medium text-white">{r.username}</td>
                                                    <td className="px-3 py-2 text-slate-300 break-all max-w-[220px]">{r.email}</td>
                                                    <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{formatAdminDormantMs(r.startTimeMs)}</td>
                                                    <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{formatAdminDormantMs(r.lastActiveAt)}</td>
                                                    <td className="px-3 py-2">
                                                        {r.rankingExcluded ? (
                                                            <span className="text-xs bg-orange-900/50 text-orange-200 px-2 py-0.5 rounded">excluído</span>
                                                        ) : (
                                                            <span className="text-slate-600">—</span>
                                                        )}
                                                    </td>
                                                    <td className="px-3 py-2 text-right whitespace-nowrap">
                                                        <div className="inline-flex items-center gap-1 justify-end">
                                                            <button
                                                                type="button"
                                                                title="Bloquear"
                                                                disabled={dormantBulkBusy}
                                                                onClick={() => void handleDormantRowBlock(r.email)}
                                                                className="p-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-white disabled:opacity-40"
                                                            >
                                                                <Lock size={14} />
                                                            </button>
                                                            <button
                                                                type="button"
                                                                title="Excluir"
                                                                disabled={dormantBulkBusy}
                                                                onClick={() => void handleDormantRowDelete(r.email)}
                                                                className="p-1.5 rounded-md bg-red-900/70 hover:bg-red-800 text-white disabled:opacity-40"
                                                            >
                                                                <Trash2 size={14} />
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))}
                                            {dormantMiningNoWallet.length === 0 && !dormantLoading && (
                                                <tr>
                                                    <td colSpan={8} className="px-3 py-8 text-center text-slate-500 text-sm">
                                                        Nenhuma conta nestes critérios.
                                                    </td>
                                                </tr>
                                            )}
                                            {dormantLoading && dormantMiningNoWallet.length === 0 && (
                                                <tr>
                                                    <td colSpan={8} className="px-3 py-8 text-center text-slate-400 text-sm">
                                                        <Loader2 className="inline animate-spin mr-2" size={16} /> A carregar…
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                                {dormantMeta && (
                                    <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-700/50 text-sm text-slate-400">
                                        <span>
                                            Página {dormantMiningNoWalletPage} de{' '}
                                            {Math.max(
                                                1,
                                                Math.ceil(dormantMeta.miningNoWalletTotal / Math.max(1, dormantMeta.limitEach))
                                            )}
                                        </span>
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                disabled={dormantLoading || dormantMiningNoWalletPage <= 1}
                                                onClick={() => setDormantMiningNoWalletPage((p) => Math.max(1, p - 1))}
                                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                                            >
                                                <ChevronLeft size={16} /> Anterior
                                            </button>
                                            <button
                                                type="button"
                                                disabled={
                                                    dormantLoading ||
                                                    dormantMiningNoWalletPage * dormantMeta.limitEach >=
                                                        dormantMeta.miningNoWalletTotal
                                                }
                                                onClick={() => setDormantMiningNoWalletPage((p) => p + 1)}
                                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                                            >
                                                Seguinte <ChevronRight size={16} />
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </section>
                        )}
                    </div>
                )}
                {subTab === 'ranking' && (
                    <AdminRanking />
                )}
            </div>

            {/* MASS GIFT MODAL */}
            {showMassGiftModal && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl max-w-md w-full p-6 animate-in zoom-in-95 duration-200">
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="text-xl font-bold text-white flex items-center gap-2">
                                <Gift className="text-amber-500" /> Presentear {selectedEmails.size} Usuários
                            </h3>
                            <button onClick={() => setShowMassGiftModal(false)} className="text-slate-500 hover:text-white">
                                <X size={20} />
                            </button>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">Tipo de Presente</label>
                                <div className="grid grid-cols-2 gap-2">
                                    <button
                                        onClick={() => setMassGiftForm({ ...massGiftForm, type: 'usdc', id: '' })}
                                        className={`py-2 px-3 rounded text-xs font-bold border transition-colors ${massGiftForm.type === 'usdc' ? 'bg-amber-600 border-amber-500 text-white' : 'bg-slate-900 border-slate-700 text-slate-400'}`}
                                    >
                                        USDC
                                    </button>
                                    <button
                                        onClick={() => setMassGiftForm({ ...massGiftForm, type: 'item', id: gameUpgrades[0]?.id || '' })}
                                        className={`py-2 px-3 rounded text-xs font-bold border transition-colors ${massGiftForm.type === 'item' ? 'bg-amber-600 border-amber-500 text-white' : 'bg-slate-900 border-slate-700 text-slate-400'}`}
                                    >
                                        ITEM DO JOGO
                                    </button>
                                    <button
                                        onClick={() => setMassGiftForm({ ...massGiftForm, type: 'box', id: lootBoxes[0]?.id || '' })}
                                        className={`py-2 px-3 rounded text-xs font-bold border transition-colors ${massGiftForm.type === 'box' ? 'bg-amber-600 border-amber-500 text-white' : 'bg-slate-900 border-slate-700 text-slate-400'}`}
                                    >
                                        LOOT BOX
                                    </button>
                                    <button
                                        onClick={() => setMassGiftForm({ ...massGiftForm, type: 'coin', id: miningCoins[0]?.id || '' })}
                                        className={`py-2 px-3 rounded text-xs font-bold border transition-colors ${massGiftForm.type === 'coin' ? 'bg-amber-600 border-amber-500 text-white' : 'bg-slate-900 border-slate-700 text-slate-400'}`}
                                    >
                                        COIN BALANCE
                                    </button>
                                </div>
                            </div>

                            {massGiftForm.type !== 'usdc' && (
                                <div>
                                    <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">Selecionar {massGiftForm.type === 'item' ? 'Item' : massGiftForm.type === 'box' ? 'Box' : 'Moeda'}</label>
                                    <select
                                        value={massGiftForm.id}
                                        onChange={(e) => setMassGiftForm({ ...massGiftForm, id: e.target.value })}
                                        className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white text-sm"
                                    >
                                        {massGiftForm.type === 'item' && gameUpgrades.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                                        {massGiftForm.type === 'box' && lootBoxes.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                                        {massGiftForm.type === 'coin' && miningCoins.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                    </select>
                                </div>
                            )}

                            <div>
                                <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">Quantidade por Usuário</label>
                                <input
                                    type="number"
                                    min={0}
                                    step={massGiftForm.type === 'item' || massGiftForm.type === 'box' ? 1 : 0.01}
                                    value={massGiftForm.qty}
                                    onChange={(e) => setMassGiftForm({ ...massGiftForm, qty: parseFloat(e.target.value) || 0 })}
                                    className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white text-sm font-mono"
                                />
                            </div>

                            <div className="pt-4 flex gap-3">
                                <button
                                    onClick={() => setShowMassGiftModal(false)}
                                    className="flex-1 bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 rounded-xl transition-colors"
                                >
                                    CANCELAR
                                </button>
                                <button
                                    onClick={handleBulkGift}
                                    disabled={isProcessingBulk || massGiftForm.qty <= 0}
                                    className="flex-3 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-bold py-3 px-8 rounded-xl transition-colors flex items-center justify-center gap-2"
                                >
                                    {isProcessingBulk ? <Loader2 className="animate-spin" size={18} /> : <Gift size={18} />} ENVIAR PRESENTES
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {/* MODAL PERMISSÕES ADMIN */}
            {showPermissionsModal && permissionsUser && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-slate-800 border border-slate-700 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="p-6 border-b border-slate-700 bg-slate-800/50">
                            <h3 className="text-xl font-bold text-white flex items-center gap-3">
                                <Shield className="text-red-500" size={24} /> Configurar Acesso Admin
                            </h3>
                            <p className="text-sm text-slate-400 mt-1">Defina o nível de acesso para {permissionsUser.username}</p>
                        </div>

                        <div className="p-6 space-y-6">
                            <div className="flex items-center justify-between bg-slate-900/50 p-4 rounded-xl border border-slate-700">
                                <div>
                                    <div className="font-bold text-white">Status Administrativo</div>
                                    <div className="text-xs text-slate-500 uppercase tracking-wider">Habilitar funções de backend</div>
                                </div>
                                <button
                                    onClick={() => {
                                        const next = !adminPermsForm.isAdmin;
                                        setAdminPermsForm({
                                            ...adminPermsForm,
                                            isAdmin: next,
                                            isSuperAdmin: next ? adminPermsForm.isSuperAdmin : false
                                        });
                                    }}
                                    className={`w-14 h-7 rounded-full relative transition-colors duration-300 ${adminPermsForm.isAdmin ? 'bg-red-600' : 'bg-slate-700'}`}
                                >
                                    <div className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all duration-300 ${adminPermsForm.isAdmin ? 'left-8' : 'left-1'}`} />
                                </button>
                            </div>

                            {adminPermsForm.isAdmin && (
                                <div className="flex items-center justify-between bg-slate-900/50 p-4 rounded-xl border border-amber-900/40">
                                    <div>
                                        <div className="font-bold text-white">Super administrador</div>
                                        <div className="text-xs text-slate-500 uppercase tracking-wider">Acesso total às rotas da API (ignora mapa de separadores)</div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setAdminPermsForm({ ...adminPermsForm, isSuperAdmin: !adminPermsForm.isSuperAdmin })}
                                        className={`w-14 h-7 rounded-full relative transition-colors duration-300 ${adminPermsForm.isSuperAdmin ? 'bg-amber-600' : 'bg-slate-700'}`}
                                        title="Apenas contas com este modo podem alterar permissões de outros admins e rotas sensíveis"
                                    >
                                        <div className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all duration-300 ${adminPermsForm.isSuperAdmin ? 'left-8' : 'left-1'}`} />
                                    </button>
                                </div>
                            )}

                            {adminPermsForm.isAdmin && (
                                <div className="space-y-3 animate-in fade-in slide-in-from-top-2 duration-300">
                                    <label className="text-xs font-bold text-slate-500 uppercase tracking-widest block">Permissões de Página</label>
                                    <div className="grid grid-cols-1 gap-2 max-h-[250px] overflow-y-auto pr-2 custom-scrollbar">
                                        {[
                                            { id: 'dashboard', label: 'Dashboard Principal' },
                                            { id: 'users', label: 'Gestão de Usuários' },
                                            { id: 'shops', label: 'Lojas e Itens (Geral)' },
                                            { id: 'shops:hardware', label: '└─ Mercado de Hardware', isSub: true },
                                            { id: 'shops:blackmarket', label: '└─ Mercado Negro', isSub: true },
                                            { id: 'shops:layout', label: '└─ Layout de Rigs', isSub: true },
                                            { id: 'lootboxes', label: 'Caixas de Recompensas' },
                                            { id: 'web3', label: 'Configurações Web3' },
                                            { id: 'settings', label: 'Configurações (Geral)' },
                                            { id: 'settings:pages', label: '└─ Visibilidade de Páginas', isSub: true },
                                            { id: 'settings:rigrooms', label: '└─ Salas de Rigs', isSub: true },
                                            { id: 'settings:news', label: '└─ Sistema de News e avisos popup', isSub: true },
                                            { id: 'settings:monetization', label: '└─ Monetização', isSub: true },
                                            { id: 'reports', label: 'Relatórios Financeiros' },
                                            { id: 'transparency', label: 'Transparência (pools / gastos)' },
                                            { id: 'games', label: 'Mini-Games' },
                                            { id: 'security', label: 'Segurança (multi-contas, IPs, atividade no jogo)' },
                                            { id: 'support', label: 'Suporte (tickets dos jogadores)' },
                                            { id: 'partners', label: 'Parceiros YouTube (aprovar vídeos)' },
                                            { id: 'backup', label: 'Backups e Database' },
                                        ].map((p: unknown) => (
                                            <button
                                                key={p.id}
                                                onClick={() => togglePermission(p.id)}
                                                className={`flex items-center justify-between p-3 rounded-lg border transition-all ${adminPermsForm.permissions.includes(p.id)
                                                    ? 'bg-red-600/10 border-red-900/50 text-white'
                                                    : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-600'
                                                    } ${p.isSub ? 'ml-4 py-2 opacity-90' : 'font-bold'}`}
                                            >
                                                <span className="text-sm">{p.label}</span>
                                                {adminPermsForm.permissions.includes(p.id) ? <CheckSquare size={16} className="text-red-500" /> : <Square size={16} />}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div className="flex gap-3 pt-4">
                                <button
                                    onClick={() => setShowPermissionsModal(false)}
                                    className="flex-1 bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 rounded-xl transition-colors"
                                >
                                    CANCELAR
                                </button>
                                <button
                                    onClick={handleSavePermissions}
                                    disabled={isSavingPerms}
                                    className="flex-3 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-bold py-3 px-8 rounded-xl transition-colors flex items-center justify-center gap-2 shadow-lg shadow-red-900/20"
                                >
                                    {isSavingPerms ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />} SALVAR ACESSO
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};
