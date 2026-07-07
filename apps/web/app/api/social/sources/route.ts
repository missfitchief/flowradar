// FlowRadar — /api/social/sources (Task E, spec §8). Operator CRUD over the
// SocialSource registry from the /social "Manage sources" UI.
//
// SHADOW-ONLY + secret-safe (spec constraints 3/4/10):
//   - apiKeyEnvName is stored as the env VAR NAME only — the route never
//     resolves process.env[name] and never persists a secret value.
//   - No Alert rows, no promoted-wallet-candidate registry or scoring-table
//     interaction — this only writes SocialSource registry rows.
// Mirrors the "accept either sourceId or name" + Zod-issue-list convention of
// /api/sources and /api/import.
import { NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { prisma } from '@/lib/db';

const PLATFORMS = ['telegram', 'discord', 'manual'] as const;
const TRUST_TIERS = ['high', 'medium', 'low'] as const;

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
  platform: z.enum(PLATFORMS),
  trustTier: z.enum(TRUST_TIERS).default('medium'),
  externalId: z.string().min(1).max(200).optional(),
  inviteLink: z.string().min(1).max(500).optional(),
  notes: z.string().max(1000).optional(),
  // NAME of an env var, not a value (spec constraint 10). Loosely validated
  // as an env-var-name shape; null/omitted allowed (required-null for manual).
  apiKeyEnvName: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be an ENV VAR NAME (e.g. SOCIAL_TELEGRAM_READ_TOKEN)').optional(),
  rateLimitPerMinute: z.number().int().positive().max(6000).default(30),
  chainSupport: z.array(z.enum(['SOLANA', 'BSC'])).default(['SOLANA']),
  enabled: z.boolean().default(true)
});

const PatchSchema = z
  .object({
    sourceId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    // Every editable field optional — this is a partial update / toggle.
    enabled: z.boolean().optional(),
    trustTier: z.enum(TRUST_TIERS).optional(),
    externalId: z.string().max(200).nullable().optional(),
    inviteLink: z.string().max(500).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
    apiKeyEnvName: z.string().regex(/^[A-Z][A-Z0-9_]*$/).nullable().optional(),
    rateLimitPerMinute: z.number().int().positive().max(6000).optional()
  })
  .refine((b) => Boolean(b.sourceId) !== Boolean(b.name), {
    message: 'exactly one of sourceId or name must be provided'
  });

const DeleteSchema = z
  .object({
    sourceId: z.string().min(1).optional(),
    name: z.string().min(1).optional()
  })
  .refine((b) => Boolean(b.sourceId) !== Boolean(b.name), {
    message: 'exactly one of sourceId or name must be provided'
  });

async function readBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function zodError(err: ZodError): NextResponse {
  return NextResponse.json(
    {
      error: 'invalid request body',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    },
    { status: 400 }
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await readBody(request);
  if (body === null) return NextResponse.json({ error: 'request body is not valid JSON' }, { status: 400 });

  let parsed;
  try {
    parsed = CreateSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) return zodError(err);
    throw err;
  }

  const existing = await prisma.socialSource.findUnique({ where: { name: parsed.name } });
  if (existing) return NextResponse.json({ error: 'a source with that name already exists' }, { status: 409 });

  const created = await prisma.socialSource.create({
    data: {
      name: parsed.name,
      platform: parsed.platform,
      trustTier: parsed.trustTier,
      externalId: parsed.externalId ?? null,
      inviteLink: parsed.inviteLink ?? null,
      notes: parsed.notes ?? null,
      apiKeyEnvName: parsed.apiKeyEnvName ?? null,
      rateLimitPerMinute: parsed.rateLimitPerMinute,
      chainSupport: parsed.chainSupport,
      enabled: parsed.enabled
    }
  });
  return NextResponse.json({ source: created }, { status: 201 });
}

export async function PATCH(request: Request): Promise<NextResponse> {
  const body = await readBody(request);
  if (body === null) return NextResponse.json({ error: 'request body is not valid JSON' }, { status: 400 });

  let parsed;
  try {
    parsed = PatchSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) return zodError(err);
    throw err;
  }

  const where = parsed.sourceId ? { id: parsed.sourceId } : { name: parsed.name! };
  const existing = await prisma.socialSource.findUnique({ where });
  if (!existing) return NextResponse.json({ error: 'source not found' }, { status: 404 });

  // Build the update patch from only the fields that were provided.
  const data: Record<string, unknown> = {};
  if (parsed.enabled !== undefined) data.enabled = parsed.enabled;
  if (parsed.trustTier !== undefined) data.trustTier = parsed.trustTier;
  if (parsed.externalId !== undefined) data.externalId = parsed.externalId;
  if (parsed.inviteLink !== undefined) data.inviteLink = parsed.inviteLink;
  if (parsed.notes !== undefined) data.notes = parsed.notes;
  if (parsed.apiKeyEnvName !== undefined) data.apiKeyEnvName = parsed.apiKeyEnvName;
  if (parsed.rateLimitPerMinute !== undefined) data.rateLimitPerMinute = parsed.rateLimitPerMinute;

  const updated = await prisma.socialSource.update({ where: { id: existing.id }, data });
  return NextResponse.json({ source: updated });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const body = await readBody(request);
  if (body === null) return NextResponse.json({ error: 'request body is not valid JSON' }, { status: 400 });

  let parsed;
  try {
    parsed = DeleteSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) return zodError(err);
    throw err;
  }

  const where = parsed.sourceId ? { id: parsed.sourceId } : { name: parsed.name! };
  const existing = await prisma.socialSource.findUnique({ where });
  if (!existing) return NextResponse.json({ error: 'source not found' }, { status: 404 });

  // Cascade deletes this source's SocialMention rows (schema onDelete: Cascade).
  await prisma.socialSource.delete({ where: { id: existing.id } });
  return NextResponse.json({ ok: true, deletedId: existing.id });
}
