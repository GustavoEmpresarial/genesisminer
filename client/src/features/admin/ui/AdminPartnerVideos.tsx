// @ts-nocheck — template legado 1:1.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RefreshCw,
  Check,
  X,
  Loader2,
  ExternalLink,
  Trash2,
  ImageIcon,
  Users,
  Clapperboard,
  UserPlus,
  FileText,
  Search,
  MonitorPlay,
  AlertTriangle
} from 'lucide-react';
import {
  getAdminPartnerYoutubeSubmissions,
  getAdminPartnerYoutubePartners,
  getAdminPartnerYoutubeApplications,
  adminApprovePartnerYoutubeApplication,
  adminRejectPartnerYoutubeApplication,
  adminApprovePartnerYoutube,
  adminRejectPartnerYoutube,
  adminDeletePartnerYoutube,
  getAdminPartnerYoutubeCreatorProfile,
  putAdminPartnerYoutubeCreatorProfile,
  uploadAdImage,
  getAdminUserMap,
  postAdminPartnerYoutubeAllowlist,
  deleteAdminPartnerYoutubeAllowlist,
  postAdminDeactivateStreamerRoom,
  getAdminStreamerRoomUsers,
  type AdminPartnerYoutubeRow,
  type AdminPartnerYoutubePartnerRow,
  type AdminPartnerYoutubeApplicationRow,
  type AdminStreamerRoomUser,
} from '../../../shared/api/admin-legacy';
import {
  PARTNER_AVATAR_URL_MAX,
  PARTNER_CHANNEL_URL_MAX,
  PARTNER_REJECT_REASON_MAX
} from '../../../shared/constants/formLimits';

function thumbUrl(videoId: string): string {
  const v = String(videoId || '').trim();
  if (!v) return '';
  return `https://i.ytimg.com/vi/${v}/hqdefault.jpg`;
}

function fmtDate(ms: number): string {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString('pt-PT');
  } catch {
    return '—';
  }
}

function fmtDateShort(ms: number | null | undefined): string {
  const n = Number(ms) || 0;
  if (!n) return '—';
  try {
    return new Date(n).toLocaleDateString('pt-PT');
  } catch {
    return '—';
  }
}

