// FlowRadar — marketDataHot job (Task 5 brief decision 3).
//
// "Hot" tier: tokens whose latest TokenFlowSnapshot.flowScore >= 50 get
// market data refreshed on the short interval (marketDataHotSec, default
// 60s) rather than waiting for the slow marketDataNormal tier (default
// 300s) — Spec §7's hot/normal tiering, so actively-flowing tokens get
// fresher price/liquidity data than quiet ones.

import type { JobContext } from '../context';
import { refreshMarketForTokens, partitionTokensByLatestFlowScore } from './marketDataShared';

const HOT_THRESHOLD = 50;

export async function run(ctx: JobContext): Promise<void> {
  const { hot } = await partitionTokensByLatestFlowScore(ctx, HOT_THRESHOLD);
  await refreshMarketForTokens(ctx, hot, 'marketDataHot');
}
