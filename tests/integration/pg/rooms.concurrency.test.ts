import { describe, expect, it } from 'vitest';
import {
  createOpenRigRoom,
  createUser,
  makeTag,
  registerPgIntegrationLifecycle,
  type PgFixtureCtx
} from './harness.js';

describe('PG integration — room slot purchase concurrency', () => {
  let ctx: PgFixtureCtx | null = null;
  registerPgIntegrationLifecycle(
    () => ctx,
    (c) => {
      ctx = c;
    }
  );

  it('duas compras concorrentes (keys distintas) com saldo só para uma: 1 sucesso, saldo nunca negativo, 1 slot', async () => {
    const c = ctx!;
    const tag = makeTag();
    const roomId = `${tag}_room`;
    c.roomIds.push(roomId);

    await createOpenRigRoom(c.pool, { id: roomId, baseSlotPrice: 70, initialCapacity: 0, maxCapacity: 5 });

    const userId = await createUser(c.pool, {
      username: `${tag}_room`,
      email: `${tag}_room@itest.local`,
      usdc: 100
    });
    c.userIds.push(userId);

    const { purchaseRigRoomSlot } = await import('../../../server/modules/rooms/services/rooms.js');

    const settled = await Promise.allSettled([
      purchaseRigRoomSlot(userId, roomId, 1, `${tag}_rk_a`),
      purchaseRigRoomSlot(userId, roomId, 1, `${tag}_rk_b`)
    ]);

    const ok = settled.filter((r) => r.status === 'fulfilled');
    const fail = settled.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(fail).toHaveLength(1);

    const usdcRes = await c.pool.query<{ usdc: string }>(`SELECT usdc::text AS usdc FROM game_states WHERE user_id = $1`, [
      userId
    ]);
    const usdc = Number(usdcRes.rows[0]?.usdc ?? -1);
    expect(usdc).toBe(30);
    expect(usdc).toBeGreaterThanOrEqual(0);

    const slots = await c.pool.query<{ unlocked_slots: number }>(
      `SELECT unlocked_slots FROM user_rig_rooms WHERE user_id = $1 AND room_id = $2`,
      [userId, roomId]
    );
    expect(Number(slots.rows[0]?.unlocked_slots ?? 0)).toBe(1);
  });
});
