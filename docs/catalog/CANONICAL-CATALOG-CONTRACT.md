# Canonical Catalog Contract — `upgrades`

**Status:** frozen (T1–T7)  
**Scope:** table/model `upgrades` in `current/` (not `admin_upgrades`).  
**Authority:** this document describes **actual runtime behaviour**, not future intent.

Primary write path: `server/modules/catalog/services/upgrades-write.ts`  
OCC: `server/modules/catalog/services/catalog-revision.ts`  
HTTP: `GET|POST /api/upgrades` (`catalog.controller.ts`)  
Merge writer: `server/modules/merge/services/merge.ts`  
Admin UX: `client/src/features/admin/AdminEditor.tsx` + `lib/upgradeCatalogIds.ts` + `lib/upgradeCatalogLifecycle.ts`

---

## A) Identity

- `upgrades.id` is the persistent canonical identity.
- Admin replace UPSERTs with `ON CONFLICT (id) DO UPDATE` — the `id` column is never rewritten.
- Rename is forbidden: payload meta `previousId` / `editingSourceId` / `sourceId` / `fromId` where value ≠ `id` → `409 CATALOG_ID_IMMUTABLE`.
- Frontend edit lock: `editingSourceId` forces the saved id; `normalizeUpgradeCatalogIds` never remaps persisted ids; FE does not emit `previousId` on catalog save.
- Soft-retire and reactivation keep the **same** id (no DELETE, no second row).
- Merge creates deterministic `merge_*` ids; `ON CONFLICT (id) DO NOTHING` does not change identity.

---

## B) Lifecycle

Relevant statuses for this contract:

| Status | Meaning |
|--------|---------|
| operational (e.g. `normal`, `limited`, …) | Editable admin catalog; may be sold if other flags allow |
| `retired` | Soft-retired; identity preserved |

**Official soft-retire** (omit editable id from replace **or** UPSERT retired fields) sets:

- `status = 'retired'`
- `is_active = 0`
- `sell_in_hardware_market = 0`
- `sell_in_black_market = 0`

**Reactivation** (admin UX / UPSERT): same id; returns to the **current** active model (`status: 'normal'`, `isActive: true`, markets `true`). No historical restoration of prior `limited` / market flags.

---

## C) Protected legacy

Protected rows (aligned with `isProtectedUpgradeRow`):

- id prefix `temp_legacy_*`
- `category = 'legacy-temp'` or `type = 'legacy-temp'`

Rules:

- Admin GET / bootstrap admin filter **excludes** them from the editable set.
- POST admin replace: omitting a protected id is a **no-op** (not soft-retire).
- They are blocked from shop purchase / operational battery use per existing filters.

---

## D) Replace semantics (POST admin)

- `POST /api/upgrades` body: `{ upgrades, expectedCatalogRevision }` (bare array rejected).
- Represents a **replace of the editable catalog set**, not a patch of one row.
- Editable id omitted → soft-retire.
- Protected id omitted → no-op.
- OCC does **not** turn replace into a merge of remote state; stale clients must reload.

---

## E) OCC (`catalogRevision`)

Persistence: singleton `upgrades_catalog_meta` (`id = 1`, `revision`).

| Direction | Field |
|-----------|--------|
| GET `/api/upgrades` | `{ catalogRevision, upgrades }` |
| POST | `expectedCatalogRevision` required |

Semantics:

1. Lock meta row `FOR UPDATE` inside the write transaction.
2. Compare locked revision to `expectedCatalogRevision`.
3. Mismatch → `409` `CATALOG_VERSION_CONFLICT` (`forceReload: true`) → **ROLLBACK**, **zero** UPSERT/soft-retire.
4. Match → mutate → bump `revision + 1` → COMMIT.
5. Merge **new** SKU insert (`rowCount > 0`) bumps revision (same lock helper).
6. Merge `ON CONFLICT DO NOTHING` / reuse existing SKU → **no** bump.

Checkout `UPDATE total_sold` does **not** bump catalog revision.

---

## F) DELETE

- Official production write path: **no** `DELETE FROM upgrades` / `prisma.upgrades.delete*`.
- Lifecycle is soft-retire only.
- Test harnesses may DELETE fixture rows; that is not production.

---

## G) Read paths (summary)

| Path | Retired | Protected |
|------|---------|-----------|
| Admin GET / bootstrap admin | Included (editable) | Excluded |
| Player bootstrap / non-admin GET | Excluded (`status` / `is_active`) | Not filtered by prefix on bootstrap non-admin (shop/checkout still block) |
| Shop catalog non-admin | Excluded | Excluded |
| Shop product-rules / checkout gates | Blocked | Blocked |
| Batteries bulk usable catalog | Excludes retired/protected | Excluded |
| Inventory / audit lookups by id | May resolve historical id | Identity lookup |

Do not “unify” all SELECTs into one filter without a dedicated task.

---

## Contract matrix

| Scenario | Expected result |
|---------|-----------------|
| Admin GET | `catalogRevision` + editable set (no protected; includes retired editables) |
| POST with current revision | Success + revision incremented |
| POST stale | `409 CATALOG_VERSION_CONFLICT` |
| POST stale | Zero mutations on `upgrades` |
| Retire | Same id + `status=retired` (+ inactive / markets off) |
| Reactivate | Same id + active model (`normal` + active + markets on) |
| Rename via `previousId` | Rejected (`CATALOG_ID_IMMUTABLE`) |
| Protected omitted | Not soft-retired |
| Editable omitted | Soft-retire |
| Merge new SKU | INSERT + revision bump |
| Merge duplicate / no-op insert | No bump |
| Physical DELETE `upgrades` | Forbidden in production writers |
| Retired in purchase | Blocked (product-rules; soft-retire also clears active/markets) |
| Protected in purchase/ops | Blocked per current shop/battery rules |

---

## Regression suite map

| Invariant | Primary tests |
|----------|----------------|
| Identity / rename | `upgrades-write.test.ts`, `upgradeCatalogIds.test.ts`, `upgrades-write.contract.test.ts` |
| Soft-retire / replace | `upgrades-write.contract.test.ts`, `upgrades-write.admin-get-post.test.ts` |
| Protected vs soft-retire | `upgrades-write.admin-get-post.test.ts`, `upgrades-catalog-invariants.test.ts` |
| OCC lock / stale / zero mutate | `catalog-revision.test.ts`, `upgrades-write.occ.test.ts`, `upgradesCatalogOcc.test.ts` |
| Lifecycle FE | `upgradeCatalogLifecycle.test.ts` |
| Merge revision | `merge-catalog-revision.test.ts` |
| Zero DELETE scan | `upgrades-catalog-invariants.test.ts` |
| Operational retired block | `product-rules.test.ts`, `shop/catalog.test.ts`, invariants |
| Admin/non-admin GET filters | `canonical-catalog-contract-freeze.test.ts` |
| OCC order lock→mutate | `canonical-catalog-contract-freeze.test.ts` |

---

## Known residual risks (not fixed by this freeze)

1. Checkout does not re-check `status ∈ {retired, legacy, exclusive}` per line if DB is inconsistent (`retired` + `is_active=1`).
2. Soft-retire overwrites prior status; reactivation does not restore historical `limited` / market flags.
3. Partial editable payload still mass soft-retires omitted editables (OCC only prevents stale races).
4. Local `dist/` may lag source; deploy from rebuild, not stale artifacts.
