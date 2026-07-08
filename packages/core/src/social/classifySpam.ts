// FlowRadar — social: pure spam / copy-paste classifier (spec §4).
//
// PURE. Shadow-only: this ONLY assigns a score + reason. It NEVER drops a
// mention (the job stores every mention with its score; the UI greys/hides
// >= uiHideThreshold). The job supplies distinctAuthorsSameHash and
// sameAuthorRecentCount from lookback queries; alnumLength comes from the
// normalized snippet's alnum core.
//
// Rules (spec §4), each with a configurable weight; the returned score is the
// MAX weight among triggered rules and the reason is that same rule:
//   copypasta      when distinctAuthorsSameHash >= copypastaAuthorMin
//   repeat_author  when sameAuthorRecentCount   >= repeatAuthorMin
//   low_content    when alnumLength             <  lowContentMinChars

import type { SocialSpamConfig, SpamContext, SpamReason } from './types';

export function classifySpam(
  ctx: SpamContext,
  cfg: SocialSpamConfig
): { spamScore: number; spamReason: SpamReason | null } {
  const triggered: { reason: SpamReason; weight: number }[] = [];

  if (ctx.distinctAuthorsSameHash >= cfg.copypastaAuthorMin) {
    triggered.push({ reason: 'copypasta', weight: cfg.weights.copypasta });
  }
  if (ctx.sameAuthorRecentCount >= cfg.repeatAuthorMin) {
    triggered.push({ reason: 'repeat_author', weight: cfg.weights.repeat_author });
  }
  if (ctx.alnumLength < cfg.lowContentMinChars) {
    triggered.push({ reason: 'low_content', weight: cfg.weights.low_content });
  }

  if (triggered.length === 0) {
    return { spamScore: 0, spamReason: null };
  }

  const worst = triggered.reduce((max, t) => (t.weight > max.weight ? t : max));
  return { spamScore: worst.weight, spamReason: worst.reason };
}
