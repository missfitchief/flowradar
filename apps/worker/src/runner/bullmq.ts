// FlowRadar — BullMqRunner: the FULL-mode JobRunner (Redis-backed).
//
// Normative source: Task 5 brief decision 2. Only ever constructed when
// REDIS_URL is a non-empty string (see runner/index.ts's createRunner() —
// LITE mode never reaches this file at all). `bullmq` is imported
// dynamically inside start() rather than statically at module top-level, so
// merely importing this module (e.g. via runner/index.ts's static import for
// type-checking) never requires a reachable Redis connection or even loads
// bullmq's TCP-connecting client code — only calling start() does.
//
// Connection: BullMQ's Queue/Worker constructors accept a plain
// `{ host, port, ... }` connection-options object and manage their own
// internal ioredis client per Queue/Worker (BullMQ's own recommended
// pattern — see https://docs.bullmq.io/guide/connections). This runner
// parses REDIS_URL into that plain object itself rather than depending on
// the `ioredis` package directly and constructing a shared client instance:
// bullmq bundles its own pinned-version copy of ioredis internally, and a
// separately-installed top-level `ioredis` package (even at a compatible
// semver range) is a structurally-different TypeScript type from bullmq's
// bundled one, which breaks `Queue`/`Worker`'s `connection` option typing.
// A plain data object has no such type-identity problem and needs no extra
// dependency.
//
// One BullMQ Queue+Worker pair per registered name:
//   - schedule(name, intervalMs, fn) records a "scheduled" registration
//     (name, intervalMs) — the actual Queue/Worker/repeatable-job wiring
//     happens in start(), once bullmq is loaded and connection options are
//     known. The job's `fn` becomes the Worker's processor.
//   - enqueue(name, payload)/process(name, fn) is the direct queue/worker
//     pair: enqueue() adds a one-off job (throws if start() hasn't run yet —
//     BullMQ needs a live connection to add a job, unlike InlineRunner's
//     purely in-memory FIFO which can buffer before any connection exists).
//     process(name, fn) registers the Worker processor for that queue.
//
// stop() closes every Worker (awaiting in-flight jobs to finish first via
// Worker.close()'s own graceful-shutdown behavior) and every Queue.

import type { JobRunner } from '@flowradar/core';

// Dynamically imported bullmq module is typed via `typeof import(...)` so
// this file still gets full type-checking without a static import.
type BullmqModule = typeof import('bullmq');
type BullmqQueue = InstanceType<BullmqModule['Queue']>;
type BullmqWorker = InstanceType<BullmqModule['Worker']>;
type BullmqConnectionOptions = ConstructorParameters<BullmqModule['Queue']>[1] extends { connection: infer C }
  ? C
  : never;

interface ScheduledRegistration {
  name: string;
  intervalMs: number;
  fn: () => Promise<void>;
}

/** Parses a redis:// or rediss:// URL into the plain options object BullMQ's Queue/Worker `connection` option accepts. */
function parseRedisUrl(redisUrl: string): BullmqConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username || undefined,
    password: url.password || undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null
  } as BullmqConnectionOptions;
}

export class BullMqRunner implements JobRunner {
  private connectionOptions: BullmqConnectionOptions | null = null;
  private readonly redisUrl: string;
  private bullmq: BullmqModule | null = null;

  private readonly scheduledRegistrations: ScheduledRegistration[] = [];
  private readonly processHandlers = new Map<string, (payload: unknown) => Promise<void>>();
  private readonly queues = new Map<string, BullmqQueue>();
  private readonly workers = new Map<string, BullmqWorker>();

  private started = false;

  constructor(redisUrl: string) {
    if (!redisUrl) {
      throw new Error('BullMqRunner requires a non-empty redisUrl (REDIS_URL) — construct InlineRunner instead in LITE mode.');
    }
    this.redisUrl = redisUrl;
  }

  schedule(name: string, intervalMs: number, fn: () => Promise<void>): void {
    if (this.started) {
      throw new Error(`BullMqRunner.schedule("${name}"): cannot register new scheduled jobs after start() has run`);
    }
    this.scheduledRegistrations.push({ name, intervalMs, fn });
  }

  process(name: string, fn: (payload: unknown) => Promise<void>): void {
    this.processHandlers.set(name, fn);
    if (this.started) {
      this.wireWorkerFor(name, fn);
    }
  }

  async enqueue(name: string, payload: unknown): Promise<string> {
    if (!this.started) {
      throw new Error(`BullMqRunner.enqueue("${name}"): call start() before enqueueing jobs`);
    }
    const queue = this.queueFor(name);
    const job = await queue.add(name, payload);
    return String(job.id);
  }

  async start(): Promise<void> {
    if (this.started) return;

    const bullmqModule = await import('bullmq');
    this.bullmq = bullmqModule;
    this.connectionOptions = parseRedisUrl(this.redisUrl);

    this.started = true;

    // Wire every schedule() registration: a Queue + repeatable job scheduler
    // (upsertJobScheduler — BullMQ 5's non-deprecated repeatable-job API) +
    // a Worker whose processor is the registration's own fn (schedule()'s fn
    // takes no payload, so the Worker processor ignores the job data).
    for (const reg of this.scheduledRegistrations) {
      const queue = this.queueFor(reg.name);
      await queue.upsertJobScheduler(`${reg.name}-scheduler`, { every: reg.intervalMs });
      this.wireWorkerFor(reg.name, async () => reg.fn());
    }

    // Wire any process() handlers registered before start() (enqueue()-style
    // queues that don't go through schedule()).
    for (const [name, handler] of this.processHandlers) {
      if (!this.workers.has(name)) {
        this.wireWorkerFor(name, handler);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    // Worker.close() drains in-flight jobs before resolving.
    await Promise.all([...this.workers.values()].map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.workers.clear();
    this.queues.clear();
    this.started = false;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private queueFor(name: string): BullmqQueue {
    if (!this.bullmq || !this.connectionOptions) {
      throw new Error('BullMqRunner: start() must run before queues can be created');
    }
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new this.bullmq.Queue(name, { connection: this.connectionOptions }) as BullmqQueue;
      this.queues.set(name, queue);
    }
    return queue;
  }

  private wireWorkerFor(name: string, fn: (payload: unknown) => Promise<void>): void {
    if (!this.bullmq || !this.connectionOptions) {
      throw new Error('BullMqRunner: start() must run before workers can be created');
    }
    if (this.workers.has(name)) return;
    const worker = new this.bullmq.Worker(
      name,
      async (job) => {
        await fn(job.data);
      },
      { connection: this.connectionOptions }
    ) as BullmqWorker;
    this.workers.set(name, worker);
  }
}
