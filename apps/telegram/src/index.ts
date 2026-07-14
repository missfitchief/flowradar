import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { OperatorService, prisma } from '@flowradar/db';
import { createBirdeyeTokenTopTraders, createGmgnTokenTopTraders, createLiveWalletCapitalScanner, createWormholeWalletBridgeScanner, type TokenTopTradersProvider } from '@flowradar/providers';
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
  console.info(`[telegram] runtime identity ${JSON.stringify({
    pid: process.pid, cwd: process.cwd(), mockMode: process.env.MOCK_MODE,
    databaseFingerprint: secretFingerprint(process.env.DATABASE_URL),
    tokenPresent: Boolean(process.env.TELEGRAM_BOT_TOKEN), allowedUserCount: allowedUserIds.size
  })}`);
  const birdeyeTopTraders = createBirdeyeTokenTopTraders(process.env);
  const gmgnTopTraders = createGmgnTokenTopTraders();
  const solanaTopTraders: TokenTopTradersProvider = birdeyeTopTraders ? {
    async getTopTraders(chain, address, options) {
      try {
        const rows = await birdeyeTopTraders.getTopTraders(chain, address, options);
        if (rows.length) return rows;
      } catch (error) {
        console.warn(`[telegram] Birdeye token scan failed; using GMGN fallback: ${error instanceof Error ? error.message : String(error)}`);
      }
      return gmgnTopTraders.getTopTraders(chain, address, options);
    }
  } : gmgnTopTraders;
  const tokenTopTraderProviders = {
    SOLANA: { name: 'telegram_real_top_traders', adapter: solanaTopTraders, windowsComparable: false, timeFrame: '24h' as const },
    ...(birdeyeTopTraders ? { BSC: { name: 'birdeye_top_traders', adapter: birdeyeTopTraders, windowsComparable: false, timeFrame: '24h' as const } } : {})
  };
  const walletCapitalScanner = createLiveWalletCapitalScanner(process.env);
  const walletBridgeScanner = createWormholeWalletBridgeScanner();
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  try { await runLongPolling({ service: new OperatorService(prisma, { tokenTopTraderProviders, walletCapitalScanner, walletBridgeScanner }), api: createTelegramApi(token), allowedUserIds, signal: controller.signal }); }
  finally { await prisma.$disconnect(); }
}

function secretFingerprint(value: string | undefined) {
  return value ? createHash('sha256').update(value).digest('hex').slice(0, 12) : 'missing';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { console.error(`[telegram] fatal: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
