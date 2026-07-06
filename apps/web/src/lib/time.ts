/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides shared relative-time and duration formatting for console feeds.
*/

// Human-readable distance between an instant and now, phrased in the direction of time.
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "from now" : "ago";
  const mins = Math.floor(abs / 60_000);
  if (mins < 1) return diff >= 0 ? "in <1m" : "<1m ago";
  if (mins < 60) return `${mins}m ${suffix}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${suffix}`;
  const days = Math.floor(hours / 24);
  return `${days}d ${suffix}`;
}

// Human-readable span between two instants, used to show how long a session or agent
// held authority from its start to its terminal moment (or to now while it is live).
export function formatDuration(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
