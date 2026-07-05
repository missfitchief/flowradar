// FlowRadar — marketDataNormal job (Task 5 brief decision 3).
//
// "Normal" tier: every token NOT in the hot tier (latest
// TokenFlowSnapshot.flowScore < 50, or no flow snapshot at all yet) gets
// market data refreshed on the slower interval (marketDataNormalSec, default
// 300s) — Spec §7's hot/normal tiering.

import type { JobContext } from '../context.js';
import { refreshMarketForTokens, partitionTokensByLatestFlowScore } from './marketDataShared.js';

const HOT_THRESHOLD = 50;

export async function run(ctx: JobContext): Promise<void> {
  const { normal } = await partitionTokensByLatestFlowScore(ctx, HOT_THRESHOLD);
  await refreshMarketForTokens(ctx, normal, 'marketDataNormal');
}
