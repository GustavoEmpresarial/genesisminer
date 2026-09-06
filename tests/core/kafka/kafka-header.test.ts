import { afterEach, describe, expect, it, vi } from 'vitest';

describe('kafka config / publish no-op', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('kafkaEnabled is false by default', async () => {
    vi.stubEnv('KAFKA_ENABLED', '0');
    vi.stubEnv('KAFKA_BROKERS', '');
    const { kafkaEnabled } = await import('../../../server/core/kafka/config.js');
    expect(kafkaEnabled()).toBe(false);
  });

  it('kafkaEnabled requires flag and brokers', async () => {
    vi.stubEnv('KAFKA_ENABLED', '1');
    vi.stubEnv('KAFKA_BROKERS', 'localhost:9092');
    const { kafkaEnabled, kafkaBrokers } = await import('../../../server/core/kafka/config.js');
    expect(kafkaEnabled()).toBe(true);
    expect(kafkaBrokers()).toEqual(['localhost:9092']);
  });

  it('publishJson skips when disabled', async () => {
    vi.stubEnv('KAFKA_ENABLED', '0');
    const { publishJson } = await import('../../../server/core/kafka/producer.js');
    const r = await publishJson('genesis.mining.progress', '1', { userId: 1 });
    expect(r).toEqual({ ok: true, skipped: true });
  });
});

describe('header invalidate from message', () => {
  it('parse + applyHeaderInvalidateFromMessageValue', async () => {
    const invalidate = vi.fn();
    vi.doMock('../../../server/modules/mining-engine/services/player-game-header-cache.js', () => ({
      invalidatePlayerGameHeaderCache: invalidate
    }));
    vi.resetModules();
    const { applyHeaderInvalidateFromMessageValue } = await import(
      '../../../server/core/kafka/consumer-header-invalidate.js'
    );
    const { parsePlayerHeaderEvent } = await import('../../../server/core/kafka/header-events.js');

    expect(parsePlayerHeaderEvent({ userId: 42, reason: 'mining_progress', at: 1 })).toMatchObject({
      userId: 42,
      reason: 'mining_progress'
    });
    expect(parsePlayerHeaderEvent({ userId: 'x' })).toBeNull();

    expect(
      applyHeaderInvalidateFromMessageValue(
        Buffer.from(JSON.stringify({ userId: 7, reason: 'exchange_liquidate', at: Date.now() }))
      )
    ).toBe(true);
    expect(invalidate).toHaveBeenCalledWith(7);

    expect(applyHeaderInvalidateFromMessageValue(Buffer.from('not-json'))).toBe(false);
    vi.doUnmock('../../../server/modules/mining-engine/services/player-game-header-cache.js');
  });
});
