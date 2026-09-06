# Camada de services (legado)

Não há camada de service única e consistente — services vivem em três lugares:

1. **`backend/services/`** (flat, 6 arquivos) — `adminMiningDistribution`,
   `adminUserAccountTrace`, `adminUserInventoryAudit`, `inventorySnapshotService`,
   `playerCalculatorService`, `playerStateSnapshot.service`. Maioria voltada
   pra admin/relatórios.
2. **`backend/modules/<dominio>/*.service.ts`** — service por domínio, dentro
   do próprio módulo (padrão preferido, mas nem todo módulo tem um service
   separado do controller).
3. **Lógica de negócio dentro de `lib/`** — vários arquivos de `lib/` são na
   prática services de domínio sem terem sido movidos pra dentro de um módulo
   (`nftRoomMining`, `checkinBonusHash`, `saveGameEconomyValidate`, etc.) —
   ver [../modules/README.md](../modules/README.md) seção 5.

Suspeita de duplicação a checar na migração:
`backend/services/inventorySnapshotService.ts` vs.
`backend/modules/inventory/inventory.snapshot.service.ts`.

## Alvo da reestruturação
Um service por módulo em `current/backend/src/modules/<dominio>/<dominio>.service.ts`,
sem lógica de domínio solta em `lib/` ou em `services/` na raiz.
