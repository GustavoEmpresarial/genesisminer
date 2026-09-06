import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('isAccountManagerEnabled', () => {
  const ORIGINAL = process.env.ACCOUNT_MANAGER_ENABLED;

  beforeEach(() => {
    delete process.env.ACCOUNT_MANAGER_ENABLED;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ACCOUNT_MANAGER_ENABLED;
    else process.env.ACCOUNT_MANAGER_ENABLED = ORIGINAL;
  });

  it('default (ausente) é desligado', async () => {
    const { isAccountManagerEnabled } = await import('../../../../server/modules/gerente/services/feature.js');
    expect(isAccountManagerEnabled()).toBe(false);
  });

  it('aceita 1/true/yes/on (case-insensitive)', async () => {
    const { isAccountManagerEnabled } = await import('../../../../server/modules/gerente/services/feature.js');
    for (const v of ['1', 'true', 'YES', 'On']) {
      process.env.ACCOUNT_MANAGER_ENABLED = v;
      expect(isAccountManagerEnabled()).toBe(true);
    }
  });

  it('valor desconhecido é desligado', async () => {
    process.env.ACCOUNT_MANAGER_ENABLED = 'nope';
    const { isAccountManagerEnabled } = await import('../../../../server/modules/gerente/services/feature.js');
    expect(isAccountManagerEnabled()).toBe(false);
  });
});
