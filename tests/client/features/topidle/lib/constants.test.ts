import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TOPIDLE_GAME_ID,
  TOPIDLE_HISTORY_LIMIT,
  TOPIDLE_NAV_ENABLED,
  TOPIDLE_VOTE_REWARD_HPS,
  TOPIDLE_VOTE_URL
} from '../../../../../client/src/features/topidle/lib/constants.js';

const CORE = readFileSync(join(process.cwd(), 'rust/genesis-core/src/topidle.rs'), 'utf8');

describe('TopIdle vote URL', () => {
  it('aponta para a ficha genesis-miner com votar=1', () => {
    expect(TOPIDLE_GAME_ID).toBe('genesis-miner-cea25b');
    expect(TOPIDLE_VOTE_URL).toBe('https://topidle.com/jogo/genesis-miner-cea25b?votar=1');
    expect(TOPIDLE_VOTE_REWARD_HPS).toBe(1);
    expect(TOPIDLE_NAV_ENABLED).toBe(true);
    expect(TOPIDLE_HISTORY_LIMIT).toBe(50);
  });

  it('espelha as constantes do genesis-core', () => {
    expect(CORE).toContain(`"${TOPIDLE_GAME_ID}"`);
    expect(CORE).toContain(`"${TOPIDLE_VOTE_URL}"`);
    expect(CORE).toContain(`TOPIDLE_VOTE_REWARD_HPS: f64 = ${TOPIDLE_VOTE_REWARD_HPS}.0`);
    expect(CORE).toContain(`TOPIDLE_NAV_ENABLED: bool = ${String(TOPIDLE_NAV_ENABLED)}`);
    expect(CORE).toContain(`TOPIDLE_HISTORY_LIMIT: i64 = ${TOPIDLE_HISTORY_LIMIT}`);
  });
});
