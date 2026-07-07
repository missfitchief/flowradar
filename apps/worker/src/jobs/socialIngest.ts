// FlowRadar — socialIngest job (Task D, Social Intelligence, Spec §6). Thin
// wrapper around @flowradar/db's runSocialIngestPass — the actual per-source
// provider resolution / mention upsert logic lives there (same
// worker/seed-sharing pattern as every other job in this directory — see
// externalWalletSource.ts's header).
//
// SHADOW-ONLY, INBOUND-ONLY (Spec global constraints 1/3/4): this job only
// reads SocialSource rows and writes SocialMention rows. It never emits an
// Alert, never touches FlowScore/Signal/CandidateWallet, and never sends
// anything outbound (it does NOT import packages/providers/src/telegram.ts's
// outbound alert sender).
//
// resolveSource: in MOCK_MODE, EVERY SocialSource row resolves to the SAME
// shared MockSocialSource instance (same "MOCK_MODE => mock source for ALL
// sources" decision as externalWalletSource.ts's getSharedMockCandidateSource),
// built once against a fresh MockWorld. Live mode (MOCK_MODE=false) maps each
// source by platform to its config-gated factory: telegram =>
// createTelegramSocialSource (null when SOCIAL_TELEGRAM_READ_TOKEN is absent),
// discord => createDiscordSocialSource (null when SOCIAL_DISCORD_BOT_TOKEN is
// absent), manual (or anything unrecognized) => null. A null return is treated
// by runSocialIngestPass as a graceful per-source skip, never a crash. These
// env var NAMES are DISTINCT from the outbound alert sender's TELEGRAM_BOT_TOKEN
// (Spec constraint 2 — the outbound sender is not reused or modified here).

import { runSocialIngestPass } from '@flowradar/db';
import {
  MockSocialSource,
  createMockWorld,
  createTelegramSocialSource,
  createDiscordSocialSource
} from '@flowradar/providers';
import type { SocialSourceProvider } from '@flowradar/providers';
import type { JobContext } from '../context';

const HOUR_MS = 60 * 60 * 1000;
const WORLD_HORIZON_HOURS = 72;

function isMockMode(): boolean {
  return process.env.MOCK_MODE !== 'false';
}

let sharedMockSocialSource: SocialSourceProvider | null = null;

/** Lazily builds ONE shared MockSocialSource for the life of this process — same genesis convention as externalWalletSource.ts's getSharedMockCandidateSource. */
function getSharedMockSocialSource(): SocialSourceProvider {
  if (!sharedMockSocialSource) {
    const genesis = new Date(Date.now() - WORLD_HORIZON_HOURS * HOUR_MS);
    const world = createMockWorld({ genesis });
    sharedMockSocialSource = new MockSocialSource(world);
  }
  return sharedMockSocialSource;
}

// Live-adapter cache (same rationale as externalWalletSource.ts's
// liveCandidateSourceCache — construct each factory at most once per process,
// reuse the returned instance + its single rate limiter on every call). Keyed
// by platform, since the live factory choice is platform-driven, not
// name-driven, for social sources.
const liveSocialSourceCache = new Map<string, SocialSourceProvider | null>();

/**
 * Live-mode (MOCK_MODE=false) source resolution by SocialSource.platform. Each
 * platform maps to its config-gated factory in @flowradar/providers/social —
 * both telegram/discord factories return `null` when their read-credential env
 * var is absent (a graceful per-source skip). `manual` (and any unrecognized
 * platform) resolves to null — no automated reader this phase.
 */
function resolveLiveSocialSource(platform: string): SocialSourceProvider | null {
  if (liveSocialSourceCache.has(platform)) {
    return liveSocialSourceCache.get(platform) ?? null;
  }

  let resolved: SocialSourceProvider | null;
  switch (platform) {
    case 'telegram':
      resolved = createTelegramSocialSource({ SOCIAL_TELEGRAM_READ_TOKEN: process.env.SOCIAL_TELEGRAM_READ_TOKEN });
      break;
    case 'discord':
      resolved = createDiscordSocialSource({ SOCIAL_DISCORD_BOT_TOKEN: process.env.SOCIAL_DISCORD_BOT_TOKEN });
      break;
    default:
      resolved = null;
  }

  liveSocialSourceCache.set(platform, resolved);
  return resolved;
}

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, log } = ctx;
  await runSocialIngestPass(
    prisma,
    settings,
    (source) => {
      if (isMockMode()) {
        return getSharedMockSocialSource();
      }
      return resolveLiveSocialSource(source.platform);
    },
    log
  );
}
