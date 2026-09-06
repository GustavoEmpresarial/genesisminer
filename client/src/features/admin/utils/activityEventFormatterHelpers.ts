/** Data estimada de registo (ms epoch, America/Sao_Paulo). */
export function formatAccountCreatedBrt(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'America/Sao_Paulo'
    }).format(new Date(ms));
  } catch {
    return null;
  }
}