export const AdminPartnerVideos: React.FC = () => {
  const [sectionTab, setSectionTab] = useState<'envios' | 'candidaturas' | 'parceiros' | 'streamers'>('envios');
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('pending');
  const [rows, setRows] = useState<AdminPartnerYoutubeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [partners, setPartners] = useState<AdminPartnerYoutubePartnerRow[]>([]);
  const [partnersLoading, setPartnersLoading] = useState(false);
  const [partnersErr, setPartnersErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const [vitrineUserId, setVitrineUserId] = useState<number | null>(null);
  const [vitrineUsername, setVitrineUsername] = useState('');
  const [vitrineChannel, setVitrineChannel] = useState('');
  const [vitrineAvatar, setVitrineAvatar] = useState('');
  const [vitrineLoad, setVitrineLoad] = useState(false);
  const [vitrineSave, setVitrineSave] = useState(false);
  const [vitrineAvatarUpload, setVitrineAvatarUpload] = useState(false);
  const vitrineFileInputRef = useRef<HTMLInputElement>(null);

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [userMap, setUserMap] = useState<Array<{ id: number; username: string; email: string }>>([]);
  const [userMapLoad, setUserMapLoad] = useState(false);
  const userMapFetched = useRef(false);
  const [allowlistBusyId, setAllowlistBusyId] = useState<number | null>(null);
  const [allowlistByTextBusy, setAllowlistByTextBusy] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [removeAllowlistBusyId, setRemoveAllowlistBusyId] = useState<number | null>(null);
  const [deactivateNftRoomBusyId, setDeactivateNftRoomBusyId] = useState<number | null>(null);

  const [streamers, setStreamers] = useState<AdminStreamerRoomUser[]>([]);
  const [streamersLoading, setStreamersLoading] = useState(false);
  const [streamersErr, setStreamersErr] = useState<string | null>(null);
  const [deactivateStreamerBusyId, setDeactivateStreamerBusyId] = useState<number | null>(null);

  const [appFilter, setAppFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('pending');
  const [applications, setApplications] = useState<AdminPartnerYoutubeApplicationRow[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appsErr, setAppsErr] = useState<string | null>(null);
  const [appRejectId, setAppRejectId] = useState<string | null>(null);
  const [appRejectReason, setAppRejectReason] = useState('');

  const addFiltered = useMemo(() => {
    const q = addSearch.trim().toLowerCase();
    if (!q) return userMap.slice(0, 60);
    return userMap
      .filter(
        (u) =>
          String(u.username || '')
            .toLowerCase()
            .includes(q) ||
          String(u.email || '')
            .toLowerCase()
            .includes(q) ||
          String(u.id).includes(q)
      )
      .slice(0, 80);
  }, [userMap, addSearch]);

  const openAddPartnerModal = useCallback(() => {
    setAddModalOpen(true);
    setAddSearch('');
    setAddErr(null);
    if (userMapFetched.current) return;
    setUserMapLoad(true);
    void (async () => {
      try {
        const m = await getAdminUserMap();
        setUserMap(Array.isArray(m) ? m : []);
        userMapFetched.current = true;
      } catch {
        setAddErr('Não foi possível carregar a lista de utilizadores.');
      } finally {
        setUserMapLoad(false);
      }
    })();
  }, []);

  const addPartnerByUserId = async (userId: number) => {
    setAllowlistBusyId(userId);
    setAddErr(null);
    try {
      const r = await postAdminPartnerYoutubeAllowlist({ userId });
      if (!r.ok) {
        setAddErr(r.error || 'Falha ao adicionar.');
        return;
      }
      if (!r.inserted) {
        alert('Este utilizador já estava na lista de parceiros (pode submeter vídeos).');
      }
      setAddModalOpen(false);
      void loadPartners();
    } finally {
      setAllowlistBusyId(null);
    }
  };

  const addPartnerByTypedText = async () => {
    const raw = addSearch.trim();
    if (!raw) {
      setAddErr('Escreve um nome de utilizador ou email.');
      return;
    }
    setAllowlistByTextBusy(true);
    setAddErr(null);
    try {
      const r = await postAdminPartnerYoutubeAllowlist({ username: raw });
      if (!r.ok) {
        setAddErr(r.error || 'Falha ao adicionar.');
        return;
      }
      if (!r.inserted) {
        alert('Este utilizador já estava na lista de parceiros.');
      }
      setAddModalOpen(false);
      void loadPartners();
    } finally {
      setAllowlistByTextBusy(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const { submissions } = await getAdminPartnerYoutubeSubmissions(filter);
      setRows(submissions);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Erro ao carregar.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadPartners = useCallback(async () => {
    setPartnersLoading(true);
    setPartnersErr(null);
    try {
      const { partners: p } = await getAdminPartnerYoutubePartners();
      setPartners(p);
    } catch (e) {
      setPartnersErr(e instanceof Error ? e.message : 'Erro ao carregar parceiros.');
      setPartners([]);
    } finally {
      setPartnersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sectionTab === 'parceiros') void loadPartners();
  }, [sectionTab, loadPartners]);

  const loadApplications = useCallback(async () => {
    setAppsLoading(true);
    setAppsErr(null);
    try {
      const { applications: rows } = await getAdminPartnerYoutubeApplications(appFilter);
      setApplications(rows);
    } catch (e) {
      setAppsErr(e instanceof Error ? e.message : 'Erro ao carregar candidaturas.');
      setApplications([]);
    } finally {
      setAppsLoading(false);
    }
  }, [appFilter]);

  useEffect(() => {
    if (sectionTab === 'candidaturas') void loadApplications();
  }, [sectionTab, loadApplications]);

  const approveApplication = async (id: string) => {
    setBusyId(id);
    try {
      const r = await adminApprovePartnerYoutubeApplication(id);
      if (!r.ok) {
        alert(r.error || 'Falha ao aprovar candidatura.');
        return;
      }
      await loadApplications();
      void loadPartners();
    } finally {
      setBusyId(null);
    }
  };

  const rejectApplication = async () => {
    if (!appRejectId) return;
    setBusyId(appRejectId);
    try {
      const r = await adminRejectPartnerYoutubeApplication(appRejectId, appRejectReason);
      if (!r.ok) {
        alert(r.error || 'Falha ao recusar candidatura.');
        return;
      }
      setAppRejectId(null);
      setAppRejectReason('');
      await loadApplications();
    } finally {
      setBusyId(null);
    }
  };

  const loadStreamers = useCallback(async () => {
    setStreamersLoading(true);
    setStreamersErr(null);
    try {
      const { users, error } = await getAdminStreamerRoomUsers();
      if (error) setStreamersErr(error);
      setStreamers(users);
    } catch (e) {
      setStreamersErr(e instanceof Error ? e.message : 'Erro ao carregar streamers.');
      setStreamers([]);
    } finally {
      setStreamersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sectionTab === 'streamers') void loadStreamers();
  }, [sectionTab, loadStreamers]);

  const approve = async (id: string) => {
    setBusyId(id);
    try {
      const r = await adminApprovePartnerYoutube(id);
      if (!r.ok) {
        alert(r.error || 'Falha ao aprovar.');
        return;
      }
      await load();
      void loadPartners();
    } finally {
      setBusyId(null);
    }
  };

  const reject = async () => {
    if (!rejectId) return;
    setBusyId(rejectId);
    try {
      const r = await adminRejectPartnerYoutube(rejectId, rejectReason);
      if (!r.ok) {
        alert(r.error || 'Falha ao recusar.');
        return;
      }
      setRejectId(null);
      setRejectReason('');
      await load();
      void loadPartners();
    } finally {
      setBusyId(null);
    }
  };

  const removeRow = async (id: string, title: string) => {
    if (
      !window.confirm(
        `Apagar permanentemente este envio?\n\n«${title.slice(0, 80)}${title.length > 80 ? '…' : ''}»\n\nIsto remove o registo da base de dados (pendente, aprovado ou recusado).`
      )
    ) {
      return;
    }
    setBusyId(id);
    try {
      const r = await adminDeletePartnerYoutube(id);
      if (!r.ok) {
        alert(r.error || 'Falha ao apagar.');
        return;
      }
      await load();
      void loadPartners();
    } finally {
      setBusyId(null);
    }
  };

  const openVitrine = async (userId: number, username: string) => {
    setVitrineUserId(userId);
    setVitrineUsername(username);
    setVitrineChannel('');
    setVitrineAvatar('');
    setVitrineLoad(true);
    try {
      const p = await getAdminPartnerYoutubeCreatorProfile(userId);
      setVitrineChannel(p.channelUrl);
      setVitrineAvatar(p.avatarUrl);
    } catch {
      setVitrineChannel('');
      setVitrineAvatar('');
    } finally {
      setVitrineLoad(false);
    }
  };

  const onVitrineAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setVitrineAvatarUpload(true);
    try {
      const r = await uploadAdImage(file);
      if (!r.ok || !r.imageUrl) {
        alert(r.error || 'Falha no upload.');
        return;
      }
      setVitrineAvatar(r.imageUrl);
    } finally {
      setVitrineAvatarUpload(false);
    }
  };

  const saveVitrine = async () => {
    if (vitrineUserId == null) return;
    setVitrineSave(true);
    try {
      const r = await putAdminPartnerYoutubeCreatorProfile(vitrineUserId, {
        channelUrl: vitrineChannel,
        avatarUrl: vitrineAvatar
      });
      if (!r.ok) {
        alert(r.error || 'Falha ao guardar.');
        return;
      }
      alert('Vitrine do parceiro atualizada.');
      setVitrineUserId(null);
      void loadPartners();
    } finally {
      setVitrineSave(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-black text-white tracking-tight">Parceiros YouTube</h2>
        <p className="text-xs text-slate-400 mt-1">
          <strong className="text-slate-300">Candidaturas</strong>: pedidos de novos parceiros YouTube (canal, capa, URL).{' '}
          <strong className="text-slate-300">Envios</strong>: aprovar, recusar ou apagar.{' '}
          <strong className="text-slate-300">Parceiros</strong>: vídeo aprovado na vitrine ou adicionado manualmente — canal YouTube e foto para «Os nossos parceiros»; quem está só na lista manual pode submeter vídeos antes de ter um aprovado.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-slate-800 pb-3">
        <button
          type="button"
          onClick={() => setSectionTab('envios')}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-black uppercase border transition-colors ${
            sectionTab === 'envios'
              ? 'bg-amber-600/20 text-white border-amber-600/60'
              : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
          }`}
        >
          <Clapperboard size={16} /> Envios
        </button>
        <button
          type="button"
          onClick={() => setSectionTab('candidaturas')}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-black uppercase border transition-colors ${
            sectionTab === 'candidaturas'
              ? 'bg-red-600/20 text-white border-red-600/60'
              : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
          }`}
        >
          <FileText size={16} /> Candidaturas
        </button>
        <button
          type="button"
          onClick={() => setSectionTab('parceiros')}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-black uppercase border transition-colors ${
            sectionTab === 'parceiros'
              ? 'bg-amber-600/20 text-white border-amber-600/60'
              : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
          }`}
        >
          <Users size={16} /> Parceiros (vitrine)
        </button>
        <button
          type="button"
          onClick={() => setSectionTab('streamers')}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-black uppercase border transition-colors ${
            sectionTab === 'streamers'
              ? 'bg-violet-600/20 text-white border-violet-600/60'
              : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
          }`}
        >
          <MonitorPlay size={16} /> Streamers
        </button>
      </div>

      {sectionTab === 'envios' && (
        <>
          <div className="flex flex-wrap gap-2">
            {(['pending', 'all', 'approved', 'rejected'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                  filter === f ? 'bg-amber-600/25 text-white border-amber-600/60' : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
                }`}
              >
                {f === 'pending' ? 'Pendentes' : f === 'all' ? 'Todos' : f === 'approved' ? 'Aprovados' : 'Recusados'}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-600 text-slate-300 hover:bg-slate-800"
            >
              <RefreshCw size={14} /> Atualizar
            </button>
          </div>

          {err && <div className="text-sm text-red-400">{err}</div>}

          {loading ? (
            <div className="flex justify-center py-16 text-amber-500">
              <Loader2 className="animate-spin" size={32} />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-slate-500 text-sm border border-slate-800 rounded-xl p-8 text-center">Sem registos neste filtro.</div>
          ) : (
            <ul className="space-y-3">
              {rows.map((r) => (
                <li
                  key={r.id}
                  className="rounded-xl border border-slate-700 bg-slate-900/50 p-4 flex flex-col sm:flex-row gap-4"
                >
                  <img
                    src={thumbUrl(r.youtubeVideoId)}
                    alt=""
                    className="w-full sm:w-40 aspect-video object-cover rounded-lg border border-slate-700 bg-slate-950 shrink-0"
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="font-bold text-white">{r.title}</div>
                    <div className="text-[11px] text-slate-500">
                      {r.username} · #{r.userId} · {r.email} · {fmtDate(r.createdAt)}
                    </div>
                    <div className="text-[11px] uppercase font-bold text-slate-400">Estado: {r.status}</div>
                    {r.rejectReason ? <div className="text-xs text-red-300/90">Motivo: {r.rejectReason}</div> : null}
                    <a
                      href={r.youtubeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300 mt-1"
                    >
                      <ExternalLink size={12} /> Abrir no YouTube
                    </a>
                  </div>
                  <div className="flex flex-col gap-2 shrink-0 justify-center">
                    {r.status === 'pending' && (
                      <>
                        <button
                          type="button"
                          disabled={busyId === r.id}
                          onClick={() => void approve(r.id)}
                          className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold disabled:opacity-40"
                        >
                          {busyId === r.id ? <Loader2 className="animate-spin" size={14} /> : <Check size={14} />}
                          Aprovar
                        </button>
                        <button
                          type="button"
                          disabled={busyId === r.id}
                          onClick={() => {
                            setRejectId(r.id);
                            setRejectReason('');
                          }}
                          className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-red-900/70 hover:bg-red-800 text-white text-xs font-bold disabled:opacity-40"
                        >
                          <X size={14} /> Recusar
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={() => void removeRow(r.id, r.title)}
                      className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg border border-slate-600 bg-slate-800/80 hover:bg-slate-800 text-slate-200 text-xs font-bold disabled:opacity-40"
                    >
                      {busyId === r.id ? <Loader2 className="animate-spin" size={14} /> : <Trash2 size={14} />}
                      Apagar
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {sectionTab === 'candidaturas' && (
        <>
          <div className="flex flex-wrap gap-2">
            {(['pending', 'all', 'approved', 'rejected'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setAppFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                  appFilter === f ? 'bg-red-600/25 text-white border-red-600/60' : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
                }`}
              >
                {f === 'pending' ? 'Pendentes' : f === 'all' ? 'Todos' : f === 'approved' ? 'Aprovados' : 'Recusados'}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void loadApplications()}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-600 text-slate-300 hover:bg-slate-800"
            >
              <RefreshCw size={14} /> Atualizar
            </button>
          </div>

          {appsErr && <div className="text-sm text-red-400">{appsErr}</div>}

          {appsLoading ? (
            <div className="flex justify-center py-16 text-red-400">
              <Loader2 className="animate-spin" size={32} />
            </div>
          ) : applications.length === 0 ? (
            <div className="text-slate-500 text-sm border border-slate-800 rounded-xl p-8 text-center">
              Sem candidaturas neste filtro.
            </div>
          ) : (
            <ul className="space-y-3">
              {applications.map((a) => (
                <li
                  key={a.id}
                  className="rounded-xl border border-slate-700 bg-slate-900/50 p-4 flex flex-col sm:flex-row gap-4"
                >
                  <div className="shrink-0">
                    {a.avatarUrl ? (
                      <img
                        src={a.avatarUrl}
                        alt=""
                        className="h-24 w-24 rounded-2xl object-cover border border-slate-600 bg-slate-950"
                      />
                    ) : (
                      <div className="h-24 w-24 rounded-2xl border border-slate-700 bg-slate-950 grid place-items-center text-slate-500 text-xs">
                        Sem capa
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="font-bold text-white text-lg">{a.channelName}</div>
                    <div className="text-[11px] text-slate-500">
                      {a.username} · #{a.userId} · {a.email} · {fmtDate(a.createdAt)}
                    </div>
                    <div className="text-[11px] uppercase font-bold text-slate-400">Estado: {a.status}</div>
                    {a.description ? <div className="text-xs text-slate-300 mt-1">{a.description}</div> : null}
                    {a.rejectReason ? <div className="text-xs text-red-300/90">Motivo: {a.rejectReason}</div> : null}
                    <a
                      href={a.channelUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300 mt-1"
                    >
                      <ExternalLink size={12} /> {a.channelUrl}
                    </a>
                  </div>
                  <div className="flex flex-col gap-2 shrink-0 justify-center">
                    {a.status === 'pending' && (
                      <>
                        <button
                          type="button"
                          disabled={busyId === a.id}
                          onClick={() => void approveApplication(a.id)}
                          className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold disabled:opacity-40"
                        >
                          {busyId === a.id ? <Loader2 className="animate-spin" size={14} /> : <Check size={14} />}
                          Aprovar + Sala Streamer
                        </button>
                        <button
                          type="button"
                          disabled={busyId === a.id}
                          onClick={() => {
                            setAppRejectId(a.id);
                            setAppRejectReason('');
                          }}
                          className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-red-900/70 hover:bg-red-800 text-white text-xs font-bold disabled:opacity-40"
                        >
                          <X size={14} /> Recusar
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {appRejectId && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
              <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 space-y-3">
                <h3 className="font-bold text-white">Recusar candidatura</h3>
                <textarea
                  value={appRejectReason}
                  onChange={(e) => setAppRejectReason(e.target.value)}
                  maxLength={PARTNER_REJECT_REASON_MAX}
                  rows={3}
                  placeholder="Motivo (opcional)"
                  className="w-full rounded-lg bg-slate-950 border border-slate-600 px-3 py-2 text-sm"
                />
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      setAppRejectId(null);
                      setAppRejectReason('');
                    }}
                    className="px-3 py-2 rounded-lg border border-slate-600 text-slate-300 text-xs font-bold"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={!!busyId}
                    onClick={() => void rejectApplication()}
                    className="px-3 py-2 rounded-lg bg-red-800 text-white text-xs font-bold disabled:opacity-40"
                  >
                    Confirmar recusa
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {sectionTab === 'parceiros' && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void loadPartners()}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-600 text-slate-300 hover:bg-slate-800"
            >
              <RefreshCw size={14} /> Atualizar lista
            </button>
            <button
              type="button"
              onClick={() => openAddPartnerModal()}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold border border-amber-700/60 bg-amber-950/35 text-amber-100 hover:bg-amber-900/40"
            >
              <UserPlus size={14} /> Adicionar parceiro
            </button>
            <span className="text-[11px] text-slate-500">
              Esta lista é da vitrine/manual: mostra parceiros com vídeo aprovado ou adicionados manualmente. A sala STREAMER fica na aba separada `Streamers`.
            </span>
          </div>
          {partnersErr && <div className="text-sm text-red-400">{partnersErr}</div>}
          {partnersLoading ? (
            <div className="flex justify-center py-16 text-amber-500">
              <Loader2 className="animate-spin" size={32} />
            </div>
          ) : partners.length === 0 ? (
            <div className="text-slate-500 text-sm border border-slate-800 rounded-xl p-8 text-center">
              Ainda não há parceiros na vitrine. Usa «Adicionar parceiro» ou aprova um primeiro vídeo.
            </div>
          ) : (
            <ul className="space-y-3">
              {partners.map((p) => (
                <li
                  key={p.userId}
                  className="rounded-xl border border-slate-700 bg-slate-900/50 p-4 flex flex-col sm:flex-row gap-4 items-center"
                >
                  <div className="shrink-0">
                    {p.avatarUrl ? (
                      <img
                        src={p.avatarUrl}
                        alt=""
                        className="h-16 w-16 rounded-full object-cover border border-slate-600 bg-slate-950"
                      />
                    ) : (
                      <div className="h-16 w-16 rounded-full bg-slate-800 border border-slate-600 flex items-center justify-center text-xl font-black text-amber-500">
                        {String(p.username || '?').slice(0, 1).toUpperCase()}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1 w-full">
                    <div className="font-bold text-white">{p.username}</div>
                    <div className="text-[11px] text-slate-500">
                      #{p.userId} · {p.email} · {p.approvedCount} vídeo(s) aprovado(s)
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Últimos 12 meses: {p.nftRoom?.approvedLast365d ?? p.approvedLast365d ?? 0}/6 · Último aprovado:{' '}
                      {fmtDateShort(p.nftRoom?.lastApprovedAt ?? p.lastApprovedAt)}
                    </div>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {p.allowlisted && (p.approvedCount ?? 0) === 0 ? (
                        <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded border border-amber-800/60 bg-amber-950/50 text-amber-200">
                          Lista manual — pode submeter
                        </span>
                      ) : null}
                      {p.channelUrl ? (
                        <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded border border-emerald-800/60 bg-emerald-950/40 text-emerald-300">
                          Canal definido
                        </span>
                      ) : (
                        <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded border border-slate-600 text-slate-500">
                          Sem canal
                        </span>
                      )}
                      {p.avatarUrl ? (
                        <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded border border-sky-800/60 bg-sky-950/40 text-sky-300">
                          Foto definida
                        </span>
                      ) : (
                        <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded border border-slate-600 text-slate-500">
                          Sem foto
                        </span>
                      )}
                      {p.nftRoom?.active ? (
                        <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded border border-violet-800/60 bg-violet-950/40 text-violet-200">
                          Sala Streamer ativa
                        </span>
                      ) : (
                        <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded border border-slate-600 text-slate-500">
                          Sem sala Streamer ativa
                        </span>
                      )}
                      {p.nftRoom?.active && p.nftRoom?.overdue ? (
                        <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded border border-red-800/70 bg-red-950/50 text-red-200">
                          Sala Streamer em falta
                        </span>
                      ) : p.nftRoom?.active ? (
                        <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded border border-emerald-800/60 bg-emerald-950/40 text-emerald-300">
                          Sala Streamer em dia
                        </span>
                      ) : null}
                    </div>
                    {p.nftRoom?.active && p.nftRoom?.overdue ? (
                      <div className="rounded-lg border border-red-900/60 bg-red-950/20 px-3 py-2 text-[11px] text-red-200">
                        Este parceiro está sem vídeo aprovado dentro da janela de 60 dias. O mínimo definido é 1 vídeo aprovado a
                        cada 2 meses e 6 por ano para manter a sala Streamer.
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0 justify-end w-full sm:w-auto">
                    {p.nftRoom?.active && p.nftRoom?.overdue ? (
                      <button
                        type="button"
                        disabled={deactivateNftRoomBusyId === p.userId}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Desativar a sala Streamer de «${p.username}»?\n\nIsto remove a sala Streamer do utilizador e desmonta as rigs dessa sala em segurança, devolvendo os itens ao inventário/armazenamento.`
                            )
                          ) {
                            return;
                          }
                          void (async () => {
                            setDeactivateNftRoomBusyId(p.userId);
                            try {
                              const r = await postAdminDeactivateStreamerRoom(p.userId);
                              if (!r.ok) {
                                alert(r.error || 'Falha ao desativar a sala Streamer.');
                                return;
                              }
                              alert(`Sala Streamer desativada com sucesso. Rigs removidas da sala: ${r.removedRackCount ?? 0}.`);
                              void loadPartners();
                            } finally {
                              setDeactivateNftRoomBusyId(null);
                            }
                          })();
                        }}
                        className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg border border-red-900/70 bg-red-950/40 hover:bg-red-900/45 text-red-100 text-xs font-bold disabled:opacity-40"
                      >
                        {deactivateNftRoomBusyId === p.userId ? (
                          <Loader2 className="animate-spin" size={14} />
                        ) : (
                          <X size={14} />
                        )}
                        Desativar sala Streamer
                      </button>
                    ) : null}
                    {p.allowlisted ? (
                      <button
                        type="button"
                        title="Remove a autorização extra de parceiro YouTube (lista manual)."
                        disabled={removeAllowlistBusyId === p.userId || vitrineUserId === p.userId}
                        onClick={() => {
                          const extra =
                            (p.approvedCount ?? 0) > 0
                              ? ' Mantém-se na lista se tiver vídeo(s) aprovado(s).'
                              : ' Deixa de poder enviar vídeos de parceiro se não tiver nível Parceiros.';
                          if (
                            !window.confirm(
                              `Remover «${p.username}» da lista manual de parceiros YouTube?${extra}`
                            )
                          ) {
                            return;
                          }
                          void (async () => {
                            setRemoveAllowlistBusyId(p.userId);
                            try {
                              const r = await deleteAdminPartnerYoutubeAllowlist(p.userId);
                              if (!r.ok) {
                                alert(r.error || 'Falha ao remover.');
                                return;
                              }
                              void loadPartners();
                            } finally {
                              setRemoveAllowlistBusyId(null);
                            }
                          })();
                        }}
                        className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg border border-red-900/70 bg-red-950/40 hover:bg-red-900/45 text-red-100 text-xs font-bold disabled:opacity-40"
                      >
                        {removeAllowlistBusyId === p.userId ? (
                          <Loader2 className="animate-spin" size={14} />
                        ) : (
                          <Trash2 size={14} />
                        )}
                        Remover da lista
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={vitrineUserId === p.userId}
                      onClick={() => void openVitrine(p.userId, p.username)}
                      className="inline-flex items-center justify-center gap-1 px-4 py-2 rounded-lg border border-amber-700/60 bg-amber-950/40 hover:bg-amber-900/50 text-amber-100 text-xs font-bold"
                    >
                      <ImageIcon size={14} /> Editar vitrine
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {addModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-slate-900 border border-slate-600 rounded-xl max-w-lg w-full p-5 space-y-3 max-h-[90vh] flex flex-col">
            <div className="font-bold text-white flex items-center gap-2">
              <UserPlus size={18} className="text-amber-400" /> Adicionar parceiro (YouTube)
            </div>
            <p className="text-xs text-slate-400">
              Pesquisa por nome, email ou ID e escolhe o utilizador. Fica autorizado a enviar vídeos de parceiro (1 por dia UTC), como quem tem nível Parceiros.
            </p>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
              <input
                value={addSearch}
                onChange={(e) => setAddSearch(e.target.value)}
                placeholder="Pesquisar ou colar email / nome exato…"
                className="w-full rounded-lg bg-slate-950 border border-slate-600 pl-9 pr-3 py-2 text-sm text-white"
              />
            </div>
            {addErr && <div className="text-sm text-red-400">{addErr}</div>}
            {userMapLoad ? (
              <div className="flex items-center gap-2 text-slate-400 text-sm py-6 justify-center">
                <Loader2 className="animate-spin" size={18} /> A carregar utilizadores…
              </div>
            ) : (
              <ul className="border border-slate-800 rounded-lg overflow-y-auto max-h-[14rem] divide-y divide-slate-800/80">
                {addFiltered.length === 0 ? (
                  <li className="p-4 text-sm text-slate-500 text-center">Sem resultados. Tenta outro termo ou adiciona por texto abaixo.</li>
                ) : (
                  addFiltered.map((u) => (
                    <li key={u.id} className="flex items-center gap-2 px-3 py-2 hover:bg-slate-800/50">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold text-white truncate">{u.username}</div>
                        <div className="text-[11px] text-slate-500 truncate">
                          #{u.id} · {u.email}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={allowlistBusyId === u.id}
                        onClick={() => void addPartnerByUserId(u.id)}
                        className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-40"
                      >
                        {allowlistBusyId === u.id ? <Loader2 className="animate-spin" size={14} /> : <UserPlus size={14} />}
                        Adicionar
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
            <div className="pt-1 border-t border-slate-800 space-y-2">
              <div className="text-[10px] uppercase font-bold text-slate-500">Nome ou email exato (servidor)</div>
              <button
                type="button"
                disabled={allowlistByTextBusy || !addSearch.trim()}
                onClick={() => void addPartnerByTypedText()}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold border border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
              >
                {allowlistByTextBusy ? <Loader2 className="animate-spin" size={16} /> : null}
                Adicionar pelo texto na caixa (ex.: email)
              </button>
            </div>
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() => setAddModalOpen(false)}
                className="px-3 py-2 rounded-lg text-sm font-bold bg-slate-700 text-white"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {vitrineUserId != null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-slate-900 border border-slate-600 rounded-xl max-w-md w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto">
            <div className="font-bold text-white">Vitrine — {vitrineUsername}</div>
            <div className="text-[11px] text-slate-500">Utilizador #{vitrineUserId}</div>
            <p className="text-xs text-slate-400">
              Canal: <code className="text-amber-200/90">https://www.youtube.com/...</code> (https, domínio YouTube). Foto: cola um URL ou usa{' '}
              <strong className="text-slate-300">Enviar imagem</strong> (PNG/JPG/GIF, máx. 5 MB — mesmo sistema dos anúncios).
            </p>
            {vitrineLoad ? (
              <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
                <Loader2 className="animate-spin" size={16} /> A carregar…
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Canal YouTube</label>
                  <input
                    value={vitrineChannel}
                    onChange={(e) => setVitrineChannel(e.target.value)}
                    placeholder="https://www.youtube.com/@canal ou /channel/…"
                    maxLength={PARTNER_CHANNEL_URL_MAX}
                    className="w-full rounded-lg bg-slate-950 border border-slate-600 px-3 py-2 text-sm text-white"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Foto (URL ou upload)</label>
                  <input
                    value={vitrineAvatar}
                    onChange={(e) => setVitrineAvatar(e.target.value)}
                    placeholder="https://… ou /img/… após enviar"
                    maxLength={PARTNER_AVATAR_URL_MAX}
                    className="w-full rounded-lg bg-slate-950 border border-slate-600 px-3 py-2 text-sm text-white"
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      ref={vitrineFileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/jpg,image/gif"
                      className="hidden"
                      onChange={(ev) => void onVitrineAvatarFile(ev)}
                    />
                    <button
                      type="button"
                      disabled={vitrineAvatarUpload}
                      onClick={() => vitrineFileInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-800 text-xs font-bold text-slate-200 hover:bg-slate-700 disabled:opacity-40"
                    >
                      {vitrineAvatarUpload ? <Loader2 className="animate-spin" size={14} /> : <ImageIcon size={14} />}
                      Enviar imagem
                    </button>
                    {vitrineAvatar ? (
                      <span className="text-[10px] text-slate-500 truncate max-w-[12rem]" title={vitrineAvatar}>
                        {vitrineAvatar}
                      </span>
                    ) : null}
                  </div>
                  {vitrineAvatar.startsWith('/') || vitrineAvatar.startsWith('http') ? (
                    <div className="mt-2 flex justify-center">
                      <img
                        src={vitrineAvatar}
                        alt="Pré-visualização"
                        className="h-16 w-16 rounded-full object-cover border border-slate-600"
                      />
                    </div>
                  ) : null}
                </div>
              </>
            )}
            <div className="flex gap-2 justify-end pt-2">
              <button
                type="button"
                onClick={() => setVitrineUserId(null)}
                className="px-3 py-2 rounded-lg text-sm font-bold bg-slate-700 text-white"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={vitrineLoad || vitrineSave}
                onClick={() => void saveVitrine()}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-bold bg-amber-600 text-white disabled:opacity-40"
              >
                {vitrineSave ? <Loader2 className="animate-spin" size={16} /> : null}
                {vitrineSave ? 'A guardar…' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {sectionTab === 'streamers' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void loadStreamers()}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-600 text-slate-300 hover:bg-slate-800"
            >
              <RefreshCw size={14} /> Atualizar
            </button>
            <span className="text-[11px] text-slate-500">
              Usuários com Sala STREAMER. Requisito: 1 vídeo aprovado a cada 60 dias.
              <span className="ml-2 text-red-400 font-bold">EM ATRASO</span> = sem vídeo aprovado nos últimos 60 dias.
            </span>
          </div>

          {streamersErr && <div className="text-sm text-red-400">{streamersErr}</div>}

          {streamersLoading ? (
            <div className="flex justify-center py-16 text-violet-400">
              <Loader2 className="animate-spin" size={32} />
            </div>
          ) : streamers.length === 0 ? (
            <div className="text-slate-500 text-sm border border-slate-800 rounded-xl p-8 text-center">
              Nenhum usuário com Sala STREAMER encontrado.
            </div>
          ) : (
            <>
              {streamers.some((s) => s.overdue) && (
                <div className="flex items-center gap-2 px-4 py-2 rounded-lg border border-red-900/60 bg-red-950/20 text-red-300 text-xs font-bold">
                  <AlertTriangle size={14} />
                  {streamers.filter((s) => s.overdue).length} streamer(s) EM ATRASO — sem vídeo aprovado nos últimos 60 dias.
                </div>
              )}
              <ul className="space-y-2">
                {streamers.map((s) => (
                  <li
                    key={s.userId}
                    className={`rounded-xl border p-4 flex flex-col sm:flex-row gap-3 items-start sm:items-center ${
                      s.overdue
                        ? 'border-red-900/60 bg-red-950/10'
                        : 'border-slate-700 bg-slate-900/40'
                    }`}
                  >
                    <div className="h-10 w-10 rounded-full bg-slate-800 border border-slate-600 flex items-center justify-center text-base font-black text-violet-400 shrink-0">
                      {String(s.username || '?').slice(0, 1).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="font-bold text-white text-sm">{s.username}</div>
                      <div className="text-[11px] text-slate-400">#{s.userId} · {s.email}</div>
                      <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {s.overdue ? (
                          <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded border border-red-800/70 bg-red-950/50 text-red-200 flex items-center gap-1">
                            <AlertTriangle size={10} /> EM ATRASO
                          </span>
                        ) : (
                          <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded border border-emerald-800/60 bg-emerald-950/40 text-emerald-300">
                            EM DIA
                          </span>
                        )}
                        <span className="text-[10px] px-2 py-0.5 rounded border border-slate-700 text-slate-400">
                          {s.approvedLast60d} vídeo(s) aprovado(s) nos últimos 60 dias
                        </span>
                        <span className="text-[10px] px-2 py-0.5 rounded border border-slate-700 text-slate-400">
                          Último aprovado: {s.lastApprovedAt ? new Date(s.lastApprovedAt).toLocaleDateString('pt-BR') : 'Nunca'}
                        </span>
                      </div>
                    </div>
                    {s.overdue && (
                      <button
                        type="button"
                        disabled={deactivateStreamerBusyId === s.userId}
                        onClick={() => {
                          if (!window.confirm(
                            `Desativar a Sala STREAMER de «${s.username}»?\n\nTODOS os itens dessa sala (GPUs, racks, baterias, etc.) serão devolvidos ao inventário e o acesso à sala será removido.`
                          )) return;
                          void (async () => {
                            setDeactivateStreamerBusyId(s.userId);
                            try {
                              const r = await postAdminDeactivateStreamerRoom(s.userId);
                              if (!r.ok) {
                                alert(r.error || 'Falha ao desativar.');
                                return;
                              }
                              alert(`Sala STREAMER desativada. Itens devolvidos: ${r.removedRackCount ?? 0} rack(s).`);
                              void loadStreamers();
                            } finally {
                              setDeactivateStreamerBusyId(null);
                            }
                          })();
                        }}
                        className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-red-900/70 bg-red-950/40 hover:bg-red-900/50 text-red-100 text-xs font-bold disabled:opacity-40 shrink-0"
                      >
                        {deactivateStreamerBusyId === s.userId ? (
                          <Loader2 className="animate-spin" size={14} />
                        ) : (
                          <X size={14} />
                        )}
                        Desativar Sala
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {rejectId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-slate-900 border border-slate-600 rounded-xl max-w-md w-full p-5 space-y-3">
            <div className="font-bold text-white">Recusar vídeo</div>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Motivo (opcional)"
              maxLength={PARTNER_REJECT_REASON_MAX}
              rows={3}
              className="w-full rounded-lg bg-slate-950 border border-slate-600 px-3 py-2 text-sm text-white"
            />
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setRejectId(null)}
                className="px-3 py-2 rounded-lg text-sm font-bold bg-slate-700 text-white"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={!!busyId}
                onClick={() => void reject()}
                className="px-3 py-2 rounded-lg text-sm font-bold bg-red-600 text-white disabled:opacity-40"
              >
                Confirmar recusa
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
