// FlowRadar — POST /api/alerts/test (Task 16 binding decision 6).
//
// Renders a TEST-kind alert via @flowradar/core's renderAlert, attempts a
// real Telegram send when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are both set
// in this process's env, persists an Alert row (type TEST) regardless of
// outcome, and returns { deliveryStatus }. The Settings page's "Send test
// alert" button (Spec §8.7) arrives in Task 17 — this task ships the route
// only, callable directly (e.g. via curl/fetch) ahead of that UI landing.
//
// deliveryStatus outcomes (same vocabulary as packages/db/src/alerts.ts's
// dispatchPendingAlerts, so the Alerts page — Task 17 — renders both alert
// origins identically):
//   'sent'             — sender was configured and Telegram accepted it.
//   'skipped_no_token'  — TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing (the
//                         default in this repo's MOCK/local setup).
//   'failed'            — sender was configured but Telegram rejected/erred.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { renderAlert } from '@flowradar/core';
import { createTelegramSender } from '@flowradar/providers';
import type { Prisma } from '@flowradar/db';

export async function POST(): Promise<NextResponse> {
  const now = new Date();
  const text = renderAlert('TEST', { timestamp: now });

  const sender = createTelegramSender({
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID
  });

  let deliveryStatus: 'sent' | 'skipped_no_token' | 'failed';
  let error: string | undefined;

  if (sender === null) {
    deliveryStatus = 'skipped_no_token';
  } else {
    try {
      await sender.send(text);
      deliveryStatus = 'sent';
    } catch (err) {
      deliveryStatus = 'failed';
      error = err instanceof Error ? err.message : String(err);
    }
  }

  await prisma.alert.create({
    data: {
      type: 'TEST',
      channel: 'TELEGRAM',
      sentAt: now,
      payload: { text } as unknown as Prisma.InputJsonValue,
      deliveryStatus,
      error
    }
  });

  return NextResponse.json({ deliveryStatus });
}
