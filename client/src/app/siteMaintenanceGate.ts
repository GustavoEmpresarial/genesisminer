/** Kill-switch de site: sessão OU `/api/site-status`. Admin passa; landing/jogo bloqueiam. */

export function resolveMaintenanceFlag(
  sessionFlag: boolean | undefined,
  statusFlag: boolean | undefined
): boolean {
  return sessionFlag === true || statusFlag === true;
}

export function shouldBlockGameAndLanding(maintenanceOn: boolean, isAdmin: boolean): boolean {
  return maintenanceOn && !isAdmin;
}
