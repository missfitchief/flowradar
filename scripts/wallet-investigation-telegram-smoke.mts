import 'dotenv/config';
import { OperatorService, prisma } from '@flowradar/db';
import { createLiveWalletCapitalScanner, createWormholeWalletBridgeScanner } from '@flowradar/providers';
import { createTelegramApi } from '../apps/telegram/src/api';
import { parseAllowedUserIds } from '../apps/telegram/src/auth';
import { createUpdateHandler } from '../apps/telegram/src/handlers';

if (process.env.MOCK_MODE !== 'false') throw new Error('Telegram smoke requires MOCK_MODE=false');
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');
const allowed = parseAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS);
const userId = [...allowed][0];
if (!userId) throw new Error('TELEGRAM_ALLOWED_USER_IDS has no authorized user');
const targets = process.argv.slice(2).filter((value) => !value.startsWith('-'));
if (!targets.length) throw new Error('Usage: tsx scripts/wallet-investigation-telegram-smoke.mts <wallet> [wallet...]');

const api = createTelegramApi(token);
const service = new OperatorService(prisma, {
  walletCapitalScanner: createLiveWalletCapitalScanner(process.env),
  walletBridgeScanner: createWormholeWalletBridgeScanner()
});

try {
  const me = await api.getMe();
  const handler = createUpdateHandler(service, api, allowed);
  for (const [index, target] of targets.entries()) {
    await handler({
      update_id: Date.now() + index,
      message: { message_id: index + 1, from: { id: Number(userId) }, chat: { id: Number(userId), type: 'private' }, text: `/wallet ${target}` }
    });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, username: me.username ?? null, authorizedUser: userId, summariesDelivered: targets.length, targets })}\n`);
} finally {
  await prisma.$disconnect();
}
