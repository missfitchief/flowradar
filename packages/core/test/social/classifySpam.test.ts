import { describe, expect, it } from 'vitest';
import { classifySpam } from '../../src/social/classifySpam';
import type { SocialSpamConfig, SpamContext } from '../../src/social/types';

const CFG: SocialSpamConfig = {
  copypastaAuthorMin: 3,
  repeatAuthorMin: 5,
  lowContentMinChars: 12,
  windowMinutes: 360,
  weights: { copypasta: 80, repeat_author: 60, low_content: 50 },
  uiHideThreshold: 70
};

function ctx(over: Partial<SpamContext>): SpamContext {
  return {
    normalizedSnippet: 'a reasonably long clean snippet about a token',
    distinctAuthorsSameHash: 1,
    sameAuthorRecentCount: 1,
    alnumLength: 45,
    ...over
  };
}

describe('classifySpam', () => {
  it('clean content → score 0, reason null', () => {
    expect(classifySpam(ctx({}), CFG)).toEqual({ spamScore: 0, spamReason: null });
  });

  it('copypasta: distinctAuthorsSameHash >= copypastaAuthorMin → weight 80', () => {
    expect(classifySpam(ctx({ distinctAuthorsSameHash: 3 }), CFG)).toEqual({
      spamScore: 80,
      spamReason: 'copypasta'
    });
  });

  it('repeat_author: sameAuthorRecentCount >= repeatAuthorMin → weight 60', () => {
    expect(classifySpam(ctx({ sameAuthorRecentCount: 5 }), CFG)).toEqual({
      spamScore: 60,
      spamReason: 'repeat_author'
    });
  });

  it('low_content: alnumLength < lowContentMinChars → weight 50', () => {
    expect(classifySpam(ctx({ alnumLength: 5 }), CFG)).toEqual({
      spamScore: 50,
      spamReason: 'low_content'
    });
  });

  it('multiple triggers → score is the MAX weight, reason is that rule', () => {
    // copypasta (80) AND low_content (50) both fire → 80 / copypasta wins
    const r = classifySpam(ctx({ distinctAuthorsSameHash: 4, alnumLength: 3 }), CFG);
    expect(r.spamScore).toBe(80);
    expect(r.spamReason).toBe('copypasta');
  });

  it('boundary: exactly at the threshold triggers (>=), one below does not', () => {
    expect(classifySpam(ctx({ distinctAuthorsSameHash: 3 }), CFG).spamReason).toBe('copypasta');
    expect(classifySpam(ctx({ distinctAuthorsSameHash: 2 }), CFG).spamReason).toBeNull();
    expect(classifySpam(ctx({ alnumLength: 12 }), CFG).spamReason).toBeNull(); // 12 is NOT < 12
    expect(classifySpam(ctx({ alnumLength: 11 }), CFG).spamReason).toBe('low_content');
  });

  it('is pure: never mutates the input context', () => {
    const c = ctx({ distinctAuthorsSameHash: 4 });
    const snapshot = JSON.stringify(c);
    classifySpam(c, CFG);
    expect(JSON.stringify(c)).toBe(snapshot);
  });
});
