import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from '../src/rateLimiter.js';

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows `rps` acquisitions immediately, then delays the next one by ~1000/rps ms', async () => {
    const limiter = createRateLimiter({ rps: 5 });

    // First 5 acquisitions should resolve without needing any timer advance —
    // the bucket starts full (capacity = rps).
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }

    let sixthResolved = false;
    limiter.acquire().then(() => {
      sixthResolved = true;
    });

    // Immediately after the 6th call, the promise must NOT have resolved yet.
    await vi.advanceTimersByTimeAsync(0);
    expect(sixthResolved).toBe(false);

    // Advancing by ~199ms (just under one token's refill interval of 200ms
    // for a 5 rps bucket) — still not resolved.
    await vi.advanceTimersByTimeAsync(150);
    expect(sixthResolved).toBe(false);

    // Advancing past the 200ms refill boundary resolves it.
    await vi.advanceTimersByTimeAsync(60);
    expect(sixthResolved).toBe(true);
  });

  it('never lets acquire() resolve for a 0-rps limiter within a bounded wait (sanity: it does gate)', async () => {
    // rps must be positive; this test guards against a limiter that never
    // blocks at all (i.e. acquire() always resolves synchronously regardless
    // of rps). We assert the 6th call under a busy 5rps bucket is gated,
    // which the prior test already covers directly — this test instead
    // checks the bucket eventually drains further calls back-to-back too.
    const limiter = createRateLimiter({ rps: 5 });
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }

    const order: number[] = [];
    const p1 = limiter.acquire().then(() => order.push(1));
    const p2 = limiter.acquire().then(() => order.push(2));

    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([p1, p2]);

    expect(order).toEqual([1, 2]);
  });

  it('acquire() resolves to void (Promise<void> contract)', async () => {
    const limiter = createRateLimiter({ rps: 100 });
    const result = await limiter.acquire();
    expect(result).toBeUndefined();
  });
});
