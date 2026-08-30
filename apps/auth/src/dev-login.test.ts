// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { devLoginPermitted, type DevLoginEnvironment } from "./dev-login.js";

const LOCAL_DEV: DevLoginEnvironment = {
  nodeEnv: "development",
  devLoginFlag: "1",
  baseURL: "http://localhost",
};

test("explicit local development enables the method", () => {
  assert.equal(devLoginPermitted(LOCAL_DEV), true);
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, baseURL: "http://localhost:8000" }), true);
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, baseURL: "http://127.0.0.1" }), true);
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, baseURL: "http://[::1]:3000" }), true);
});

test("production can never enable the method", () => {
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, nodeEnv: "production" }), false);
});

test("only an explicit development NODE_ENV qualifies", () => {
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, nodeEnv: undefined }), false);
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, nodeEnv: "" }), false);
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, nodeEnv: "test" }), false);
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, nodeEnv: "staging" }), false);
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, nodeEnv: "Development" }), false);
});

test("the opt-in flag must be exactly 1", () => {
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, devLoginFlag: undefined }), false);
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, devLoginFlag: "0" }), false);
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, devLoginFlag: "true" }), false);
});

test("a public deployment URL blocks the method even in dev mode", () => {
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, baseURL: "https://caracal.example.com" }), false);
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, baseURL: "https://staging.caracal.run" }), false);
  // Loopback as a subdomain of a public host must not qualify.
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, baseURL: "https://localhost.example.com" }), false);
});

test("missing or malformed base URLs fail closed", () => {
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, baseURL: undefined }), false);
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, baseURL: "" }), false);
  assert.equal(devLoginPermitted({ ...LOCAL_DEV, baseURL: "not a url" }), false);
});
