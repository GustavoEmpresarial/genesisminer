import { describe, expect, it } from 'vitest';
import {
  fallbackPartnerGamesConfig,
  parsePartnerGamesConfig,
  partnerGameBySlug,
  PARTNER_GAMES_HEARTBEAT_INTERVAL_MS
} from '../../../../client/src/shared/api/partner-games.js';

describe('parsePartnerGamesConfig', () => {
  it('narrows a multi-game catalog payload', () => {
    const parsed = parsePartnerGamesConfig({
      ok: true,
      heartbeatIntervalMs: PARTNER_GAMES_HEARTBEAT_INTERVAL_MS,
      maintenance: false,
      games: [
        {
          slug: 'master-legends',
          name: 'Master Legends',
          publicUrl: 'https://masterlegends.online/',
          embedPath: '/ml/?v=16',
          imageUrl: null,
          sessionKind: 'master-legends',
          section: 'official'
        },
        {
          slug: 'blockminer',
          name: 'BlockMiner',
          publicUrl: 'https://blockminer.space/',
          embedPath: '/bm/',
          imageUrl: '/img/partner/blockminer.webp',
          sessionKind: 'blockminer',
          section: 'partner'
        }
      ]
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.maintenance).toBe(false);
    expect(parsed!.heartbeatIntervalMs).toBe(PARTNER_GAMES_HEARTBEAT_INTERVAL_MS);
    expect(parsed!.games).toHaveLength(2);
    expect(parsed!.games[0]!.section).toBe('official');
    expect(parsed!.games[0]!.embedPath).toBe('/ml/?v=16');
    expect(parsed!.games[1]!.section).toBe('partner');
    expect(parsed!.games[1]!.embedPath).toBe('/bm/');
  });

  it('skips invalid game rows and rejects non-ok', () => {
    expect(parsePartnerGamesConfig({ ok: false })).toBeNull();
    const parsed = parsePartnerGamesConfig({
      ok: true,
      games: [
        { slug: 'x' },
        {
          slug: 'bad-section',
          name: 'Bad',
          publicUrl: 'https://x/',
          sessionKind: 'bad',
          section: 'unknown'
        },
        {
          slug: 'ok',
          name: 'Ok',
          publicUrl: 'https://x/',
          sessionKind: 'ok',
          section: 'partner'
        }
      ]
    });
    expect(parsed!.games).toHaveLength(1);
    expect(parsed!.games[0]!.slug).toBe('ok');
  });

  it('fallback is fail-closed maintenance with empty games', () => {
    const fb = fallbackPartnerGamesConfig();
    expect(fb.maintenance).toBe(true);
    expect(fb.games).toEqual([]);
  });

  it('partnerGameBySlug resolves catalog entries', () => {
    const cfg = parsePartnerGamesConfig({
      ok: true,
      games: [
        {
          slug: 'blockminer',
          name: 'BlockMiner',
          publicUrl: 'https://blockminer.space/',
          embedPath: '/bm/',
          imageUrl: null,
          sessionKind: 'blockminer',
          section: 'partner'
        }
      ]
    })!;
    expect(partnerGameBySlug(cfg, 'blockminer')?.name).toBe('BlockMiner');
    expect(partnerGameBySlug(cfg, 'missing')).toBeNull();
  });
});
