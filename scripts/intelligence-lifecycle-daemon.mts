import { prisma, runIntelligenceLifecycle } from '@flowradar/db';

const configured = Number(process.env.INTELLIGENCE_LIFECYCLE_INTERVAL_SEC ?? 300);
const intervalMs = Math.max(30, Number.isFinite(configured) ? configured : 300) * 1_000;
let running = true;

process.once('SIGINT', () => { running = false; });
process.once('SIGTERM', () => { running = false; });

while (running) {
  const started = Date.now();
  try {
    const report = await runIntelligenceLifecycle(prisma);
    console.log(JSON.stringify({ at: new Date().toISOString(), event: 'intelligence_lifecycle_complete', ...report }));
  } catch (error) {
    console.error(JSON.stringify({
      at: new Date().toISOString(), event: 'intelligence_lifecycle_failed',
      error: error instanceof Error ? error.message : String(error)
    }));
  }
  const remaining = Math.max(1_000, intervalMs - (Date.now() - started));
  await new Promise((resolve) => setTimeout(resolve, remaining));
}

await prisma.$disconnect();
