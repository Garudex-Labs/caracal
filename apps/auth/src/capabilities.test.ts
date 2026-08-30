// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { computeCapabilities, type CapabilityInputs } from "./capabilities.js";

const NOTHING: CapabilityInputs = {
  emailDelivery: false,
  google: false,
  github: false,
  devLogin: false,
  ssoProviders: 0,
  passkeys: 0,
};

test("bare deployment advertises only email and password", () => {
  assert.deepEqual(computeCapabilities(NOTHING), {
    email_password: true,
    magic_links: false,
    google: false,
    github: false,
    sso: false,
    passkeys: false,
    dev_login: false,
  });
});

test("magic links require working email delivery", () => {
  assert.equal(computeCapabilities(NOTHING).magic_links, false);
  assert.equal(computeCapabilities({ ...NOTHING, emailDelivery: true }).magic_links, true);
});

test("social providers appear only with credentials present", () => {
  const google = computeCapabilities({ ...NOTHING, google: true });
  assert.equal(google.google, true);
  assert.equal(google.github, false);
  const both = computeCapabilities({ ...NOTHING, google: true, github: true });
  assert.equal(both.google && both.github, true);
});

test("enterprise SSO requires at least one registered provider", () => {
  assert.equal(computeCapabilities({ ...NOTHING, ssoProviders: 0 }).sso, false);
  assert.equal(computeCapabilities({ ...NOTHING, ssoProviders: 1 }).sso, true);
});

test("passkeys require at least one registered credential", () => {
  assert.equal(computeCapabilities({ ...NOTHING, passkeys: 0 }).passkeys, false);
  assert.equal(computeCapabilities({ ...NOTHING, passkeys: 3 }).passkeys, true);
});

test("failed registration probes fail closed", () => {
  const failed = computeCapabilities({ ...NOTHING, ssoProviders: -1, passkeys: -1 });
  assert.equal(failed.sso, false);
  assert.equal(failed.passkeys, false);
});

test("everything configured advertises everything", () => {
  const all = computeCapabilities({
    emailDelivery: true,
    google: true,
    github: true,
    devLogin: true,
    ssoProviders: 2,
    passkeys: 5,
  });
  assert.deepEqual(all, {
    email_password: true,
    magic_links: true,
    google: true,
    github: true,
    sso: true,
    passkeys: true,
    dev_login: true,
  });
});

test("descriptor carries no secrets or configuration values", () => {
  const all = computeCapabilities({ ...NOTHING, google: true, ssoProviders: 1 });
  for (const value of Object.values(all)) {
    assert.equal(typeof value, "boolean");
  }
});
