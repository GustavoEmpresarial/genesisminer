// @ts-nocheck — template legado 1:1.
import React, { useState, useEffect } from 'react';
import { SecurityStats, GameUserActivityEntry, AdminDeviceFingerprintLog } from '../lib/adminTypes';
import { getSecurityStats, addToBlacklist, removeFromBlacklist, getAdminUserActivity, getAdminDeviceFingerprints, toggleUserBlocked, getSession, getAdminSecurityBulkToolsConfig, saveAdminSecurityBulkToolsConfig, previewAdminInactiveBlock, applyAdminInactiveBlock, previewAdminForcePasswordReset, applyAdminForcePasswordReset } from '../../../shared/api/admin-legacy';
import { Shield, AlertTriangle, Users, Globe, RefreshCw, Lock, Terminal, Ban, CheckCircle, Gamepad2, Fingerprint, Eye, KeyRound, Clock, Loader2 } from 'lucide-react';

import { formatActivityEvent } from '../utils/activityEventFormatter';

function formatActivityRow(row: GameUserActivityEntry): string {
    if (row.display?.summary) return row.display.summary;
    return formatActivityEvent(row.action, row.meta).summary;
}

export const AdminSecurity: React.FC = () => {
    const [stats, setStats] = useState<SecurityStats>({
        multiAccounts: [],
        historyMultiAccounts: [],
        sharedRegistrationIps: [],
        sharedDeviceIps: [],
        sharedFingerprints: [],
        suspectedAutoReferrals: [],
        accessLogs: [],
        blacklist: [],
        blockedUsers: []
    });
    const [loading, setLoading] = useState(true);
    const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
    const [activeTab, setActiveTab] = useState<'multi' | 'registrationIps' | 'historyIps' | 'sharedDevices' | 'logs' | 'blacklist' | 'activity' | 'fingerprints' | 'bulkTools'>('multi');
    const [banningIp, setBanningIp] = useState<string | null>(null);
    const [togglingUserEmail, setTogglingUserEmail] = useState<string | null>(null);
    const [activityEmail, setActivityEmail] = useState('');
    const [activityLogs, setActivityLogs] = useState<GameUserActivityEntry[]>([]);
    const [activityLoading, setActivityLoading] = useState(false);
    const [activityError, setActivityError] = useState<string | null>(null);

    const [fpRows, setFpRows] = useState<AdminDeviceFingerprintLog[]>([]);
    const [fpTotal, setFpTotal] = useState(0);
    const [fpLoading, setFpLoading] = useState(false);
    const [fpSearch, setFpSearch] = useState('');
    const [fpEventFilter, setFpEventFilter] = useState<'all' | 'login' | 'register'>('all');
    const [fpUserIdFilter, setFpUserIdFilter] = useState('');
    const [fpDetail, setFpDetail] = useState<AdminDeviceFingerprintLog | null>(null);
    const [fpApplyTick, setFpApplyTick] = useState(0);
    const fpPageSize = 40;

    const [isSuperAdmin, setIsSuperAdmin] = useState(false);
    const [inactiveDays, setInactiveDays] = useState(90);
    const [autoBlockEnabled, setAutoBlockEnabled] = useState(false);
    const [inactivePreview, setInactivePreview] = useState<number | null>(null);
    const [inactiveCutoffMs, setInactiveCutoffMs] = useState<number | null>(null);
    const [inactivePreviewLoading, setInactivePreviewLoading] = useState(false);
    const [passwordPreview, setPasswordPreview] = useState<number | null>(null);
    const [bulkBusy, setBulkBusy] = useState<string | null>(null);
    const [bulkMsg, setBulkMsg] = useState<string | null>(null);

    const loadBulkConfig = async () => {
        const cfg = await getAdminSecurityBulkToolsConfig();
        if (cfg?.ok) {
            setInactiveDays(cfg.inactiveBlockDays);
            setAutoBlockEnabled(cfg.autoBlockEnabled);
        }
    };

    useEffect(() => {
        void getSession().then((u) => setIsSuperAdmin(!!u?.isSuperAdmin));
    }, []);

    useEffect(() => {
        if (activeTab !== 'bulkTools') return;
        void loadBulkConfig();
        void previewAdminForcePasswordReset().then((r) => setPasswordPreview(r?.targetCount ?? null));
    }, [activeTab]);

    useEffect(() => {
        if (activeTab !== 'bulkTools') return;
        setInactivePreviewLoading(true);
        const t = window.setTimeout(() => {
            void previewAdminInactiveBlock(inactiveDays).then((r) => {
                setInactivePreview(r?.inactiveCount ?? null);
                setInactiveCutoffMs(r?.cutoffMs ?? null);
                setInactivePreviewLoading(false);
            });
        }, 350);
        return () => window.clearTimeout(t);
    }, [activeTab, inactiveDays]);

    const loadSection = async (section: 'multi' | 'registrationIps' | 'historyIps' | 'sharedDevices' | 'logs' | 'blacklist') => {
        const sectionMap: Record<typeof section, string[]> = {
            multi: ['multiAccounts', 'historyMultiAccounts', 'suspectedAutoReferrals'],
            registrationIps: ['sharedRegistrationIps'],
            historyIps: ['sharedDeviceIps'],
            sharedDevices: ['sharedFingerprints'],
            logs: ['accessLogs'],
            blacklist: ['blacklist']
        };
        setLoading(true);
        const parts = sectionMap[section];
        const responses = await Promise.all(parts.map((part) => getSecurityStats(part)));
        const merged: SecurityStats = {
            multiAccounts: [],
            historyMultiAccounts: [],
            sharedRegistrationIps: [],
            sharedDeviceIps: [],
            sharedFingerprints: [],
            suspectedAutoReferrals: [],
            accessLogs: [],
            blacklist: [],
            blockedUsers: []
        };
        for (const data of responses) {
            if (!data) continue;
            merged.multiAccounts = data.multiAccounts ?? merged.multiAccounts;
            merged.historyMultiAccounts = data.historyMultiAccounts ?? merged.historyMultiAccounts;
            merged.sharedRegistrationIps = data.sharedRegistrationIps ?? merged.sharedRegistrationIps;
            merged.sharedDeviceIps = data.sharedDeviceIps ?? merged.sharedDeviceIps;
            merged.sharedFingerprints = data.sharedFingerprints ?? merged.sharedFingerprints;
            merged.suspectedAutoReferrals = data.suspectedAutoReferrals ?? merged.suspectedAutoReferrals;
            merged.accessLogs = data.accessLogs ?? merged.accessLogs;
            merged.blacklist = data.blacklist ?? merged.blacklist;
            merged.blockedUsers = data.blockedUsers ?? merged.blockedUsers;
        }
        setStats((prev) => ({ ...prev, ...merged }));
        setLoading(false);
        setLastRefresh(new Date());
    };

    useEffect(() => {
        if (activeTab !== 'fingerprints') return;
        let cancelled = false;
        (async () => {
            setFpLoading(true);
            const uidParsed = fpUserIdFilter.trim() ? parseInt(fpUserIdFilter.trim(), 10) : NaN;
            const uidOk = Number.isFinite(uidParsed) && uidParsed > 0 ? uidParsed : undefined;
            const data = await getAdminDeviceFingerprints({
                limit: fpPageSize,
                offset: 0,
                eventType: fpEventFilter === 'all' ? '' : fpEventFilter,
                userId: uidOk,
                q: fpSearch.trim() || undefined
            });
            if (cancelled) return;
            setFpLoading(false);
            if (!data) {
                setFpRows([]);
                setFpTotal(0);
                return;
            }
            setFpRows(data.rows);
            setFpTotal(data.total);
        })();
        return () => {
            cancelled = true;
        };
    }, [activeTab, fpEventFilter, fpApplyTick]);

    const applyFpFilters = () => setFpApplyTick((t) => t + 1);

    const handleFpLoadMore = async () => {
        if (fpLoading || fpRows.length >= fpTotal) return;
        setFpLoading(true);
        const uidParsed = fpUserIdFilter.trim() ? parseInt(fpUserIdFilter.trim(), 10) : NaN;
        const uidOk = Number.isFinite(uidParsed) && uidParsed > 0 ? uidParsed : undefined;
        const data = await getAdminDeviceFingerprints({
            limit: fpPageSize,
            offset: fpRows.length,
            eventType: fpEventFilter === 'all' ? '' : fpEventFilter,
            userId: uidOk,
            q: fpSearch.trim() || undefined
        });
        setFpLoading(false);
        if (data?.rows?.length) setFpRows((prev) => [...prev, ...data.rows]);
    };

    useEffect(() => {
        if (activeTab === 'activity' || activeTab === 'fingerprints' || activeTab === 'bulkTools') return;
        void loadSection(activeTab);
    }, [activeTab]);

    const handleBanIp = async (ip: string) => {
        const reason = window.prompt(`Motivo do banimento para o IP ${ip}:`, 'Multi-contas ou acesso não autorizado');
        if (reason === null) return;

        setBanningIp(ip);
        const res = await addToBlacklist(ip, reason);
        if (res.ok) {
            await loadSection(activeTab === 'activity' || activeTab === 'fingerprints' || activeTab === 'bulkTools' ? 'blacklist' : activeTab);
        } else {
            alert('Erro ao banir IP: ' + res.error);
        }
        setBanningIp(null);
    };

    const handleUnbanIp = async (ip: string) => {
        if (!window.confirm(`Deseja remover o IP ${ip} da lista negra?`)) return;

        const res = await removeFromBlacklist(ip);
        if (res.ok) {
            await loadSection('blacklist');
        } else {
            alert('Erro ao remover IP: ' + res.error);
        }
    };

    const isIpBlacklisted = (ip: string): boolean =>
        stats.blacklist.some((entry) => String(entry.ip || '').trim().toLowerCase() === String(ip || '').trim().toLowerCase());

    const handleToggleIpBan = async (ip: string) => {
        if (isIpBlacklisted(ip)) {
            await handleUnbanIp(ip);
            return;
        }
        await handleBanIp(ip);
    };

    const handleToggleUserBlocked = async (email: string, blocked: boolean) => {
        const em = String(email || '').trim();
        if (!em) return;
        const confirmMsg = blocked
            ? `Deseja bloquear o usuário ${em}?`
            : `Deseja desbloquear o usuário ${em}?`;
        if (!window.confirm(confirmMsg)) return;
        setTogglingUserEmail(em);
        const res = await toggleUserBlocked(em, blocked);
        if (res.ok) {
            await loadSection(activeTab === 'activity' || activeTab === 'fingerprints' || activeTab === 'bulkTools' ? 'blacklist' : activeTab);
        } else {
            alert(`Erro ao ${blocked ? 'bloquear' : 'desbloquear'} usuário: ` + res.error);
        }
        setTogglingUserEmail(null);
    };

    const loadUserActivity = async () => {
        setActivityLoading(true);
        setActivityError(null);
        const { logs, error } = await getAdminUserActivity(activityEmail, { limit: 100 });
        setActivityLoading(false);
        if (error) {
            setActivityLogs([]);
            setActivityError(error);
            return;
        }
        setActivityLogs(logs);
    };

    if (loading && !stats) {
        return (
            <div className="flex flex-col items-center justify-center p-12 space-y-4">
                <RefreshCw className="text-red-600 animate-spin" size={48} />
                <p className="text-slate-400 font-bold tracking-widest animate-pulse">ANALISANDO SEGURANÇA...</p>
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-red-900/30 pb-4">
                <div>
                    <h2 className="text-2xl font-bold text-white flex items-center gap-3">
                        <Shield className="text-red-600" />
                        SEGURANÇA E AUDITORIA
                    </h2>
                    <p className="text-xs text-slate-500 uppercase tracking-tighter">Proteção Avançada contra Multi-contas e Invasões</p>
                </div>
                <div className="flex items-center gap-4">
                    <span className="text-[10px] text-slate-500">ÚLTIMA SCAN: {lastRefresh.toLocaleTimeString()}</span>
                    <button
                        onClick={() => {
                            if (activeTab === 'activity' || activeTab === 'fingerprints' || activeTab === 'bulkTools') return;
                            void loadSection(activeTab);
                        }}
                        disabled={loading}
                        className="p-2 rounded bg-slate-800 border border-slate-700 text-slate-300 hover:text-white hover:border-red-600 transition-all disabled:opacity-50"
                    >
                        <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                    </button>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 p-1 bg-slate-950/50 rounded-lg border border-slate-800 w-fit">
                <button
                    onClick={() => setActiveTab('multi')}
                    className={`px-4 py-2 text-xs font-bold rounded-md transition-all flex items-center gap-2 ${activeTab === 'multi' ? 'bg-red-600 text-white shadow-lg shadow-red-900/40' : 'text-slate-500 hover:text-slate-300'}`}
                >
                    <Users size={14} /> MULTI-CONTAS
                </button>
                <button
                    onClick={() => setActiveTab('registrationIps')}
                    className={`px-4 py-2 text-xs font-bold rounded-md transition-all flex items-center gap-2 ${activeTab === 'registrationIps' ? 'bg-red-600 text-white shadow-lg shadow-red-900/40' : 'text-slate-500 hover:text-slate-300'}`}
                >
                    <Users size={14} /> IP RESIDENCIAL
                </button>
                <button
                    onClick={() => setActiveTab('historyIps')}
                    className={`px-4 py-2 text-xs font-bold rounded-md transition-all flex items-center gap-2 ${activeTab === 'historyIps' ? 'bg-red-600 text-white shadow-lg shadow-red-900/40' : 'text-slate-500 hover:text-slate-300'}`}
                >
                    <Globe size={14} /> IP HISTORICO
                </button>
                <button
                    onClick={() => setActiveTab('sharedDevices')}
                    className={`px-4 py-2 text-xs font-bold rounded-md transition-all flex items-center gap-2 ${activeTab === 'sharedDevices' ? 'bg-red-600 text-white shadow-lg shadow-red-900/40' : 'text-slate-500 hover:text-slate-300'}`}
                >
                    <Fingerprint size={14} /> DISPOSITIVO PARTILHADO
                </button>
                <button
                    onClick={() => setActiveTab('logs')}
                    className={`px-4 py-2 text-xs font-bold rounded-md transition-all flex items-center gap-2 ${activeTab === 'logs' ? 'bg-red-600 text-white shadow-lg shadow-red-900/40' : 'text-slate-500 hover:text-slate-300'}`}
                >
                    <Terminal size={14} /> ACESSOS SUSPEITOS
                </button>
                <button
                    onClick={() => setActiveTab('blacklist')}
                    className={`px-4 py-2 text-xs font-bold rounded-md transition-all flex items-center gap-2 ${activeTab === 'blacklist' ? 'bg-red-600 text-white shadow-lg shadow-red-900/40' : 'text-slate-500 hover:text-slate-300'}`}
                >
                    <Lock size={14} /> LISTA NEGRA
                </button>
                <button
                    onClick={() => setActiveTab('activity')}
                    className={`px-4 py-2 text-xs font-bold rounded-md transition-all flex items-center gap-2 ${activeTab === 'activity' ? 'bg-red-600 text-white shadow-lg shadow-red-900/40' : 'text-slate-500 hover:text-slate-300'}`}
                >
                    <Gamepad2 size={14} /> ATIVIDADE JOGO
                </button>
                <button
                    onClick={() => setActiveTab('fingerprints')}
                    className={`px-4 py-2 text-xs font-bold rounded-md transition-all flex items-center gap-2 ${activeTab === 'fingerprints' ? 'bg-red-600 text-white shadow-lg shadow-red-900/40' : 'text-slate-500 hover:text-slate-300'}`}
                >
                    <Fingerprint size={14} /> DISPOSITIVOS
                </button>
                <button
                    onClick={() => setActiveTab('bulkTools')}
                    className={`px-4 py-2 text-xs font-bold rounded-md transition-all flex items-center gap-2 ${activeTab === 'bulkTools' ? 'bg-red-600 text-white shadow-lg shadow-red-900/40' : 'text-slate-500 hover:text-slate-300'}`}
                >
                    <KeyRound size={14} /> FERRAMENTAS
                </button>
            </div>

            {activeTab === 'multi' && (
                <div className="space-y-8 animate-in fade-in duration-300">
                    {/* Suspected Auto-Referrals */}
                    <div className="bg-slate-900/50 border border-red-900/20 rounded-xl overflow-hidden shadow-2xl">
                        <div className="bg-red-600/10 p-4 border-b border-red-900/30 flex items-center gap-3">
                            <AlertTriangle className="text-red-500" size={20} />
                            <h3 className="text-lg font-bold text-red-100 italic">Suspeita de Auto-Indicação</h3>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm">
                                <thead className="bg-slate-950 text-slate-500 uppercase text-[10px] tracking-widest font-bold">
                                    <tr>
                                        <th className="px-4 py-3">Indicador</th>
                                        <th className="px-4 py-3">Indicado</th>
                                        <th className="px-4 py-3">IP (Evidência)</th>
                                        <th className="px-4 py-3">Ação</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800/50">
                                    {stats?.suspectedAutoReferrals && stats.suspectedAutoReferrals.length > 0 ? (
                                        stats.suspectedAutoReferrals.map((ref, idx) => (
                                            <tr key={idx} className="hover:bg-red-600/5 transition-colors group">
                                                <td className="px-4 py-4">
                                                    <div className="text-white font-bold">{ref.referrer_username}</div>
                                                    <div className="text-[10px] text-slate-500">ID: {ref.referrer_id}</div>
                                                </td>
                                                <td className="px-4 py-4">
                                                    <div className="text-red-400 font-bold">{ref.referred_username}</div>
                                                    <div className="text-[10px] text-slate-500">ID: {ref.referred_id}</div>
                                                </td>
                                                <td className="px-4 py-4">
                                                    <div className="flex items-center gap-2">
                                                        <div className="font-mono text-xs p-1 bg-slate-800 rounded text-slate-300 border border-slate-700">
                                                            {ref.referrer_ip}
                                                        </div>
                                                        <span className="text-[10px] font-bold text-red-500 animate-pulse">MATCH</span>
                                                    </div>
                                                </td>
                                                <td className="px-4 py-4">
                                                    <button
                                                        onClick={() => handleBanIp(ref.referrer_ip)}
                                                        className="bg-red-900/20 hover:bg-red-600 text-red-500 hover:text-white border border-red-900/50 p-2 rounded transition-all flex items-center gap-2 text-[10px] font-bold"
                                                    >
                                                        <Ban size={12} /> BANIR IP
                                                    </button>
                                                </td>
                                            </tr>
                                        ))
                                    ) : (
                                        <tr>
                                            <td colSpan={4} className="px-4 py-8 text-center text-slate-600 italic">Nenhum caso óbvio de auto-indicação detectado.</td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                        {/* Multi-Accounts (IP de Registro) */}
                        <div className="bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
                            <div className="bg-slate-950 p-4 border-b border-slate-800 flex items-center gap-3">
                                <Users className="text-amber-500" size={20} />
                                <h3 className="text-lg font-bold text-slate-100 italic font-serif">Multi-contas (Registro)</h3>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-sm">
                                    <thead className="bg-slate-950 text-slate-500 uppercase text-[10px] tracking-widest font-bold">
                                        <tr>
                                            <th className="px-4 py-3">Endereço IP</th>
                                            <th className="px-4 py-3 text-center">Contas</th>
                                            <th className="px-4 py-3">Ação</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-800/50">
                                        {stats?.multiAccounts && stats.multiAccounts.length > 0 ? (
                                            stats.multiAccounts.map((acc, idx) => (
                                                <tr key={idx} className="hover:bg-slate-800/50 transition-colors group">
                                                    <td className="px-4 py-4">
                                                        <div className="font-mono text-xs text-amber-400">{acc.registration_ip}</div>
                                                        <div className="flex flex-wrap gap-1 mt-1">
                                                            {acc.usernames.slice(0, 3).map((u, i) => (
                                                                <span key={i} className="text-[9px] bg-slate-800 px-1 py-0.2 rounded text-slate-500">
                                                                    {u}
                                                                </span>
                                                            ))}
                                                            {acc.usernames.length > 3 && <span className="text-[9px] text-slate-600">+{acc.usernames.length - 3}</span>}
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-4 text-center">
                                                        <span className="bg-amber-900/20 text-amber-400 px-2 py-1 rounded text-xs font-bold ring-1 ring-amber-500/30">
                                                            {acc.account_count}
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-4">
                                                        <button
                                                            onClick={() => handleBanIp(acc.registration_ip)}
                                                            className="opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-400 transition-all"
                                                        >
                                                            <Ban size={16} />
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))
                                        ) : (
                                            <tr>
                                                <td colSpan={3} className="px-4 py-8 text-center text-slate-600 italic">Nenhum IP compartilhado detectado.</td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        {/* Multi-Accounts (Dynamic History IP) */}
                        <div className="bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
                            <div className="bg-slate-950 p-4 border-b border-slate-800 flex items-center gap-3">
                                <Globe className="text-emerald-500" size={20} />
                                <h3 className="text-lg font-bold text-slate-100 italic">Cruzamento Histórico</h3>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-sm">
                                    <thead className="bg-slate-950 text-slate-500 uppercase text-[10px] tracking-widest font-bold">
                                        <tr>
                                            <th className="px-4 py-3">IP Ativo</th>
                                            <th className="px-4 py-3 text-center">Membros</th>
                                            <th className="px-4 py-3">Ação</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-800/50">
                                        {stats?.historyMultiAccounts && stats.historyMultiAccounts.length > 0 ? (
                                            stats.historyMultiAccounts.map((acc, idx) => (
                                                <tr key={idx} className="hover:bg-slate-800/50 transition-colors group">
                                                    <td className="px-4 py-4">
                                                        <div className="font-mono text-xs text-emerald-400">{acc.ip}</div>
                                                        <div className="text-[10px] text-slate-500 italic mt-1 truncate max-w-[150px]">
                                                            {acc.usernames.join(', ')}
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-4 text-center">
                                                        <span className="bg-emerald-900/20 text-emerald-400 px-2 py-1 rounded text-xs font-bold ring-1 ring-emerald-500/30">
                                                            {acc.user_count}
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-4">
                                                        <button
                                                            onClick={() => handleBanIp(acc.ip)}
                                                            className="opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-400 transition-all"
                                                        >
                                                            <Ban size={16} />
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))
                                        ) : (
                                            <tr>
                                                <td colSpan={3} className="px-4 py-8 text-center text-slate-600 italic">Nenhum cruzamento histórico detectado.</td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {activeTab === 'registrationIps' && (
                <div className="space-y-8 animate-in fade-in duration-300">
                    <div className="bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
                        <div className="bg-slate-950 p-4 border-b border-slate-800 flex items-center gap-3">
                            <Users className="text-amber-500" size={20} />
                            <div>
                                <h3 className="text-lg font-bold text-slate-100 italic">IP residencial partilhado</h3>
                                <p className="text-[10px] text-slate-500 uppercase tracking-tighter">Contas com o mesmo `registration_ip`</p>
                            </div>
                        </div>
                        <div className="p-4 space-y-4">
                            {stats?.sharedRegistrationIps && stats.sharedRegistrationIps.length > 0 ? (
                                stats.sharedRegistrationIps.map((group) => (
                                    <div key={`reg-${group.ip}`} className="rounded-lg border border-slate-800 bg-slate-950/70 overflow-hidden">
                                        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800">
                                            <div>
                                                <div className="font-mono text-sm text-amber-400">{group.ip}</div>
                                                <div className="text-[10px] text-slate-500">{group.userCount} conta(s)</div>
                                            </div>
                                            <button
                                                onClick={() => void handleToggleIpBan(group.ip)}
                                                className="text-xs font-bold px-3 py-1.5 rounded bg-red-900/30 hover:bg-red-600 text-red-300 hover:text-white border border-red-900/50"
                                                disabled={banningIp === group.ip}
                                            >
                                                {isIpBlacklisted(group.ip) ? 'Desbanir IP' : 'Banir IP'}
                                            </button>
                                        </div>
                                        <div className="divide-y divide-slate-800/60">
                                            {group.users.map((user) => (
                                                <div key={`reg-${group.ip}-${user.id}`} className="px-4 py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                                                    <div>
                                                        <div className="text-sm font-bold text-white">{user.username || '—'}</div>
                                                        <div className="text-[11px] text-slate-400">{user.email || '—'}</div>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <div className="text-[10px] text-slate-500 font-mono">ID {user.id}</div>
                                                        <button
                                                            type="button"
                                                            onClick={() => void handleToggleUserBlocked(user.email, !user.isBlocked)}
                                                            disabled={togglingUserEmail === user.email}
                                                            className={`text-[10px] font-bold px-2 py-1 rounded border ${
                                                                user.isBlocked
                                                                    ? 'border-emerald-700/50 bg-emerald-900/20 text-emerald-300'
                                                                    : 'border-red-700/50 bg-red-900/20 text-red-300'
                                                            }`}
                                                        >
                                                            {togglingUserEmail === user.email ? '...' : user.isBlocked ? 'Desbloquear usuário' : 'Bloquear usuário'}
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <div className="py-10 text-center text-slate-600 italic">Nenhum grupo com IP residencial partilhado.</div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {activeTab === 'historyIps' && (
                <div className="space-y-8 animate-in fade-in duration-300">
                    <div className="bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
                        <div className="bg-slate-950 p-4 border-b border-slate-800 flex items-center gap-3">
                            <Globe className="text-cyan-500" size={20} />
                            <div>
                                <h3 className="text-lg font-bold text-slate-100 italic">IP historico partilhado</h3>
                                <p className="text-[10px] text-slate-500 uppercase tracking-tighter">Contas com o mesmo IP em `user_history_ips`</p>
                            </div>
                        </div>
                        <div className="p-4 space-y-4">
                            {stats?.sharedDeviceIps && stats.sharedDeviceIps.length > 0 ? (
                                stats.sharedDeviceIps.map((group) => (
                                    <div key={`dev-${group.ip}`} className="rounded-lg border border-slate-800 bg-slate-950/70 overflow-hidden">
                                        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800">
                                            <div>
                                                <div className="font-mono text-sm text-cyan-400">{group.ip}</div>
                                                <div className="text-[10px] text-slate-500">
                                                    {group.userCount} conta(s)
                                                    {group.lastSeenAt ? ` · último uso ${new Date(group.lastSeenAt).toLocaleString()}` : ''}
                                                </div>
                                            </div>
                                            <button
                                                onClick={() => void handleToggleIpBan(group.ip)}
                                                className="text-xs font-bold px-3 py-1.5 rounded bg-red-900/30 hover:bg-red-600 text-red-300 hover:text-white border border-red-900/50"
                                                disabled={banningIp === group.ip}
                                            >
                                                {isIpBlacklisted(group.ip) ? 'Desbanir IP' : 'Banir IP'}
                                            </button>
                                        </div>
                                        <div className="divide-y divide-slate-800/60">
                                            {group.users.map((user) => (
                                                <div key={`dev-${group.ip}-${user.id}`} className="px-4 py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                                                    <div>
                                                        <div className="text-sm font-bold text-white">{user.username || '—'}</div>
                                                        <div className="text-[11px] text-slate-400">{user.email || '—'}</div>
                                                        <div className="text-[10px] text-slate-500">
                                                            IP de registo: {user.registrationIp || '—'}
                                                        </div>
                                                    </div>
                                                    <div className="text-right">
                                                        <div className="text-[10px] text-slate-500 font-mono">ID {user.id}</div>
                                                        <div className="text-[10px] text-slate-500">
                                                            {user.lastUsedAt ? `Visto em ${new Date(user.lastUsedAt).toLocaleString()}` : 'Sem data'}
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={() => void handleToggleUserBlocked(user.email, !user.isBlocked)}
                                                            disabled={togglingUserEmail === user.email}
                                                            className={`mt-2 text-[10px] font-bold px-2 py-1 rounded border ${
                                                                user.isBlocked
                                                                    ? 'border-emerald-700/50 bg-emerald-900/20 text-emerald-300'
                                                                    : 'border-red-700/50 bg-red-900/20 text-red-300'
                                                            }`}
                                                        >
                                                            {togglingUserEmail === user.email ? '...' : user.isBlocked ? 'Desbloquear usuário' : 'Bloquear usuário'}
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <div className="py-10 text-center text-slate-600 italic">Nenhum grupo com IP de dispositivo partilhado.</div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {activeTab === 'sharedDevices' && (
                <div className="space-y-8 animate-in fade-in duration-300">
                    <div className="bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
                        <div className="bg-slate-950 p-4 border-b border-slate-800 flex items-center gap-3">
                            <Fingerprint className="text-cyan-500" size={20} />
                            <div>
                                <h3 className="text-lg font-bold text-slate-100 italic">Dispositivo partilhado</h3>
                                <p className="text-[10px] text-slate-500 uppercase tracking-tighter">Contas com o mesmo fingerprint de dispositivo</p>
                            </div>
                        </div>
                        <div className="p-4 space-y-4">
                            {stats?.sharedFingerprints && stats.sharedFingerprints.length > 0 ? (
                                stats.sharedFingerprints.map((group) => (
                                    <div key={group.fingerprintHash} className="rounded-lg border border-slate-800 bg-slate-950/70 overflow-hidden">
                                        <div className="px-4 py-3 border-b border-slate-800">
                                            <div className="font-mono text-sm text-cyan-400 break-all">{group.fingerprintHash}</div>
                                            <div className="text-[10px] text-slate-500">
                                                {group.userCount} conta(s)
                                                {group.lastSeenAt ? ` · ultimo uso ${new Date(group.lastSeenAt).toLocaleString()}` : ''}
                                            </div>
                                        </div>
                                        <div className="divide-y divide-slate-800/60">
                                            {group.users.map((user) => (
                                                <div key={`${group.fingerprintHash}-${user.id}`} className="px-4 py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                                                    <div>
                                                        <div className="text-sm font-bold text-white">{user.username || '—'}</div>
                                                        <div className="text-[11px] text-slate-400">{user.email || '—'}</div>
                                                        <div className="text-[10px] text-slate-500">Ultimo IP visto: {user.lastIp || '—'}</div>
                                                    </div>
                                                    <div className="text-right">
                                                        <div className="text-[10px] text-slate-500 font-mono">ID {user.id}</div>
                                                        <div className="text-[10px] text-slate-500">
                                                            {user.lastSeenAt ? `Visto em ${new Date(user.lastSeenAt).toLocaleString()}` : 'Sem data'}
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <div className="py-10 text-center text-slate-600 italic">Nenhum grupo com fingerprint partilhado.</div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {activeTab === 'logs' && (
                <div className="animate-in fade-in duration-300">
                    <div className="bg-slate-900 border border-red-900/30 rounded-xl overflow-hidden shadow-2xl">
                        <div className="bg-slate-950 p-4 border-b border-red-900/30 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <Terminal className="text-red-600" size={20} />
                                <h3 className="text-lg font-bold text-white italic underline decoration-red-600/30">Logs de Tentativas Frustradas (Admin)</h3>
                            </div>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm">
                                <thead className="bg-slate-950 text-slate-500 uppercase text-[10px] tracking-widest font-bold">
                                    <tr>
                                        <th className="px-4 py-3">Data / Hora</th>
                                        <th className="px-4 py-3">Endereço IP</th>
                                        <th className="px-4 py-3">URL Tentada</th>
                                        <th className="px-4 py-3">Detalhes</th>
                                        <th className="px-4 py-3">Ação</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800/50">
                                    {stats?.accessLogs && stats.accessLogs.length > 0 ? (
                                        stats.accessLogs.map((log, idx) => (
                                            <tr key={idx} className="hover:bg-red-600/5 transition-colors group">
                                                <td className="px-4 py-4 text-[10px] text-slate-400 font-mono">
                                                    {new Date(Number(log.created_at)).toLocaleString()}
                                                </td>
                                                <td className="px-4 py-4">
                                                    <div className="font-mono text-xs text-red-400 font-bold">{log.ip}</div>
                                                </td>
                                                <td className="px-4 py-4 font-mono text-[10px] text-slate-300">
                                                    {log.attempted_url}
                                                </td>
                                                <td className="px-4 py-4 text-[10px] text-slate-500 max-w-xs truncate" title={log.details || log.user_agent}>
                                                    {log.details || 'Sem detalhes adicionais'}
                                                </td>
                                                <td className="px-4 py-4">
                                                    <button
                                                        onClick={() => handleBanIp(log.ip)}
                                                        className="bg-red-600 hover:bg-red-700 text-white p-1.5 rounded transition-all shadow-lg shadow-red-900/20"
                                                        title="Banir IP Permanentemente"
                                                    >
                                                        <Ban size={14} />
                                                    </button>
                                                </td>
                                            </tr>
                                        ))
                                    ) : (
                                        <tr>
                                            <td colSpan={5} className="px-4 py-8 text-center text-slate-600 italic font-bold tracking-widest">SISTEMA INTACTO. NENHUMA TENTATIVA SUSPEITA REGISTRADA.</td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {activeTab === 'activity' && (
                <div className="animate-in fade-in duration-300 space-y-4">
                    <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 flex flex-wrap items-end gap-3">
                        <div className="flex-1 min-w-[200px]">
                            <label className="block text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-1">Email ou username</label>
                            <input
                                type="text"
                                value={activityEmail}
                                onChange={(e) => setActivityEmail(e.target.value)}
                                placeholder="nome@dominio.com ou ElonMuskBR"
                                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-red-600 focus:outline-none"
                            />
                        </div>
                        <button
                            type="button"
                            onClick={loadUserActivity}
                            disabled={activityLoading}
                            className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-bold uppercase disabled:opacity-50"
                        >
                            {activityLoading ? 'A carregar…' : 'Carregar'}
                        </button>
                    </div>
                    {activityError && (
                        <p className="text-sm text-amber-500 font-medium">{activityError}</p>
                    )}
                    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl">
                        <div className="bg-slate-950 p-4 border-b border-slate-800 flex items-center gap-3">
                            <Gamepad2 className="text-emerald-500" size={20} />
                            <div>
                                <h3 className="text-lg font-bold text-white italic">Registo de ações no jogo</h3>
                                <p className="text-[10px] text-slate-500 uppercase tracking-tighter">Depósitos, loja, caixas, câmbio, rigs e oficina (registos enviados pelo servidor)</p>
                            </div>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm">
                                <thead className="bg-slate-950 text-slate-500 uppercase text-[10px] tracking-widest font-bold">
                                    <tr>
                                        <th className="px-4 py-3">Data / Hora</th>
                                        <th className="px-4 py-3">Ação</th>
                                        <th className="px-4 py-3">Detalhes</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800/50">
                                    {activityLogs.length > 0 ? (
                                        activityLogs.map((row) => (
                                            <tr key={row.id} className="hover:bg-slate-800/40">
                                                <td className="px-4 py-3 text-[10px] text-slate-400 font-mono whitespace-nowrap">
                                                    {new Date(row.createdAt).toLocaleString()}
                                                </td>
                                                <td className="px-4 py-3 font-mono text-xs text-emerald-400">{row.action}</td>
                                                <td className="px-4 py-3 text-xs text-slate-300 break-words max-w-xl" title={row.action}>
                                                    {formatActivityRow(row)}
                                                </td>
                                            </tr>
                                        ))
                                    ) : (
                                        <tr>
                                            <td colSpan={3} className="px-4 py-10 text-center text-slate-600 italic">
                                                {activityError ? '—' : 'Introduza o email ou o username da conta e clique em Carregar. Se a lista estiver vazia sem erro, o jogador ainda não tem eventos registados.'}
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {activeTab === 'fingerprints' && (
                <div className="animate-in fade-in duration-300 space-y-4">
                    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl">
                        <div className="bg-slate-950 p-4 border-b border-slate-800 flex flex-col gap-4">
                            <div className="flex items-center gap-3">
                                <Fingerprint className="text-cyan-500" size={22} />
                                <div>
                                    <h3 className="text-lg font-bold text-white">Fingerprints de dispositivo</h3>
                                    <p className="text-[10px] text-slate-500">Registos enviados em login e registo (hash + dados permitidos).</p>
                                </div>
                            </div>
                            <div className="flex flex-wrap items-end gap-3">
                                <div>
                                    <label className="text-[10px] uppercase text-slate-500 font-bold block mb-1">Evento</label>
                                    <select
                                        value={fpEventFilter}
                                        onChange={(e) => setFpEventFilter(e.target.value as 'all' | 'login' | 'register')}
                                        className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white"
                                    >
                                        <option value="all">Todos</option>
                                        <option value="login">Login</option>
                                        <option value="register">Registo</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="text-[10px] uppercase text-slate-500 font-bold block mb-1">User ID</label>
                                    <input
                                        type="number"
                                        min={1}
                                        placeholder="opcional"
                                        value={fpUserIdFilter}
                                        onChange={(e) => setFpUserIdFilter(e.target.value)}
                                        className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white w-28 font-mono"
                                    />
                                </div>
                                <div className="flex-1 min-w-[180px]">
                                    <label className="text-[10px] uppercase text-slate-500 font-bold block mb-1">Pesquisa</label>
                                    <input
                                        type="text"
                                        placeholder="email, nome, hash, IP…"
                                        value={fpSearch}
                                        onChange={(e) => setFpSearch(e.target.value)}
                                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white"
                                    />
                                </div>
                                <button
                                    type="button"
                                    onClick={applyFpFilters}
                                    className="px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white text-xs font-bold self-end"
                                >
                                    Aplicar pesquisa
                                </button>
                            </div>
                            <p className="text-[10px] text-slate-500">
                                {fpTotal} registo(s). O tipo de evento atualiza ao mudar; pesquisa e ID de utilizador com
                                &quot;Aplicar pesquisa&quot;.
                            </p>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm">
                                <thead className="bg-slate-950 text-slate-500 uppercase text-[10px] tracking-widest font-bold">
                                    <tr>
                                        <th className="px-3 py-2">Data</th>
                                        <th className="px-3 py-2">Evento</th>
                                        <th className="px-3 py-2">Utilizador</th>
                                        <th className="px-3 py-2">IP</th>
                                        <th className="px-3 py-2">Hash</th>
                                        <th className="px-3 py-2 text-right">Payload</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800/50">
                                    {fpRows.length === 0 && !fpLoading ? (
                                        <tr>
                                            <td colSpan={6} className="px-4 py-10 text-center text-slate-600 italic">
                                                Nenhum registo. Ajuste filtros ou aguarde novos logins/registos com fingerprint.
                                            </td>
                                        </tr>
                                    ) : (
                                        fpRows.map((row) => (
                                            <tr key={row.id} className="hover:bg-slate-800/40">
                                                <td className="px-3 py-2 text-[10px] text-slate-400 whitespace-nowrap">
                                                    {new Date(row.createdAt).toLocaleString()}
                                                </td>
                                                <td className="px-3 py-2">
                                                    <span
                                                        className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                                                            row.eventType === 'login'
                                                                ? 'bg-blue-900/40 text-blue-300 border border-blue-800'
                                                                : 'bg-amber-900/40 text-amber-300 border border-amber-800'
                                                        }`}
                                                    >
                                                        {row.eventType}
                                                    </span>
                                                </td>
                                                <td className="px-3 py-2">
                                                    <div className="text-slate-200 text-xs font-medium">{row.username || '—'}</div>
                                                    <div className="text-[10px] text-slate-500 font-mono truncate max-w-[200px]" title={row.email || ''}>
                                                        {row.email || '—'}
                                                    </div>
                                                    <div className="text-[9px] text-slate-600 font-mono">id {row.userId}</div>
                                                </td>
                                                <td className="px-3 py-2 font-mono text-[10px] text-emerald-400">{row.ip || '—'}</td>
                                                <td className="px-3 py-2 font-mono text-[9px] text-slate-400 break-all max-w-[140px]" title={row.fingerprintHash}>
                                                    {row.fingerprintHash.slice(0, 16)}…
                                                </td>
                                                <td className="px-3 py-2 text-right">
                                                    <button
                                                        type="button"
                                                        onClick={() => setFpDetail(row)}
                                                        className="inline-flex items-center gap-1 text-cyan-500 hover:text-cyan-400 text-[10px] font-bold uppercase"
                                                    >
                                                        <Eye size={12} /> Ver
                                                    </button>
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                        <div className="p-3 border-t border-slate-800 flex justify-between items-center bg-slate-950/50">
                            <span className="text-[10px] text-slate-500">
                                A mostrar {fpRows.length} de {fpTotal}
                            </span>
                            {fpRows.length < fpTotal && (
                                <button
                                    type="button"
                                    disabled={fpLoading}
                                    onClick={handleFpLoadMore}
                                    className="text-xs font-bold text-red-400 hover:text-red-300 disabled:opacity-50"
                                >
                                    {fpLoading ? 'A carregar…' : 'Carregar mais'}
                                </button>
                            )}
                        </div>
                    </div>

                    {fpDetail && (
                        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={() => setFpDetail(null)}>
                            <div
                                className="bg-slate-900 border border-slate-700 rounded-xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col shadow-2xl"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <div className="p-4 border-b border-slate-800 flex justify-between items-center">
                                    <h4 className="text-white font-bold text-sm">Detalhe do fingerprint</h4>
                                    <button type="button" onClick={() => setFpDetail(null)} className="text-slate-500 hover:text-white text-xs">
                                        Fechar
                                    </button>
                                </div>
                                <div className="p-4 overflow-y-auto text-xs space-y-3 custom-scrollbar">
                                    <div className="text-slate-400">
                                        <span className="text-slate-500">User-Agent (pedido):</span>
                                        <pre className="mt-1 p-2 bg-slate-950 rounded border border-slate-800 text-[10px] whitespace-pre-wrap break-words">{fpDetail.userAgent || '—'}</pre>
                                    </div>
                                    <div className="text-slate-400">
                                        <span className="text-slate-500">Payload (JSON):</span>
                                        <pre className="mt-1 p-2 bg-slate-950 rounded border border-slate-800 text-[10px] whitespace-pre-wrap break-words">
                                            {(() => {
                                                if (!fpDetail.payloadJson) return '—';
                                                try {
                                                    return JSON.stringify(JSON.parse(fpDetail.payloadJson), null, 2);
                                                } catch {
                                                    return fpDetail.payloadJson;
                                                }
                                            })()}
                                        </pre>
                                    </div>
                                    <div className="font-mono text-[10px] text-slate-500 break-all">Hash completo: {fpDetail.fingerprintHash}</div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {activeTab === 'blacklist' && (
                <div className="animate-in fade-in duration-300">
                    <div className="space-y-8">
                        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl">
                            <div className="bg-slate-950 p-4 border-b border-slate-800 flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <Users className="text-red-500" size={20} />
                                    <h3 className="text-lg font-bold text-white">Usuários Bloqueados</h3>
                                </div>
                            </div>
                            <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {stats?.blockedUsers && stats.blockedUsers.length > 0 ? (
                                    stats.blockedUsers.map((user) => (
                                        <div key={user.id} className="bg-slate-950 border border-slate-800 p-4 rounded-lg">
                                            <div className="text-sm font-bold text-white">{user.username || '—'}</div>
                                            <div className="text-[11px] text-slate-400">{user.email || '—'}</div>
                                            <div className="mt-2 text-[10px] text-slate-500 font-mono">ID {user.id}</div>
                                            <div className="text-[10px] text-slate-500 font-mono break-all">
                                                IP registo: {user.registrationIp || '—'}
                                            </div>
                                            <div className="mt-4 pt-2 border-t border-slate-900 flex justify-end">
                                                <button
                                                    type="button"
                                                    onClick={() => void handleToggleUserBlocked(user.email, false)}
                                                    disabled={togglingUserEmail === user.email}
                                                    className="text-[10px] font-bold px-3 py-1.5 rounded bg-emerald-900/20 hover:bg-emerald-700/30 text-emerald-300 border border-emerald-700/40"
                                                >
                                                    {togglingUserEmail === user.email ? '...' : 'Desbloquear usuário'}
                                                </button>
                                            </div>
                                        </div>
                                    ))
                                ) : (
                                    <div className="col-span-full py-12 text-center">
                                        <Shield className="text-slate-800 mx-auto mb-4" size={48} />
                                        <p className="text-slate-600 font-bold uppercase tracking-tighter">NENHUM USUÁRIO BLOQUEADO</p>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl">
                            <div className="bg-slate-950 p-4 border-b border-slate-800 flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <Lock className="text-yellow-500" size={20} />
                                    <h3 className="text-lg font-bold text-white">IPs Bloqueados</h3>
                                </div>
                            </div>
                            <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {stats?.blacklist && stats.blacklist.length > 0 ? (
                                    stats.blacklist.map((entry, idx) => (
                                        <div key={idx} className="bg-slate-950 border border-slate-800 p-4 rounded-lg relative group overflow-hidden">
                                            <div className="absolute top-0 right-0 p-2 opacity-0 group-hover:opacity-100 transition-all">
                                                <button
                                                    onClick={() => handleUnbanIp(entry.ip)}
                                                    className="text-slate-500 hover:text-emerald-500"
                                                    title="Remover Banimento"
                                                >
                                                    <CheckCircle size={18} />
                                                </button>
                                            </div>
                                            <div className="font-mono text-sm text-red-500 font-bold mb-1">{entry.ip}</div>
                                            <div className="text-[10px] text-slate-500 mb-2 italic">"{entry.reason || 'Sem motivo especificado'}"</div>
                                            {entry.linkedUsers && entry.linkedUsers.length > 0 && (
                                                <div className="text-[10px] text-amber-600/90 dark:text-amber-400/90 mb-2 space-y-1">
                                                    <div className="font-bold text-amber-700 dark:text-amber-300 uppercase tracking-tight">Contas associadas a este IP</div>
                                                    {entry.linkedUsers.map((u) => (
                                                        <div key={u.id} className="pl-1 border-l border-amber-700/40 dark:border-amber-500/40">
                                                            <span className="text-slate-200 font-semibold">{u.username}</span>
                                                            <span className="text-slate-500"> · </span>
                                                            <span className="text-slate-400">{u.email}</span>
                                                            <span className="text-slate-600 block text-[9px] mt-0.5">
                                                                {[
                                                                    u.vias?.includes('registro') ? 'IP de registo' : null,
                                                                    u.vias?.includes('hist_login') ? 'Histórico de login' : null
                                                                ]
                                                                    .filter(Boolean)
                                                                    .join(' · ')}
                                                            </span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                            <div className="flex items-center justify-between mt-4 pt-2 border-t border-slate-900">
                                                <span className="text-[9px] text-slate-600">
                                                    BANIDO EM:{' '}
                                                    {new Date(Number(entry.added_at)).toLocaleString('pt-PT', {
                                                        day: '2-digit',
                                                        month: '2-digit',
                                                        year: 'numeric',
                                                        hour: '2-digit',
                                                        minute: '2-digit',
                                                        second: '2-digit'
                                                    })}
                                                </span>
                                                <button
                                                    onClick={() => handleUnbanIp(entry.ip)}
                                                    className="text-[9px] text-red-900 hover:text-red-500 font-bold uppercase transition-colors"
                                                >
                                                    REVOGAR
                                                </button>
                                            </div>
                                        </div>
                                    ))
                                ) : (
                                    <div className="col-span-full py-12 text-center">
                                        <Shield className="text-slate-800 mx-auto mb-4" size={48} />
                                        <p className="text-slate-600 font-bold uppercase tracking-tighter">NENHUM IP BLOQUEADO NO MOMENTO</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {activeTab === 'bulkTools' && (
                <div className="space-y-6 animate-in fade-in duration-300">
                    {!isSuperAdmin && (
                        <div className="rounded-lg border border-amber-800/50 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
                            Apenas <strong>super administradores</strong> podem executar bloqueio em massa e reset de senhas.
                        </div>
                    )}
                    {bulkMsg && (
                        <div className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-xs text-slate-200">{bulkMsg}</div>
                    )}

                    <div className="bg-slate-900/50 border border-red-900/20 rounded-xl p-5 space-y-4">
                        <div className="flex items-center gap-2">
                            <Clock className="text-red-500" size={18} />
                            <h3 className="text-lg font-bold text-white">Bloqueio por inatividade</h3>
                        </div>
                        <p className="text-xs text-slate-400">
                            Contas de jogadores (não admin) sem login há mais de X dias são bloqueadas. Usa{' '}
                            <span className="font-mono text-slate-300">last_active_at</span> ou última actividade no{' '}
                            <span className="font-mono text-slate-300">game_state</span>.
                        </p>
                        <div className="grid md:grid-cols-2 gap-3 items-end">
                            <label className="flex flex-col gap-1">
                                <span className="text-[10px] uppercase font-bold text-slate-500">Dias sem login</span>
                                <input
                                    type="number"
                                    min={1}
                                    max={3650}
                                    value={inactiveDays}
                                    onChange={(e) => setInactiveDays(Math.max(1, parseInt(e.target.value, 10) || 1))}
                                    className="bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white text-sm"
                                />
                            </label>
                            <label className="flex items-center gap-2 text-sm text-slate-300 pb-2">
                                <input
                                    type="checkbox"
                                    checked={autoBlockEnabled}
                                    onChange={(e) => setAutoBlockEnabled(e.target.checked)}
                                    disabled={!isSuperAdmin}
                                />
                                Bloqueio automático diário
                            </label>
                        </div>
                        <p className="text-sm text-amber-300 font-mono">
                            {inactivePreviewLoading ? (
                                'A calcular contas inactivas…'
                            ) : inactivePreview != null ? (
                                <>
                                    <strong>{inactivePreview.toLocaleString('pt-BR')}</strong> conta(s) sem login há mais de{' '}
                                    <strong>{inactiveDays}</strong> dias
                                    {inactiveCutoffMs != null && (
                                        <>
                                            {' '}
                                            (última actividade antes de{' '}
                                            {new Date(inactiveCutoffMs).toLocaleString('pt-BR', {
                                                day: '2-digit',
                                                month: '2-digit',
                                                year: 'numeric',
                                                hour: '2-digit',
                                                minute: '2-digit'
                                            })}
                                            )
                                        </>
                                    )}
                                    .
                                </>
                            ) : (
                                '—'
                            )}
                        </p>
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                disabled={!isSuperAdmin || bulkBusy != null}
                                onClick={async () => {
                                    setBulkBusy('save-config');
                                    const r = await saveAdminSecurityBulkToolsConfig({
                                        inactiveBlockDays: inactiveDays,
                                        autoBlockEnabled
                                    });
                                    setBulkBusy(null);
                                    setBulkMsg(r?.ok ? 'Configuração guardada.' : r?.error || 'Falha ao guardar.');
                                }}
                                className="text-xs font-bold bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white px-4 py-2 rounded"
                            >
                                Guardar configuração
                            </button>
                            <button
                                type="button"
                                disabled={!isSuperAdmin || bulkBusy != null}
                                onClick={async () => {
                                    if (!window.confirm(`Bloquear agora todas as contas inactivas há mais de ${inactiveDays} dias?`)) return;
                                    setBulkBusy('apply-inactive');
                                    try {
                                        const r = await applyAdminInactiveBlock(inactiveDays);
                                        if (r?.ok) {
                                            setBulkMsg(`${r.blockedCount ?? 0} conta(s) bloqueada(s).`);
                                            const p = await previewAdminInactiveBlock(inactiveDays);
                                            setInactivePreview(p?.inactiveCount ?? 0);
                                            setInactiveCutoffMs(p?.cutoffMs ?? null);
                                        } else {
                                            setBulkMsg(r?.error || 'Falha ao bloquear.');
                                        }
                                    } catch {
                                        setBulkMsg('Erro de rede ou timeout ao bloquear.');
                                    } finally {
                                        setBulkBusy(null);
                                    }
                                }}
                                className="text-xs font-bold bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white px-4 py-2 rounded inline-flex items-center gap-1"
                            >
                                {bulkBusy === 'apply-inactive' ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />}
                                Bloquear inactivas agora
                            </button>
                        </div>
                    </div>

                    <div className="bg-slate-900/50 border border-red-900/20 rounded-xl p-5 space-y-4">
                        <div className="flex items-center gap-2">
                            <KeyRound className="text-red-500" size={18} />
                            <h3 className="text-lg font-bold text-white">Reset global de senhas (jogadores)</h3>
                        </div>
                        <p className="text-xs text-slate-400">
                            Altera a senha de <strong>todos os jogadores</strong> para um valor aleatório e encerra sessões.
                            Contas <strong>admin</strong> e <strong>super admin</strong> são ignoradas. Os jogadores devem usar
                            &quot;Esqueci a senha&quot; para definir uma nova.
                        </p>
                        {passwordPreview != null && (
                            <p className="text-sm text-amber-300 font-mono">
                                <strong>{passwordPreview.toLocaleString('pt-BR')}</strong> jogador(es) serão afectados (admins excluídos).
                            </p>
                        )}
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                disabled={!isSuperAdmin || bulkBusy != null}
                                onClick={async () => {
                                    const n = passwordPreview ?? 0;
                                    if (
                                        !window.confirm(
                                            `REDEFINIR senhas de ${n} jogador(es)?\n\nAdmins e super admins NÃO serão afectados.\nEsta ação é IRREVERSÍVEL.`
                                        )
                                    ) {
                                        return;
                                    }
                                    setBulkBusy('apply-pw');
                                    try {
                                        const r = await applyAdminForcePasswordReset();
                                        if (r?.ok) {
                                            setBulkMsg(r.message || `${r.resetCount ?? 0} senha(s) alterada(s).`);
                                        } else {
                                            setBulkMsg(r?.error || 'Falha no reset de senhas.');
                                        }
                                    } catch {
                                        setBulkMsg('Erro de rede ou timeout ao redefinir senhas.');
                                    } finally {
                                        setBulkBusy(null);
                                    }
                                }}
                                className="text-xs font-bold bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white px-4 py-2 rounded inline-flex items-center gap-1"
                            >
                                {bulkBusy === 'apply-pw' ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
                                Redefinir todas as senhas
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
