/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the compact Operator error label and the session-scoped audit log it archives into.
*/
import { appLink } from "@/platform/nav/appLink";
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";

import { cx } from "@/lib/cx";
import {
  clearOperatorNotices,
  recordOperatorNotice,
  useOperatorNotices,
  type OperatorNoticeSeverity,
} from "@/platform/state/operatorNotices";

// How long a notice label rests before it auto-archives, and how long the shrink-into-audit
// animation runs. The animation duration is mirrored in the label's transition class.
const AUTO_DISMISS_MS = 6000;
const ARCHIVE_ANIM_MS = 450;
// The audit box is hidden while a label is shown; it comes up this long before the label archives
// so the label visibly shrinks into it, then lingers briefly after the label vanishes before
// hiding again. So the box only appears around the archive moment rather than persisting.
const PRE_REVEAL_MS = 2000;
const ARCHIVE_LINGER_MS = 1500;

// A discrete notice to surface, carrying its severity so the label is coloured to match. The id
// identifies the occurrence, so the same message text raised again (for example a second send while
// no provider is connected) is a new event and re-surfaces the label rather than being suppressed
// as a duplicate.
export interface OperatorNoticeEvent {
  id: string;
  severity: OperatorNoticeSeverity;
  message: string;
}

// The label palette per severity: a hard error reads destructive; a non-blocking warning reads
// amber. The archive box tints to the active severity while a label is shrinking into it.
const SEVERITY_LABEL: Record<OperatorNoticeSeverity, string> = {
  error: "border-destructive/30 bg-destructive/10 text-destructive",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-500",
};

const SEVERITY_ACCENT: Record<OperatorNoticeSeverity, string> = {
  error: "text-destructive",
  warning: "text-amber-600 dark:text-amber-500",
};

function ArchiveIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// The Operator notice surface: a compact label (not a full-width banner) that enters from the left,
// then shrinks back into the audit archive on the left after a few seconds or when dismissed. The
// archive holds every notice this session and opens a filterable log, so a transient warning or
// error is never just lost — it is recorded and reviewable.
export function OperatorErrorLog({ event }: { event: OperatorNoticeEvent | null }) {
  const log = useOperatorNotices();
  const [active, setActive] = useState<{
    id: string;
    severity: OperatorNoticeSeverity;
    message: string;
  } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [filter, setFilter] = useState("");
  // Whether the audit box is visible. It stays hidden while a label rests, comes up shortly before
  // the label archives so the label shrinks into it, lingers a moment after the label vanishes, then
  // hides again. The panel being open keeps it visible so an opened log is not yanked away.
  const [revealed, setRevealed] = useState(false);
  // The occurrence last surfaced as a label, keyed by event id so a distinct occurrence — even with
  // the same message text — reopens the label, while the same event never re-surfaces.
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!event) return;
    if (event.id === handled.current) return;
    handled.current = event.id;
    setActive({ id: event.id, severity: event.severity, message: event.message });
    setArchiving(false);
    // A new label is shown, so the audit box auto-hides behind it until just before it archives.
    setRevealed(false);
  }, [event]);

  // While a label rests: reveal the audit box shortly before it archives, then begin the
  // shrink-into-audit animation.
  useEffect(() => {
    if (!active || archiving) return;
    const reveal = setTimeout(
      () => setRevealed(true),
      Math.max(0, AUTO_DISMISS_MS - PRE_REVEAL_MS),
    );
    const archive = setTimeout(() => setArchiving(true), AUTO_DISMISS_MS);
    return () => {
      clearTimeout(reveal);
      clearTimeout(archive);
    };
  }, [active, archiving]);

  // A dismissal (the X) archives immediately, so make sure the box is revealed as the shrink target.
  useEffect(() => {
    if (archiving) setRevealed(true);
  }, [archiving]);

  // Once the animation has played, commit the label to the shared audit log and remove it. The log
  // is the shared session store, so the same record appears on the Audit page.
  useEffect(() => {
    if (!archiving || !active) return;
    const { severity, message } = active;
    const timer = setTimeout(() => {
      recordOperatorNotice(severity, message);
      setActive(null);
      setArchiving(false);
    }, ARCHIVE_ANIM_MS);
    return () => clearTimeout(timer);
  }, [archiving, active]);

  // After the label has vanished, let the box linger briefly, then hide it again — unless the log
  // panel is open, in which case it stays so the operator can keep reading.
  useEffect(() => {
    if (active || !revealed || panelOpen) return;
    const timer = setTimeout(() => setRevealed(false), ARCHIVE_LINGER_MS);
    return () => clearTimeout(timer);
  }, [active, revealed, panelOpen]);

  const boxVisible = revealed || panelOpen;
  if (!active && !boxVisible) return null;

  const filtered = log.filter((entry) =>
    entry.message.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-30 flex items-start gap-2">
      {/* The audit archive: hidden while a label rests, it appears as the label's shrink target. */}
      {boxVisible ? (
        <div className="pointer-events-auto relative flex animate-fade-in flex-col items-center">
          <button
            type="button"
            onClick={() => setPanelOpen((open) => !open)}
            aria-label="Operator audit log"
            aria-expanded={panelOpen}
            className={cx(
              "grid h-9 w-9 place-items-center rounded-lg bg-card text-muted-foreground shadow-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
              archiving && active ? SEVERITY_ACCENT[active.severity] : "",
            )}
          >
            <ArchiveIcon className="h-4 w-4" />
            {log.length > 0 ? (
              <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
                {log.length}
              </span>
            ) : null}
          </button>
          <span className="mt-0.5 text-[10px] leading-none text-muted-foreground">audit</span>

          {panelOpen ? (
            <div className="absolute left-0 top-12 z-40 w-72 rounded-lg border border-border bg-card p-2 shadow-xl">
              <div className="mb-2 flex items-center gap-2">
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter operator notices"
                  aria-label="Filter operator notices"
                  className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/25"
                />
                <button
                  type="button"
                  onClick={() => {
                    clearOperatorNotices();
                    setFilter("");
                    setPanelOpen(false);
                  }}
                  className="h-8 shrink-0 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  Clear
                </button>
              </div>
              <div className="scrollbar-thin max-h-64 overflow-y-auto">
                {filtered.length === 0 ? (
                  <p className="px-1 py-3 text-center text-xs text-muted-foreground">
                    {log.length === 0
                      ? "No operator notices this session."
                      : "No notices match the filter."}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {filtered.map((entry) => (
                      <li
                        key={entry.id}
                        className="rounded-md border border-border/70 bg-background px-2 py-1.5"
                      >
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cx(
                              "rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
                              SEVERITY_LABEL[entry.severity],
                            )}
                          >
                            {entry.severity}
                          </span>
                          <span className="text-[10px] font-mono text-muted-foreground">
                            {timeLabel(entry.at)}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs leading-relaxed text-foreground">
                          {entry.message}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <Link
                to={appLink("/audit")}
                onClick={() => setPanelOpen(false)}
                className="mt-2 block rounded-md px-1 py-1 text-center text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                Open in Audit →
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* The active notice label: compact, left-anchored, coloured by severity, with the dismiss
          control on the left. */}
      {active ? (
        <div
          role="alert"
          aria-live="polite"
          className={cx(
            "pointer-events-auto flex max-w-sm origin-left items-start gap-2 rounded-lg border py-1.5 pl-1.5 pr-2.5 shadow-sm transition-all ease-in",
            SEVERITY_LABEL[active.severity],
            archiving
              ? "-translate-x-6 scale-90 opacity-0 duration-[450ms]"
              : "translate-x-0 scale-100 opacity-100 duration-200",
          )}
        >
          <button
            type="button"
            onClick={() => setArchiving(true)}
            aria-label="Dismiss notice"
            className="mt-px shrink-0 rounded-md p-0.5 opacity-70 outline-none transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-current/40"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
          <AlertIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <p className="min-w-0 text-xs leading-relaxed">{active.message}</p>
        </div>
      ) : null}
    </div>
  );
}
