// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "caracal-pi-"));
process.env.HOME = home;

const caracalDir = path.join(home, ".caracal");
fs.mkdirSync(caracalDir, { recursive: true });
const sessionFile = path.join(home, "session.jsonl");
const lines = Array.from({ length: 501 }, (_, index) => JSON.stringify({ type: "message", index }));
fs.writeFileSync(sessionFile, `${lines.join("\n")}\n`);

type IngestPayload = {
  lines: string[];
  start_offset: number;
  end_byte_offsets: number[];
  final?: boolean;
};
type PiHandler = (event: Record<string, unknown>, ctx: unknown) => Promise<void> | void;
function fire(handlers: Map<string, PiHandler>, name: string, event: Record<string, unknown>, ctx: unknown) {
  const handler = handlers.get(name);
  assert(handler, `no handler for ${name}`);
  return handler(event, ctx);
}
const ingestPayloads: IngestPayload[] = [];
let serverAcknowledgedLine = -1;
let serverAcknowledgedOffset = 0;
let repairFinalOnce = false;
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url?.startsWith("/api/v1/ingest/session")) {
    assert.equal(request.headers["x-caracal-org"], "acme");
    assert.equal(request.headers["x-caracal-project"], "platform");
  }
  if (request.method === "GET" && request.url?.startsWith("/api/v1/ingest/session/checkpoint")) {
    response.end(JSON.stringify({
      session_id: "pi-session",
      harness: "pi",
      acknowledged_line: serverAcknowledgedLine,
      acknowledged_offset: serverAcknowledgedOffset,
    }));
    return;
  }
  const chunks: Buffer[] = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as IngestPayload & { hash?: string };
    if (request.url === "/api/v1/layer-snapshots") {
      response.end(JSON.stringify({ hash: payload.hash }));
      return;
    }

    ingestPayloads.push(payload);
    if (ingestPayloads.length === 2) {
      response.end(JSON.stringify({ ingested: payload.lines.length })); // HTTP success without acknowledgement.
      return;
    }
    if (repairFinalOnce && payload.final) {
      repairFinalOnce = false;
      serverAcknowledgedLine = 499;
      serverAcknowledgedOffset = ingestPayloads[0]?.end_byte_offsets.at(-1) ?? 0;
      response.end(JSON.stringify({
        acknowledged_line: serverAcknowledgedLine,
        acknowledged_offset: serverAcknowledgedOffset,
        integrity_ok: false,
        repair_from_line: 500,
      }));
      return;
    }
    if (payload.lines.length > 0) {
      serverAcknowledgedLine = payload.start_offset + payload.lines.length - 1;
      serverAcknowledgedOffset = payload.end_byte_offsets.at(-1) ?? 0;
    }
    response.end(
      JSON.stringify({
        acknowledged_line: serverAcknowledgedLine,
        acknowledged_offset: serverAcknowledgedOffset,
      }),
    );
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const address = server.address();
assert(address && typeof address === "object");
fs.writeFileSync(
  path.join(caracalDir, "config.json"),
  JSON.stringify({
    server_url: `http://127.0.0.1:${address.port}`,
    access_token: "token",
    default_org: "acme",
    default_project: "platform",
    user_id: "user",
  }),
);

const handlers = new Map<string, PiHandler>();
const pi = {
  on(name: string, handler: PiHandler) {
    handlers.set(name, handler);
  },
  registerCommand() {},
};
const extension = await import(`../extensions/caracal.ts?test=${Date.now()}`);
extension.default(pi);
const context = {
  cwd: "/project",
  hasUI: false,
  sessionManager: {
    getSessionFile: () => sessionFile,
    getSessionId: () => "pi-session",
  },
};

await fire(handlers, "session_start", { reason: "resume" }, context);
await fire(handlers, "agent_end", {}, context);

const statePath = path.join(caracalDir, "sync_state.json");
let cursor = JSON.parse(fs.readFileSync(statePath, "utf-8"))["pi-session"];
assert.equal(cursor.line_count, 500, "only the acknowledged first chunk advances");
assert(cursor.offset < fs.statSync(sessionFile).size);
const outboxDir = path.join(caracalDir, "pi_session_outbox");
let outboxFiles = fs.readdirSync(outboxDir);
assert.equal(outboxFiles.length, 1);
assert(outboxFiles[0]);
const pending = JSON.parse(fs.readFileSync(path.join(outboxDir, outboxFiles[0]), "utf-8")) as { payload: IngestPayload };
assert.equal(pending.payload.start_offset, 500);
assert.deepEqual(pending.payload.lines, [lines[500]]);

const restartedHandlers = new Map<string, PiHandler>();
const restartedPi = {
  on(name: string, handler: PiHandler) {
    restartedHandlers.set(name, handler);
  },
  registerCommand() {},
};
const restartedExtension = await import(`../extensions/caracal.ts?restart=${Date.now()}`);
restartedExtension.default(restartedPi);
await fire(restartedHandlers, "session_start", { reason: "resume" }, context);
await fire(restartedHandlers, "agent_end", {}, context);
cursor = JSON.parse(fs.readFileSync(statePath, "utf-8"))["pi-session"];
assert.equal(cursor.line_count, 501);
assert.equal(cursor.offset, fs.statSync(sessionFile).size);
outboxFiles = fs.readdirSync(outboxDir);
assert.equal(outboxFiles.length, 0);
assert.equal(ingestPayloads.length, 3);
assert.deepEqual(ingestPayloads[1], ingestPayloads[2], "retry keeps the same source identity and content");

fs.unlinkSync(statePath);
const recoveredHandlers = new Map<string, PiHandler>();
const recoveredPi = {
  on(name: string, handler: PiHandler) {
    recoveredHandlers.set(name, handler);
  },
  registerCommand() {},
};
const recoveredExtension = await import(`../extensions/caracal.ts?recover=${Date.now()}`);
recoveredExtension.default(recoveredPi);
await fire(recoveredHandlers, "session_start", { reason: "resume" }, context);
await fire(recoveredHandlers, "agent_end", {}, context);
cursor = JSON.parse(fs.readFileSync(statePath, "utf-8"))["pi-session"];
assert.equal(cursor.line_count, 501, "missing local state recovers from the server checkpoint");
assert.equal(ingestPayloads.length, 3, "checkpoint recovery avoids replaying acknowledged history");

repairFinalOnce = true;
await fire(recoveredHandlers, "session_shutdown", {}, context);
cursor = JSON.parse(fs.readFileSync(statePath, "utf-8"))["pi-session"];
assert.equal(cursor.finalized, true, "finality also requires a server acknowledgement");
const finalizer = ingestPayloads[3];
const replay = ingestPayloads[4];
assert(finalizer && replay, "finalizer and repair replay must both have been delivered");
assert.equal(finalizer.final, true);
assert.deepEqual(finalizer.lines, []);
assert.equal(replay.start_offset, 500, "repair rewinds and replays in the same finalizer");
assert.deepEqual(replay.lines, [lines[500]]);
assert.equal(replay.final, true);

await new Promise((resolve) => server.close(resolve));
fs.rmSync(home, { recursive: true, force: true });
console.log("Pi acknowledged delivery check passed");
