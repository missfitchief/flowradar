// FlowRadar — receipts-backed cross-wallet behavior engine (pure; GMGN
// behavior plan Tasks 5/7/8/14 / directive Task 5).
//
// Independently derives coordination/behavior classifications from LOCAL
// on-chain evidence (trades with block/slot + tx hashes, transfer edges) —
// never from provider labels, never from any external service's branding or
// label vocabulary. Every classification is a RECEIPT: component metrics,
// the exact evidence transactions, example tokens, independent-token
// repetition count, confidence, caveats, engine version, data-quality status,
// and explorer links. No opaque labels.
//
// NOTHING here grants signal eligibility, smart-wallet votes, or promotion —
// results are observation-side receipts only (grantsEligibility:false).

export const RECEIPTS_ENGINE_VERSION = 1;

export type ReceiptClassification =
  | 'same_block_launch_cluster'
  | 'distribution_into_later_buyers'
  | 'single_burst_exit'
  | 'launch_team_linked_destructive_exit'
  | 'repeated_coordinated_crew'
  | 'possible_side_wallet'
  | 'probable_side_wallet'
  | 'strong_onchain_link'
  | 'repeat_low_mcap_early_buyer'
  | 'independent_sharp_trader'
  | 'bot_or_arbitrage'
  | 'market_maker_or_service'
  | 'one_hit_wonder'
  | 'high_rug_exposure';

export interface ReceiptTradeInput {
  walletAddress: string;
  tokenAddress: string;
  action: 'BUY' | 'SELL';
  amountUsd: number;
  ts: Date;
  blockOrSlot: bigint;
  txHash: string;
  marketCapAtTrade: number | null;
}

export interface ReceiptTransferInput {
  sourceAddress: string;
  destinationAddress: string;
  usd: number | null;
  ts: Date;
  txHash: string;
}

export interface ReceiptsEngineInput {
  trades: ReceiptTradeInput[];
  transfers: ReceiptTransferInput[];
  /** Token outcome map when runner-mining series exist (address -> outcome). */
  tokenOutcomes?: Record<string, 'runner' | 'rug' | 'dead' | 'flat'>;
  now: Date;
  /** solscan-style explorer prefix; default Solana mainnet. */
  explorerTxPrefix?: string;
}

export interface BehaviorReceipt {
  classification: ReceiptClassification;
  /** Wallet(s) the receipt is about (pairs for link receipts, sets for crews). */
  wallets: string[];
  confidence: number; // 0..100
  componentMetrics: Record<string, number | string | null>;
  /** The exact transactions that evidence the claim. */
  evidenceTxs: string[];
  exampleTokens: string[];
  /** Number of INDEPENDENT tokens the pattern repeats across. */
  independentTokenRepetition: number;
  caveats: string[];
  dataQuality: 'complete' | 'partial';
  classificationVersion: number;
  explorerLinks: string[];
}

export interface ReceiptsEngineResult {
  engineVersion: number;
  receipts: BehaviorReceipt[];
  /** Input rows dropped by the hard engine bounds — reported, never silent. */
  inputTruncation: { tradesTruncated: number; transfersTruncated: number };
  grantsEligibility: false;
}

const LAUNCH_WINDOW_SLOTS = 30n; // "launch" = within 30 slots of the token's first observed trade
const MIN_CLUSTER = 3;
const BURST_EXIT_SEC = 60;
const BURST_EXIT_RATIO = 0.9;
const LOW_MCAP_USD = 250_000;
const CREW_ENTRY_WINDOW_SEC = 300;

const BASE_CAVEATS = [
  'derived from locally observed trades/transfers only (bounded polling) — coverage may be partial',
  'coordination receipts describe on-chain timing/funding patterns, not proven intent'
];

/** Hard input bound: beyond this the engine truncates (newest-first by ts)
 *  and REPORTS it — quadratic scans over unbounded histories are a DoS. */
const MAX_ENGINE_TRADES = 50_000;
const MAX_ENGINE_TRANSFERS = 50_000;

function link(prefix: string, tx: string): string {
  // Path-encode the hash and refuse non-https prefixes (a UI rendering these
  // must never receive a javascript:/data: URL or an unescaped path segment).
  const safePrefix = prefix.startsWith('https://') ? prefix : 'https://solscan.io/tx/';
  return `${safePrefix}${encodeURIComponent(tx)}`;
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k) ?? [];
    list.push(it);
    m.set(k, list);
  }
  return m;
}

