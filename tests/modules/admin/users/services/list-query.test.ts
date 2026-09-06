import { describe, expect, it } from 'vitest';
import {
  buildUsersListWhere,
  ONLINE_WINDOW_MS,
  orderByClause,
  parseAdminPermissionsJson,
  parseAdminUsersListQuery
} from '../../../../../server/modules/admin/users/services/list-query.js';

describe('parseAdminUsersListQuery', () => {
  it('aplica defaults e caps', () => {
    const q = parseAdminUsersListQuery({});
    expect(q.page).toBe(1);
    expect(q.limit).toBe(50);
    expect(q.offset).toBe(0);
    expect(q.sortBy).toBe('creation');
    expect(q.sortDir).toBe('ASC');
    expect(q.filterStatus).toBe('all');
    expect(q.filterAdminsOnly).toBe(false);
    expect(q.userId).toBeNull();
  });

  it('page < 1 volta a 1; limit > 200 cap; filterAdmins 1', () => {
    const q = parseAdminUsersListQuery({
      page: '0',
      limit: '999',
      sortBy: 'alpha',
      sortDir: 'desc',
      filterStatus: 'online',
      filterAdmins: '1',
      search: 'AbC'
    });
    expect(q.page).toBe(1);
    expect(q.limit).toBe(200);
    expect(q.sortBy).toBe('alpha');
    expect(q.sortDir).toBe('DESC');
    expect(q.filterStatus).toBe('online');
    expect(q.filterAdminsOnly).toBe(true);
    expect(q.search).toBe('abc');
    expect(q.userId).toBeNull();
  });

  it('userId positivo exact; inválido → null', () => {
    expect(parseAdminUsersListQuery({ userId: '42' }).userId).toBe(42);
    expect(parseAdminUsersListQuery({ userId: 7 }).userId).toBe(7);
    expect(parseAdminUsersListQuery({ userId: '0' }).userId).toBeNull();
    expect(parseAdminUsersListQuery({ userId: '-3' }).userId).toBeNull();
    expect(parseAdminUsersListQuery({ userId: 'abc' }).userId).toBeNull();
  });
});

describe('buildUsersListWhere', () => {
  it('admins-only sem params extra', () => {
    const q = parseAdminUsersListQuery({ filterAdmins: 'true' });
    const w = buildUsersListWhere(q, 1_000_000);
    expect(w.whereSql).toContain('u.is_admin = 1');
    expect(w.params).toEqual([]);
  });

  it('userId exact filtra u.id', () => {
    const q = parseAdminUsersListQuery({ userId: '99' });
    const w = buildUsersListWhere(q, 0);
    expect(w.whereSql).toContain('u.id = $1');
    expect(w.params).toEqual([99]);
    expect(w.nextIdx).toBe(2);
  });

  it('userId + search combina AND', () => {
    const q = parseAdminUsersListQuery({ userId: 5, search: 'bob' });
    const w = buildUsersListWhere(q, 0);
    expect(w.whereSql).toContain('u.id = $1');
    expect(w.whereSql).toContain('LIKE $2');
    expect(w.params).toEqual([5, '%bob%']);
  });

  it('search + offline usa game_states last_updated_at', () => {
    const q = parseAdminUsersListQuery({ search: 'x', filterStatus: 'offline' });
    const now = 10_000_000;
    const w = buildUsersListWhere(q, now);
    expect(w.params[0]).toBe('%x%');
    expect(w.whereSql).toContain('LIKE $1');
    expect(w.whereSql).toContain('gs.last_updated_at < $2');
    expect(w.params[1]).toBe(now - ONLINE_WINDOW_MS);
    expect(w.nextIdx).toBe(3);
  });

  it('online usa gs.last_updated_at', () => {
    const q = parseAdminUsersListQuery({ filterStatus: 'online' });
    const now = 10_000_000;
    const w = buildUsersListWhere(q, now);
    expect(w.whereSql).toContain('gs.last_updated_at >= $1');
    expect(w.params).toEqual([now - ONLINE_WINDOW_MS]);
  });

  it('filterLevel ignorado se filterRoom ≠ all', () => {
    const q = parseAdminUsersListQuery({ filterLevel: 'vip', filterRoom: 'room_1' });
    const w = buildUsersListWhere(q, 0);
    expect(w.whereSql).not.toContain('u.access_level_id =');
    expect(w.whereSql).toContain('user_rig_rooms');
    expect(w.params).toEqual(['room_1']);
  });
});

describe('orderByClause', () => {
  it('creation vs alpha', () => {
    expect(orderByClause(parseAdminUsersListQuery({ sortBy: 'creation', sortDir: 'desc' }))).toBe(
      'ORDER BY u.id DESC'
    );
    expect(orderByClause(parseAdminUsersListQuery({ sortBy: 'alpha', sortDir: 'asc' }))).toBe(
      'ORDER BY u.username ASC'
    );
  });
});

describe('parseAdminPermissionsJson', () => {
  it('array JSON, vazio, inválido', () => {
    expect(parseAdminPermissionsJson('["users","shops"]')).toEqual(['users', 'shops']);
    expect(parseAdminPermissionsJson(null)).toEqual([]);
    expect(parseAdminPermissionsJson('not-json')).toEqual([]);
    expect(parseAdminPermissionsJson(['a'])).toEqual(['a']);
  });
});
