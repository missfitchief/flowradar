import { prisma, promoteIntelligenceWeightProposal } from '@flowradar/db';

const proposalId = process.argv[2]?.trim();
const approvedBy = process.argv[3]?.trim();
if (!proposalId || !approvedBy) {
  throw new Error('Usage: npm run intelligence:promote-model -- <proposal-id> <operator-id>');
}

try {
  const model = await promoteIntelligenceWeightProposal(prisma, proposalId, approvedBy);
  console.log(JSON.stringify({
    status: model.status,
    version: model.version,
    source: model.source,
    approvedAt: model.approvedAt?.toISOString() ?? null,
    approvedBy: model.approvedBy,
    automaticPromotion: false
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
