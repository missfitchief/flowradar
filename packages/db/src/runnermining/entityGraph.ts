// FlowRadar — evidence-backed wallet roles + entity-adjusted ENTITY DNA
// (complete-discovery sprint).
//
// ROLES are derived ONLY from already-persisted evidence tables (outflow
// paths, receiver enrollments, funding paths, entity-dormancy observations,
// repeat candidates, operator lineage roots) — probabilistic on-chain
// relationships with receipts, NEVER identity claims.
//
// ENTITY DNA aggregates ADDRESS DNA over union-find components built from
// SUFFICIENT links only: receiver→funder enrollment, probable/strong
// relationship tiers on outflow paths, repeat-candidate membership, and
// operator-root direct funding. Buying the same token NEVER links wallets.
// Ten linked side wallets count as ONE entity. Everything observation_only.

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { toErrorReceipt, ERROR_RECEIPTS_MAX } from '../dormancy/activity';
import type { WalletErrorReceipt } from '../dormancy/activity';

export const ENTITY_GRAPH_ENGINE_VERSION = 1;
const UNPRICED_LEG_CAP = 200_000;

export interface EntityGraphReport {
  rolesWritten: number;
  byRole: Record<string, number>;
  entitiesWritten: number;
  multiWalletEntities: number;
  rootEntities: number;
  staleRolesRemoved: number;
  staleEntitiesRemoved: number;
  errors: number;
  errorReceipts: WalletErrorReceipt[];
}

class Dsu {
  private parent = new Map<string, string>();
  ensure(k: string): void {
    if (!this.parent.has(k)) this.parent.set(k, k);
  }
  find(k: string): string {
    this.ensure(k);
    let r = k;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(k, r);
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); // smaller key = deterministic root
  }
  keys(): string[] {
    return [...this.parent.keys()];
  }
}