/** Wallet sets whose FIRST buy of a token lands within the token's launch
 *  window (first observed slot + LAUNCH_WINDOW_SLOTS). Cluster receipts fire
 *  for sets of >= MIN_CLUSTER wallets; repetition counts tokens where the
 *  SAME wallet appears in a launch cluster. */
function deriveLaunchClusters(input: ReceiptsEngineInput, prefix: string): BehaviorReceipt[] {
  const byToken = groupBy(input.trades, (t) => t.tokenAddress);
  const launchWalletsPerToken = new Map<string, { wallet: string; tx: string; slot: bigint }[]>();

  for (const [token, trades] of byToken) {
    const buys = trades.filter((t) => t.action === 'BUY').sort((a, b) => (a.blockOrSlot < b.blockOrSlot ? -1 : 1));
    if (buys.length === 0) continue;
    // Launch anchor = first observed trade of ANY side (Codex Important-17):
    // an earlier observed SELL proves the token predates the buy cluster.
    const launchSlot = trades.reduce((min, t) => (t.blockOrSlot < min ? t.blockOrSlot : min), buys[0].blockOrSlot);
    const firstBuyByWallet = new Map<string, ReceiptTradeInput>();
    for (const b of buys) if (!firstBuyByWallet.has(b.walletAddress)) firstBuyByWallet.set(b.walletAddress, b);
    const inWindow = [...firstBuyByWallet.values()].filter((b) => b.blockOrSlot - launchSlot <= LAUNCH_WINDOW_SLOTS);
    if (inWindow.length >= MIN_CLUSTER) {
      launchWalletsPerToken.set(token, inWindow.map((b) => ({ wallet: b.walletAddress, tx: b.txHash, slot: b.blockOrSlot })));
    }
  }

  const receipts: BehaviorReceipt[] = [];
  const tokensPerWallet = new Map<string, string[]>();
  for (const [token, members] of launchWalletsPerToken) {
    for (const m of members) {
      const list = tokensPerWallet.get(m.wallet) ?? [];
      list.push(token);
      tokensPerWallet.set(m.wallet, list);
    }
  }
  for (const [token, members] of launchWalletsPerToken) {
    const repeated = members.filter((m) => (tokensPerWallet.get(m.wallet)?.length ?? 0) >= 2);
    const evidence = members.map((m) => m.tx);
    receipts.push({
      classification: 'same_block_launch_cluster',
      wallets: members.map((m) => m.wallet),
      confidence: Math.min(85, 40 + members.length * 10 + repeated.length * 5),
      componentMetrics: {
        token,
        clusterSize: members.length,
        launchWindowSlots: Number(LAUNCH_WINDOW_SLOTS),
        membersRepeatingAcrossTokens: repeated.length
      },
      evidenceTxs: evidence,
      exampleTokens: [token],
      independentTokenRepetition: Math.max(0, ...members.map((m) => tokensPerWallet.get(m.wallet)?.length ?? 0)),
      caveats: [...BASE_CAVEATS, 'launch = first LOCALLY OBSERVED trade slot — the true mint slot may be earlier'],
      dataQuality: 'partial',
      classificationVersion: RECEIPTS_ENGINE_VERSION,
      explorerLinks: evidence.slice(0, 10).map((tx) => link(prefix, tx))
    });
  }
  return receipts;
}

