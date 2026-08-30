// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { runCommand } from "./command";
import { adminCredentials } from "./helpers";

const PULL_DIR = "/tmp/kiro-e2e-pull";

test.describe("Kiro CLI Commands", () => {
  test.beforeAll(() => {
    const { email, password } = adminCredentials();
    runCommand(
      "caracal",
      [
        "auth",
        "login",
        "--server",
        "http://localhost",
        "--email",
        email,
      ],
      {
        allowFailure: true,
        env: { CARACAL_PASSWORD: password },
      },
    );
  });

  test("caracal doctor --harness kiro runs without errors", () => {
    const output = runCommand(
      "caracal",
      ["doctor", "--harness", "kiro"],
      { allowFailure: true },
    );
    expect(output).toBeTruthy();
    expect(output).not.toContain("Traceback");
    expect(output).not.toContain("TypeError");
  });

  test("caracal scan --harness kiro shows read-only inventory", () => {
    const output = runCommand(
      "caracal",
      ["scan", "--harness", "kiro"],
      { allowFailure: true },
    );
    expect(output).not.toContain("Traceback");
    expect(output).toMatch(/Agents/);
    expect(output).toMatch(/coder|backend|frontend/i);
  });

  test("caracal scan shows components from multiple harnesses", () => {
    const output = runCommand("caracal", ["scan"], { allowFailure: true });
    expect(output).not.toContain("Traceback");
    const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
    expect(clean).toMatch(/\d+ components discovered/);
    expect(clean).toMatch(/kiro/i);
  });

  test("caracal doctor patch --harness kiro --dry-run previews changes", () => {
    const output = runCommand(
      "caracal",
      ["doctor", "patch", "--harness", "kiro", "--dry-run"],
      { allowFailure: true },
    );
    expect(output).not.toContain("Traceback");
    expect(output).toMatch(/Dry run|Would/i);
  });

  test("caracal agent pull --harness kiro --dry-run generates Kiro config", () => {
    let agents: { id?: string; name?: string }[];
    try {
      const payload = JSON.parse(
        runCommand("caracal", ["agent", "list", "--output", "json"]),
      );
      agents = payload.items;
    } catch {
      test.skip();
      return;
    }
    if (!agents || agents.length === 0) {
      test.skip();
      return;
    }

    const agentId = agents[0].id ?? agents[0].name;
    if (!agentId) {
      test.skip();
      return;
    }
    rmSync(PULL_DIR, { recursive: true, force: true });
    mkdirSync(PULL_DIR, { recursive: true });

    try {
      const output = runCommand(
        "caracal",
        [
          "agent",
          "pull",
          agentId,
          "--harness",
          "kiro",
          "--dir",
          PULL_DIR,
          "--dry-run",
          "--no-prompt",
        ],
        { allowFailure: true },
      );
      expect(output).not.toContain("Traceback");
    } finally {
      rmSync(PULL_DIR, { recursive: true, force: true });
    }
  });

  test("caracal auth status reports healthy server", () => {
    const output = runCommand("caracal", ["auth", "status"]);
    expect(output.toLowerCase()).toMatch(/ok|healthy/);
  });

  test("caracal auth whoami returns current user", () => {
    const output = runCommand("caracal", ["auth", "whoami"]);
    expect(output).toBeTruthy();
    expect(output).not.toContain("401");
    expect(output).not.toContain("Unauthorized");
  });
});