export async function buildEntityGraph(
  prisma: PrismaClient,
  opts: { chain?: 'SOLANA' | 'BSC'; now?: Date } = {}
): Promise<EntityGraphReport> {
  const chain = opts.chain ?? 'SOLANA';
  const now = opts.now ?? new Date();
  const report: EntityGraphReport = {
    rolesWritten: 0,
    byRole: {},
    entitiesWritten: 0,
    multiWalletEntities: 0,
    rootEntities: 0,
    staleRolesRemoved: 0,
    staleEntitiesRemoved: 0,
    errors: 0,
    errorReceipts: []
  };

  // ---- Load evidence (bounded, stable) -----------------------------------
  const [outflows, receivers, fundedPaths, sideWalletObs, repeatEntities, roots, dnaRows] = await Promise.all([
    prisma.capitalOutflowPath.findMany({
      where: { chain },
      orderBy: [{ sourceWallet: 'asc' }, { destinationAddress: 'asc' }, { evidenceTier: 'asc' }],
      take: 10_000
    }),
    prisma.receiverEnrollment.findMany({
      where: { chain },
      orderBy: { receiverAddress: 'asc' },
      take: 5000
    }),
    prisma.fundingReactivationPath.findMany({
      where: { chain, status: 'funded' },
      orderBy: [{ walletAddress: 'asc' }, { anchorKey: 'asc' }],
      take: 10_000,
      select: { walletAddress: true, directFunderAddress: true, funderRelationshipTier: true, repeatFundingCount: true }
    }),
    prisma.entityDormancyObservation.findMany({
      where: { chain, entityClass: { in: ['probable_side_wallet_reactivation', 'fresh_funded_by_active_entity'] } },
      orderBy: [{ walletAddress: 'asc' }, { anchorKey: 'asc' }],
      take: 5000,
      select: { walletAddress: true, entityClass: true }
    }),
    prisma.repeatRunnerCandidate.findMany({
      where: { chain },
      orderBy: { entityKey: 'asc' },
      take: 5000,
      select: { entityKey: true, memberWallets: true }
    }),
    prisma.lineageRoot.findMany({
      where: { wallet: { chain } },
      orderBy: { walletId: 'asc' },
      take: 5000,
      select: { label: true, wallet: { select: { address: true, chain: true } } }
    }),
    prisma.walletDnaProfile.findMany({
      where: { chain },
      orderBy: { walletAddress: 'asc' },
      take: 5000
    })
  ]);
  const rootAddrs = new Set(roots.map((r) => r.wallet.address));
  // Truncation flags — a capped evidence table can silently split a
  // component; surfaced on every entity row rather than hidden.
  const truncation = {
    outflows: outflows.length >= 10_000,
    receivers: receivers.length >= 5000,
    fundedPaths: fundedPaths.length >= 10_000,
    sideWalletObs: sideWalletObs.length >= 5000,
    repeatEntities: repeatEntities.length >= 5000,
    roots: roots.length >= 5000,
    dnaRows: dnaRows.length >= 5000,
    unpricedLegs: false // set below once the unpriced-leg query has run
  };
  const anyTruncation0 = () => Object.values(truncation).some(Boolean);

  // ---- Union-find over SUFFICIENT links only ------------------------------
  const dsu = new Dsu();
  const linkEvidence = new Map<string, string[]>(); // component-agnostic note per wallet
  const note = (w: string, s: string) => {
    const l = linkEvidence.get(w) ?? [];
    if (l.length < 10) l.push(s);
    linkEvidence.set(w, l);
  };
  for (const d of dnaRows) dsu.ensure(d.walletAddress);
  for (const r of rootAddrs) dsu.ensure(r);
  for (const e of repeatEntities) {
    for (const m of e.memberWallets) {
      dsu.ensure(m);
      dsu.union(e.entityKey, m);
      note(m, `repeat_candidate_member:${e.entityKey.slice(0, 8)}`);
    }
  }
  for (const r of receivers) {
    // Receiver→funder: DIRECT transfer evidence (strongest tier).
    for (const src of r.sourceWallets) {
      dsu.union(r.receiverAddress, src);
      note(r.receiverAddress, `funded_by:${src.slice(0, 8)} (${r.evidenceTiers.join('/')})`);
    }
  }
  for (const p of outflows) {
    // Probable/strong PRE-EXISTING relationship between source and receiver.
    if (
      p.destinationType === 'wallet' &&
      (p.receiverRelationshipTier === 'probable' || p.receiverRelationshipTier === 'strong')
    ) {
      dsu.union(p.sourceWallet, p.destinationAddress);
      note(p.destinationAddress, `${p.receiverRelationshipTier}_relationship_with:${p.sourceWallet.slice(0, 8)}`);
    }
  }
  for (const f of fundedPaths) {
    // Funder link only at probable/strong tier (a lone valued transfer is a
    // role signal, not an entity merge).
    if (f.directFunderAddress && (f.funderRelationshipTier === 'probable' || f.funderRelationshipTier === 'strong')) {
      dsu.union(f.walletAddress, f.directFunderAddress);
      note(f.walletAddress, `${f.funderRelationshipTier}_funder:${f.directFunderAddress.slice(0, 8)}`);
    }
  }

  // ---- ROLE ASSIGNMENTS ----------------------------------------------------
  interface RoleRow {
    walletAddress: string;
    role: string;
    evidenceTier: string;
    confidence: number;
    reasonCodes: string[];
    receipts: unknown;
  }
  const roles: RoleRow[] = [];
  const addRole = (r: RoleRow) => roles.push(r);

  for (const addr of rootAddrs) {
    addRole({
      walletAddress: addr,
      role: 'operator_root',
      evidenceTier: 'derived',
      confidence: 95,
      reasonCodes: ['operator_supplied_lineage_root'],
      receipts: {}
    });
  }
  for (const r of receivers) {
    const base = {
      receipts: { sources: r.sourceWallets.slice(0, 5), tiers: r.evidenceTiers, firstReceiptTs: r.firstReceiptTs.toISOString() }
    };
    if (r.receiverClass === 'fresh_receiver') {
      addRole({ walletAddress: r.receiverAddress, role: 'fresh_funded_receiver', evidenceTier: 'direct_transfer', confidence: 70, reasonCodes: ['fresh_at_first_receipt'], ...base });
    } else if (r.receiverClass === 'dormant_reactivated') {
      addRole({ walletAddress: r.receiverAddress, role: 'dormant_funded_receiver', evidenceTier: 'direct_transfer', confidence: 70, reasonCodes: ['dormant_at_first_receipt'], ...base });
    }
    if (r.receiverClass === 'linked_side_wallet') {
      addRole({ walletAddress: r.receiverAddress, role: 'probable_side_wallet', evidenceTier: 'relationship_tier', confidence: 65, reasonCodes: ['pre_receipt_probable_relationship'], ...base });
    }
    if (r.deployedTokenCount > 0) {
      addRole({
        walletAddress: r.receiverAddress,
        role: 'execution_wallet',
        evidenceTier: 'direct_transfer',
        confidence: 65,
        reasonCodes: [`received_then_deployed_into_${r.deployedTokenCount}_tokens`],
        receipts: { deployedTokenCount: r.deployedTokenCount, ...base.receipts as object }
      });
    } else if (r.totalKnownInflowUsd !== null && r.sourceWallets.length > 0 && Number(r.totalKnownInflowUsd) > 0) {
      addRole({
        walletAddress: r.receiverAddress,
        role: 'profit_collection_wallet',
        evidenceTier: 'direct_transfer',
        confidence: 45,
        reasonCodes: ['receives_valued_capital_no_observed_deployments'],
        receipts: { knownInflowUsd: Number(r.totalKnownInflowUsd), ...base.receipts as object }
      });
    }
  }
  const funderCounts = new Map<string, number>();
  for (const f of fundedPaths) {
    if (f.directFunderAddress) funderCounts.set(f.directFunderAddress, (funderCounts.get(f.directFunderAddress) ?? 0) + 1);
  }
  for (const [funder, n] of [...funderCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    addRole({
      walletAddress: funder,
      role: 'funding_wallet',
      evidenceTier: n > 1 ? 'repeated_direct' : 'direct_transfer',
      confidence: n > 1 ? 65 : 50,
      reasonCodes: [`direct_funder_of_${n}_qualified_entr${n === 1 ? 'y' : 'ies'}`],
      receipts: { fundedEntries: n }
    });
  }
  for (const p of outflows) {
    if (p.destinationType === 'bridge') {
      addRole({
        walletAddress: p.destinationAddress,
        role: 'bridge_linked_receiver',
        evidenceTier: 'bridge_inference',
        confidence: 35,
        reasonCodes: ['capital_exited_via_bridge', ...(p.bridgeProtocol ? [`protocol:${p.bridgeProtocol}`] : [])],
        receipts: { sourceWallet: p.sourceWallet }
      });
    } else if (p.destinationType === 'cex') {
      addRole({
        walletAddress: p.destinationAddress,
        role: 'possible_cex_mediated_receiver',
        evidenceTier: 'cex_correlation',
        confidence: 20,
        reasonCodes: ['cex_deposit_correlation_only_never_identity'],
        receipts: { sourceWallet: p.sourceWallet }
      });
    } else if (p.destinationType === 'service') {
      addRole({
        walletAddress: p.destinationAddress,
        role: 'service_router_cex_node',
        evidenceTier: 'derived',
        confidence: 80,
        reasonCodes: p.reasonCodes.filter((c) => c.startsWith('service_terminal')),
        receipts: {}
      });
    }
  }
  for (const o of sideWalletObs) {
    addRole({
      walletAddress: o.walletAddress,
      role: 'probable_side_wallet',
      evidenceTier: 'relationship_tier',
      confidence: 60,
      reasonCodes: [`entity_dormancy:${o.entityClass}`],
      receipts: {}
    });
  }

  // Deduplicate (keep the highest-confidence row per wallet+role), persist.
  const seenRole = new Map<string, RoleRow>();
  for (const r of roles) {
    const k = `${r.walletAddress}|${r.role}`;
    const prev = seenRole.get(k);
    if (!prev || r.confidence > prev.confidence) seenRole.set(k, r);
  }
  for (const r of [...seenRole.values()].sort((a, b) => (a.walletAddress < b.walletAddress ? -1 : 1))) {
    try {
      dsu.ensure(r.walletAddress);
      const data = {
        chain,
        walletAddress: r.walletAddress,
        role: r.role,
        evidenceTier: r.evidenceTier,
        entityKey: dsu.find(r.walletAddress),
        confidence: r.confidence,
        reasonCodes: r.reasonCodes,
        receiptsJson: (r.receipts ?? {}) as Prisma.InputJsonValue,
        caveats: [
          'probabilistic on-chain relationship — never an identity claim',
          'observation_only: roles grant no votes, eligibility, or promotion'
        ],
        engineVersion: ENTITY_GRAPH_ENGINE_VERSION,
        computedAt: now
      };
      await prisma.walletRoleAssignment.upsert({
        where: { chain_walletAddress_role: { chain, walletAddress: r.walletAddress, role: r.role } },
        create: data,
        update: data
      });
      report.rolesWritten += 1;
      report.byRole[r.role] = (report.byRole[r.role] ?? 0) + 1;
    } catch (err) {
      report.errors += 1;
      if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) report.errorReceipts.push(toErrorReceipt(r.walletAddress, err));
    }
  }

  // ---- ENTITY DNA ----------------------------------------------------------
  const dnaOf = new Map(dnaRows.map((d) => [d.walletAddress, d]));

  // Per-wallet runner-mint sets for TRUE entity-adjusted dedup: distinct
  // verified-$10M+ mints ENTERED and WON, read from each member's behavior
  // profile (bounded — only DNA-covered wallets). Ten linked wallets that all
  // traded the same runner union to ONE mint, not ten.
  const runnerMints = new Set(
    (
      await prisma.tokenLifecycle.findMany({ where: { runnerClass: 'verified_above_10m' }, select: { mint: true } })
    ).map((r) => r.mint)
  );
  const enteredRunnersOf = new Map<string, Set<string>>();
  const wonRunnersOf = new Map<string, Set<string>>();
  const dnaWalletRows = await prisma.wallet.findMany({
    where: { chain, address: { in: dnaRows.map((d) => d.walletAddress) } },
    select: { id: true, address: true }
  });
  const [behaviorProfiles, unpricedLegRows] = await Promise.all([
    prisma.walletBehaviorProfile.findMany({
      where: { chain, walletAddress: { in: dnaRows.map((d) => d.walletAddress) } },
      select: { walletAddress: true, profileJson: true }
    }),
    // Trade-level mixed-leg detection (same rule the DNA builder uses): a
    // token with ANY unpriced BUY/SELL leg has an unknown cost basis — it can
    // never be counted as a WON runner. Deterministically ordered so that,
    // if the cap is hit, only the LAST partially-loaded wallet is uncertain.
    prisma.walletTokenTrade.findMany({
      where: { chain, walletId: { in: dnaWalletRows.map((w) => w.id) }, action: { in: ['BUY', 'SELL'] }, amountUsd: 0 },
      orderBy: [{ walletId: 'asc' }, { tokenId: 'asc' }],
      select: { walletId: true, token: { select: { address: true } } },
      distinct: ['walletId', 'tokenId'],
      take: UNPRICED_LEG_CAP + 1
    })
  ]);
  const addrOfWalletId = new Map(dnaWalletRows.map((w) => [w.id, w.address]));
  const unpricedTruncated = unpricedLegRows.length > UNPRICED_LEG_CAP;
  truncation.unpricedLegs = unpricedTruncated;
  const usableUnpriced = unpricedLegRows.slice(0, UNPRICED_LEG_CAP);
  // Under truncation the LAST walletId in the loaded window may be missing
  // rows — its unpriced set is incomplete, so it is win-INELIGIBLE (unknown
  // basis) rather than wrongly counted as a winner.
  const boundaryWalletId = unpricedTruncated ? usableUnpriced[usableUnpriced.length - 1]?.walletId ?? null : null;
  const unpricedTokensOf = new Map<string, Set<string>>();
  for (const t of usableUnpriced) {
    const a = addrOfWalletId.get(t.walletId);
    if (!a) continue;
    const s = unpricedTokensOf.get(a) ?? new Set<string>();
    s.add(t.token.address);
    unpricedTokensOf.set(a, s);
  }
  const boundaryAddr = boundaryWalletId ? addrOfWalletId.get(boundaryWalletId) ?? null : null;
  for (const bp of behaviorProfiles) {
    const positions =
      ((bp.profileJson as { local?: { tokenPositions?: {
        tokenAddress: string; buyUsd: number; sellUsd: number; exitRatio: number | null; fullExitSec: number | null; firstBuyTs: string | null;
      }[] } } | null)?.local?.tokenPositions ?? []);
    const unpriced = unpricedTokensOf.get(bp.walletAddress) ?? new Set<string>();
    // A wallet whose unpriced set may be incomplete (the truncation boundary)
    // cannot have any win asserted — cost basis is unknown.
    const winEligible = bp.walletAddress !== boundaryAddr;
    const entered = new Set<string>();
    const won = new Set<string>();
    for (const p of positions) {
      if (!runnerMints.has(p.tokenAddress) || p.firstBuyTs === null) continue;
      entered.add(p.tokenAddress); // entering is a fact regardless of pricing
      const completed = p.exitRatio !== null && p.exitRatio >= 0.95 && p.fullExitSec !== null;
      const priced = p.buyUsd > 0 && !unpriced.has(p.tokenAddress); // mixed-leg -> unknown basis, never a win
      if (winEligible && completed && priced && p.sellUsd - p.buyUsd > 0) won.add(p.tokenAddress);
    }
    enteredRunnersOf.set(bp.walletAddress, entered);
    wonRunnersOf.set(bp.walletAddress, won);
  }
  const anyTruncation = anyTruncation0();

  const components = new Map<string, string[]>();
  for (const k of dsu.keys()) {
    const root = dsu.find(k);
    const list = components.get(root) ?? [];
    list.push(k);
    components.set(root, list);
  }
  const receiverByAddr = new Map(receivers.map((r) => [r.receiverAddress, r]));

  for (const [entityKey, membersRaw] of [...components.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    try {
      const members = [...new Set(membersRaw)].sort();
      // Entities worth persisting: have DNA evidence, a root, or 2+ members.
      const memberDna = members.map((m) => dnaOf.get(m)).filter((d): d is NonNullable<typeof d> => d !== undefined);
      const rootMember = members.find((m) => rootAddrs.has(m)) ?? null;
      if (memberDna.length === 0 && rootMember === null && members.length < 2) continue;

      const sum = (f: (d: (typeof memberDna)[number]) => number) => memberDna.reduce((a, d) => a + f(d), 0);
      const wins = sum((d) => d.winCount);
      const losses = sum((d) => d.lossCount);
      const unresolved = sum((d) => d.openPositions + d.unpricedPositions);

      // TRUE entity-adjusted runner involvement/repeat: DISTINCT runner mints
      // across members (union), never a sum of linked wallets.
      const enteredRunnerMints = new Set<string>();
      const wonRunnerMints = new Set<string>();
      for (const m of members) {
        for (const mint of enteredRunnersOf.get(m) ?? []) enteredRunnerMints.add(mint);
        for (const mint of wonRunnersOf.get(m) ?? []) wonRunnerMints.add(mint);
      }
      // Some members may lack a behavior profile (no dedup data) — flag it.
      const membersMissingRunnerData = members.filter((m) => dnaOf.has(m) && !enteredRunnersOf.has(m)).length;

      // Realized/EV: ONLY over members with a KNOWN realized figure; the
      // denominator is those members' completed positions (never mix a known
      // numerator with an unknown member's positions). Incompleteness flagged.
      const realizedMembers = memberDna.filter((d) => d.totalRealizedPnlUsd !== null);
      const realized = realizedMembers.length > 0
        ? realizedMembers.reduce((a, d) => a + Number(d.totalRealizedPnlUsd), 0)
        : null;
      const completedRealized = realizedMembers.reduce((a, d) => a + d.completedPositions, 0);
      const realizedIncomplete = realizedMembers.length < memberDna.length;
      // completedPositions for W/L are pure counts (never null) — safe to sum.
      const completed = sum((d) => d.completedPositions);

      // Pooled average return WEIGHTED by completed positions (avgReturn is
      // itself a per-wallet mean, so avgReturn*completed = that wallet's return
      // sum). Median cannot be honestly derived from per-wallet averages — NULL.
      const retMembers = memberDna.filter((d) => d.avgReturn !== null && d.completedPositions > 0);
      const retWeight = retMembers.reduce((a, d) => a + d.completedPositions, 0);
      const avgReturn = retWeight > 0 ? retMembers.reduce((a, d) => a + (d.avgReturn as number) * d.completedPositions, 0) / retWeight : null;

      // One-winner dependence: max member positive realized over total positive
      // realized, computed ONLY over members with KNOWN realized PnL (an
      // unknown member can never be silently treated as zero). Flagged when
      // any member's PnL is unknown, since the true denominator may be larger.
      const positives = realizedMembers.map((d) => Math.max(0, Number(d.totalRealizedPnlUsd))).filter((x) => x > 0);
      const posTotal = positives.reduce((a, b) => a + b, 0);
      const oneWinner = positives.length > 0 && posTotal > 0 ? Math.max(...positives) / posTotal : null;

      const memberReceivers = members.map((m) => receiverByAddr.get(m)).filter((r): r is NonNullable<typeof r> => r !== undefined);
      const stagedKnown = memberReceivers.filter((r) => r.totalKnownInflowUsd !== null);
      const staged = stagedKnown.length > 0 ? stagedKnown.reduce((a, r) => a + Number(r.totalKnownInflowUsd), 0) : null;
      const stagedIncomplete = stagedKnown.length < memberReceivers.length;
      // Repeat-runner count is a lower bound whenever a member's runner-win
      // data is missing (no behavior profile) — flagged, never silently exact.
      const repeatIncomplete = membersMissingRunnerData > 0;

      const dormantReact = memberDna.reduce((a, d) => {
        const s = (d.dormancySummaryJson ?? {}) as { address?: Record<string, number> };
        return a + (s.address?.covered_dormant ?? 0);
      }, 0);
      const funded = memberDna.reduce((a, d) => {
        const s = (d.fundingSummaryJson ?? {}) as Record<string, number>;
        return a + (s.funded ?? 0);
      }, 0);

      const coverage =
        memberDna.length === 0 ? 'minimal' : memberDna.some((d) => d.coverage === 'full') ? 'partial' : 'partial';
      const data = {
        chain,
        entityKey,
        memberWallets: members.slice(0, 100),
        memberCount: members.length,
        rootWallet: rootMember,
        linkEvidenceJson: Object.fromEntries(
          members.slice(0, 25).map((m) => [m, linkEvidence.get(m) ?? []])
        ) as unknown as Prisma.InputJsonValue,
        runnersInvolved: enteredRunnerMints.size, // DISTINCT mints, entity-adjusted
        completedPositions: completed,
        winCount: wins,
        lossCount: losses,
        unresolvedPositions: unresolved,
        winRate: completed > 0 ? wins / completed : null,
        evUsdPerCompletedPosition: completedRealized > 0 && realized !== null ? realized / completedRealized : null,
        avgReturn,
        medianReturn: null, // not honestly derivable from per-wallet averages
        totalRealizedPnlUsd: realized,
        repeatRunnerCount: membersMissingRunnerData > 0 && wonRunnerMints.size === 0 ? null : wonRunnerMints.size,
        oneWinnerDependence: oneWinner,
        dormantReactivations: dormantReact,
        fundedEntries: funded,
        stagedCapitalUsd: staged,
        undeployedReceivers: memberReceivers.filter((r) => r.deployedTokenCount === 0).length,
        deployedReceivers: memberReceivers.filter((r) => r.deployedTokenCount > 0).length,
        coverage,
        confidence: Math.min(80, 20 + memberDna.length * 10 + (rootMember ? 10 : 0)),
        reasonCodes: [
          `members:${members.length}`,
          `members_with_dna:${memberDna.length}`,
          `distinct_runners:${enteredRunnerMints.size}`,
          ...(realizedIncomplete ? ['realized_pnl_incomplete_some_members_unknown'] : []),
          ...(stagedIncomplete ? ['staged_capital_incomplete_some_receivers_unknown'] : []),
          ...(repeatIncomplete ? ['repeat_runner_count_lower_bound_missing_member_data'] : []),
          ...(rootMember ? ['contains_operator_root'] : [])
        ],
        receiptsJson: {
          linkBasis: 'receiver_funding + probable/strong relationship tiers + repeat-candidate membership',
          sameTokenBuysNeverLink: true,
          runnersInvolvedBasis: 'distinct_runner_mints_union_across_members',
          repeatRunnerBasis: 'distinct_won_runner_mints_union_across_members',
          realizedPnlMembersKnown: realizedMembers.length,
          realizedPnlMembersTotal: memberDna.length,
          membersMissingRunnerData,
          inputTruncation: truncation
        } as unknown as Prisma.InputJsonValue,
        caveats: [
          'entity grouping is probabilistic linkage — never an identity claim',
          'entity metrics aggregate ADDRESS DNA rollups; median return is not derivable from per-wallet averages and is left null; one-winner dependence uses known-realized members only',
          ...(realizedIncomplete ? ['realized PnL / EV cover only members with a known realized figure — the true entity total may be larger'] : []),
          ...(stagedIncomplete ? ['staged capital covers only receivers with a known inflow — the true staged total may be larger'] : []),
          ...(repeatIncomplete ? ['repeat-runner count is a LOWER BOUND — a member lacked behavior-profile data'] : []),
          ...(anyTruncation ? ['an evidence input hit its row cap — a component may be under-linked; counts are a lower bound and stale-row reconciliation was SKIPPED this pass'] : []),
          'observation_only: no votes, no eligibility, no promotion'
        ],
        engineVersion: ENTITY_GRAPH_ENGINE_VERSION,
        computedAt: now
      };
      await prisma.entityDnaProfile.upsert({
        where: { chain_entityKey: { chain, entityKey } },
        create: data,
        update: data
      });
      report.entitiesWritten += 1;
      if (members.length > 1) report.multiWalletEntities += 1;
      if (rootMember) report.rootEntities += 1;
    } catch (err) {
      report.errors += 1;
      if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) report.errorReceipts.push(toErrorReceipt(entityKey, err));
    }
  }

  // ---- Stale-row reconciliation -------------------------------------------
  // Every role/entity written this pass was stamped computedAt = now; any row
  // with an earlier computedAt is from a prior run whose evidence disappeared
  // (or whose entity merged into a different key) and must not linger — else
  // linked wallets could reappear as independent entities.
  // ONLY reconcile when the full evidence set was loaded — under truncation a
  // "stale" row may just be an un-recomputed real one, so deleting it would
  // lose data. Skipped (never a silent partial wipe) when any input was capped.
  if (report.errors === 0 && !anyTruncation) {
    const [staleRoles, staleEntities] = await Promise.all([
      prisma.walletRoleAssignment.deleteMany({ where: { chain, computedAt: { lt: now } } }),
      prisma.entityDnaProfile.deleteMany({ where: { chain, computedAt: { lt: now } } })
    ]);
    report.staleRolesRemoved = staleRoles.count;
    report.staleEntitiesRemoved = staleEntities.count;
  }
  return report;
}
