# Production mass transaction tracker

## Scope and safety

This sprint adds a provider-independent Solana/BSC (EVM) mass transaction
tracker. It is additive and shadow-only. It does not sign, submit, or simulate
transactions and no tracker writer can grant `signal_eligible`. Operator roots
are capital-provenance seeds (`operator_root`), never inferred trader wallets.
Receivers are created only as `observation_only` and may receive a bounded
`fresh_receiver_hot` monitoring subscription under an existing lineage root.

## Architecture

- Canonical `MassTransactionEvent` envelope with explicit actor, provider,
  asset, exact event identity, bridge message, status, and observation time.
- Pure deterministic relevance classifier separates failed/self/dust/service/
  contract noise from capital, gas-funding, token-buy, and bridge evidence.
- BSC swap outputs require same-transaction actor outflow plus a contract call;
  a bare inbound BEP-20 transfer is never guessed to be a buy.
- Infrastructure nodes stay graph-visible but never create identity links.
- Bounded, cycle-safe, time-monotonic BFS traces direct and multi-hop capital
  to a receiver token buy. Every proof has `grantsEligibility=false`.
- Cursor/batch DB ingest is replay-idempotent on provider-scoped `eventId` and
  records throughput, peak heap, retries, provider failures, duplicates,
  enrollments, bridge pairs, and traces in `MassTrackerRun`.
- Bridge correlation first uses protocol-native IDs. Wormhole is matched by
  canonical VAA tuple (`emitter_chain/emitter_address/sequence`) plus observed
  destination completion. Source finality is stored separately (`confirmed`
  is never labeled `finalized`). Amount/time matching is only `probable` and
  is forbidden from carrying entity lineage across chains.

## Real-data evidence (2026-07-13)

### Large local evidence pilot

Source tables before the run contained 1,283,161 money-flow edges and 249,156
wallet trades. The bounded cursor pilot consumed 105,805 real rows (100,000
edges plus all 5,805 BUY rows available in the selected cursor range):

- throughput: 272.85 events/s
- peak heap: 171,915,736 bytes (~164 MiB)
- relevant events: 10,246
- receiver enrollments: 38
- retries/provider errors: 0/0
- duplicate replay rows: 100,000; new rows: 5,805

The targeted root/member evidence pass consumed another 55,510 real events:

- throughput: 149.52 events/s
- peak heap: 117,435,392 bytes (~112 MiB)
- relevant events: 9,276
- observation-only receiver enrollments: 767
- retries/provider errors: 0/0

The corrected entity-member trace pass loaded 14,498 relevant canonical
events for 30 permanent entities and persisted 1,929 complete proofs without
truncation. Samples include:

- direct `operator_root -> receiver -> token BUY`, confidence 85;
- multi-hop `linked_wallet -> receiver -> execution receiver -> token BUY`,
  confidence 75.

All persisted proofs have `grantsEligibility=false`.

### Official Wormhole Solana/BSC pilot

Ten pages per direction from the official WormholeScan mainnet API produced:

- 626 real canonical bridge legs;
- 313 verified source/destination pairs;
- 0 duplicates, retries, or provider errors;
- exact canonical VAA message IDs and both real transaction hashes;
- source finality retained as reported (commonly `confirmed`), destination
  protocol status `completed`.

The API endpoint and VAA identity rules come from official Wormhole docs. A
completed official message establishes a verified bridge operation, not a
real-world identity claim.

## Commands

```bash
npm run tracker:pilot
npm run tracker:lineage-pilot
npm run tracker:wormhole-pilot
```

Environment bounds: `MASS_TRACKER_MAX_EDGES`, `MASS_TRACKER_MAX_BUYS`,
`MASS_TRACKER_BATCH_SIZE`, and `WORMHOLE_PILOT_PAGES`.
