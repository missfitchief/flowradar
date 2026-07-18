import { prisma, recordRuntimeHeartbeat, runEntityDecayPass, runIntelligenceLifecycle, runIntelligenceOutcomePass } from '@flowradar/db';

const configured = Number(process.env.INTELLIGENCE_LIFECYCLE_INTERVAL_SEC ?? 300);
const intervalMs = Math.max(30, Number.isFinite(configured) ? configured : 300) * 1_000;
let running = true;
const processStartedAt = new Date();

await recordRuntimeHeartbeat(prisma, {
  component: 'intelligence', status: 'starting', startedAt: processStartedAt, metadata: { intervalMs, expectedIntervalMs: intervalMs }
});

process.once('SIGINT', () => { running = false; });
process.once('SIGTERM', () => { running = false; });

while (running) {
  const started = Date.now();
  try {
    const report = await runIntelligenceLifecycle(prisma);
    const [outcomes, decay] = await Promise.all([
      runIntelligenceOutcomePass(prisma, { take: 10_000 }),
      runEntityDecayPass(prisma)
    ]);
    console.log(JSON.stringify({ at: new Date().toISOString(), event: 'intelligence_lifecycle_complete', ...report, outcomes, decay }));
    await recordRuntimeHeartbeat(prisma, {
      component: 'intelligence', status: 'healthy', startedAt: processStartedAt, success: true,
      metadata: { intervalMs, expectedIntervalMs: intervalMs, eventsProcessed: report.eventsProcessed, signalsCreated: report.signalsCreated }
    });
  } catch (error) {
    console.error(JSON.stringify({
      at: new Date().toISOString(), event: 'intelligence_lifecycle_failed',
      error: error instanceof Error ? error.message : String(error)
    }));
    await recordRuntimeHeartbeat(prisma, {
      component: 'intelligence', status: 'degraded', startedAt: processStartedAt, error,
      metadata: { intervalMs, expectedIntervalMs: intervalMs }
    }).catch(() => undefined);
  }
  const remaining = Math.max(1_000, intervalMs - (Date.now() - started));
  await new Promise((resolve) => setTimeout(resolve, remaining));
}

await recordRuntimeHeartbeat(prisma, {
  component: 'intelligence', status: 'stopping', startedAt: processStartedAt, metadata: {}
}).catch(() => undefined);
await prisma.$disconnect();
