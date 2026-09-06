/**
 * Smoke: fluxo real guest support — criar ticket → lookup email → admin reply.
 * Corre com `npm run test:pg-integration` (Postgres real).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SMOKE_EMAIL = `guest-smoke-${crypto.randomUUID().slice(0, 8)}@example.com`;
const SMOKE_NAME = 'Smoke Guest';

describe('support guest flow (smoke)', () => {
  let ticketId = '';
  let adminUserId = 0;
  let replyId = '';

  beforeAll(async () => {
    const admin = await prisma.users.findFirst({
      where: { is_admin: 1 },
      select: { id: true },
      orderBy: { id: 'asc' }
    });
    if (!admin) throw new Error('Smoke precisa de pelo menos 1 admin em users');
    adminUserId = admin.id;
  });

  afterAll(async () => {
    if (replyId) {
      await prisma.$executeRawUnsafe(`DELETE FROM support_ticket_replies WHERE id = $1`, replyId);
    }
    if (ticketId) {
      await prisma.$executeRawUnsafe(`DELETE FROM support_tickets WHERE id = $1`, ticketId);
    }
    await prisma.$disconnect();
  });

  it('cria ticket guest (user_id NULL + contact_*)', async () => {
    ticketId = crypto.randomUUID();
    const now = Date.now();
    await prisma.$executeRawUnsafe(
      `INSERT INTO support_tickets (
        id, user_id, subject, message, attachments, status, created_at, contact_name, contact_email
      ) VALUES ($1, NULL, $2, $3, '[]'::jsonb, 'open', $4, $5, $6)`,
      ticketId,
      'Smoke subject guest',
      'Smoke message body for guest support ticket',
      now,
      SMOKE_NAME,
      SMOKE_EMAIL
    );
    const rows = await prisma.$queryRaw<Array<{ user_id: number | null; contact_email: string }>>`
      SELECT user_id, contact_email FROM support_tickets WHERE id = ${ticketId} LIMIT 1
    `;
    expect(rows[0]?.user_id).toBeNull();
    expect(rows[0]?.contact_email).toBe(SMOKE_EMAIL);
  });

  it('lookup por email encontra o ticket', async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM support_tickets
      WHERE user_id IS NULL
        AND lower(btrim(COALESCE(contact_email, ''))) = ${SMOKE_EMAIL}
      ORDER BY created_at DESC
      LIMIT 5
    `;
    expect(rows.some((r) => r.id === ticketId)).toBe(true);
  });

  it('admin reply no mesmo ticket', async () => {
    replyId = crypto.randomUUID();
    const now = Date.now();
    await prisma.$executeRawUnsafe(
      `INSERT INTO support_ticket_replies (
        id, ticket_id, admin_user_id, message, attachments, created_at
      ) VALUES ($1, $2, $3, $4, '[]'::jsonb, $5)`,
      replyId,
      ticketId,
      adminUserId,
      'Resposta smoke admin',
      now
    );
    const rows = await prisma.$queryRaw<Array<{ message: string }>>`
      SELECT message FROM support_ticket_replies WHERE id = ${replyId} LIMIT 1
    `;
    expect(rows[0]?.message).toContain('smoke');
  });

  it('lista admin LEFT JOIN mostra contact_email', async () => {
    const rows = await prisma.$queryRaw<Array<{ email: string; username: string }>>`
      SELECT COALESCE(u.username, t.contact_name, 'Guest') AS username,
             COALESCE(u.email, t.contact_email, '') AS email
      FROM support_tickets t
      LEFT JOIN users u ON u.id = t.user_id
      WHERE t.id = ${ticketId}
      LIMIT 1
    `;
    expect(rows[0]?.email).toBe(SMOKE_EMAIL);
    expect(rows[0]?.username).toBe(SMOKE_NAME);
  });
});