/** Sells >= BURST_EXIT_RATIO of a wallet's position in one block or <= 60s. */
function deriveBurstExits(input: ReceiptsEngineInput, prefix: string): BehaviorReceipt[] {
  const receipts: BehaviorReceipt[] = [];
  const byWalletToken = groupBy(input.trades, (t) => `${t.walletAddress}|${t.tokenAddress}`);
  for (const [key, trades] of byWalletToken) {
    const [wallet, token] = key.split('|');
    const buys = trades.filter((t) => t.action === 'BUY');
    const sells = trades.filter((t) => t.action === 'SELL').sort((a, b) => a.ts.getTime() - b.ts.getTime());
    const buyUsd = buys.reduce((s, t) => s + t.amountUsd, 0);
    if (buyUsd <= 0) continue;
    // Only sells AFTER the first observed buy count toward "exiting the
    // position" (Codex Important-13: pre-buy sells belong to an unobserved
    // earlier position and must not inflate the burst).
    const firstBuyTs = Math.min(...buys.map((b) => b.ts.getTime()));
    const postBuySells = sells.filter((s) => s.ts.getTime() >= firstBuyTs);
    if (postBuySells.length === 0) continue;
    // widest sell burst window <= BURST_EXIT_SEC
    for (let i = 0; i < postBuySells.length; i++) {
      let burstUsd = 0;
      const burstTxs: string[] = [];
      for (let j = i; j < postBuySells.length && (postBuySells[j].ts.getTime() - postBuySells[i].ts.getTime()) / 1000 <= BURST_EXIT_SEC; j++) {
        burstUsd += postBuySells[j].amountUsd;
        burstTxs.push(postBuySells[j].txHash);
      }
      if (burstUsd >= buyUsd * BURST_EXIT_RATIO) {
        receipts.push({
          classification: 'single_burst_exit',
          wallets: [wallet],
          confidence: 75,
          componentMetrics: { token, burstUsd, positionBuyUsd: buyUsd, burstSeconds: BURST_EXIT_SEC, burstTradeCount: burstTxs.length },
          evidenceTxs: burstTxs,
          exampleTokens: [token],
          independentTokenRepetition: 1,
          caveats: [
            ...BASE_CAVEATS,
            'exit share is a USD proxy (proceeds vs cost) — under strong price appreciation a partial token exit can read as a full USD exit; token-quantity accounting requires amount series'
          ],
          dataQuality: 'partial',
          classificationVersion: RECEIPTS_ENGINE_VERSION,
          explorerLinks: burstTxs.slice(0, 10).map((tx) => link(prefix, tx))
        });
        break;
      }
    }
  }
  // repetition: same wallet bursting across multiple tokens
  const byWallet = groupBy(receipts, (r) => r.wallets[0]);
  for (const [, list] of byWallet) {
    if (list.length > 1) for (const r of list) r.independentTokenRepetition = list.length;
  }
  return receipts;
}

/** A seller whose outbound transfer reaches an address that then BUYS the same
 *  token within 1h — distribution into later buyers (receipt = both txs). */
function deriveDistribution(input: ReceiptsEngineInput, prefix: string): BehaviorReceipt[] {
  const receipts: BehaviorReceipt[] = [];
  const buysByWallet = groupBy(input.trades.filter((t) => t.action === 'BUY'), (t) => t.walletAddress);
  const sellersByToken = groupBy(input.trades.filter((t) => t.action === 'SELL'), (t) => t.walletAddress);

  for (const tr of input.transfers) {
    if (tr.sourceAddress === tr.destinationAddress) continue; // self-transfer is never distribution
    const sellerSells = sellersByToken.get(tr.sourceAddress) ?? [];
    if (sellerSells.length === 0) continue;
    const receiverBuys = buysByWallet.get(tr.destinationAddress) ?? [];
    for (const sell of sellerSells) {
      // Sequencing (Codex Important-12): the SELL must precede the transfer
      // (within 24h), and the receiver's buy must follow the transfer within
      // 1h — sell -> transfer -> buy, never a months-old sell.
      const sellBeforeTransfer =
        sell.ts.getTime() <= tr.ts.getTime() && tr.ts.getTime() - sell.ts.getTime() <= 24 * 3600_000;
      if (!sellBeforeTransfer) continue;
      const laterBuy = receiverBuys.find(
        (b) => b.tokenAddress === sell.tokenAddress &&
          b.ts.getTime() >= tr.ts.getTime() &&
          b.ts.getTime() - tr.ts.getTime() <= 3600_000
      );
      if (laterBuy) {
        receipts.push({
          classification: 'distribution_into_later_buyers',
          wallets: [tr.sourceAddress, tr.destinationAddress],
          confidence: 65,
          componentMetrics: {
            token: sell.tokenAddress,
            transferUsd: tr.usd,
            receiverBuyUsd: laterBuy.amountUsd,
            transferToBuyGapSec: Math.round((laterBuy.ts.getTime() - tr.ts.getTime()) / 1000)
          },
          evidenceTxs: [tr.txHash, sell.txHash, laterBuy.txHash],
          exampleTokens: [sell.tokenAddress],
          independentTokenRepetition: 1,
          caveats: [...BASE_CAVEATS, 'transfer->buy sequencing is circumstantial without amount tracing'],
          dataQuality: 'partial',
          classificationVersion: RECEIPTS_ENGINE_VERSION,
          explorerLinks: [tr.txHash, sell.txHash, laterBuy.txHash].map((tx) => link(prefix, tx))
        });
        break;
      }
    }
  }
  return receipts;
}

