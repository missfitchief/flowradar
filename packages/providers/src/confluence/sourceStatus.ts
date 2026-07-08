// FlowRadar — getConfluenceSourceStatuses: reports the effective mode for every
// ExternalConfluenceSource ROW in the registry (design doc §Provider status
// taxonomy). Operator-managed DB rows (like getSocialSourceStatuses), so this
// reads them from Prisma. Never echoes a secret VALUE — only the configured env
// var NAME and whether it is PRESENT in process.env (Boolean only; design doc
// §Security, constraint 13).
//
// Mode per source:
//   - MOCK_MODE (default): every row => 'mock' (all resolve to the shared
//     MockConfluenceProvider, same one-switch convention as social/candidates).
//   - live (MOCK_MODE=false), by provider:
//       * holderscan: keyed  => 'plan_required' (a key alone doesn't make an
//                               unverified paid plan real — matches the adapter
//                               stub); unkeyed => 'missing_key'.
//       * clobr / gmgn:        => 'stub' (no confirmed public API this build,
//                               regardless of whether a key env var is set).
//       * ag_paper / manual:   => 'stub' (manual/keyless, no automated reader).
//       * anything else:       => 'stub' (unknown provider, honest default).
//   Provider unavailability NEVER maps to a safe/clean/'live' mode from absence.
import type { ConfluenceSourceMode, ConfluenceSourceStatusRow } from './types';

/** Minimal shape this function reads — a full PrismaClient satisfies it. */
export interface ConfluenceSourceStatusClient {
  externalConfluenceSource: {
    findMany(args: {
      select: { name: true; provider: true; apiKeyEnvName: true };
      orderBy: { name: 'asc' };
    }): Promise<{ name: string; provider: string; apiKeyEnvName: string | null }[]>;
  };
}

function isMockMode(): boolean {
  return process.env.MOCK_MODE !== 'false';
}

export async function getConfluenceSourceStatuses(
  prisma: ConfluenceSourceStatusClient
): Promise<ConfluenceSourceStatusRow[]> {
  const sources = await prisma.externalConfluenceSource.findMany({
    select: { name: true, provider: true, apiKeyEnvName: true },
    orderBy: { name: 'asc' }
  });

  const mockMode = isMockMode();

  return sources.map((s): ConfluenceSourceStatusRow => {
    const envName = s.apiKeyEnvName ?? null;

    if (mockMode) {
      return {
        sourceName: s.name,
        provider: s.provider,
        mode: 'mock',
        note: 'MOCK_MODE active — serving deterministic mock confluence.',
        apiKeyEnvName: envName
      };
    }

    // Presence via Boolean ONLY — never read the value into any returned field.
    const hasKey = Boolean(envName && process.env[envName]);

    if (s.provider === 'holderscan') {
      const mode: ConfluenceSourceMode = hasKey ? 'plan_required' : 'missing_key';
      return {
        sourceName: s.name,
        provider: s.provider,
        mode,
        note: hasKey
          ? 'Key present but HolderScan plan/integration not verified — reports plan_required; no data fetched. Absence is NOT a safe signal.'
          : `Missing ${envName ?? 'HOLDERSCAN_API_KEY'}; factory returns null, ingest skips gracefully.`,
        apiKeyEnvName: envName
      };
    }

    if (s.provider === 'clobr' || s.provider === 'gmgn') {
      return {
        sourceName: s.name,
        provider: s.provider,
        mode: 'stub',
        note: 'No confirmed public API — typed stub, no data fetched. See adapter file header TODO(provider). Not integrated is NOT a safe signal.',
        apiKeyEnvName: envName
      };
    }

    // ag_paper / manual / unknown → honest stub.
    return {
      sourceName: s.name,
      provider: s.provider,
      mode: 'stub',
      note: 'Manual/stub source — no automated reader this phase.',
      apiKeyEnvName: envName
    };
  });
}
