import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { OperatorService, prisma } from '@flowradar/db';
import { createTelegramApi } from './api';
import { parseAllowedUserIds } from './auth';
import { runLongPolling } from './poller';

export * from './types';
export * from './api';
export * from './auth';
export * from './render';
export * from './handlers';
export * from './poller';

export async function main() {
  if (process.env.MOCK_MODE !== 'false') throw new Error('Telegram operator bot requires MOCK_MODE=false');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
  const allowedUserIds = parseAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS);
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  try { await runLongPolling({ service: new OperatorService(prisma), api: createTelegramApi(token), allowedUserIds, signal: controller.signal }); }
  finally { await prisma.$disconnect(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error(`[telegram] fatal: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