/** Side-wallet link tiers from direct funding + co-entry timing. */
function deriveSideWalletLinks(input: ReceiptsEngineInput, prefix: string): BehaviorReceipt[] {
  const receipts: BehaviorReceipt[] = [];
  const firstBuys = new Map<string, Map<string, ReceiptTradeInput>>(); // wallet -> token -> first buy
  for (const t of input.trades.filter((x) => x.action === 'BUY').sort((a, b) => a.ts.getTime() - b.ts.getTime())) {
    const m = firstBuys.get(t.walletAddress) ?? new Map();
    if (!m.has(t.tokenAddress)) m.set(t.tokenAddress, t);
    firstBuys.set(t.walletAddress, m);
  }

  // Pair identity is UNDIRECTED (Codex Important-14: A->B and B->A are one
  // relationship) and self-transfers never form a link.
  const fundingPairs = groupBy(
    input.transfers.filter((tr) => tr.sourceAddress !== tr.destinationAddress),
    (tr) => [tr.sourceAddress, tr.destinationAddress].sort().join('|')
  );
  for (const [pairKey, transfers] of fundingPairs) {
    const [a, b] = pairKey.split('|');
    const aBuys = firstBuys.get(a);
    const bBuys = firstBuys.get(b);
    // co-entries: same token, first buys within CREW_ENTRY_WINDOW_SEC
    const coEntries: { token: string; txA: string; txB: string; gapSec: number }[] = [];
    if (aBuys && bBuys) {
      for (const [token, buyA] of aBuys) {
        const buyB = bBuys.get(token);
        if (!buyB) continue;
        const gapSec = Math.abs(buyA.ts.getTime() - buyB.ts.getTime()) / 1000;
        if (gapSec <= CREW_ENTRY_WINDOW_SEC) coEntries.push({ token, txA: buyA.txHash, txB: buyB.txHash, gapSec: Math.round(gapSec) });
      }
    }
    // Only transfers with KNOWN, non-dust value count as funding evidence for
    // the tiers (Codex Important-14); unknown-value transfers are reported
    // separately, never silently valued at 0.
    const valuedTransfers = transfers.filter((t) => t.usd !== null && t.usd >= 10);
    const unknownValueTransfers = transfers.length - transfers.filter((t) => t.usd !== null).length;
    const hasFunding = valuedTransfers.length > 0;
    const tier: ReceiptClassification | null =
      hasFunding && coEntries.length >= 3
        ? 'strong_onchain_link'
        : hasFunding && coEntries.length >= 2
          ? 'probable_side_wallet'
          : (hasFunding && coEntries.length >= 1) || valuedTransfers.length >= 2
            ? 'possible_side_wallet'
            : null;
    if (!tier) continue;
    const evidence = [...valuedTransfers.slice(0, 3).map((t) => t.txHash), ...coEntries.flatMap((c) => [c.txA, c.txB])];
    receipts.push({
      classification: tier,
      wallets: [a, b],
      confidence: tier === 'strong_onchain_link' ? 85 : tier === 'probable_side_wallet' ? 65 : 40,
      componentMetrics: {
        directTransfers: transfers.length,
        coEntryTokens: coEntries.length,
        coEntryWindowSec: CREW_ENTRY_WINDOW_SEC,
        knownTransferUsd: valuedTransfers.reduce((s, t) => s + (t.usd as number), 0),
        unknownValueTransfers
      },
      evidenceTxs: evidence,
      exampleTokens: coEntries.slice(0, 5).map((c) => c.token),
      independentTokenRepetition: coEntries.length,
      caveats: [...BASE_CAVEATS, 'linked wallets NEVER inherit any status automatically — link receipts are evidence, not promotion'],
      dataQuality: 'partial',
      classificationVersion: RECEIPTS_ENGINE_VERSION,
      explorerLinks: evidence.slice(0, 10).map((tx) => link(prefix, tx))
    });
  }
  return receipts;
}

