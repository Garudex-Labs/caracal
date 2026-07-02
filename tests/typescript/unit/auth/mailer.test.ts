// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the SMTP mailer: configuration gating and message dispatch.

import { describe, expect, it, vi } from 'vitest'

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn().mockResolvedValue(undefined) }))
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail })) },
}))

import { createMailer } from '../../../../apps/auth/src/mailer.ts'

describe('createMailer', () => {
  it('is disabled without a relay url or sender', () => {
    expect(createMailer({ smtpUrl: null, smtpFrom: null })).toBeNull()
    expect(createMailer({ smtpUrl: 'smtps://smtp.example.com', smtpFrom: null })).toBeNull()
    expect(createMailer({ smtpUrl: null, smtpFrom: 'no-reply@example.com' })).toBeNull()
  })

  it('sends password reset mail with the emailed link and configured sender', async () => {
    const mailer = createMailer({ smtpUrl: 'smtps://smtp.example.com', smtpFrom: 'Caracal <no-reply@example.com>' })
    await mailer?.sendPasswordReset('richard.hendricks@piedpiper.example', 'https://auth.example.com/reset?token=abc')
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Caracal <no-reply@example.com>',
        to: 'richard.hendricks@piedpiper.example',
        subject: expect.stringMatching(/reset/i),
        text: expect.stringContaining('https://auth.example.com/reset?token=abc'),
      }),
    )
  })

  it('sends verification mail with the emailed link', async () => {
    const mailer = createMailer({ smtpUrl: 'smtps://smtp.example.com', smtpFrom: 'Caracal <no-reply@example.com>' })
    await mailer?.sendEmailVerification('monica.hall@raviga.example', 'https://auth.example.com/verify?token=xyz')
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'monica.hall@raviga.example',
        subject: expect.stringMatching(/verify/i),
        text: expect.stringContaining('https://auth.example.com/verify?token=xyz'),
      }),
    )
  })
})
