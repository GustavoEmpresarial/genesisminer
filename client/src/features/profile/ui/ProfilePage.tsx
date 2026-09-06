/**
 * Console do operador Genesis — identidade, referral, wallet Polygon, segurança.
 * Ported from `legacy/frontend/components/ProfilePage.tsx`.
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  User as UserIcon,
  Lock,
  Mail,
  Save,
  AlertCircle,
  CheckCircle2,
  Wallet,
  ShieldCheck,
  Share2,
  Copy,
  Unplug
} from 'lucide-react';
import { AUTH_PASSWORD_MAX, AUTH_PASSWORD_MIN, AUTH_REFERRAL_MAX, AUTH_USERNAME_MAX, AUTH_USERNAME_MIN } from '../../../shared/constants/authLimits';
import { getSession } from '../../../shared/api/auth';
import {
  getProfileState,
  getProfileWallet,
  patchProfileIdentity,
  postProfilePasswordChange,
  postProfileReferralBind,
  postProfileWalletChallenge,
  postProfileWalletRemove,
  postProfileWalletVerify,
  type ProfileApiState,
  type ProfileWalletHistoryDto
} from '../../../shared/api/profile';
import { UiNoticeModal, type UiNotice } from '../../../shared/ui/UiNoticeModal';
import type { User } from '../../../shared/types/auth';
import { ReferralOverviewPanel } from './ReferralOverviewPanel';
import { useT } from '../../../shared/i18n';

function utf8MessageToHex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return `0x${hex}`;
}

function maskWalletAddress(addr: string | null | undefined): string {
  if (!addr || typeof addr !== 'string') return '—';
  const a = addr.trim();
  if (a.length <= 14) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function walletHistoryActionLabel(action: string): string {
  if (action === 'connected') return 'Conectada';
  if (action === 'changed') return 'Trocada';
  if (action === 'removed') return 'Removida';
  if (action === 'admin_changed') return 'Alterada (admin)';
  return action;
}

export type ProfilePageProps = {
  user: User;
  onUserUpdate?: (partial: { username?: string; polygonWallet?: string | null }) => void;
};

export const ProfilePage: React.FC<ProfilePageProps> = ({ user, onUserUpdate }) => {
  const t = useT();
  const [username, setUsername] = useState(user.username);
  const [polygonWallet, setPolygonWallet] = useState(user.polygonWallet || '');
  const [accessLevelLabel, setAccessLevelLabel] = useState('');
  const [accessLevelsCatalog, setAccessLevelsCatalog] = useState<ProfileApiState['accessLevelsCatalog']>([]);
  const [userAccessLevelIds, setUserAccessLevelIds] = useState<string[]>([]);
  const [invitedCount, setInvitedCount] = useState(0);
  const [referralInviteUrl, setReferralInviteUrl] = useState('');
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [referredBy, setReferredBy] = useState<string | null>(null);
  const [profileBadges, setProfileBadges] = useState<NonNullable<ProfileApiState['badges']>>([]);
  const [showBadgesSection, setShowBadgesSection] = useState(false);
  const [referralCodeInput, setReferralCodeInput] = useState('');
  const [referralClaimLoading, setReferralClaimLoading] = useState(false);
  const [notice, setNotice] = useState<UiNotice | null>(null);
  const [referralReloadNonce, setReferralReloadNonce] = useState(0);
  const [identitySaving, setIdentitySaving] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletRemoveConfirmOpen, setWalletRemoveConfirmOpen] = useState(false);
  const [walletRemoveBusy, setWalletRemoveBusy] = useState(false);
  const [walletHistoryRows, setWalletHistoryRows] = useState<ProfileWalletHistoryDto[]>([]);
  const identityLock = useRef(false);
  const passwordLock = useRef(false);
  const walletLock = useRef(false);

  const [currentPass, setCurrentPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');

  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const userReferralCode = user.referralCode;
  const userReferredBy = user.referredBy;
  const userAccessLevelId = user.accessLevelId;
  const userAccessLevelIdsProp = user.accessLevelIds ?? [];

  useEffect(() => {
    setPolygonWallet(user.polygonWallet || '');
  }, [user.polygonWallet]);

  useEffect(() => {
    setUsername(user.username);
  }, [user.username]);

  const applyProfileState = (st: ProfileApiState) => {
    const identity = st.identity;
    const referral = st.referral;
    const wallet = st.wallet;
    if (identity) {
      setAccessLevelLabel(identity.accessLevelLabel || identity.accessLevelId || '');
    }
    setAccessLevelsCatalog(Array.isArray(st.accessLevelsCatalog) ? st.accessLevelsCatalog : []);
    setUserAccessLevelIds(Array.isArray(st.userAccessLevelIds) ? st.userAccessLevelIds : []);
    if (referral) {
      setInvitedCount(typeof referral.invitedCount === 'number' ? referral.invitedCount : 0);
      setReferralInviteUrl(referral.inviteUrl || '');
      setReferralCode(referral.code ?? null);
      setReferredBy(referral.referredBy ?? null);
    }
    if (wallet) {
      setPolygonWallet(wallet.address || '');
    }

    const badges = Array.isArray(st.badges) ? st.badges : [];
    setProfileBadges(badges);
    setShowBadgesSection(badges.length > 0);
  };

  const refreshSessionUser = async () => {
    const fresh = await getSession();
    if (fresh && onUserUpdate) {
      onUserUpdate({
        username: fresh.username,
        polygonWallet: fresh.polygonWallet ?? null
      });
    }
  };

  const refreshWalletHistory = async () => {
    const pack = await getProfileWallet(100);
    if (pack?.ok && Array.isArray(pack.history)) {
      setWalletHistoryRows(pack.history);
    }
  };

  const reloadProfileState = async () => {
    const st = await getProfileState();
    if (st) applyProfileState(st);
    await refreshWalletHistory();
  };

  const handleConnectWallet = async () => {
    if (walletLock.current || walletBusy) return;
    walletLock.current = true;
    setWalletBusy(true);
    try {
      const eth = (window as Window & { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
      if (!eth) {
        setMessage({ type: 'error', text: t('profile.installWallet') });
        return;
      }
      const ch = await postProfileWalletChallenge();
      if (!ch.ok || !ch.message || !ch.challengeId) {
        setMessage({ type: 'error', text: ch.error || t('profile.walletLinkStartFailed') });
        return;
      }
      const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[] | undefined;
      const addr = accounts && accounts[0];
      if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) {
        setMessage({ type: 'error', text: t('profile.walletAddressFailed') });
        return;
      }
      try {
        const chainId = (await eth.request({ method: 'eth_chainId' })) as string;
        if (chainId !== '0x89') {
          try {
            await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] });
          } catch {
            try {
              await eth.request({
                method: 'wallet_addEthereumChain',
                params: [
                  {
                    chainId: '0x89',
                    chainName: 'Polygon Mainnet',
                    nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
                    rpcUrls: ['https://polygon-rpc.com'],
                    blockExplorerUrls: ['https://polygonscan.com']
                  }
                ]
              });
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
      const msgHex = utf8MessageToHex(ch.message);
      let signature: string;
      try {
        signature = (await eth.request({
          method: 'personal_sign',
          params: [msgHex, addr]
        })) as string;
      } catch {
        setMessage({ type: 'error', text: t('profile.signatureCancelled') });
        return;
      }
      const verify = await postProfileWalletVerify({
        challengeId: ch.challengeId,
        address: addr,
        signature,
        chainId: ch.chainId ?? 137
      });
      if (!verify.ok) {
        if (verify.code === 'CHALLENGE_EXPIRED' || verify.code === 'NONCE_USED') {
          await reloadProfileState();
        }
        setMessage({ type: 'error', text: verify.error || t('profile.walletVerifyFailed') });
        return;
      }
      await refreshSessionUser();
      await reloadProfileState();
      await refreshWalletHistory();
      setMessage({ type: 'success', text: t('profile.walletVerified') });
    } catch {
      setMessage({ type: 'error', text: t('profile.authCancelled') });
    } finally {
      setWalletBusy(false);
      walletLock.current = false;
    }
  };

  const handleRemoveConnectedWallet = () => {
    if (!polygonWallet) return;
    setWalletRemoveConfirmOpen(true);
  };

  const confirmRemoveWallet = async () => {
    if (!polygonWallet || walletRemoveBusy) return;
    setWalletRemoveBusy(true);
    try {
      const cleared = await postProfileWalletRemove();
      if (!cleared.ok) {
        setMessage({
          type: 'error',
          text: cleared.error || 'Não foi possível remover a carteira. Tente novamente.'
        });
        return;
      }
      setPolygonWallet('');
      setWalletRemoveConfirmOpen(false);
      onUserUpdate?.({ polygonWallet: null });
      await refreshSessionUser();
      await reloadProfileState();
      await refreshWalletHistory();
      setMessage({
        type: 'success',
        text: cleared.message || 'Carteira removida com sucesso.'
      });
    } finally {
      setWalletRemoveBusy(false);
    }
  };

  const handleUpdateBasicInfo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (identityLock.current || identitySaving) return;
    const u = username.trim();
    if (!u) {
      setMessage({ type: 'error', text: t('profile.usernameEmpty') });
      return;
    }
    if (u.length < AUTH_USERNAME_MIN || u.length > AUTH_USERNAME_MAX) {
      setMessage({
        type: 'error',
        text: t('profile.usernameLen', { min: AUTH_USERNAME_MIN, max: AUTH_USERNAME_MAX })
      });
      return;
    }
    identityLock.current = true;
    setIdentitySaving(true);
    try {
      const out = await patchProfileIdentity(u);
      if (!out.ok) {
        await reloadProfileState();
        setMessage({ type: 'error', text: out.error || t('profile.profileUpdateFailed') });
        return;
      }
      onUserUpdate?.({ username: u });
      await refreshSessionUser();
      await reloadProfileState();
      setMessage({ type: 'success', text: t('profile.basicsUpdated') });
    } finally {
      setIdentitySaving(false);
      identityLock.current = false;
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordLock.current || passwordSaving) return;
    if (!newPass.length) {
      setMessage({ type: 'error', text: t('profile.enterNewPassword') });
      return;
    }
    if (newPass.length > AUTH_PASSWORD_MAX) {
      setMessage({ type: 'error', text: t('profile.passwordMax', { max: AUTH_PASSWORD_MAX }) });
      return;
    }
    if (newPass.length < AUTH_PASSWORD_MIN) {
      setMessage({ type: 'error', text: t('profile.passwordMin', { min: AUTH_PASSWORD_MIN }) });
      return;
    }
    if (newPass !== confirmPass) {
      setMessage({ type: 'error', text: t('profile.passwordsMismatch') });
      return;
    }
    passwordLock.current = true;
    setPasswordSaving(true);
    try {
      const out = await postProfilePasswordChange({
        currentPassword: currentPass,
        newPassword: newPass,
        confirmPassword: confirmPass
      });
      if (!out.ok) {
        if (out.code === 'PASSWORD_CURRENT_WRONG' || out.code === 'PASSWORD_WEAK') {
          await reloadProfileState();
        }
        setMessage({ type: 'error', text: out.error || t('profile.passwordChangeFailed') });
        return;
      }
      await refreshSessionUser();
      await reloadProfileState();
      setMessage({ type: 'success', text: out.message || t('profile.passwordChanged') });
      setCurrentPass('');
      setNewPass('');
      setConfirmPass('');
    } finally {
      setPasswordSaving(false);
      passwordLock.current = false;
    }
  };

  const copyReferralLink = () => {
    const code = referralCode || userReferralCode;
    const link =
      referralInviteUrl.trim() ||
      (code ? `${window.location.origin}?ref=${encodeURIComponent(code)}` : '');
    if (!link) return;
    void navigator.clipboard.writeText(link);
    alert('Link de indicação copiado!');
  };

  useEffect(() => {
    const load = async () => {
      const st = await getProfileState();
      if (st) {
        applyProfileState(st);
      } else {
        setReferralInviteUrl(
          userReferralCode ? `${window.location.origin}?ref=${encodeURIComponent(userReferralCode)}` : ''
        );
        setReferredBy(userReferredBy ?? null);
        setReferralCode(userReferralCode ?? null);
      }
      await refreshWalletHistory();
    };
    void load();
  }, [user.email, user.username, userReferralCode, userReferredBy]);

  const effectiveReferredBy = referredBy ?? userReferredBy ?? null;
  const effectiveReferralCode = referralCode ?? userReferralCode ?? null;

  const currentLevelName = (() => {
    if (accessLevelLabel) return accessLevelLabel;
    const lvlIds = userAccessLevelIds.length ? userAccessLevelIds : userAccessLevelIdsProp;
    const primaryId = userAccessLevelId || lvlIds[0];
    const lvl = accessLevelsCatalog.find((l) => l.id === primaryId);
    return lvl ? lvl.name : primaryId || 'Desconhecido';
  })();

  const canBindReferral = !effectiveReferredBy;

  return (
    <div className="flex flex-col p-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="flex items-center gap-3 mb-6 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div className="bg-slate-200 dark:bg-slate-800 p-2 rounded-lg text-amber-600 dark:text-amber-400">
          <UserIcon size={24} />
        </div>
        <div>
          <h2 className="text-xl font-bold text-slate-800 dark:text-slate-200">{t('profile.consoleTitle')}</h2>
          <p className="text-sm text-slate-500">{t('profile.consoleSubtitle')}</p>
        </div>
      </div>

      {message && (
        <div
          className={`mb-6 p-4 rounded-lg flex items-center gap-2 text-sm font-bold ${
            message.type === 'success'
              ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800'
              : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800'
          }`}
        >
          {message.type === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 pb-8">
        <div className="space-y-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm">
            <h3 className="text-lg font-bold text-slate-800 dark:text-white mb-4 flex items-center gap-2">
              <UserIcon size={18} className="text-amber-500" /> {t('profile.networkIdentity')}
            </h3>
            <form onSubmit={handleUpdateBasicInfo} className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs uppercase font-bold text-slate-500">{t('profile.emailId')}</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                  <input
                    type="text"
                    value={user.email}
                    disabled
                    className="w-full bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg py-2 pl-10 pr-4 text-slate-500 dark:text-slate-400 cursor-not-allowed"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs uppercase font-bold text-slate-500">{t('profile.username')}</label>
                <div className="relative">
                  <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    maxLength={AUTH_USERNAME_MAX}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg py-2 pl-10 pr-4 text-slate-900 dark:text-white focus:border-amber-500 outline-none transition-colors"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs uppercase font-bold text-slate-500">{t('profile.accessLevel')}</label>
                <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg py-2 px-3 text-slate-700 dark:text-slate-300">
                  <ShieldCheck size={16} className="text-green-600 dark:text-green-400" />
                  <span className="text-sm font-bold">{currentLevelName}</span>
                </div>
              </div>
              <button
                type="submit"
                disabled={identitySaving}
                className="bg-amber-600 hover:bg-amber-500 text-white text-sm font-bold py-2 px-4 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Save size={16} /> {identitySaving ? 'A gravar…' : 'Salvar alterações'}
              </button>
            </form>
          </div>

          <div className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-950/40 border border-amber-200 dark:border-amber-800 rounded-xl p-6 shadow-sm">
            <h3 className="text-lg font-bold text-slate-800 dark:text-white mb-4 flex items-center gap-2">
              <Share2 size={18} className="text-amber-500" /> {t('profile.referralProgram')}
            </h3>

            <div className="space-y-4">
              <div>
                <label className="text-xs uppercase font-bold text-slate-500">{t('profile.inviteLink')}</label>
                <div className="flex gap-2 mt-1">
                  <div className="bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg py-2 px-3 text-slate-600 dark:text-slate-400 text-sm font-mono truncate flex-1">
                    {referralInviteUrl.trim() ||
                      (effectiveReferralCode ? `?ref=${effectiveReferralCode}` : 'Código não gerado')}
                  </div>
                  <button
                    type="button"
                    onClick={copyReferralLink}
                    disabled={!referralInviteUrl.trim() && !effectiveReferralCode}
                    className="bg-amber-600 hover:bg-amber-500 text-white p-2 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
                    title={t('profile.copyLink')}
                  >
                    <Copy size={18} />
                  </button>
                </div>
              </div>

              <div className="bg-white dark:bg-slate-950 rounded-lg p-3 border border-slate-200 dark:border-slate-800">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-bold text-slate-500 uppercase">{t('profile.invitedOperators')}</span>
                  <span className="text-sm font-bold text-amber-600 dark:text-amber-400">{invitedCount}</span>
                </div>

                <div className="text-xs text-slate-400 italic">
                  {invitedCount > 0 ? (
                    <>
                      Total de <span className="font-semibold text-amber-700 dark:text-amber-400">{invitedCount}</span>{' '}
                      operador(es) na sua rede de indicações. A comissão é creditada pelo servidor quando há depósito
                      USDC elegível do indicado.
                    </>
                  ) : (
                    <>
                      Nenhum indicado ainda. Quando um indicado depositar USDC na conta dele, você recebe automaticamente{' '}
                      <span className="font-semibold text-amber-700 dark:text-amber-400">5%</span> do valor creditado em
                      USDC no seu saldo.
                    </>
                  )}
                </div>
              </div>

              {effectiveReferredBy && (
                <div className="bg-white dark:bg-slate-950 rounded-lg p-3 border border-slate-200 dark:border-slate-800 mt-3">
                  <div className="text-xs font-bold text-slate-500 uppercase">{t('profile.whoReferredYou')}</div>
                  <div className="mt-1 text-sm font-mono text-emerald-600 dark:text-emerald-400 truncate">
                    {effectiveReferredBy}
                  </div>
                </div>
              )}

              {canBindReferral && (
                <div className="bg-white dark:bg-slate-950 rounded-lg p-3 border border-slate-200 dark:border-slate-800 mt-3">
                  <div className="text-xs font-bold text-slate-500 uppercase mb-2">Quem te indicou?</div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={referralCodeInput}
                      onChange={(e) => setReferralCodeInput(e.target.value.slice(0, AUTH_REFERRAL_MAX))}
                      maxLength={AUTH_REFERRAL_MAX}
                      placeholder={t('profile.referralCode')}
                      className="flex-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg py-2 px-3 text-sm"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const code = referralCodeInput.trim();
                        if (!code || referralClaimLoading) return;
                        setReferralClaimLoading(true);
                        const res = await postProfileReferralBind(code);
                        setReferralClaimLoading(false);
                        if (res.ok) {
                          setReferralCodeInput('');
                          await refreshSessionUser();
                          await reloadProfileState();
                          setReferralReloadNonce((n) => n + 1);
                          setNotice({
                            variant: 'success',
                            title: t('profile.referrerLinked'),
                            message: t('profile.referrerLinkedOk')
                          });
                        } else {
                          await reloadProfileState();
                          const map: Record<string, { title: string; message: string }> = {
                            REFERRAL_ALREADY_BOUND: {
                              title: t('profile.alreadyLinked'),
                              message: t('profile.alreadyHasReferrer')
                            },
                            REFERRAL_SELF: { title: t('profile.invalidCode'), message: t('profile.cannotUseOwnCode') },
                            REFERRAL_CODE_INVALID: {
                              title: t('profile.invalidCode'),
                              message: 'Esse código de indicação não existe.'
                            },
                            REFERRAL_CYCLE: {
                              title: t('profile.linkBlocked'),
                              message: 'Não é possível usar o código de alguém que você já indicou.'
                            },
                            REFERRAL_IP_RULE: {
                              title: 'Anti-fraude',
                              message: res.error || 'Não foi possível vincular este código a partir do seu IP.'
                            }
                          };
                          const m = res.code ? map[res.code] : undefined;
                          setNotice({
                            variant: 'error',
                            title: m?.title ?? 'Não foi possível vincular',
                            message: m?.message ?? res.error ?? 'Tente de novo dentro de momentos.'
                          });
                        }
                      }}
                      disabled={referralClaimLoading}
                      className="bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white px-4 rounded-lg text-sm font-bold"
                    >
                      {referralClaimLoading ? t('profile.processing') : t('profile.linkCode')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <ReferralOverviewPanel reloadNonce={referralReloadNonce} />
        </div>

        <div className="space-y-6">
          {showBadgesSection && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm">
              <h3 className="text-lg font-bold text-slate-800 dark:text-white mb-4">{t('profile.seasonBadges')}</h3>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                {profileBadges.map((b, idx) => (
                  <div key={`${b.passId}-${idx}`} className="flex flex-col items-center gap-2">
                    {b.imageUrl ? (
                      <img
                        src={b.imageUrl}
                        alt={b.name}
                        className="w-16 h-16 object-cover rounded border border-slate-200 dark:border-slate-700"
                      />
                    ) : (
                      <div className="w-16 h-16 rounded bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-400">
                        🏅
                      </div>
                    )}
                    <div className="text-[10px] text-slate-600 dark:text-slate-400 text-center truncate w-16">{b.name}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm">
            <h3 className="text-lg font-bold text-slate-800 dark:text-white mb-4 flex items-center gap-2">
              <Lock size={18} className="text-red-500" /> {t('profile.changePassword')}
            </h3>
            <form onSubmit={handleChangePassword} className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs uppercase font-bold text-slate-500">{t('profile.currentPassword')}</label>
                <input
                  type="password"
                  value={currentPass}
                  onChange={(e) => setCurrentPass(e.target.value)}
                  maxLength={AUTH_PASSWORD_MAX}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg py-2 px-4 text-slate-900 dark:text-white focus:border-red-500 outline-none transition-colors"
                />
              </div>
              <div className="border-t border-slate-200 dark:border-slate-800 my-2"></div>
              <div className="space-y-1">
                <label className="text-xs uppercase font-bold text-slate-500">{t('profile.newPassword')}</label>
                <input
                  type="password"
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                  maxLength={AUTH_PASSWORD_MAX}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg py-2 px-4 text-slate-900 dark:text-white focus:border-amber-500 outline-none transition-colors"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs uppercase font-bold text-slate-500">{t('profile.confirmNewPassword')}</label>
                <input
                  type="password"
                  value={confirmPass}
                  onChange={(e) => setConfirmPass(e.target.value)}
                  maxLength={AUTH_PASSWORD_MAX}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg py-2 px-4 text-slate-900 dark:text-white focus:border-amber-500 outline-none transition-colors"
                />
              </div>
              <button
                type="submit"
                disabled={passwordSaving}
                className="bg-slate-800 hover:bg-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600 text-white text-sm font-bold py-2 px-4 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Save size={16} /> {passwordSaving ? t('profile.updating') : t('profile.updatePassword')}
              </button>
            </form>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-5 text-orange-500 pointer-events-none">
              <Wallet size={100} />
            </div>
            <h3 className="text-lg font-bold text-slate-800 dark:text-white mb-4 flex items-center gap-2 relative z-10">
              <Wallet size={18} className="text-orange-500" /> {t('profile.withdrawWallet')}
            </h3>
            <div className="flex flex-wrap items-center gap-2 mb-4 relative z-10">
              <button
                type="button"
                onClick={handleConnectWallet}
                disabled={!!polygonWallet || walletBusy}
                className="bg-orange-100 dark:bg-orange-900/30 hover:bg-orange-200 dark:hover:bg-orange-900/50 border border-orange-300 dark:border-orange-800 text-orange-700 dark:text-orange-400 text-xs font-bold px-4 py-2 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {walletBusy ? t('profile.linking') : t('profile.connectBrowserWallet')}
              </button>
              {polygonWallet ? (
                <button
                  type="button"
                  onClick={handleRemoveConnectedWallet}
                  className="bg-slate-100 dark:bg-slate-800/80 hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 text-xs font-bold px-4 py-2 rounded transition-colors flex items-center gap-1.5"
                >
                  <Unplug size={14} className="shrink-0 opacity-80" />
                  Remover carteira conectada
                </button>
              ) : null}
              {polygonWallet && (
                <span className="text-[10px] font-mono text-slate-600 dark:text-slate-400 truncate max-w-full sm:max-w-[min(100%,18rem)]">
                  {polygonWallet}
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500 mb-4 relative z-10">
              Ligação segura na Polygon (assinatura no navegador). O servidor valida o desafio e nunca pede seed phrase.
            </p>

            <div className="space-y-2 relative z-10">
              <label className="text-xs uppercase font-bold text-slate-500">{t('profile.publicAddress')}</label>
              <div className="w-full bg-slate-100 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg py-2 px-4 text-slate-700 dark:text-slate-300 font-mono text-sm">
                {polygonWallet || 'Nenhuma carteira conectada'}
              </div>
            </div>

            <div className="mt-6 border-t border-slate-200 dark:border-slate-800 pt-4 relative z-10">
              <h4 className="text-sm font-bold text-slate-800 dark:text-white mb-3">{t('profile.walletHistory')}</h4>
              {walletHistoryRows.length === 0 ? (
                <p className="text-xs text-slate-500">{t('profile.noWalletEvents')}</p>
              ) : (
                <ul className="space-y-2 max-h-52 overflow-y-auto pr-1">
                  {walletHistoryRows.map((row) => {
                    const display =
                      row.walletAddress || row.newWalletAddress || row.previousWalletAddress || '';
                    const when = new Date(row.createdAt);
                    const dateStr = Number.isFinite(when.getTime())
                      ? when.toLocaleString('pt-PT', {
                          day: '2-digit',
                          month: '2-digit',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit'
                        })
                      : String(row.createdAt);
                    return (
                      <li
                        key={row.id}
                        className="flex flex-wrap items-center justify-between gap-2 text-xs bg-slate-50 dark:bg-slate-950/80 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="text-slate-500 dark:text-slate-400">{dateStr}</span>
                          <span className="mx-1 text-slate-400">—</span>
                          <span className="font-bold text-amber-700 dark:text-amber-400">
                            {walletHistoryActionLabel(row.action)}
                          </span>
                          <span className="mx-1 text-slate-400">—</span>
                          <span className="font-mono text-slate-700 dark:text-slate-300">
                            {maskWalletAddress(display)}
                          </span>
                          <span className="mx-1 text-slate-400">·</span>
                          <span className="text-slate-500 capitalize">{row.network}</span>
                        </div>
                        {display && String(display).startsWith('0x') ? (
                          <button
                            type="button"
                            className="shrink-0 text-[10px] font-bold uppercase text-amber-600 dark:text-amber-400 hover:text-amber-500"
                            onClick={() => void navigator.clipboard.writeText(String(display))}
                          >
                            Copiar
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>

      {walletRemoveConfirmOpen ? (
        <div
          className="fixed inset-0 z-[170] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
          role="dialog"
          aria-modal="true"
          aria-labelledby="wallet-remove-title"
          onClick={() => {
            if (!walletRemoveBusy) setWalletRemoveConfirmOpen(false);
          }}
        >
          <div
            className="relative w-full max-w-md rounded-2xl border border-slate-600/80 bg-slate-900 p-5 shadow-2xl dark:bg-slate-950"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="wallet-remove-title" className="mb-2 text-base font-bold text-white pr-2">
              Remover carteira de saque?
            </h3>
            <p className="text-sm leading-relaxed text-slate-300">
              Depósitos e levantamentos em cripto ficarão indisponíveis até conectar outra carteira.
            </p>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                disabled={walletRemoveBusy}
                onClick={() => setWalletRemoveConfirmOpen(false)}
                className="flex-1 rounded-xl border border-slate-600 py-2.5 text-xs font-black uppercase tracking-widest text-slate-200 transition hover:bg-slate-800 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={walletRemoveBusy}
                onClick={() => void confirmRemoveWallet()}
                className="flex-1 rounded-xl bg-orange-600 py-2.5 text-xs font-black uppercase tracking-widest text-white transition hover:bg-orange-500 disabled:opacity-50"
              >
                {walletRemoveBusy ? 'Removendo…' : 'Remover carteira'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <UiNoticeModal notice={notice} onClose={() => setNotice(null)} overlayZClassName="z-[160]" />
    </div>
  );
};
