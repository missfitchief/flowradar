# Stale BSC Test Fixture — Quarantine Record & Post-Run Cleanup (Rollout Step 8)

## What it is
The live DB contains exactly one `signal_eligible` wallet, and it is **not a real wallet**:

| Field | Value |
|---|---|
| address | `0x1234567890abcdef1234567890abcdef12345678` (the canonical EVM placeholder) |
| chain | `BSC` |
| status | `signal_eligible` |
| WalletStats.source | `csv` (1 row — the DB's only WalletStats row) |
| classification | `bridge_related` (confidence 90) |
| Solana trades / flow edges | **0 / 0** |

Provenance: leaked test-fixture data from **before** the test/live DB isolation existed
(`resolveDatabaseUrlForEnv` in `packages/db/src/testDb.ts` now makes this class of leak
impossible under vitest — fail-closed). It predates the isolation fix and was never cleaned.

## Disposition: Option B — documented post-run maintenance cleanup (chosen over live mutation)
The fixture is **NOT deleted or modified during the shadow run**: the run's trust invariant
has tracked `eligible = 1` since baseline, and mutating live-run rows mid-run is prohibited
(hard rule). Instead:

1. **It is provably inert for Solana intelligence** — enforced by the regression suite
   `packages/db/test/isolation/evmFixtureIsolation.test.ts`, which seeds this exact shape
   (BSC + signal_eligible + watched + csv stats + BSC trades) and proves:
   - it never appears in a SOLANA token's aggregate inputs or trades;
   - `smartWalletCount` / flow scoring of SOLANA tokens are bit-identical with and without it;
   - SOLANA-scoped eligibility counts exclude it (chain scoping);
   - the stealth pass attributes its trades only to BSC-chained snapshots;
   - EVM `0x` addresses are structurally parked by the lineage root parser (`evmParked`),
     never Solana roots.
2. **Census/reporting must label it**: any report of `signal_eligible = 1` on this run
   must carry the note "the 1 eligible wallet is the stale BSC test fixture (inert)".
   `runs/shadow-20260711105525-9280/checkpoint-pre-rollout.json` and the rollout report do this.

## The cleanup (run at end-of-run or an operator-approved maintenance window — NOT before)
```sql
-- 1. Verify it is still exactly the fixture (abort if anything differs):
SELECT id, chain, status FROM wallets
 WHERE address = '0x1234567890abcdef1234567890abcdef12345678' AND chain = 'BSC';

-- 2. Verify zero Solana involvement (must all be 0):
SELECT count(*) FROM wallet_token_trades t JOIN wallets w ON w.id = t."walletId"
 WHERE w.address = '0x1234567890abcdef1234567890abcdef12345678' AND t.chain = 'SOLANA';

-- 3. Quarantine (prefer status flip over delete — preserves audit trail):
UPDATE wallets SET status = 'excluded'
 WHERE address = '0x1234567890abcdef1234567890abcdef12345678' AND chain = 'BSC'
   AND status = 'signal_eligible';
-- After this, signal_eligible reflects ONLY real approved wallets (expected: 0
-- until a real wallet is approved). Optionally also delete the csv WalletStats row.
```

Executing the UPDATE requires an explicit operator go — it changes the `eligible` census
the run's trust invariant asserts, so it must land between runs or with the invariant
expectation updated in the same window.
