// FlowRadar — post-entry behavior classifier tests (dormancy Task 10, pure).

import { describe, expect, it } from 'vitest';
import { classifyPostEntryBehavior, POST_ENTRY_ENGINE_VERSION } from '../../src/postentry/postEntryBehavior';
import type { PostEntryInput } from '../../src/postentry/postEntryBehavior';

const ENTRY = new Date('2026-06-01T00:00:00Z');
const NOW = new Date('2026-07-10T00:00:00Z');

function input(over: Partial<PostEntryInput> = {}, pos: Partial<PostEntryInput['position']> = {}): PostEntryInput {
  return {
    position: {
      buyCount: 1,
      sellCount: 0,
      buyUsd: 100,
      sellUsd: 0,
      firstBuyTs: ENTRY.toISOString(),
      lastSellTs: null,
      timeToFirstSellSec: null,
      exitRatio: null,
      stillHolding: true,
      fullExitSec: null,
      ...pos
    },
    firstSellTs: null,
    outboundTransfers: { total: 0, toLinked: 0, toService: 0, toUnknown: 0 },
    burstExitReceipt: false,
    localViewTruncated: false,
    now: NOW,
    ...over
  };
}

describe('classifyPostEntryBehavior', () => {
  it('holding with no sells beyond the durable threshold = durable_hold (also still_holding)', () => {
    const d = classifyPostEntryBehavior(input());
    expect(d.primaryClass).toBe('durable_hold');
    expect(d.labels).toContain('still_holding');
    expect(d.engineVersion).toBe(POST_ENTRY_ENGINE_VERSION);
    expect(d.confidence).toBeLessThanOrEqual(90);
  });

  it('recent entry with no sells = still_holding (not durable yet)', () => {
    const recent = new Date(NOW.getTime() - 86_400_000);
    const d = classifyPostEntryBehavior(input({}, { firstBuyTs: recent.toISOString() }));
    expect(d.primaryClass).toBe('still_holding');
    expect(d.labels).not.toContain('durable_hold');
  });

  it('full exit within an hour (but after the dump window) = fast_flip (also full_exit)', () => {
    const d = classifyPostEntryBehavior(
      input({ firstSellTs: new Date(ENTRY.getTime() + 1200_000).toISOString() }, {
        sellCount: 1, sellUsd: 200, exitRatio: 2, stillHolding: false,
        timeToFirstSellSec: 1200, fullExitSec: 1200,
        lastSellTs: new Date(ENTRY.getTime() + 1200_000).toISOString()
      })
    );
    expect(d.primaryClass).toBe('fast_flip');
    expect(d.labels).toContain('full_exit');
    expect(d.labels).not.toContain('fast_dump'); // first sell after the dump window
  });

  it('heavy exit starting within 5 minutes = fast_dump (outranks fast_flip)', () => {
    const d = classifyPostEntryBehavior(
      input({ firstSellTs: new Date(ENTRY.getTime() + 30_000).toISOString() }, {
        sellCount: 2, sellUsd: 95, exitRatio: 0.95, stillHolding: false,
        timeToFirstSellSec: 30, fullExitSec: 120,
        lastSellTs: new Date(ENTRY.getTime() + 120_000).toISOString()
      })
    );
    expect(d.primaryClass).toBe('fast_dump');
  });

  it('receipts-engine burst evidence labels burst_exit', () => {
    const d = classifyPostEntryBehavior(
      input({ burstExitReceipt: true, firstSellTs: new Date(ENTRY.getTime() + 40 * 86_400_000).toISOString() }, {
        sellCount: 1, sellUsd: 100, exitRatio: 1, stillHolding: false,
        timeToFirstSellSec: 40 * 86_400, fullExitSec: 40 * 86_400,
        lastSellTs: new Date(ENTRY.getTime() + 40 * 86_400_000).toISOString()
      })
    );
    expect(d.primaryClass).toBe('burst_exit');
    expect(d.reasonCodes).toContain('receipts_engine_single_burst_exit');
  });

  it('many heavy sells spread over more than a day = staged_distribution', () => {
    const d = classifyPostEntryBehavior(
      input({ firstSellTs: new Date(ENTRY.getTime() + 86_400_000).toISOString() }, {
        sellCount: 5, sellUsd: 92, buyUsd: 100, exitRatio: 0.92, stillHolding: false,
        timeToFirstSellSec: 86_400, fullExitSec: null,
        lastSellTs: new Date(ENTRY.getTime() + 5 * 86_400_000).toISOString()
      })
    );
    expect(d.primaryClass).toBe('staged_distribution');
  });

  it('partial sells below the full-exit threshold = partial_exit', () => {
    const d = classifyPostEntryBehavior(
      input({ firstSellTs: new Date(ENTRY.getTime() + 10 * 86_400_000).toISOString() }, {
        sellCount: 1, sellUsd: 30, exitRatio: 0.3, stillHolding: false,
        timeToFirstSellSec: 10 * 86_400,
        lastSellTs: new Date(ENTRY.getTime() + 10 * 86_400_000).toISOString()
      })
    );
    expect(d.primaryClass).toBe('partial_exit');
  });

  it('outbound token transfers label transfer_to_linked / transfer_to_service — NEVER exits', () => {
    const linked = classifyPostEntryBehavior(
      input({ outboundTransfers: { total: 1, toLinked: 1, toService: 0, toUnknown: 0 } })
    );
    expect(linked.labels).toContain('transfer_to_linked');
    expect(linked.labels).not.toContain('partial_exit'); // transfer is not a sale
    const service = classifyPostEntryBehavior(
      input({ outboundTransfers: { total: 1, toLinked: 0, toService: 1, toUnknown: 0 } })
    );
    expect(service.labels).toContain('transfer_to_service');
    const unknownDest = classifyPostEntryBehavior(
      input({ outboundTransfers: { total: 2, toLinked: 0, toService: 0, toUnknown: 2 } })
    );
    expect(unknownDest.caveats.join(' ')).toContain('not counted as exits or links');
  });

  it('no locally observed entry = unknown, honestly', () => {
    const d = classifyPostEntryBehavior(input({}, { firstBuyTs: null, buyCount: 0 }));
    expect(d.primaryClass).toBe('unknown');
    expect(d.reasonCodes).toContain('no_locally_observed_entry');
    expect(d.confidence).toBeLessThanOrEqual(25);
  });

  it('a truncated local view caps confidence and is caveated', () => {
    const d = classifyPostEntryBehavior(input({ localViewTruncated: true }));
    expect(d.confidence).toBeLessThanOrEqual(45);
    expect(d.caveats.join(' ')).toContain('truncated');
  });

  it('thresholds are configurable', () => {
    const d = classifyPostEntryBehavior(
      input({ firstSellTs: new Date(ENTRY.getTime() + 7200_000).toISOString() }, {
        sellCount: 1, sellUsd: 200, exitRatio: 2, stillHolding: false,
        timeToFirstSellSec: 7200, fullExitSec: 7200,
        lastSellTs: new Date(ENTRY.getTime() + 7200_000).toISOString()
      }),
      { fastFlipMaxSec: 10_000 }
    );
    expect(d.primaryClass).toBe('fast_flip'); // 2h exit is a flip under the widened window
  });
});
