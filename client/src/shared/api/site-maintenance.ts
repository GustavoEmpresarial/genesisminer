import { apiFetch } from './http';

export type SiteStatus = {
  /** Host-effective: true only on genesisdao.tech / www. */
  maintenance: boolean;
  /** Raw kill-switch, independent of Host (admin toggle). */
  armed: boolean;
};

export async function getSiteStatus(): Promise<SiteStatus> {
  try {
    const res = await apiFetch('/api/site-status');
    if (!res.ok) return { maintenance: false, armed: false };
    const j = (await res.json()) as { maintenance?: boolean; armed?: boolean };
    const maintenance = j.maintenance === true;
    const armed = j.armed === true || (j.armed === undefined && maintenance);
    return { maintenance, armed };
  } catch {
    return { maintenance: false, armed: false };
  }
}

export async function setSiteMaintenance(maintenance: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch('/api/admin/site-maintenance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maintenance })
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: j.error || 'Pedido falhou.' };
    return { ok: j.ok !== false };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}
