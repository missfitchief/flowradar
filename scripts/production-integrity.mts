import { prisma, runProductionIntegrity } from '@flowradar/db';

try {
  const report = await runProductionIntegrity(prisma);
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'failed') process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
