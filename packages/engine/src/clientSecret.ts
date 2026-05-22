// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Client secret generation shared by confidential application provisioning flows.

import { randomBytes } from 'node:crypto'

export function generateClientSecret(): string {
  return `cs_${randomBytes(32).toString('base64url')}`
}
