// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// SMTP delivery for password reset and email verification messages.

import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'

import type { AuthConfig } from './config.ts'
import { logger } from './logger.ts'

export interface Mailer {
  sendPasswordReset(to: string, url: string): Promise<void>
  sendEmailVerification(to: string, url: string): Promise<void>
}

// Messages are plain text: the recipient only needs the link, and text-only mail avoids HTML
// rendering pitfalls and keeps the content trivially auditable. Send failures are logged without
// the message body so a misbehaving relay never leaks a live reset or verification link.
export function createMailer(cfg: Pick<AuthConfig, 'smtpUrl' | 'smtpFrom'>): Mailer | null {
  if (!cfg.smtpUrl || !cfg.smtpFrom) return null
  const transport: Transporter = nodemailer.createTransport(cfg.smtpUrl)
  const from = cfg.smtpFrom

  async function send(to: string, subject: string, text: string): Promise<void> {
    try {
      await transport.sendMail({ from, to, subject, text })
    } catch (error) {
      logger.error('mail delivery failed', { subject, cause: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  return {
    sendPasswordReset: (to, url) =>
      send(
        to,
        'Reset your Caracal password',
        `A password reset was requested for your Caracal account.\n\nChoose a new password:\n${url}\n\nIf you did not request this, you can ignore this email; your password is unchanged.`,
      ),
    sendEmailVerification: (to, url) =>
      send(
        to,
        'Verify your Caracal email address',
        `Confirm this email address to activate your Caracal account:\n${url}\n\nIf you did not create a Caracal account, you can ignore this email.`,
      ),
  }
}