/** The same >= MIN_CLUSTER wallet set entering >= 3 tokens within tight windows. */
function deriveCrews(input: ReceiptsEngineInput, prefix: string): BehaviorReceipt[] {
  const byToken = groupBy(input.trades.filter((t) => t.action === 'BUY'), (t) => t.tokenAddress);
  // token -> set of wallets whose first buys land within one CREW window of each other
  const entrySets: { token: string; wallets: string[]; txs: string[] }[] = [];
  for (const [token, buys] of byToken) {
    const firstByWallet = new Map<string, ReceiptTradeInput>();
    for (const b of [...buys].sort((x, y) => x.ts.getTime() - y.ts.getTime())) {
      if (!firstByWallet.has(b.walletAddress)) firstByWallet.set(b.walletAddress, b);
    }
    const entries = [...firstByWallet.values()].sort((x, y) => x.ts.getTime() - y.ts.getTime());
    // sliding window over first entries
    for (let i = 0; i < entries.length; i++) {
      const windowWallets = entries.filter(
        (e) => e.ts.getTime() >= entries[i].ts.getTime() && e.ts.getTime() - entries[i].ts.getTime() <= CREW_ENTRY_WINDOW_SEC * 1000
      );
      if (windowWallets.length >= MIN_CLUSTER) {
        entrySets.push({ token, wallets: windowWallets.map((w) => w.walletAddress).sort(), txs: windowWallets.map((w) => w.txHash) });
        break;
      }
    }
  }
  // crews = identical wallet sets appearing across >= 3 tokens
  const bySet = groupBy(entrySets, (s) => s.wallets.join(','));
  const receipts: BehaviorReceipt[] = [];
  for (const [setKey, occurrences] of bySet) {
    if (occurrences.length < 3) continue;
    const wallets = setKey.split(',');
    const evidence = occurrences.flatMap((o) => o.txs).slice(0, 15);
    receipts.push({
      classification: 'repeated_coordinated_crew',
      wallets,
      confidence: Math.min(90, 50 + occurrences.length * 10),
      componentMetrics: { crewSize: wallets.length, tokensCoEntered: occurrences.length, entryWindowSec: CREW_ENTRY_WINDOW_SEC },
      evidenceTxs: evidence,
      exampleTokens: occurrences.slice(0, 5).map((o) => o.token),
      independentTokenRepetition: occurrences.length,
      caveats: [...BASE_CAVEATS, 'crew identity v1 requires the EXACT same wallet set per token — supersets/noisy variants evade it; treat absence as unknown, not clearance'],
      dataQuality: 'partial',
      classificationVersion: RECEIPTS_ENGINE_VERSION,
      explorerLinks: evidence.slice(0, 10).map((tx) => link(prefix, tx))
    });
  }
  return receipts;
}

/** Launch-cluster member with a burst exit AND a funding link to another
 *  cluster member — the destructive launch-team shape. */
function deriveLaunchTeamDestructive(
  launchClusters: BehaviorReceipt[],
  burstExits: BehaviorReceipt[],
  input: ReceiptsEngineInput,
  prefix: string
): BehaviorReceipt[] {
  const receipts: BehaviorReceipt[] = [];
  for (const cluster of launchClusters) {
    const token = String(cluster.componentMetrics.token);
    for (const burst of burstExits) {
      const wallet = burst.wallets[0];
      if (!cluster.wallets.includes(wallet)) continue;
      if (String(burst.componentMetrics.token) !== token) continue;
      // The claimed funding link's transfer tx MUST be in the evidence
      // (Codex Important-17): find the actual transfer(s), not just the flag.
      const fundingTxs = input.transfers
        .filter(
          (t) =>
            (t.destinationAddress === wallet && cluster.wallets.includes(t.sourceAddress) && t.sourceAddress !== wallet) ||
            (t.sourceAddress === wallet && cluster.wallets.includes(t.destinationAddress) && t.destinationAddress !== wallet)
        )
        .map((t) => t.txHash);
      if (fundingTxs.length === 0) continue;
      const evidence = [...fundingTxs.slice(0, 3), ...burst.evidenceTxs, ...cluster.evidenceTxs.slice(0, 5)];
      receipts.push({
        classification: 'launch_team_linked_destructive_exit',
        wallets: [wallet],
        confidence: 70,
        componentMetrics: { token, clusterSize: cluster.componentMetrics.clusterSize, burstUsd: burst.componentMetrics.burstUsd },
        evidenceTxs: evidence,
        exampleTokens: [token],
        independentTokenRepetition: 1,
        caveats: [...BASE_CAVEATS, '"launch team" = same-launch-window cluster + direct funding link — creator attribution is NOT on-chain-proven here'],
        dataQuality: 'partial',
        classificationVersion: RECEIPTS_ENGINE_VERSION,
        explorerLinks: evidence.slice(0, 10).map((tx) => link(prefix, tx))
      });
    }
  }
  return receipts;
}

