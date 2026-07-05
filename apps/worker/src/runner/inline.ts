// FlowRadar — InlineRunner: the default JobRunner in LITE mode (no Redis).
//
// Normative source: Task 5 brief decision 2 + plan Shared Contracts JobRunner
// interface (packages/core/src/types.ts). Two independent mechanisms live
// side by side on one runner instance:
//   - schedule(name, intervalMs, fn): a setInterval per name, started by
//     start() and cleared by stop(). A per-name "running" flag skips a tick
//     entirely if the previous invocation of that same name hasn't finished
//     yet (overlap guard) — a slow job never runs two overlapping copies of
//     itself concurrently.
//   - enqueue(name, payload) / process(name, fn): a classic queue-worker
//     pair. enqueue() pushes onto an in-process FIFO array immediately
//     (synchronously) and returns a generated job id; a single serial drain
//     loop pulls jobs off the front of the FIFO one at a time (across ALL
//     names — this is one shared serial queue, not one per name) and calls
//     the handler registered via process() for that job's name. If enqueue()
//     is called before process() has registered a handler for that name, the
//     job simply waits in the FIFO until a handler is registered and the next
//     drain tick runs (drain is triggered both by enqueue() and by
//     process()) — jobs are never dropped.
//
// stop() clears every scheduled interval AND awaits any in-flight scheduled
// invocation or in-flight FIFO drain before resolving, so a caller can rely
// on "no more work is happening in this runner" once stop() resolves.

import type { JobRunner } from '@flowradar/core';

interface ScheduledEntry {
  name: string;
  intervalMs: number;
  fn: () => Promise<void>;
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  /** Resolves once the currently in-flight invocation (if any) settles. */
  inFlight: Promise<void> | null;
}

interface QueueItem {
  id: string;
  name: string;
  payload: unknown;
}

let jobIdCounter = 0;
function nextJobId(): string {
  jobIdCounter += 1;
  return `inline-job-${Date.now()}-${jobIdCounter}`;
}

export class InlineRunner implements JobRunner {
  private readonly scheduled = new Map<string, ScheduledEntry>();
  private readonly handlers = new Map<string, (payload: unknown) => Promise<void>>();
  private readonly fifo: QueueItem[] = [];
  private draining = false;
  /** Resolves once the current drain loop pass (if any) fully empties the FIFO. */
  private drainComplete: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;

  schedule(name: string, intervalMs: number, fn: () => Promise<void>): void {
    if (this.scheduled.has(name)) {
      throw new Error(`InlineRunner.schedule: "${name}" is already scheduled`);
    }
    this.scheduled.set(name, { name, intervalMs, fn, timer: null, running: false, inFlight: null });
    if (this.started && !this.stopped) {
      this.startTimerFor(name);
    }
  }

  async enqueue(name: string, payload: unknown): Promise<string> {
    const id = nextJobId();
    this.fifo.push({ id, name, payload });
    this.kickDrain();
    return id;
  }

  process(name: string, fn: (payload: unknown) => Promise<void>): void {
    this.handlers.set(name, fn);
    this.kickDrain();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const name of this.scheduled.keys()) {
      this.startTimerFor(name);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const entry of this.scheduled.values()) {
      if (entry.timer) {
        clearInterval(entry.timer);
        entry.timer = null;
      }
    }
    // Await every in-flight scheduled invocation, plus the FIFO drain loop,
    // so no work is still running once stop() resolves.
    await Promise.all([...this.scheduled.values()].map((e) => e.inFlight ?? Promise.resolve()));
    await this.drainComplete;
  }

  // ---------------------------------------------------------------------------
  // Scheduled interval mechanics
  // ---------------------------------------------------------------------------

  private startTimerFor(name: string): void {
    const entry = this.scheduled.get(name);
    if (!entry || entry.timer) return;
    entry.timer = setInterval(() => {
      if (entry.running) return; // overlap guard: previous tick still in flight, skip this one
      entry.running = true;
      entry.inFlight = entry
        .fn()
        .catch((err) => {
          // A scheduled job's own fn() is expected to catch its own errors
          // (jobs never rethrow past their boundary — see brief decision 3),
          // but guard here too so one misbehaving job can never take down
          // the runner's interval loop.
          // eslint-disable-next-line no-console
          console.error(`[runner:inline] scheduled job "${name}" threw:`, err);
        })
        .finally(() => {
          entry.running = false;
          entry.inFlight = null;
        });
    }, entry.intervalMs);
  }

  // ---------------------------------------------------------------------------
  // FIFO enqueue/process mechanics
  // ---------------------------------------------------------------------------

  private kickDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.drainComplete = this.drainLoop().finally(() => {
      this.draining = false;
    });
  }

  private async drainLoop(): Promise<void> {
    for (;;) {
      const item = this.fifo[0];
      if (!item) return;
      const handler = this.handlers.get(item.name);
      if (!handler) return; // no handler registered yet — leave item queued, stop draining until process() kicks us again

      this.fifo.shift();
      try {
        await handler(item.payload);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[runner:inline] queued job "${item.name}" (${item.id}) threw:`, err);
      }
    }
  }
}
