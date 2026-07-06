// FlowRadar — GET/PUT /api/settings (Task 17 binding decision 3).
//
// Settings is a Prisma singleton table (see schema.prisma model Settings doc
// comment: "Zod-validated Json of all thresholds") — this route always reads/
// writes the FIRST row it finds and creates one on first GET/PUT if none
// exists yet (a freshly-migrated-but-never-seeded DB has zero Settings rows;
// packages/db/src/seed.ts creates one during seeding, but this route must
// not assume seeding has run).
//
// GET  -> current settings, deep-merged over DEFAULT_SETTINGS via
//         parseSettings so a partially-populated/legacy row (missing a key
//         added by a later schema change) still returns a fully-shaped
//         Settings object rather than a partial one.
// PUT  -> body is the FULL settings object (binding decision 3: "No partial
//         patch — full object only"). Runs through parseSettings, which
//         deep-merges over DEFAULT_SETTINGS then validates via
//         SettingsSchema.parse (throws ZodError on failure, including the
//         rules.A.mcapMin < rules.A.mcapMax cross-field refinement). Invalid
//         body -> 400 with the zod issue list; valid body -> upserts the
//         singleton row and returns the saved settings.

import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { prisma } from '@/lib/db';
import { parseSettings } from '@flowradar/core';

/** Reads the singleton Settings row, creating one from DEFAULT_SETTINGS if none exists yet. */
async function getOrCreateSettingsRow() {
  const existing = await prisma.settings.findFirst();
  if (existing) return existing;

  const defaults = parseSettings({});
  return prisma.settings.create({ data: { values: defaults } });
}

export async function GET(): Promise<NextResponse> {
  const row = await getOrCreateSettingsRow();
  const settings = parseSettings(row.values);
  return NextResponse.json({ settings });
}

export async function PUT(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'request body is not valid JSON' }, { status: 400 });
  }

  let settings;
  try {
    settings = parseSettings(body);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        {
          error: 'invalid settings',
          issues: err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
        { status: 400 },
      );
    }
    throw err;
  }

  const row = await getOrCreateSettingsRow();
  const updated = await prisma.settings.update({
    where: { id: row.id },
    data: { values: settings },
  });

  return NextResponse.json({ settings: parseSettings(updated.values) });
}
