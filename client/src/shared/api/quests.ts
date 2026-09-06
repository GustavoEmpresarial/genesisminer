import { apiFetch } from './http';

const base = '/api';

export type QuestPeriod = 'daily' | 'weekly';

export type QuestStateItem = {
  id: string;
  period: QuestPeriod;
  actionType: string;
  title: string;
  description: string;
  targetCount: number;
  rewardUsdc: number;
  sortOrder: number;
  periodKey: string;
  progress: number;
  completed: boolean;
  claimed: boolean;
  canClaim: boolean;
};

export type QuestPeriodBounds = {
  key: string;
  startMs: number;
  endMs: number;
};

export type QuestsStatePayload = {
  daily: QuestStateItem[];
  weekly: QuestStateItem[];
  dailyPeriodKey: string;
  weeklyPeriodKey: string;
  dailyPeriod: QuestPeriodBounds | null;
  weeklyPeriod: QuestPeriodBounds | null;
};

function parseQuestStateItem(raw: unknown): QuestStateItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : '';
  if (!id) return null;
  return {
    id,
    period: o.period === 'weekly' ? 'weekly' : 'daily',
    actionType: typeof o.actionType === 'string' ? o.actionType : String(o.action_type || ''),
    title: typeof o.title === 'string' ? o.title : id,
    description: typeof o.description === 'string' ? o.description : '',
    targetCount: Math.max(1, Math.floor(Number(o.targetCount ?? o.target_count) || 1)),
    rewardUsdc: Math.max(0, Number(o.rewardUsdc ?? o.reward_usdc) || 0),
    sortOrder: Math.floor(Number(o.sortOrder ?? o.sort_order) || 0),
    periodKey: typeof o.periodKey === 'string' ? o.periodKey : String(o.period_key || ''),
    progress: Math.max(0, Math.floor(Number(o.progress) || 0)),
    completed: o.completed === true,
    claimed: o.claimed === true,
    canClaim: o.canClaim === true
  };
}

function parseBounds(raw: unknown): QuestPeriodBounds | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const startMs = Math.floor(Number(o.startMs) || 0);
  const endMs = Math.floor(Number(o.endMs) || 0);
  if (startMs <= 0 || endMs <= startMs) return null;
  return {
    key: typeof o.key === 'string' ? o.key : '',
    startMs,
    endMs
  };
}

export async function getQuestsState(): Promise<{ data: QuestsStatePayload | null; error: string | null }> {
  try {
    const res = await apiFetch(`${base}/quests/state`);
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (res.status === 401) return { data: null, error: 'SESSION' };
      return { data: null, error: typeof raw.error === 'string' ? raw.error : 'LOAD_FAILED' };
    }
    const daily = Array.isArray(raw.daily)
      ? raw.daily.map(parseQuestStateItem).filter((x): x is QuestStateItem => !!x)
      : [];
    const weekly = Array.isArray(raw.weekly)
      ? raw.weekly.map(parseQuestStateItem).filter((x): x is QuestStateItem => !!x)
      : [];
    return {
      data: {
        daily,
        weekly,
        dailyPeriodKey: typeof raw.dailyPeriodKey === 'string' ? raw.dailyPeriodKey : '',
        weeklyPeriodKey: typeof raw.weeklyPeriodKey === 'string' ? raw.weeklyPeriodKey : '',
        dailyPeriod: parseBounds(raw.dailyPeriod),
        weeklyPeriod: parseBounds(raw.weeklyPeriod)
      },
      error: null
    };
  } catch {
    return { data: null, error: 'NETWORK' };
  }
}

export async function claimQuestReward(
  questId: string
): Promise<{ data: { rewardUsdc: number; newUsdc: number } | null; error: string | null }> {
  try {
    const res = await apiFetch(`${base}/quests/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questId })
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (res.status === 401) return { data: null, error: 'SESSION' };
      return { data: null, error: typeof raw.error === 'string' ? raw.error : 'CLAIM_FAILED' };
    }
    return {
      data: {
        rewardUsdc: Math.max(0, Number(raw.rewardUsdc) || 0),
        newUsdc: Math.max(0, Number(raw.newUsdc) || 0)
      },
      error: null
    };
  } catch {
    return { data: null, error: 'NETWORK' };
  }
}

export async function getMyGlobalRanking(opts?: { fresh?: boolean }): Promise<{
  ok: boolean;
  position: number | null;
  totalRanked: number;
  hash: number;
}> {
  try {
    const q = opts?.fresh ? '?fresh=1' : '';
    const res = await apiFetch(`${base}/ranking/me${q}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, position: null, totalRanked: 0, hash: 0 };
    }
    const positionRaw = data.position;
    const position =
      positionRaw == null || positionRaw === ''
        ? null
        : Math.max(1, Math.floor(Number(positionRaw)) || 0) || null;
    return {
      ok: true,
      position,
      totalRanked: Math.max(0, Math.floor(Number(data.totalRanked) || 0)),
      hash: Math.max(0, Number(data.hash) || 0)
    };
  } catch {
    return { ok: false, position: null, totalRanked: 0, hash: 0 };
  }
}
