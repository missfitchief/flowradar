// FlowRadar — per-provider token-bucket rate limiter.
//
// No external libs (spec §5 "Hard rule" / Task 4 brief: providers deps are
// ONLY @flowradar/core). Implemented locally: capacity = rps tokens, refills
// continuously at `rps` tokens/sec. acquire() takes one token immediately if
// available; otherwise it waits until enough time has elapsed for a token to
// refill, then takes it.
//
// Uses real wall-clock time (Date.now()) for the refill clock — this is a
// timing utility, not mock-world content, so it is exempt from the
// mock/world.ts "no Date.now()" determinism rule (see mock/world.ts header).

export interface RateLimiterOptions {
  /** Sustained requests per second the bucket allows. Must be > 0. */
  rps: number;
}

export interface RateLimiter {
  /** Resolves once a token is available, consuming it. */
  acquire(): Promise<void>;
}

/**
 * Token-bucket limiter: capacity equals `rps` (so a burst of up to `rps`
 * calls resolves immediately with a full bucket), refilling continuously at
 * `rps` tokens/sec (i.e. one token every `1000/rps` ms).
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { rps } = options;
  if (!(rps > 0)) {
    throw new Error(`createRateLimiter: rps must be > 0, got ${rps}`);
  }

  const capacity = rps;
  const refillIntervalMs = 1000 / rps;

  let tokens = capacity;
  let lastRefillMs = Date.now();
  // Serializes waiters so tokens are handed out in FIFO order and each
  // waiter's timer is scheduled relative to when it actually gets to the
  // front of the line (not all scheduled optimistically up front).
  let queueTail: Promise<void> = Promise.resolve();

  function refill(): void {
    const now = Date.now();
    const elapsedMs = now - lastRefillMs;
    if (elapsedMs <= 0) {
      return;
    }
    const refilled = elapsedMs / refillIntervalMs;
    tokens = Math.min(capacity, tokens + refilled);
    lastRefillMs = now;
  }

  function acquire(): Promise<void> {
    const next = queueTail.then(async () => {
      refill();
      while (tokens < 1) {
        const deficit = 1 - tokens;
        const waitMs = Math.max(0, deficit * refillIntervalMs);
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        refill();
      }
      tokens -= 1;
    });
    // Swallow rejections in the shared tail so one waiter's failure never
    // blocks the queue for everyone behind it (acquire() itself never
    // rejects, so this is defensive only).
    queueTail = next.catch(() => undefined);
    return next;
  }

  return { acquire };
}
