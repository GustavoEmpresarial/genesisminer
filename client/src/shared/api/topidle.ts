import { apiFetch } from './http';
import {
  TOPIDLE_GAME_ID,
  TOPIDLE_HISTORY_LIMIT,
  TOPIDLE_VOTE_REWARD_HPS,
  TOPIDLE_VOTE_URL
} from '../../features/topidle/lib/constants';

const base = '/api';

export type TopIdleHistoryItem = {
  eventId: string;
  votedAtMs: number;
  hpsGranted: number;
};

export type TopIdleStatus = {
  voteUrl: string;
  gameId: string;
  nextVoteAtMs: number | null;
  canVoteNow: boolean;
  voteCount: number;
  totalHps: number;
  history: TopIdleHistoryItem[];
};

function finiteNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseHistoryItem(raw: unknown): TopIdleHistoryItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const eventId = typeof o.eventId === 'string' ? o.eventId.trim() : '';
  const votedAtMs = finiteNum(o.votedAtMs);
  const hpsGranted = finiteNum(o.hpsGranted) ?? TOPIDLE_VOTE_REWARD_HPS;
  if (!eventId || votedAtMs == null || votedAtMs <= 0) return null;
  return { eventId, votedAtMs, hpsGranted };
}

export function emptyTopIdleStatus(): TopIdleStatus {
  return {
    voteUrl: TOPIDLE_VOTE_URL,
    gameId: TOPIDLE_GAME_ID,
    nextVoteAtMs: null,
    canVoteNow: true,
    voteCount: 0,
    totalHps: 0,
    history: []
  };
}

export function parseTopIdleStatus(raw: unknown): TopIdleStatus {
  const fallback = emptyTopIdleStatus();
  if (!raw || typeof raw !== 'object') return fallback;
  const j = raw as Record<string, unknown>;
  const voteUrl = typeof j.voteUrl === 'string' && j.voteUrl.trim() ? j.voteUrl.trim() : TOPIDLE_VOTE_URL;
  const gameId = typeof j.gameId === 'string' && j.gameId.trim() ? j.gameId.trim() : TOPIDLE_GAME_ID;
  const nextVoteAtMs = finiteNum(j.nextVoteAtMs);
  const history = Array.isArray(j.history)
    ? j.history
        .map(parseHistoryItem)
        .filter((x): x is TopIdleHistoryItem => x != null)
        .slice(0, TOPIDLE_HISTORY_LIMIT)
    : [];
  const voteCount = Math.max(0, Math.trunc(finiteNum(j.voteCount) ?? history.length));
  const totalHps = finiteNum(j.totalHps) ?? voteCount * TOPIDLE_VOTE_REWARD_HPS;
  return {
    voteUrl,
    gameId,
    nextVoteAtMs,
    canVoteNow: j.canVoteNow !== false,
    voteCount,
    totalHps: totalHps < 0 ? 0 : totalHps,
    history
  };
}

export async function getTopIdleStatus(): Promise<TopIdleStatus> {
  const fallback = emptyTopIdleStatus();
  try {
    const res = await apiFetch(`${base}/topidle/status`);
    if (!res.ok) return fallback;
    return parseTopIdleStatus(await res.json());
  } catch {
    return fallback;
  }
}
