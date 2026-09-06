/**
 * Gate de acesso a sala — **funções puras, sem dependência de DB**.
 *
 * Vive separado de `rooms.ts` (que importa `prisma`/`pool`) para que a
 * invariante "este utilizador pode usar esta sala?" seja importável e testável
 * isoladamente por qualquer módulo, sem arrastar o cliente de base de dados.
 *
 * Domínio (#89): **sala ≠ plano**. `access_levels` = planos/membership;
 * `rig_rooms` = pisos. API JSON usa `allowedPlanIds` / `planIds`; as colunas SQL
 * permanecem `allowed_levels` / `allowed_season_pass_ids` (schema legado).
 */

/** Planos/membership + season passes que o jogador possui. */
export type UserRoomAccess = {
  /** Planos/membership do jogador (tabela `access_levels`). */
  planIds: string[];
  passIds: string[];
};

/** Restrições declaradas pela sala. Listas vazias = sala sem restrição. */
export type RoomAccessGate = { allowedPlanIds: string[]; allowedSeasonPassIds: string[] };

function parseJsonStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

/**
 * Fonte única do shape de gate a partir da linha crua de `rig_rooms`.
 * Sem isto cada chamador reimplementa o parse das colunas JSON e uma das
 * cópias acaba por divergir — foi assim que a checagem de sala se espalhou.
 */
export function roomAccessGateFromRow(row: { allowed_levels?: unknown; allowed_season_pass_ids?: unknown }): RoomAccessGate {
  return {
    allowedPlanIds: parseJsonStringArray(row.allowed_levels),
    allowedSeasonPassIds: parseJsonStringArray(row.allowed_season_pass_ids)
  };
}

/** Sala sem restrição libera todos; com restrição, precisa plano E passe (se ambos definidos). */
export function isRoomAccessAllowedForUser(room: RoomAccessGate, access: UserRoomAccess): boolean {
  const planOk =
    room.allowedPlanIds.length === 0 || room.allowedPlanIds.some((id) => access.planIds.includes(id));
  const seasonOk =
    room.allowedSeasonPassIds.length === 0 ||
    room.allowedSeasonPassIds.some((passId) => access.passIds.includes(passId));
  return planOk && seasonOk;
}