/** Per-wallet solo patterns: repeat low-mcap early buyer / independent sharp
 *  trader / one-hit wonder / bot cadence / market-maker shape / rug exposure. */
function deriveSoloPatterns(input: ReceiptsEngineInput, linked: Set<string>, prefix: string): BehaviorReceipt[] {
  const receipts: BehaviorReceipt[] = [];
  const byWallet = groupBy(input.trades, (t) => t.walletAddress);

  for (const [wallet, trades] of byWallet) {
    const buys = trades.filter((t) => t.action === 'BUY');
    const lowMcapEarly = buys.filter((b) => b.marketCapAtTrade !== null && b.marketCapAtTrade <= LOW_MCAP_USD);
    const lowMcapTokens = [...new Set(lowMcapEarly.map((b) => b.tokenAddress))];

    if (lowMcapTokens.length >= 3) {
      const cls: ReceiptClassification = linked.has(wallet) ? 'repeat_low_mcap_early_buyer' : 'independent_sharp_trader';
      const evidence = lowMcapEarly.slice(0, 10).map((b) => b.txHash);
      receipts.push({
        classification: cls,
        wallets: [wallet],
        confidence: Math.min(80, 35 + lowMcapTokens.length * 8),
        componentMetrics: { lowMcapEntries: lowMcapTokens.length, mcapThresholdUsd: LOW_MCAP_USD, coordinationLinks: linked.has(wallet) ? 1 : 0 },
        evidenceTxs: evidence,
        exampleTokens: lowMcapTokens.slice(0, 5),
        independentTokenRepetition: lowMcapTokens.length,
        caveats: [...BASE_CAVEATS, 'entry quality says nothing about exits — read together with the hold/dump classifier', 'independence = no coordination links FOUND in partial local data — absence of evidence, not proof of independence'],
        dataQuality: 'partial',
        classificationVersion: RECEIPTS_ENGINE_VERSION,
        explorerLinks: evidence.slice(0, 10).map((tx) => link(prefix, tx))
      });
    } else if (lowMcapTokens.length === 1 && [...new Set(buys.map((b) => b.tokenAddress))].length <= 2) {
      receipts.push({
        classification: 'one_hit_wonder',
        wallets: [wallet],
        confidence: 45,
        componentMetrics: { lowMcapEntries: 1, totalTokens: [...new Set(buys.map((b) => b.tokenAddress))].length },
        evidenceTxs: lowMcapEarly.slice(0, 3).map((b) => b.txHash),
        exampleTokens: lowMcapTokens,
        independentTokenRepetition: 1,
        caveats: [...BASE_CAVEATS, 'a single early entry is not a pattern — repetition across independent tokens is the bar'],
        dataQuality: 'partial',
        classificationVersion: RECEIPTS_ENGINE_VERSION,
        explorerLinks: lowMcapEarly.slice(0, 3).map((b) => link(prefix, b.txHash))
      });
    }

    // bot cadence: >= 20 trades whose inter-trade gaps are near-constant
    if (trades.length >= 20) {
      const sorted = [...trades].sort((a, b) => a.ts.getTime() - b.ts.getTime());
      const gaps: number[] = [];
      for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i].ts.getTime() - sorted[i - 1].ts.getTime()) / 1000);
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
      const cv = mean > 0 ? Math.sqrt(variance) / mean : Infinity;
      if (cv < 0.25 && mean < 600) {
        receipts.push({
          classification: 'bot_or_arbitrage',
          wallets: [wallet],
          confidence: 70,
          componentMetrics: { tradeCount: trades.length, meanGapSec: Math.round(mean), gapCoefficientOfVariation: Math.round(cv * 100) / 100 },
          evidenceTxs: sorted.slice(0, 10).map((t) => t.txHash),
          exampleTokens: [...new Set(sorted.map((t) => t.tokenAddress))].slice(0, 5),
          independentTokenRepetition: [...new Set(sorted.map((t) => t.tokenAddress))].length,
          caveats: [...BASE_CAVEATS, 'cadence regularity is a bot SIGNATURE, not proof — schedulers and DCA tools share it'],
          dataQuality: 'partial',
          classificationVersion: RECEIPTS_ENGINE_VERSION,
          explorerLinks: sorted.slice(0, 5).map((t) => link(prefix, t.txHash))
        });
      }
      // market-maker shape: near-balanced two-sided flow on the SAME token(s)
      const perToken = groupBy(trades, (t) => t.tokenAddress);
      for (const [token, tt] of perToken) {
        const b = tt.filter((x) => x.action === 'BUY').length;
        const s = tt.filter((x) => x.action === 'SELL').length;
        if (b >= 10 && s >= 10 && Math.min(b, s) / Math.max(b, s) >= 0.7) {
          receipts.push({
            classification: 'market_maker_or_service',
            wallets: [wallet],
            confidence: 65,
            componentMetrics: { token, buys: b, sells: s },
            evidenceTxs: tt.slice(0, 10).map((t) => t.txHash),
            exampleTokens: [token],
            independentTokenRepetition: 1,
            caveats: BASE_CAVEATS,
            dataQuality: 'partial',
            classificationVersion: RECEIPTS_ENGINE_VERSION,
            explorerLinks: tt.slice(0, 5).map((t) => link(prefix, t.txHash))
          });
          break;
        }
      }
    }

    // rug exposure — only with outcome data, never inferred
    if (input.tokenOutcomes) {
      const entered = [...new Set(buys.map((b) => b.tokenAddress))];
      const known = entered.filter((t) => input.tokenOutcomes![t] !== undefined);
      const rugged = known.filter((t) => input.tokenOutcomes![t] === 'rug');
      if (known.length >= 3 && rugged.length / known.length >= 0.5) {
        receipts.push({
          classification: 'high_rug_exposure',
          wallets: [wallet],
          confidence: 70,
          componentMetrics: { tokensWithKnownOutcome: known.length, ruggedTokens: rugged.length, rugSharePct: Math.round((rugged.length / known.length) * 100) },
          evidenceTxs: buys.filter((b) => rugged.includes(b.tokenAddress)).slice(0, 10).map((b) => b.txHash),
          exampleTokens: rugged.slice(0, 5),
          independentTokenRepetition: rugged.length,
          caveats: [...BASE_CAVEATS, 'outcomes from runner-mining series; exposure alone does not distinguish victim from participant'],
          dataQuality: 'partial',
          classificationVersion: RECEIPTS_ENGINE_VERSION,
          explorerLinks: []
        });
      }
    }
  }
  return receipts;
}

