/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Session-scoped recovery helpers for durable Operator message runs.
*/

export interface PendingOperatorMessage {
  zoneId: string;
  conversationId: string;
  clientMessageId: string;
  correlationId: string;
  text: string;
  createdAt: number;
}

interface PendingStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

const PENDING_MESSAGE_PREFIX = "caracal.operator.pendingMessage.";
const PENDING_MESSAGE_MAX_AGE_MS = 10 * 60 * 1000;

function browserStore(): PendingStore | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage;
}

export function pendingOperatorMessageKey(zoneId: string, conversationId: string): string {
  return `${PENDING_MESSAGE_PREFIX}${zoneId}.${conversationId}`;
}

export function makePendingOperatorMessage(
  zoneId: string,
  conversationId: string,
  text: string,
  randomId: string = crypto.randomUUID(),
  now: number = Date.now(),
): PendingOperatorMessage {
  const clientMessageId = `web.${randomId}`;
  return {
    zoneId,
    conversationId,
    clientMessageId,
    correlationId: clientMessageId,
    text,
    createdAt: now,
  };
}

function validPendingMessage(
  value: unknown,
  zoneId: string,
  conversationId: string,
): value is PendingOperatorMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message.zoneId === zoneId &&
    message.conversationId === conversationId &&
    typeof message.clientMessageId === "string" &&
    typeof message.correlationId === "string" &&
    typeof message.text === "string" &&
    message.text.trim().length > 0 &&
    typeof message.createdAt === "number" &&
    Number.isFinite(message.createdAt)
  );
}

export function readPendingOperatorMessage(
  zoneId: string,
  conversationId: string,
  now: number = Date.now(),
  store: PendingStore | null = browserStore(),
): PendingOperatorMessage | null {
  if (!store) return null;
  const key = pendingOperatorMessageKey(zoneId, conversationId);
  const raw = store.getItem(key);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    store.removeItem(key);
    return null;
  }
  if (
    !validPendingMessage(parsed, zoneId, conversationId) ||
    now - parsed.createdAt > PENDING_MESSAGE_MAX_AGE_MS
  ) {
    store.removeItem(key);
    return null;
  }
  return parsed;
}

export function savePendingOperatorMessage(
  message: PendingOperatorMessage,
  store: PendingStore | null = browserStore(),
): void {
  if (!store) return;
  store.setItem(
    pendingOperatorMessageKey(message.zoneId, message.conversationId),
    JSON.stringify(message),
  );
}

export function clearPendingOperatorMessage(
  zoneId: string,
  conversationId: string,
  store: PendingStore | null = browserStore(),
): void {
  store?.removeItem(pendingOperatorMessageKey(zoneId, conversationId));
}

export function messageRunIsActive(state: string): boolean {
  return !["completed", "cancelled", "failed", "timeout"].includes(state);
}
