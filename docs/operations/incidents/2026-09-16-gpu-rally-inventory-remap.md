# Incidente: GPU Rally / RALLY 2H/s “apareceu do nada” (2026-09-16)

## Resumo

Em 16–17 Set, jogadores viram GPU Rally / RALLY 2H/s “surgir do nada”. **Não foi mint bug** — remap em massa de ops restaurou stock legado que estava invisível no inventário.

## Causa raiz

1. Catálogo retirou `rally_v3` / `rally_v1`. Stock órfão e placeholders `temp_legacy_{uid}_rally_v3` ficaram em `stock`, mas a UI de inventário escondeu-os (`resolve_stackable_rows` ignora IDs sem catálogo).
2. Ops em 2026-09-16 converteu essas linhas para o item vivo `gpu_rally_v1` (nome de display: RALLY 2H/s / GPU Rally).

## O que correu

- `scripts/ops/remap-temp-legacy-rally-v3-to-gpu-rally-v1-20260916.sql` — `temp_legacy` → `gpu_rally_v1` (header: 169 players / 349 qty)
- Remap separado órfão `rally_v3` → `gpu_rally_v1` (85/149, tag ops `20260916-rally-v3-orphan`)
- Auditoria: `inventory_movements` com `action = admin_compensate`, `meta.ops` contendo `20260916-rally*`
- Check VM live: 236 players distintos com esses movements; residual temp/órfão qty = 0

## Porquê jogadores dizem “apareceu do nada”

Já tinham qty legado **invisível**; após o remap passou a ser visível como `gpu_rally_v1`.

## SOP suporte (IMPORTANTE)

**NÃO** tratar como mint gratuito. **NÃO** auto-swap para GPU Dolar salvo política explícita de compensação.

Verificar com:

```sql
SELECT * FROM inventory_movements
WHERE user_id = <id> AND meta ILIKE '%20260916-rally%';

SELECT qty FROM stock WHERE user_id = <id> AND item_id = 'gpu_rally_v1';
```

Se o movement existir → propriedade restaurada, não mint bug.

### Texto para anúncio suporte / comunidade (PT — copiar/colar WhatsApp/Discord)

```
Olá! Sobre a GPU Rally / RALLY 2H/s que “apareceu” no inventário:

Não foi mint bug nem crédito gratuito. Em 16/09 fizemos um remap de ops que restaurou stock RALLY legado que já estava na conta mas invisível (o catálogo antigo `rally_v3`/`rally_v1` tinha sido retirado e a UI escondia essas linhas).

Agora o item aparece com o id vivo `gpu_rally_v1` (display: RALLY 2H/s / GPU Rally).

Suporte: NÃO tratar como mint. NÃO trocar automaticamente por GPU Dolar — só se houver política explícita de compensação. Confirmar com movement `admin_compensate` / meta `20260916-rally*`.
```

Paste curto: `docs/operations/incidents/2026-09-16-gpu-rally-support-announce.md`

## Follow-ups

1. ~~Manter `LEGACY_STOCK_ID_ALIASES` (`rally_v3`/`rally_v1` → `gpu_rally_v1`) para créditos futuros não recriarem ghosts~~ **DONE** — já em `rust/genesis-core/src/hardware/catalog.rs` + twin `server/modules/hardware/services/catalog.ts`
2. Limpar rows de upgrades `temp_legacy_*_rally_v3` (placeholders de catálogo) se stock/ii = 0 → script:
   `scripts/ops/purge-temp-legacy-rally-v3-catalog-placeholders-20260917.sql` (aplicar na VM; não re-correr remap)
3. ~~Anunciar a suporte/comunidade: remap restaurou stock RALLY~~ **DONE** — texto acima + ficheiro support-announce
4. **Não** re-correr o SQL de remap (idempotente, mas já executado)
5. Excluir `gpu_rally_v1` da Sala NFT (`NFT_ROOM_EXCLUDED_MACHINE_IDS`; manter `rally_v3` por segurança) — twins Rust/TS/client

## Ficheiros relacionados

- `scripts/ops/remap-temp-legacy-rally-v3-to-gpu-rally-v1-20260916.sql`
- `scripts/ops/purge-temp-legacy-rally-v3-catalog-placeholders-20260917.sql`
- `docs/operations/incidents/2026-09-16-gpu-rally-support-announce.md`
- `rust/genesis-core/src/hardware/catalog.rs` — aliases LEGACY
- `server/modules/hardware/services/catalog.ts` — twin TS
- `NFT_ROOM_EXCLUDED_MACHINE_IDS` twins (constants.rs / nft-room-mining.ts / adminTypes.ts / servers/types.ts)
