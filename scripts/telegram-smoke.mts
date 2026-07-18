import 'dotenv/config';
import { OperatorService, prisma } from '@flowradar/db';
import { createTelegramApi, parseAllowedUserIds, TELEGRAM_COMMANDS } from '../apps/telegram/src/index';

if (process.env.MOCK_MODE !== 'false') throw new Error('Telegram smoke requires MOCK_MODE=false');
if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is missing');
const allowed = parseAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS);
const api = createTelegramApi(process.env.TELEGRAM_BOT_TOKEN);
try {
  const me = await api.getMe();
  await api.setMyCommands(TELEGRAM_COMMANDS);
  const userId = [...allowed][0];
  const service = new OperatorService(prisma);
  const watches = await service.listWatches(userId, userId);
  await api.sendMessage(userId, `<b>FlowRadar smoke PASS</b>\nBot @${me.username ?? me.id}\nAuthorization: allowed\nPersisted watches: ${watches.length}`);
  console.log(JSON.stringify({ ok: true, username: me.username ?? null, startCommand: 'npm run telegram', authorizedUser: userId, persistedWatches: watches.length }));
} finally { await prisma.$disconnect(); }
