// FlowRadar — PATCH /api/sources (Task 36, Wave 4.5, Spec §5b).
//
// Toggles ExternalWalletSource.enabled from the Source Health page
// (app/sources/page.tsx's SourceHealthTable "enabled" switch). Body accepts
// EITHER `sourceId` (the row's cuid) OR `name` (the unique source name, e.g.
// 'solana_tracker_pnl') plus `enabled: boolean` — same "accept either handle"
// convenience as nothing else in this app needs yet, but the brief calls for
// it explicitly (binding decision 3: "PATCH {sourceId or name, enabled}").
// Exactly one of sourceId/name must be present; both or neither is a 400.

import { NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { prisma } from '@/lib/db';

const PatchSourceSchema = z
  .object({
    sourceId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    enabled: z.boolean()
  })
  .refine((body) => Boolean(body.sourceId) !== Boolean(body.name), {
    message: 'exactly one of sourceId or name must be provided'
  });

export async function PATCH(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'request body is not valid JSON' }, { status: 400 });
  }

  let parsed;
  try {
    parsed = PatchSourceSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        {
          error: 'invalid request body',
          issues: err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
        },
        { status: 400 }
      );
    }
    throw err;
  }

  const where = parsed.sourceId ? { id: parsed.sourceId } : { name: parsed.name! };

  const existing = await prisma.externalWalletSource.findUnique({ where });
  if (!existing) {
    return NextResponse.json({ error: 'source not found' }, { status: 404 });
  }

  const updated = await prisma.externalWalletSource.update({
    where: { id: existing.id },
    data: { enabled: parsed.enabled }
  });

  return NextResponse.json({ source: updated });
}
