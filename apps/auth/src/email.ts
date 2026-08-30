// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Email delivery boundary.
 *
 * Better Auth calls this for verification, password-reset, magic-link, and
 * invitation mail. Delivery itself is deployment infrastructure: in
 * development messages go to the log; in production they are handed to the
 * webhook configured via AUTH_EMAIL_WEBHOOK_URL (e.g. an SMTP relay
 * sidecar). No auth logic lives here.
 */

import { env } from "./env.js";

export type OutboundEmail = {
  to: string;
  subject: string;
  text: string;
};

export async function sendEmail(mail: OutboundEmail): Promise<void> {
  if (!env.isProduction) {
    console.info(`[email:dev] to=${mail.to} subject=${JSON.stringify(mail.subject)}\n${mail.text}`);
    return;
  }
  if (!env.emailWebhookUrl) {
    console.error(`[email] AUTH_EMAIL_WEBHOOK_URL is not configured; dropping mail to ${mail.to}`);
    return;
  }
  // Delivery failures must never fail the auth flow that triggered the mail:
  // log and drop, with a bounded wait so a hanging relay cannot stall sign-up.
  try {
    const response = await fetch(env.emailWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mail),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error(`[email] delivery webhook returned ${response.status} for mail to ${mail.to}`);
    }
  } catch (error) {
    console.error(`[email] delivery webhook unreachable for mail to ${mail.to}:`, error);
  }
}
