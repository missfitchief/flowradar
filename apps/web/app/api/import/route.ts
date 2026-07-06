// FlowRadar — POST /api/import (Task 12 binding decision 2 & 4).
//
// Runs the CSV wallet import SYNCHRONOUSLY in this route handler by calling
// @flowradar/db's importWalletsCsv directly — the web app and the worker are
// separate processes, and this path must work with only `npm run dev`
// running (no worker process required). apps/worker's `walletImport` job
// (src/jobs/walletImport.ts) wraps the exact same importWalletsCsv function
// for later async/scheduled use, but this route does not depend on it or on
// the worker being up at all.
//
// Request: multipart/form-data, field name `file` (decision 4).
// Validation order (decision 5 — each rejection is a JSON error body, and
// NONE of these create an ImportJob row; only a real importWalletsCsv() call
// does that, and it always creates one even for a malformed CSV body):
//   1. method !== POST                => 405
//   2. no `file` field / not a File    => 400
//   3. file.size > 2MB                 => 413
//   4. filename doesn't end in .csv    => 415
// Success: 200 { importJobId, totalRows, okRows, errorRows, errors } — errors
// capped to the first 50 row-level errors (decision 4) so a CSV with
// thousands of bad rows doesn't inflate the response body unboundedly; the
// full error list is still on the persisted ImportJob.errors Json column.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { importWalletsCsv } from '@flowradar/db';

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB (decision 5)
const MAX_RETURNED_ERRORS = 50; // decision 4: "errors: first 50"

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Next.js App Router route handlers only export the HTTP methods they
 * support — an unlisted method (e.g. GET here) already 405s on its own via
 * Next's own routing, so decision 5's "non-POST => 405" is satisfied by
 * simply not exporting a GET/PUT/etc. handler rather than needing an
 * explicit method check inside POST.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonError('request body is not valid multipart/form-data', 400);
  }

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return jsonError('missing required "file" field (multipart/form-data)', 400);
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return jsonError(`file exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes (2MB)`, 413);
  }

  if (!file.name.toLowerCase().endsWith('.csv')) {
    return jsonError('file must have a .csv extension', 415);
  }

  const csvText = await file.text();
  const result = await importWalletsCsv(prisma, csvText, file.name);

  return NextResponse.json({
    importJobId: result.importJobId,
    totalRows: result.totalRows,
    okRows: result.okRows,
    errorRows: result.errorRows,
    errors: result.errors.slice(0, MAX_RETURNED_ERRORS)
  });
}
