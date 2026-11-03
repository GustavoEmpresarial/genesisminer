import { describe, expect, it } from 'vitest';
import { parseTopIdleStatus } from '../../../../client/src/shared/api/topidle.js';
import {
  TOPIDLE_GAME_ID,
  TOPIDLE_HISTORY_LIMIT,
  TOPIDLE_VOTE_REWARD_HPS,
  TOPIDLE_VOTE_URL
} from '../../../../client/src/features/topidle/lib/constants.js';

describe('parseTopIdleStatus', () => {
  it('falls back when payload is empty', () => {
    const s = parseTopIdleStatus(null);
    expect(s.voteUrl).toBe(TOPIDLE_VOTE_URL);
    expect(s.gameId).toBe(TOPIDLE_GAME_ID);
    expect(s.nextVoteAtMs).toBeNull();
    expect(s.canVoteNow).toBe(true);
    expect(s.voteCount).toBe(0);
    expect(s.totalHps).toBe(0);
    expect(s.history).toEqual([]);
  });

  it('maps history rows and totals', () => {
    const votedAtMs = 1_730_000_000_000;
    const s = parseTopIdleStatus({
      voteUrl: TOPIDLE_VOTE_URL,
      gameId: TOPIDLE_GAME_ID,
      nextVoteAtMs: votedAtMs,
      canVoteNow: false,
      voteCount: 2,
      totalHps: 2,
      history: [
        { eventId: 'ev-2', votedAtMs, hpsGranted: TOPIDLE_VOTE_REWARD_HPS },
        { eventId: 'ev-1', votedAtMs: votedAtMs - 1, hpsGranted: TOPIDLE_VOTE_REWARD_HPS }
      ]
    });
    expect(s.canVoteNow).toBe(false);
    expect(s.voteCount).toBe(2);
    expect(s.totalHps).toBe(2);
    expect(s.history).toEqual([
      { eventId: 'ev-2', votedAtMs, hpsGranted: TOPIDLE_VOTE_REWARD_HPS },
      { eventId: 'ev-1', votedAtMs: votedAtMs - 1, hpsGranted: TOPIDLE_VOTE_REWARD_HPS }
    ]);
  });

  it('drops malformed rows and caps at TOPIDLE_HISTORY_LIMIT', () => {
    const votedAtMs = 1_730_000_000_000;
    const extra = TOPIDLE_HISTORY_LIMIT + 3;
    const history = Array.from({ length: extra }, (_, i) => ({
      eventId: `ev-${i}`,
      votedAtMs: votedAtMs - i,
      hpsGranted: TOPIDLE_VOTE_REWARD_HPS
    }));
    history[1] = { eventId: '', votedAtMs, hpsGranted: TOPIDLE_VOTE_REWARD_HPS };
    const s = parseTopIdleStatus({ history, voteCount: extra, totalHps: extra });
    expect(s.history).toHaveLength(TOPIDLE_HISTORY_LIMIT);
    expect(s.history[0]?.eventId).toBe('ev-0');
    expect(s.history.some((row) => row.eventId === 'ev-1')).toBe(false);
  });
});
