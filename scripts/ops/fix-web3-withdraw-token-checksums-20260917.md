# Fix `web3_withdraw_tokens` EIP-55 contract checksums (2026-09-17)

## Problem

Admin setting `settings.web3_withdraw_tokens` can store ERC-20 `contract` addresses with a **mixed wrong EIP-55 checksum**.

- Client withdraw UI accepts any `0x` + 40 hex → token looks withdrawable.
- Server `is_withdraw_token_usable` (Rust) used to call `checksum_evm_address`, which **rejects** mixed wrong checksums → PT error:
  `Saque indisponível para DOGE. Confirma a configuração no painel administrativo.`

Code now accepts well-formed hex for **usability**; still normalize contracts in DB to correct EIP-55 for ops hygiene and any on-chain tooling.

## Known bad entry (DOGE / Binance-Peg Dogecoin on BSC)

| | Address |
|---|---|
| Stored (wrong) | `0xbA2aE424d960c26247Dd6c32edC70B295c744c43` |
| Correct EIP-55 | `0xbA2aE424d960c26247Dd6c32edC70B295c744C43` |

Diff: final nibble group `...744c43` → `...744C43` (`C` uppercase).

Verify with ethers:

```js
const { getAddress } = require("ethers");
getAddress("0xba2ae424d960c26247dd6c32edc70b295c744c43");
// → 0xbA2aE424d960c26247Dd6c32edC70B295c744C43
getAddress("0xbA2aE424d960c26247Dd6c32edC70B295c744c43"); // throws: bad address checksum
```

## Preview (read-only)

```sql
SELECT key, value
FROM settings
WHERE key = 'web3_withdraw_tokens';
```

Inspect each token's `contract` field. Flag any mixed-case address that fails `ethers.getAddress(contract)`.

## Apply (VM — parent / ops only)

Prefer fixing via admin Web3 settings UI after paste through `getAddress`, or a one-shot Node rewrite:

```bash
# On VM with repo + node_modules/ethers available. Does NOT mutate unless you pipe UPDATE.
node - <<'NODE'
const { getAddress } = require("ethers");
// Paste the JSON array from: SELECT value FROM settings WHERE key = 'web3_withdraw_tokens';
const tokens = JSON.parse(process.env.WEB3_WITHDRAW_TOKENS_JSON || "[]");
let changed = 0;
for (const t of tokens) {
  const c = (t.contract || "").trim();
  if (!c) continue;
  try {
    const fixed = getAddress(c.toLowerCase()); // lowercase → recompute checksum
    if (fixed !== c) {
      console.error(`fix ${t.symbol || t.name || t.coinId}: ${c} → ${fixed}`);
      t.contract = fixed;
      changed++;
    }
  } catch (e) {
    console.error(`SKIP invalid contract ${t.symbol || "?"}: ${c} (${e.shortMessage || e.message})`);
  }
}
console.log(JSON.stringify(tokens));
console.error(`changed=${changed}`);
NODE
```

Then upsert (example — adapt quoting / container):

```sql
UPDATE settings
SET value = $FIXED_JSON$
-- paste normalized JSON array here
$FIXED_JSON$
WHERE key = 'web3_withdraw_tokens'
RETURNING key, length(value);
```

Or DOGE-only surgical replace if the JSON is otherwise trusted:

```sql
UPDATE settings
SET value = replace(
  value,
  '0xbA2aE424d960c26247Dd6c32edC70B295c744c43',
  '0xbA2aE424d960c26247Dd6c32edC70B295c744C43'
)
WHERE key = 'web3_withdraw_tokens'
  AND value LIKE '%0xbA2aE424d960c26247Dd6c32edC70B295c744c43%'
RETURNING key;
```

## After fix

1. Confirm `getAddress` accepts every non-empty `contract` in the array.
2. Smoke: DOGE withdraw request no longer returns the “Saque indisponível… configuração” error (balance/min/wallet rules still apply).
3. Redeploy wallet binary only if relying on the Rust usability fix without DB normalize; DB normalize alone unblocks **before** this code lands if the old binary still used strict checksum.
