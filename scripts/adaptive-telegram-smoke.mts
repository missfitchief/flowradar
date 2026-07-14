import 'dotenv/config';
import { OperatorService, prisma } from '@flowradar/db';
import { createTelegramApi } from '../apps/telegram/src/api';
import { renderIntelligenceAlert } from '../apps/telegram/src/intelligenceAlertRenderer';

const token = process.env.TELEGRAM_BOT_TOKEN;
const allowedUserIds = process.env.TELEGRAM_ALLOWED_USER_IDS?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
if (!token || !allowedUserIds.length) throw new Error('Telegram token/allowlist configuration is incomplete');
const persistedWatch = process.env.TELEGRAM_CHAT_ID ? null : await prisma.operatorWatch.findFirst({
  where: { active: true, userId: { in: allowedUserIds } }, orderBy: { updatedAt: 'desc' }, select: { chatId: true, userId: true }
});
const chatId = process.env.TELEGRAM_CHAT_ID || persistedWatch?.chatId;
const userId = persistedWatch?.userId || allowedUserIds[0];
if (!chatId || !userId) throw new Error('No authorized Telegram chat is configured or persisted');

const now = new Date();
const dedupeKey = 'controlled-adaptive-telegram-transport-v1';
try {
  const watch = await prisma.operatorWatch.upsert({
    where: { userId_chatId_targetType_targetKey: { userId, chatId, targetType: 'system', targetKey: 'adaptive-transport-test' } },
    create: { userId, chatId, targetType: 'system', targetKey: 'adaptive-transport-test', alertTypes: [], active: false },
    update: { active: false }
  });
  const signal = await prisma.intelligenceSignal.upsert({
    where: { dedupeKey },
    create: {
      dedupeKey, chain: 'BASE', tokenAddress: 'controlled-transport-test', signalType: 'controlled_transport_test',
      level: 'WATCH', lifecycleStage: 'OBSERVATION', score: 0, status: 'controlled_test', activatedAt: now,
      clusterKeys: [], entityKeys: [], entityIds: [], walletAddresses: [], sourceEventIds: [],
      reasons: ['Controlled Telegram transport test only; this is not a market signal.'],
      evidenceJson: { controlledTest: true, excludedFromAnalytics: true },
      historySupportJson: { controlledTest: true },
      scoreDecompositionJson: { transport: { raw: 0, weight: 0, contribution: 0, explanation: 'Transport/render/callback smoke only.' } },
      entryMarketJson: { controlledTest: true, noMarketData: true },
      rejectionReceiptJson: { controlledTest: true, reason: 'not_an_analytic_signal' },
      explanation: 'CONTROLLED TRANSPORT TEST — not a signal, candidate, or recommendation.',
      independentEntityCount: 0, independentCapitalRootCount: 0, coreWalletCount: 0, peripheralWalletCount: 0,
      outcomeStatus: 'not_applicable', ruleVersion: 1, modelVersion: 1, engineVersion: 2
    },
    update: { activatedAt: now, explanation: 'CONTROLLED TRANSPORT TEST — not a signal, candidate, or recommendation.' }
  });
  const alert = await prisma.operatorWatchAlert.upsert({
    where: { watchId_eventKey_alertType: { watchId: watch.id, eventKey: dedupeKey, alertType: 'receiver_bought_token' } },
    create: {
      watchId: watch.id, eventKey: dedupeKey, alertType: 'receiver_bought_token', status: 'sent', sentAt: now,
      payloadJson: { token: 'CONTROLLED TEST — NOT A SIGNAL', symbol: 'TEST', intelligenceSignalId: signal.id, controlledTest: true }
    },
    update: { status: 'sent', sentAt: now, payloadJson: { token: 'CONTROLLED TEST — NOT A SIGNAL', symbol: 'TEST', intelligenceSignalId: signal.id, controlledTest: true } }
  });
  const service = new OperatorService(prisma);
  const data = await service.intelligenceAlert(alert.id);
  if (!data) throw new Error('Controlled alert could not be loaded through production service');
  const rendered = renderIntelligenceAlert(data);
  const api = createTelegramApi(token);
  const me = await api.getMe();
  await api.sendMessage(chatId, `<b>CONTROLLED TRANSPORT TEST · NOT A SIGNAL</b>\n${rendered.text}`, rendered.keyboard);
  console.log(JSON.stringify({ botUsername: me.username ?? null, status: 'sent', productionServiceLoaded: true, productionRendererUsed: true, callbackButtons: rendered.keyboard.inline_keyboard.flat().length, analyticsExcluded: signal.status === 'controlled_test' }));
} finally {
  await prisma.$disconnect();
}
