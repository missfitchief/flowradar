import { prisma } from '@/lib/db';
import { parseSettings } from '@flowradar/core';
import { getProviderStatuses } from '@flowradar/providers';
import { SettingsForm } from '@/components/settings/SettingsForm';
import type { EnvPresence } from '@/components/settings/SettingsForm';

// DB-backed dashboard — must render per-request, never freeze at build time
// (same invariant every other DB page in this app follows).
export const dynamic = 'force-dynamic';

/** Every env var the Settings page reports presence for — booleans ONLY, values never leave the server (Task 17 binding decision 2). */
const ENV_KEYS: (keyof EnvPresence)[] = [
  'HELIUS_API_KEY',
  'BIRDEYE_API_KEY',
  'BSCSCAN_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
];

/**
 * Settings page (Task 17 binding decision 2). Loads the Settings singleton
 * row (creating one from DEFAULT_SETTINGS if the DB has none yet — mirrors
 * app/api/settings/route.ts's own getOrCreateSettingsRow, duplicated here
 * rather than shared because this is a one-line read-only fallback, not
 * worth a shared helper for two call sites in the same app), the provider
 * status table (getProviderStatuses() from @flowradar/providers — never
 * calls a live API, just reports MOCK_MODE + env-key presence), and
 * env-presence booleans for the 5 keys the task brief names. Every value
 * handed to <SettingsForm> (a client component) is a plain boolean/string/
 * number — no secret ever crosses the server/client boundary.
 */
export default async function SettingsPage() {
  const existing = await prisma.settings.findFirst();
  const settings = parseSettings(existing?.values ?? {});

  const providerStatuses = getProviderStatuses();

  const envPresence = ENV_KEYS.reduce((acc, key) => {
    acc[key] = Boolean(process.env[key]);
    return acc;
  }, {} as EnvPresence);

  // Address registry stats (Task 26 binding decision 4) — trivial grouped
  // count, source is either 'static-2026-07' (packages/providers/src/
  // registryData's curated lists) or 'mock-world' (packages/db/src/seed.ts's
  // scenario-derived rows); any other source value (future admin-UI-added
  // rows) folds into the mock bucket's complement via the total, not shown
  // as a 3rd number since the brief's line only asks for static vs mock.
  const registryGroups = await prisma.addressRegistry.groupBy({
    by: ['source'],
    _count: { _all: true },
  });
  const registryStaticCount = registryGroups
    .filter((g) => g.source === 'static-2026-07')
    .reduce((sum, g) => sum + g._count._all, 0);
  const registryTotalCount = registryGroups.reduce((sum, g) => sum + g._count._all, 0);
  const registryMockCount = registryTotalCount - registryStaticCount;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Rule thresholds, alert delivery, and provider configuration.
      </p>

      <div className="mt-6">
        <SettingsForm
          initialSettings={settings}
          providerStatuses={providerStatuses}
          envPresence={envPresence}
          registryStats={{
            total: registryTotalCount,
            static: registryStaticCount,
            mock: registryMockCount,
          }}
        />
      </div>
    </div>
  );
}
