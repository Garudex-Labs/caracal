// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for same-origin SPA static serving: traversal protection, cache policy, and SPA fallback.

import { Writable } from "node:stream";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cacheControlFor,
  resolveStaticPath,
  serveStatic,
} from "../../../../apps/auth/src/static.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "caracal-web-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>SPA</title>");
  writeFileSync(join(root, "assets", "index-abc123.js"), "console.log(1)");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

class MockRes extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  readonly done: Promise<void>;
  constructor() {
    super();
    this.done = new Promise((resolve) => this.once("finish", () => resolve()));
  }
  setHeader(key: string, value: string): void {
    this.headers[key.toLowerCase()] = String(value);
  }
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.body += chunk.toString();
    cb();
  }
}

describe("resolveStaticPath", () => {
  it("resolves an in-root file", () => {
    const p = resolveStaticPath(root, "/assets/index-abc123.js");
    expect(p).toBe(resolve(root, "assets", "index-abc123.js"));
  });

  it("contains directory traversal within the web root", () => {
    // Normalization collapses `..` so a traversal attempt can never resolve outside the root;
    // it maps to a (non-existent) in-root path, which the server then answers with the SPA shell.
    const rootResolved = resolve(root);
    for (const attempt of [
      "/../../etc/passwd",
      "/assets/../../secret",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/..%2f..%2fsecret",
    ]) {
      const out = resolveStaticPath(root, attempt);
      expect(out === undefined || out === rootResolved || out.startsWith(rootResolved + sep)).toBe(true);
    }
  });

  it("keeps a sibling-prefix path from escaping the root", () => {
    const escaped = resolveStaticPath(root, "/" + `..${sep}` + "evil");
    expect(escaped === undefined || escaped.startsWith(resolve(root) + sep)).toBe(true);
  });
});

describe("cacheControlFor", () => {
  it("marks hashed assets immutable and the shell no-cache", () => {
    expect(cacheControlFor("/assets/index-abc123.js")).toContain("immutable");
    expect(cacheControlFor("/index.html")).toBe("no-cache");
    expect(cacheControlFor("/app/zones")).toBe("no-cache");
  });
});

describe("serveStatic", () => {
  async function serve(path: string): Promise<MockRes> {
    const res = new MockRes();
    const outcome = await serveStatic(res, root, path, "", true);
    expect(outcome.served).toBe(true);
    await res.done;
    return res;
  }

  it("serves a hashed asset with an immutable cache header and correct type", async () => {
    const res = await serve("/assets/index-abc123.js");
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.body).toContain("console.log");
  });

  it("falls back to the SPA shell for a deep client-side route", async () => {
    const res = await serve("/app/zones/123");
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.body).toContain("SPA");
  });

  it("serves the shell for the root path", async () => {
    const res = await serve("/");
    expect(res.body).toContain("SPA");
  });

  it("reports not served when the SPA shell is missing", async () => {
    rmSync(join(root, "index.html"));
    const res = new MockRes();
    const outcome = await serveStatic(res, root, "/whatever", "", true);
    expect(outcome.served).toBe(false);
  });

  it("emits HSTS only when secure", async () => {
    const secure = new MockRes();
    await serveStatic(secure, root, "/", "", true);
    await secure.done;
    expect(secure.headers["strict-transport-security"]).toContain("max-age=");
    const plain = new MockRes();
    await serveStatic(plain, root, "/", "", false);
    await plain.done;
    expect(plain.headers["strict-transport-security"]).toBeUndefined();
  });
});
