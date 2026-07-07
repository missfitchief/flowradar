// FlowRadar — getSocialSourceStatuses: reports the effective mode for every
// SocialSource ROW in the registry (spec §2/§8). Unlike the candidate
// sourceStatus (a fixed 6-source spec list), social sources are
// operator-managed DB rows, so this reads them from Prisma. Mirrors
// getCandidateSourceStatuses's mode taxonomy ('live'|'mock'|'missing_key'|
// 'stub'). Never echoes a secret VALUE — only the configured env var NAME
// and whether it is present in process.env.
//
// Mode per source:
//   - MOCK_MODE (default): every row => 'mock' (all resolve to the shared
//     MockSocialSource, same one-switch convention as candidates).
//   - live (MOCK_MODE=false):
//       * platform 'manual'         => 'stub' (registry entry, no reader).
//       * telegram/discord, no key  => 'missing_key' (apiKeyEnvName env
//         value absent — factory returns null, ingest skips gracefully).
//       * telegram/discord, keyed   => 'stub' (typed stub reader — a key
//         alone doesn't make an unverified inbound integration real, same
//         rule the kolscan/gmgn candidate stubs follow).
import type { SocialSourceMode, SocialSourceStatusRow } from './types';

/** Minimal shape this function reads — a full PrismaClient satisfies it. */
export interface SocialSourceStatusClient {
  socialSource: {
    findMany(args: {
      select: { name: true; platform: true; apiKeyEnvName: true };
      orderBy: { name: 'asc' };
    }): Promise<{ name: string; platform: string; apiKeyEnvName: string | null }[]>;
  };
}

function isMockMode(): boolean {
  return process.env.MOCK_MODE !== 'false';
}

export async function getSocialSourceStatuses(prisma: SocialSourceStatusClient): Promise<SocialSourceStatusRow[]> {
  const sources = await prisma.socialSource.findMany({
    select: { name: true, platform: true, apiKeyEnvName: true },
    orderBy: { name: 'asc' }
  });

  const mockMode = isMockMode();

  return sources.map((s): SocialSourceStatusRow => {
    if (mockMode) {
      return {
        sourceName: s.name,
        platform: s.platform,
        mode: 'mock',
        note: 'MOCK_MODE active — serving deterministic mock posts.',
        apiKeyEnvName: s.apiKeyEnvName ?? null
      };
    }

    if (s.platform === 'manual') {
      return {
        sourceName: s.name,
        platform: s.platform,
        mode: 'stub',
        note: 'Manual registry entry — no automated reader this phase.',
        apiKeyEnvName: null
      };
    }

    const envName = s.apiKeyEnvName ?? null;
    const hasKey = Boolean(envName && process.env[envName]);
    const mode: SocialSourceMode = hasKey ? 'stub' : 'missing_key';
    return {
      sourceName: s.name,
      platform: s.platform,
      mode,
      note: hasKey
        ? 'Typed inbound stub — key present but no verified read integration yet; fetchPosts returns []. See file header TODO(provider).'
        : `Missing ${envName ?? 'read credential'}; factory returns null, ingest skips gracefully.`,
      apiKeyEnvName: envName
    };
  });
}