export function deriveBehaviorReceipts(rawInput: ReceiptsEngineInput): ReceiptsEngineResult {
  // Hard input bounds (Codex Important-15): newest-first truncation, REPORTED
  // via truncation counters — quadratic scans over unbounded input are a DoS.
  const tradesTruncated = Math.max(0, rawInput.trades.length - MAX_ENGINE_TRADES);
  const transfersTruncated = Math.max(0, rawInput.transfers.length - MAX_ENGINE_TRANSFERS);
  const input: ReceiptsEngineInput =
    tradesTruncated > 0 || transfersTruncated > 0
      ? {
          ...rawInput,
          trades: [...rawInput.trades].sort((a, b) => b.ts.getTime() - a.ts.getTime()).slice(0, MAX_ENGINE_TRADES),
          transfers: [...rawInput.transfers].sort((a, b) => b.ts.getTime() - a.ts.getTime()).slice(0, MAX_ENGINE_TRANSFERS)
        }
      : rawInput;

  const prefix = input.explorerTxPrefix ?? 'https://solscan.io/tx/';
  const launchClusters = deriveLaunchClusters(input, prefix);
  const burstExits = deriveBurstExits(input, prefix);
  const distribution = deriveDistribution(input, prefix);
  const sideLinks = deriveSideWalletLinks(input, prefix);
  const crews = deriveCrews(input, prefix);
  const launchTeam = deriveLaunchTeamDestructive(launchClusters, burstExits, input, prefix);
  const linkedWallets = new Set<string>([
    ...sideLinks.flatMap((r) => r.wallets),
    ...crews.flatMap((r) => r.wallets),
    ...launchClusters.flatMap((r) => r.wallets)
  ]);
  const solo = deriveSoloPatterns(input, linkedWallets, prefix);

  return {
    engineVersion: RECEIPTS_ENGINE_VERSION,
    receipts: [...launchClusters, ...burstExits, ...distribution, ...sideLinks, ...crews, ...launchTeam, ...solo],
    inputTruncation: { tradesTruncated, transfersTruncated },
    grantsEligibility: false
  };
}
