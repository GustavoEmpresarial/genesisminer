/** Na Gestão o AM chat também vai embutido na página. */
export const GAME_VIEW_WITH_PAGE_GERENCIA_CHAT = 'management';

/** Canal público — único com TTL de mensagens. */
export const CHAT_CHANNEL_GLOBAL = 'global';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_DAY =
  MS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY;

/** Retenção mínima do chat global (alinhado ao mining-worker / Node). */
export const CHAT_MESSAGE_TTL_DAYS = 90;
/** Chat público: mensagens mais velhas que isto somem (purge + prune client). */
export const CHAT_MESSAGE_TTL_MS = CHAT_MESSAGE_TTL_DAYS * MS_PER_DAY;

/** TTL só no Global. DMs `am:owner:manager` não expiram sozinhas. */
export function chatChannelUsesMessageTtl(channel: string | null | undefined): boolean {
  const s = String(channel || '').trim();
  return s === '' || s === CHAT_CHANNEL_GLOBAL;
}

export function shouldUsePageGerenciaChat(view: string): boolean {
  return view === GAME_VIEW_WITH_PAGE_GERENCIA_CHAT;
}

export type FloatingGerenciaChatUserFlags = {
  isImpersonating?: boolean;
  isManagingAccount?: boolean;
  managerMode?: boolean;
};

/**
 * Popup no GameShell: jogo normal, modo gerência (dentro da conta) e
 * visualizar conta de utilizador. Não esconder em `isImpersonating` —
 * era isso que fazia o mini-chat desaparecer ao entrar na conta.
 */
export function shouldShowFloatingGerenciaChat(
  flags: FloatingGerenciaChatUserFlags = {}
): boolean {
  const managing = Boolean(flags.isManagingAccount || flags.managerMode);
  const viewingUserAccount = Boolean(flags.isImpersonating);
  const ownAccount = !managing && !viewingUserAccount;
  return ownAccount || managing || viewingUserAccount;
}

export type AmPeerThreadRole = 'owner' | 'manager';

/** `role: owner` = o viewer é o dono, o par é o gerente. */
export function amPeerThreadLabel(peer: {
  role: AmPeerThreadRole;
  peerUsername: string;
}): string {
  const name = peer.peerUsername.trim();
  if (peer.role === 'owner') {
    return name ? `Gerente · ${name}` : 'Gerente';
  }
  return name ? `Conta · ${name}` : 'Conta';
}

export function amPeerPickerHeading(peers: Array<{ role: AmPeerThreadRole }>): string {
  if (peers.length <= 1) {
    return peers[0]?.role === 'manager' ? 'Conta' : 'Gerente';
  }
  const asOwner = peers.some((p) => p.role === 'owner');
  const asManager = peers.some((p) => p.role === 'manager');
  if (asOwner && !asManager) return 'Escolhe o gerente';
  if (asManager && !asOwner) return 'Escolhe a conta';
  return 'Escolhe a conversa';
}

/** Prefere o par da conta que estás a ver; senão o primeiro contrato. */
export function pickInitialAmPeerChannel(
  peers: Array<{ channel: string; peerUserId: number }>,
  preferredPeerUserId?: number | null
): string | null {
  const preferred = Number(preferredPeerUserId);
  if (Number.isFinite(preferred) && preferred > 0) {
    const match = peers.find((p) => p.peerUserId === preferred);
    if (match) return match.channel;
  }
  return peers[0]?.channel ?? null;
}

/** Mini Blog expanded `max-w-[20rem]`. */
export const MINI_BLOG_EXPANDED_MAX_REM = 20;
/** Expanded rail `lg:mx-4`. */
export const MINI_BLOG_EXPANDED_MARGIN_REM = 1;
/** Collapsed rail `w-12`. */
export const MINI_BLOG_COLLAPSED_WIDTH_REM = 3;
/** Collapsed rail `lg:mx-3`. */
export const MINI_BLOG_COLLAPSED_MARGIN_REM = 0.75;
/** Space between popup and Mini Blog. */
export const CHAT_POPUP_RAIL_GAP_REM = 1;
/** Default `right-4`. */
export const CHAT_POPUP_EDGE_REM = 1;
/** Acima do anúncio in-app `z-[200]`; abaixo do skip `z-[9999]`. */
export const CHAT_POPUP_Z_CLASS = 'z-[220]';

/** `right` em rem para o popup não ficar por baixo do Mini Blog. */
export function floatingChatDockRightRem(opts: {
  miniBlogVisible: boolean;
  miniBlogExpanded: boolean;
}): number {
  if (!opts.miniBlogVisible) return CHAT_POPUP_EDGE_REM;
  if (opts.miniBlogExpanded) {
    return MINI_BLOG_EXPANDED_MAX_REM + MINI_BLOG_EXPANDED_MARGIN_REM + CHAT_POPUP_RAIL_GAP_REM;
  }
  return MINI_BLOG_COLLAPSED_WIDTH_REM + MINI_BLOG_COLLAPSED_MARGIN_REM + CHAT_POPUP_RAIL_GAP_REM;
}

/** Rail Mini Blog só existe em `xl:flex` — no mobile o popup fica em `right-4`. */
export const CHAT_POPUP_DOCK_DEFAULT_CLASS = 'right-4';
export const CHAT_POPUP_DOCK_BLOG_EXPANDED_CLASS = 'right-4 xl:right-[22rem]';
export const CHAT_POPUP_DOCK_BLOG_COLLAPSED_CLASS = 'right-4 xl:right-[4.75rem]';

export function floatingChatDockClass(opts: {
  miniBlogVisible: boolean;
  miniBlogExpanded: boolean;
}): string {
  if (!opts.miniBlogVisible) return CHAT_POPUP_DOCK_DEFAULT_CLASS;
  if (opts.miniBlogExpanded) return CHAT_POPUP_DOCK_BLOG_EXPANDED_CLASS;
  return CHAT_POPUP_DOCK_BLOG_COLLAPSED_CLASS;
}
