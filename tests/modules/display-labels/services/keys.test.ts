import { describe, expect, it } from 'vitest';
import {
  GAME_NAV_LABEL_SHORT_KEYS,
  UI_DISPLAY_LABEL_KEY_SET,
  UI_DISPLAY_LABEL_KEYS,
  UI_DISPLAY_LABEL_VALUE_MAX
} from '../../../../server/modules/display-labels/services/keys.js';

describe('display-labels keys allowlist', () => {
  it('aceita nav.profile e nav.management', () => {
    expect(UI_DISPLAY_LABEL_KEY_SET.has('nav.profile')).toBe(true);
    expect(UI_DISPLAY_LABEL_KEY_SET.has('nav.management')).toBe(true);
  });

  it('inclui todos os shorts GAME_NAV + roleta_tab_visible + legado page/shop/p2p', () => {
    for (const short of GAME_NAV_LABEL_SHORT_KEYS) {
      expect(UI_DISPLAY_LABEL_KEY_SET.has(`nav.${short}`)).toBe(true);
    }
    expect(UI_DISPLAY_LABEL_KEY_SET.has('nav.roleta_tab_visible')).toBe(true);
    expect(UI_DISPLAY_LABEL_KEY_SET.has('page.profile')).toBe(true);
    expect(UI_DISPLAY_LABEL_KEY_SET.has('shop.page_title')).toBe(true);
    expect(UI_DISPLAY_LABEL_KEY_SET.has('p2p.type.all')).toBe(true);
    expect(UI_DISPLAY_LABEL_KEYS.length).toBeGreaterThan(GAME_NAV_LABEL_SHORT_KEYS.length);
  });

  it('rejeita chave inexistente', () => {
    expect(UI_DISPLAY_LABEL_KEY_SET.has('nav.nope')).toBe(false);
  });

  it('VALUE max é 200', () => {
    expect(UI_DISPLAY_LABEL_VALUE_MAX).toBe(200);
  });
});
