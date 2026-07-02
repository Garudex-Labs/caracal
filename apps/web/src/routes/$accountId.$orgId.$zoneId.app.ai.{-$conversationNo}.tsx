/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Caracal Operator route, the Community Edition workspace for operating the control plane in natural language.
*/
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";

import { ModulePage } from "@/components/console/ModulePage";
import { OperatorErrorLog, type OperatorNoticeEvent } from "@/components/console/OperatorErrorLog";
import { OperatorPolicyDraft } from "@/components/console/OperatorPolicyDraft";
import type { OperatorNoticeSeverity } from "@/platform/state/operatorNotices";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Response } from "@/components/ai-elements/response";
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemBadge,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import { Badge, Breadcrumbs, Button, ConfirmDialog, useToast } from "@/components/ui";
import { cx } from "@/lib/cx";
import {
  useActiveZone,
  useApplications,
  useArchiveOperatorConversation,
  useCreateOperatorConversation,
  useDecideOperatorPlan,
  useDeleteOperatorConversation,
  useExecuteOperatorPlan,
  useOperatorAiStatus,
  useOperatorContext,
  useOperatorConversations,
  useOperatorCapabilities,
  useOperatorStatus,
  useOperatorTurns,
  useRenameOperatorConversation,
  useRestoreOperatorConversation,
  useSetOperatorConversationMode,
  useSetOperatorConversationAutopilot,
  useOperatorAutopilotAvailable,
  useSendOperatorMessage,
} from "@/platform/api/hooks";
import {
  buildTimeline,
  type ErrorItem,
  type MessageItem,
  type PlanItem,
  type PlanStepView,
  type TimelineItem,
} from "@/platform/operator/timeline";
import {
  clearPendingOperatorMessage,
  makePendingOperatorMessage,
  messageRunIsActive,
  readPendingOperatorMessage,
  savePendingOperatorMessage,
  type PendingOperatorMessage,
} from "@/platform/operator/messageRuns";
import {
  deriveTitle,
  formatRelative,
  groupConversations,
  leadSuggestion,
  streamWindow,
  type SuggestionId,
} from "@/platform/operator/view";
import {
  ArchiveGlyph,
  ArrowUpGlyph,
  CheckGlyph,
  CopyGlyph,
  ExpandGlyph,
  HelpGlyph,
  KeyGlyph,
  LinkGlyph,
  OperatorGlyph,
  PanelGlyph,
  PencilGlyph,
  PlugGlyph,
  PlusGlyph,
  RestoreGlyph,
  RotateGlyph,
  ShrinkGlyph,
  StarGlyph,
  TrashGlyph,
  TrimGlyph,
  ZoneGlyph,
  type Glyph,
} from "@/components/console/OperatorGlyphs";
import { DeliberationReplay, DeliberationTrail } from "@/components/console/OperatorDeliberation";
import { PlanArtifact, PlanHistoryRow } from "@/components/console/OperatorPlan";
import {
  Composer,
  HeroComposer,
  type ComposerControls,
  type SessionUsage,
} from "@/components/console/OperatorComposer";
import type {
  OperatorConversation,
  OperatorConversationMode,
  OperatorProgressStage,
  OperatorUsageMeta,
} from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/ai/{-$conversationNo}")({
  component: CaracalOperatorPage,
});

const SUGGESTIONS: { id: SuggestionId; title: string; hint: string; icon: Glyph }[] = [
  {
    id: "registerApp",
    title: "Register an application",
    hint: "Register a managed application",
    icon: LinkGlyph,
  },
  {
    id: "connectProvider",
    title: "Connect a provider",
    hint: "Broker credentials for a resource",
    icon: PlugGlyph,
  },
  {
    id: "defineResource",
    title: "Define a resource",
    hint: "Protect an API or service",
    icon: TrimGlyph,
  },
  {
    id: "grant",
    title: "Grant access to a resource",
    hint: "Grant scoped access",
    icon: KeyGlyph,
  },
  {
    id: "rotate",
    title: "Rotate an application's credentials",
    hint: "Issue a fresh secret",
    icon: RotateGlyph,
  },
  {
    id: "explainDeny",
    title: "Why was a request denied?",
    hint: "Explain a policy decision",
    icon: HelpGlyph,
  },
];

function CaracalOperatorPage() {
  const { data: enabled, isLoading } = useOperatorStatus();

  if (enabled === true) {
    return <OperatorWorkspace />;
  }

  return (
    <ModulePage
      title="Caracal Operator"
      description="Operate your entire Caracal control plane in natural language. The Operator plans, previews, and safely applies changes through audited, guarded APIs."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Caracal Operator" }]}
      titleAccessory={
        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent-purple">
          Beta
        </span>
      }
      actions={<SecureByCaracal />}
      fill
    >
      {isLoading ? <LoadingState /> : <DisabledState />}
    </ModulePage>
  );
}

// A trust marker that reassures operators the chat runs under Caracal's brokered
// authority, sitting in the workspace header beside the full-screen control.
function SecureByCaracal() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground">
      <StarGlyph className="h-3.5 w-3.5" />
      Secure by Caracal
    </span>
  );
}

/* -------------------------------- shell -------------------------------- */

// Full-width surface that fills the remaining content height through the flex chain, so
// the workspace sits flush under the navbar and beside the utility rail rather than
// guessing a viewport offset. The negative margins cancel the Console main padding so
// the panes read as one full-bleed workspace.
const SHELL = "min-h-0 flex-1 border-t border-border -mx-5 -mt-6 -mb-6 md:-mx-8";
// The rail column tracks a CSS variable so a drag handle can resize it live, while the
// min() caps it at a quarter of the workspace width no matter how far the handle moves.
const SHELL_COLUMNS =
  "grid overflow-hidden lg:grid-cols-[minmax(0,1fr)_min(var(--rail-width),25%)]";

// Full-screen mode lifts the whole workspace out of the Console chrome to cover the
// viewport. It is portaled to the document body and sits above all console chrome, so the
// navbar, sidebars, and rails never show through.
const SHELL_FULLSCREEN =
  "fixed inset-0 z-[60] grid overflow-hidden bg-background lg:grid-cols-[minmax(0,1fr)_min(var(--rail-width),25%)]";

// The sessions rail collapse and width preferences survive reloads so the operator
// keeps the layout they chose for the workspace.
const RAIL_COLLAPSE_KEY = "caracal.operator.railCollapsed";
const RAIL_WIDTH_KEY = "caracal.operator.railWidth";
const RAIL_MIN_WIDTH = 208;
const RAIL_DEFAULT_WIDTH = 240;

// How long a send may go idle - no stage, token, or reasoning delta arriving - before its stream
// is aborted and the working state settles. Every delta resets it, so an actively streaming answer
// is never cut; it only fires on a silently stalled stream, guaranteeing the working indicator can
// never linger on a send that has quietly died.
const SEND_SETTLE_GUARD_MS = 60_000;
const RAIL_COLLAPSED_WIDTH = "2.75rem";

// How many of the most recent transcript entries the stream mounts at once. Long sessions hold
// every earlier turn but render only this tail, so scrolling stays smooth; the "show earlier"
// control widens the window one page at a time.
const STREAM_WINDOW = 40;

// Short, clean openers for the new-chat hero. One is picked fresh on every mount - each refresh and
// each new session - so the empty state greets the operator differently each time instead of
// repeating one fixed line.
const HERO_GREETINGS = [
  "What are we operating?",
  "What's the move?",
  "Where do we start?",
  "What needs doing?",
  "Ready when you are.",
  "What's on deck?",
  "Let's make a change.",
  "What can I do?",
] as const;

// The mode and autopilot chosen for the last new conversation are remembered so a fresh chat
// opens the way the operator last worked. Mode defaults to the safer read-only "ask".
const DRAFT_MODE_KEY = "caracal.operator.draftMode";
const DRAFT_AUTOPILOT_KEY = "caracal.operator.draftAutopilot";

// The last chat left open is remembered per zone in session storage so returning to the Operator -
// after a reload or a visit to another module - reopens that exact chat instead of the new-chat
// hero. Closing the browser clears it, so a fresh launch starts on the hero; starting a new chat
// clears it too, so an explicit fresh start is honoured rather than bounced back to the prior chat.
const LAST_CONVERSATION_KEY = "caracal.operator.lastConversation";

// Raised as a warning when a message is sent while no AI provider is connected. The Operator turns
// natural language into governed plans through a model, so with no provider the send cannot be
// acted on; rather than dispatch it into an upstream refusal, the send is held back and this is
// surfaced as a non-blocking warning so the operator sees why nothing happened.
const AI_DISCONNECTED_WARNING =
  "No AI provider is connected, so the Operator can't act on that. Connect a provider to continue.";

function readRailCollapsed(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(RAIL_COLLAPSE_KEY) === "1";
}

function readRailWidth(): number {
  if (typeof localStorage === "undefined") return RAIL_DEFAULT_WIDTH;
  const stored = Number(localStorage.getItem(RAIL_WIDTH_KEY));
  return Number.isFinite(stored) && stored >= RAIL_MIN_WIDTH ? stored : RAIL_DEFAULT_WIDTH;
}

function readDraftMode(): OperatorConversationMode {
  if (typeof localStorage === "undefined") return "ask";
  return localStorage.getItem(DRAFT_MODE_KEY) === "agent" ? "agent" : "ask";
}

function readDraftAutopilot(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(DRAFT_AUTOPILOT_KEY) === "1";
}

function readLastConversation(zoneId: string | null): number | null {
  if (zoneId == null || typeof sessionStorage === "undefined") return null;
  const stored = Number(sessionStorage.getItem(`${LAST_CONVERSATION_KEY}.${zoneId}`));
  return Number.isInteger(stored) && stored > 0 ? stored : null;
}

function writeLastConversation(zoneId: string | null, number: number | null): void {
  if (zoneId == null || typeof sessionStorage === "undefined") return;
  const key = `${LAST_CONVERSATION_KEY}.${zoneId}`;
  if (number == null) sessionStorage.removeItem(key);
  else sessionStorage.setItem(key, String(number));
}

/* ------------------------------ workspace ------------------------------ */

function OperatorWorkspace() {
  const { activeZone } = useActiveZone();
  const zoneId = activeZone?.id ?? null;
  const toast = useToast();

  // The selected conversation is addressed by its per-zone number in the URL, so a reload restores
  // the open chat instead of dropping back to a new one, and a bare /app/ai is the new-chat hero.
  const routeParams = Route.useParams();
  const navigate = useNavigate();
  const routeNumber = routeParams.conversationNo ? Number(routeParams.conversationNo) : null;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [heroDraft, setHeroDraft] = useState("");
  const [draftMode, setDraftMode] = useState<OperatorConversationMode>(readDraftMode);
  const [draftAutopilot, setDraftAutopilot] = useState(readDraftAutopilot);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [usageByConversation, setUsageByConversation] = useState<Record<string, SessionUsage>>({});
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(readRailCollapsed);
  const [railWidth, setRailWidth] = useState(readRailWidth);
  const [view, setView] = useState<"active" | "archived">("active");
  const [streamError, setStreamError] = useState(false);
  // The notice currently surfaced to the operator label, as a discrete event so the same message
  // raised again re-surfaces. Query and stream failures feed it through an effect; a send held back
  // because no provider is connected reports one directly.
  const [operatorNotice, setOperatorNotice] = useState<OperatorNoticeEvent | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  const conversations = useOperatorConversations(zoneId, search, view);
  const create = useCreateOperatorConversation(zoneId);
  const rename = useRenameOperatorConversation(zoneId);
  const archive = useArchiveOperatorConversation(zoneId);
  const restore = useRestoreOperatorConversation(zoneId);
  const remove = useDeleteOperatorConversation(zoneId);

  // Drive the URL from the open chat: a conversation's per-zone number addresses it, and a null
  // number is the new-chat hero at the bare route. The router is the single place the open chat is
  // recorded, so a reload reopens the same chat rather than starting over.
  const goToConversation = useCallback(
    (number: number | null, replace = false) => {
      navigate({
        to: "/$accountId/$orgId/$zoneId/app/ai/{-$conversationNo}",
        params: {
          accountId: routeParams.accountId,
          orgId: routeParams.orgId,
          zoneId: routeParams.zoneId,
          conversationNo: number == null ? undefined : String(number),
        },
        replace,
      });
    },
    [navigate, routeParams.accountId, routeParams.orgId, routeParams.zoneId],
  );

  // Select a conversation by its id: mark it open and reflect its number in the URL. Looking the
  // number up in the loaded list keeps the id the rest of the workspace uses while the URL stays
  // human-readable; a null id returns to the new-chat hero.
  const selectConversation = useCallback(
    (id: string | null) => {
      if (id == null) {
        setSelectedId(null);
        // An explicit new chat forgets the remembered one, so a later return lands on the hero
        // rather than reopening the chat the operator just left behind.
        writeLastConversation(zoneId, null);
        goToConversation(null);
        return;
      }
      setSelectedId(id);
      const conversation = (conversations.data ?? []).find((c) => c.id === id);
      goToConversation(conversation ? conversation.number : null);
    },
    [conversations.data, goToConversation, zoneId],
  );

  // Restore the open chat from the URL: when the number resolves to a loaded conversation, open it.
  // Only sets when it differs, so it reconciles a reload or a browser back/forward without fighting
  // a selection the handlers just made or clobbering a freshly created chat not yet in the list.
  useEffect(() => {
    if (routeNumber == null) return;
    const conversation = (conversations.data ?? []).find((c) => c.number === routeNumber);
    if (conversation && conversation.id !== selectedId) setSelectedId(conversation.id);
  }, [routeNumber, conversations.data, selectedId]);

  // Remember whichever chat is currently open so a return to the Operator reopens it. Only a real
  // chat is recorded; the hero leaves the memory untouched so navigating away mid-compose still
  // restores the last actual chat.
  useEffect(() => {
    if (routeNumber != null) writeLastConversation(zoneId, routeNumber);
  }, [zoneId, routeNumber]);

  // On the bare route, reopen the zone's remembered chat once its list has loaded and the chat still
  // exists, replacing the bare entry so the browser back button returns to where the operator came
  // from. An explicit new chat clears the memory, so this never fights a deliberate fresh start.
  useEffect(() => {
    if (zoneId == null || conversations.data == null || routeNumber != null) return;
    const last = readLastConversation(zoneId);
    if (last != null && conversations.data.some((c) => c.number === last)) {
      goToConversation(last, true);
    }
  }, [zoneId, conversations.data, routeNumber, goToConversation]);

  const { data: autopilotAvailable } = useOperatorAutopilotAvailable();

  // Whether the Operator has a usable model. Only a loaded status that reports no provider counts;
  // while the status is still loading a send proceeds normally so a configured deployment never
  // briefly refuses. The composer stays interactive either way — a send with no provider is held
  // back and reported in the error label rather than disabling the input.
  const aiStatus = useOperatorAiStatus(true);
  const aiUnavailable = aiStatus.data?.enabled === false;

  // Surfaces a notice to the operator label as a fresh occurrence, so an identical message raised
  // again still re-opens the label. severity colours the label and is recorded in the audit log.
  const reportNotice = useCallback((severity: OperatorNoticeSeverity, message: string) => {
    setOperatorNotice({ id: crypto.randomUUID(), severity, message });
  }, []);

  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(RAIL_COLLAPSE_KEY, railCollapsed ? "1" : "0");
    }
  }, [railCollapsed]);

  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(RAIL_WIDTH_KEY, String(Math.round(railWidth)));
    }
  }, [railWidth]);

  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(DRAFT_MODE_KEY, draftMode);
    }
  }, [draftMode]);

  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(DRAFT_AUTOPILOT_KEY, draftAutopilot ? "1" : "0");
    }
  }, [draftAutopilot]);

  // Escape leaves full-screen so the overlay never traps the operator.
  useEffect(() => {
    if (!fullscreen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setFullscreen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // Dragging the rail edge resizes its column live. The width is clamped to a usable
  // minimum and a quarter of the workspace so the chat pane always keeps three quarters
  // of the surface; the CSS min() enforces the same cap when the window itself resizes.
  const startRailResize = useCallback((event: React.PointerEvent) => {
    const shell = shellRef.current;
    if (!shell) return;
    event.preventDefault();
    const rect = shell.getBoundingClientRect();
    const max = rect.width / 4;
    function onMove(move: PointerEvent) {
      const next = Math.min(Math.max(rect.right - move.clientX, RAIL_MIN_WIDTH), max);
      setRailWidth(next);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  // The active query or stream failure as a message, or null when none. It feeds the operator
  // error label through an effect so each distinct failure surfaces as its own occurrence.
  const errorMessage = useMemo(() => {
    if (conversations.isError) {
      return "Your sessions could not be loaded. Check your connection and try again.";
    }
    if (create.isError) {
      return "That session could not be started. Confirm an AI provider is reachable and try again.";
    }
    if (streamError) {
      return "That request could not be processed. Confirm an AI provider is reachable and try again.";
    }
    return null;
  }, [conversations.isError, create.isError, streamError]);

  useEffect(() => {
    if (errorMessage) reportNotice("error", errorMessage);
  }, [errorMessage, reportNotice]);

  // Accumulate the real token usage reported by each answered message so the rail can
  // show genuine context consumption for the session rather than an estimate.
  function recordUsage(conversationId: string, meta: OperatorUsageMeta) {
    const usage = meta.usage;
    if (!usage) return;
    setUsageByConversation((current) => {
      const prior = current[conversationId];
      return {
        ...current,
        [conversationId]: {
          inputTokens: (prior?.inputTokens ?? 0) + usage.input_tokens,
          outputTokens: (prior?.outputTokens ?? 0) + usage.output_tokens,
          model: meta.model ?? prior?.model ?? null,
          maxTokens: meta.max_tokens ?? prior?.maxTokens ?? 0,
          failover: meta.failover === true || (prior?.failover ?? false),
        },
      };
    });
  }

  // Starting from intent: derive a session title from the message, create the session, then hand
  // the message to the stream to send as the opening turn. With no AI provider the request could
  // only be refused upstream, so the send is held back — no session is created — and the reason is
  // surfaced as a warning instead.
  function startFromIntent(text: string) {
    const value = text.trim();
    if (!value || create.isPending) return;
    if (aiUnavailable) {
      reportNotice("warning", AI_DISCONNECTED_WARNING);
      return;
    }
    setPendingMessage(value);
    setHeroDraft("");
    create.mutate(
      {
        title: deriveTitle(value),
        mode: draftMode,
        autopilot: draftMode === "agent" && draftAutopilot,
      },
      {
        onSuccess: (conversation) => {
          setSelectedId(conversation.id);
          goToConversation(conversation.number);
        },
        onError: () => setPendingMessage(null),
      },
    );
  }

  // Rename a session in place. The empty case is ignored so a cleared field never
  // wipes the title; failures surface a toast rather than silently reverting.
  function renameSession(id: string, title: string) {
    const name = title.trim();
    if (!name) return;
    rename.mutate(
      { id, title: name },
      { onError: () => toast({ tone: "error", title: "Rename failed" }) },
    );
  }

  // Archive removes a session from the active list. When the archived session is the
  // open one the stream returns to the hero so the workspace never points at a hidden
  // conversation.
  function archiveSession(id: string) {
    archive.mutate(id, {
      onSuccess: (conversation) => {
        if (selectedId === id) selectConversation(null);
        toast({ tone: "info", title: "Session archived", description: conversation.title });
      },
      onError: () => toast({ tone: "error", title: "Archive failed" }),
    });
  }

  // Restore returns an archived session to the active list so a chat can be picked up
  // again where it left off.
  function restoreSession(id: string) {
    restore.mutate(id, {
      onSuccess: (conversation) => {
        toast({ tone: "success", title: "Session restored", description: conversation.title });
      },
      onError: () => toast({ tone: "error", title: "Restore failed" }),
    });
  }

  // Delete is permanent: it drops the conversation and its whole turn ledger. The open
  // session falls back to the hero when it is the one removed.
  function deleteSession(id: string) {
    remove.mutate(id, {
      onSuccess: () => {
        if (selectedId === id) selectConversation(null);
        toast({ tone: "info", title: "Session deleted" });
      },
      onError: () => toast({ tone: "error", title: "Delete failed" }),
    });
  }

  if (!activeZone) {
    return <NoZoneState />;
  }

  const workspace = (
    <div
      ref={shellRef}
      className={cx(fullscreen ? SHELL_FULLSCREEN : cx(SHELL, SHELL_COLUMNS))}
      style={
        {
          "--rail-width": railCollapsed ? RAIL_COLLAPSED_WIDTH : `${railWidth}px`,
        } as CSSProperties
      }
    >
      <section className="relative flex min-h-0 min-w-0 flex-col bg-background">
        {/* A thin header bar above the chat that carries the workspace breadcrumb, the trust
            marker, and the full-screen toggle on one row, so the tall module header is reclaimed
            for the chat. In full screen the Caracal logo replaces the breadcrumb on the left.
            Large screens only, matching where the full-screen control is shown. */}
        <div className="hidden flex-shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1.5 lg:flex">
          {fullscreen ? (
            <div className="flex flex-shrink-0 items-center">
              <img
                src="/caracal_light.png"
                alt="Caracal"
                className="h-auto w-28 select-none dark:hidden"
              />
              <img
                src="/caracal_dark.png"
                alt="Caracal"
                className="hidden h-auto w-28 select-none dark:block"
              />
            </div>
          ) : (
            <div className="flex min-w-0 flex-shrink-0 items-center gap-2">
              <Breadcrumbs
                items={[{ label: "Console", to: "/app" }, { label: "Caracal Operator" }]}
              />
              <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent-purple">
                Beta
              </span>
            </div>
          )}
          <div className="mr-auto min-w-0">
            <OperatorErrorLog event={operatorNotice} />
          </div>
          <SecureByCaracal />
          <button
            type="button"
            onClick={() => setFullscreen((value) => !value)}
            aria-pressed={fullscreen}
            aria-label={fullscreen ? "Exit full screen" : "Full screen chat"}
            title={fullscreen ? "Exit full screen" : "Full screen chat"}
            className="grid h-8 w-8 place-items-center rounded-md border border-border bg-card/80 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {fullscreen ? <ShrinkGlyph className="h-4 w-4" /> : <ExpandGlyph className="h-4 w-4" />}
          </button>
        </div>
        <SessionStrip
          conversations={conversations.data ?? []}
          selectedId={selectedId}
          onSelect={selectConversation}
          onCreate={() => selectConversation(null)}
        />
        {selectedId ? (
          <ActivityStream
            key={selectedId}
            zoneId={zoneId}
            conversationId={selectedId}
            mode={(conversations.data ?? []).find((c) => c.id === selectedId)?.mode ?? "agent"}
            autopilot={
              (conversations.data ?? []).find((c) => c.id === selectedId)?.autopilot ?? false
            }
            initialMessage={pendingMessage}
            onInitialConsumed={() => setPendingMessage(null)}
            onUsage={(meta) => recordUsage(selectedId, meta)}
            onError={setStreamError}
            usage={usageByConversation[selectedId]}
            model={selectedModel}
            onModelChange={setSelectedModel}
            aiUnavailable={aiUnavailable}
            onBlockedSend={() => reportNotice("warning", AI_DISCONNECTED_WARNING)}
            onNotice={reportNotice}
          />
        ) : (
          <NewChatHero
            value={heroDraft}
            onChange={setHeroDraft}
            onSubmit={() => startFromIntent(heroDraft)}
            onPick={(text) => startFromIntent(text)}
            pending={create.isPending}
            zoneId={zoneId}
            model={selectedModel}
            onModelChange={setSelectedModel}
            controls={{
              mode: draftMode,
              onModeChange: setDraftMode,
              modePending: false,
              autopilot: draftAutopilot,
              onAutopilotChange: setDraftAutopilot,
              autopilotPending: false,
              autopilotAvailable: autopilotAvailable ?? false,
            }}
          />
        )}
      </section>
      <SessionsRail
        conversations={conversations.data ?? []}
        loading={conversations.isLoading}
        search={search}
        onSearch={setSearch}
        selectedId={selectedId}
        onSelect={selectConversation}
        onCreate={() => selectConversation(null)}
        onRename={renameSession}
        onArchive={archiveSession}
        onRestore={restoreSession}
        onDelete={deleteSession}
        view={view}
        onChangeView={setView}
        collapsed={railCollapsed}
        onToggleCollapse={() => setRailCollapsed((value) => !value)}
        onResizeStart={startRailResize}
      />
    </div>
  );

  // In full screen the workspace is portaled to the document body so it escapes the
  // Console layout entirely and reliably covers the navbar, sidebar, and utility rail.
  return fullscreen && typeof document !== "undefined"
    ? createPortal(workspace, document.body)
    : workspace;
}

/* ------------------------------- sessions ------------------------------ */

function SessionsRail({
  conversations,
  loading,
  search,
  onSearch,
  selectedId,
  onSelect,
  onCreate,
  onRename,
  onArchive,
  onRestore,
  onDelete,
  view,
  onChangeView,
  collapsed,
  onToggleCollapse,
  onResizeStart,
}: {
  conversations: OperatorConversation[];
  loading: boolean;
  search: string;
  onSearch: (value: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  view: "active" | "archived";
  onChangeView: (view: "active" | "archived") => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onResizeStart: (event: React.PointerEvent) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<OperatorConversation | null>(null);

  const groups = useMemo(() => groupConversations(conversations), [conversations]);
  const archived = view === "archived";

  function startRename(conversation: OperatorConversation) {
    setEditingId(conversation.id);
    setEditDraft(conversation.title);
  }

  function commitRename() {
    if (editingId === null) return;
    const id = editingId;
    const title = editDraft.trim();
    setEditingId(null);
    if (title) onRename(id, title);
  }

  // Collapsed rail: a slim column with just the controls needed to reopen the panel or
  // start a session, so the chat reclaims the width without losing the entry points.
  if (collapsed) {
    return (
      <div className="hidden min-h-0 flex-col items-center gap-1 border-l border-border bg-card py-2.5 lg:flex">
        <button
          onClick={onToggleCollapse}
          aria-label="Expand sessions"
          title="Expand sessions"
          className="grid h-8 w-8 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelGlyph className="h-4 w-4" />
        </button>
        <button
          onClick={onCreate}
          aria-label="New session"
          title="New session"
          className="grid h-8 w-8 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PlusGlyph className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative hidden min-h-0 flex-col border-l border-border bg-card lg:flex">
      <div
        onPointerDown={onResizeStart}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sessions"
        className="absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize bg-transparent transition-colors hover:bg-accent-purple/40"
      />
      <div className="flex flex-shrink-0 items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={onToggleCollapse}
            aria-label="Collapse sessions"
            title="Collapse sessions"
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PanelGlyph className="h-4 w-4" />
          </button>
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {archived ? "Archived" : "Sessions"}
          </span>
        </div>
        {archived ? null : (
          <button
            onClick={onCreate}
            aria-label="New session"
            title="New session"
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PlusGlyph className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex flex-shrink-0 items-center gap-1.5 px-3 pb-2">
        <input
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder={archived ? "Search archived" : "Search"}
          aria-label="Search operator sessions"
          className="h-8 min-w-0 flex-1 border border-input bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        />
        <button
          onClick={() => onChangeView(archived ? "active" : "archived")}
          aria-pressed={archived}
          aria-label={archived ? "Show active sessions" : "Show archived sessions"}
          title={archived ? "Back to active sessions" : "Archived sessions"}
          className={cx(
            "grid h-8 w-8 flex-shrink-0 place-items-center rounded border transition-colors",
            archived
              ? "border-accent bg-accent text-foreground"
              : "border-input text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <ArchiveGlyph className="h-4 w-4" />
        </button>
      </div>

      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {loading ? (
          <SessionSkeleton />
        ) : conversations.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            {search.trim()
              ? "No sessions match."
              : archived
                ? "No archived sessions."
                : "No sessions yet."}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              <p className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                {group.label}
              </p>
              {group.items.map((conversation) => {
                const selected = conversation.id === selectedId;
                if (conversation.id === editingId) {
                  return (
                    <div key={conversation.id} className="px-0.5">
                      <input
                        autoFocus
                        value={editDraft}
                        onChange={(event) => setEditDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") commitRename();
                          if (event.key === "Escape") setEditingId(null);
                        }}
                        onBlur={commitRename}
                        aria-label="Rename session"
                        className="h-8 w-full border border-input bg-background px-2.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                      />
                    </div>
                  );
                }
                return (
                  <div
                    key={conversation.id}
                    className={cx(
                      "group/session relative flex items-center transition-colors",
                      selected ? "bg-accent" : "hover:bg-accent/50",
                    )}
                  >
                    <button
                      onClick={() => onSelect(conversation.id)}
                      aria-pressed={selected}
                      className="flex min-w-0 flex-1 flex-col items-start gap-0.5 py-2 pl-2.5 pr-14 text-left"
                    >
                      <span
                        className={cx(
                          "w-full truncate text-xs font-medium",
                          selected ? "text-foreground" : "text-foreground/90",
                        )}
                      >
                        {conversation.title}
                      </span>
                      <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span
                          className={cx(
                            "uppercase tracking-wide",
                            conversation.mode === "ask"
                              ? "text-muted-foreground"
                              : "text-foreground/70",
                          )}
                        >
                          {conversation.mode}
                        </span>
                        {conversation.mode === "agent" && conversation.autopilot ? (
                          <span className="text-accent-purple">· autopilot</span>
                        ) : null}
                        <span>· {formatRelative(conversation.last_activity_at)}</span>
                      </span>
                    </button>
                    <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/session:opacity-100">
                      {archived ? (
                        <button
                          onClick={() => onRestore(conversation.id)}
                          aria-label="Restore session"
                          title="Restore"
                          className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                        >
                          <RestoreGlyph className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() => startRename(conversation)}
                            aria-label="Rename session"
                            title="Rename"
                            className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                          >
                            <PencilGlyph className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => onArchive(conversation.id)}
                            aria-label="Archive session"
                            title="Archive"
                            className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                          >
                            <ArchiveGlyph className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => setPendingDelete(conversation)}
                        aria-label="Delete session"
                        title="Delete"
                        className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-destructive"
                      >
                        <TrashGlyph className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) onDelete(pendingDelete.id);
          setPendingDelete(null);
        }}
        title="Delete session?"
        description={
          pendingDelete
            ? `"${pendingDelete.title}" and its full history will be permanently removed. This cannot be undone.`
            : ""
        }
        confirmLabel="Delete"
        tone="danger"
      />
    </div>
  );
}

// Session group label for the date-bucketed history, oldest bucket last.
// Horizontal session switcher shown only below the sessions rail breakpoint.
function SessionStrip({
  conversations,
  selectedId,
  onSelect,
  onCreate,
}: {
  conversations: OperatorConversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-border bg-card px-2 py-1.5 lg:hidden">
      <button
        onClick={onCreate}
        className="inline-flex flex-shrink-0 items-center gap-1 border border-border bg-background px-2 py-1 text-xs font-medium text-foreground"
      >
        <PlusGlyph className="h-3.5 w-3.5" /> New
      </button>
      <div className="scrollbar-thin flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {conversations.map((conversation) => {
          const selected = conversation.id === selectedId;
          return (
            <button
              key={conversation.id}
              onClick={() => onSelect(conversation.id)}
              aria-pressed={selected}
              className={cx(
                "max-w-[10rem] flex-shrink-0 truncate border px-2 py-1 text-xs",
                selected
                  ? "border-foreground bg-accent text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {conversation.title}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------------- activity stream --------------------------- */

function ActivityStream({
  zoneId,
  conversationId,
  mode,
  autopilot,
  initialMessage,
  onInitialConsumed,
  onUsage,
  onError,
  usage,
  model,
  onModelChange,
  aiUnavailable,
  onBlockedSend,
  onNotice,
}: {
  zoneId: string | null;
  conversationId: string;
  mode: OperatorConversationMode;
  autopilot: boolean;
  initialMessage?: string | null;
  onInitialConsumed?: () => void;
  onUsage?: (meta: OperatorUsageMeta) => void;
  onError?: (active: boolean) => void;
  usage?: SessionUsage;
  model: string | null;
  onModelChange: (id: string | null) => void;
  aiUnavailable: boolean;
  onBlockedSend?: () => void;
  onNotice?: (severity: OperatorNoticeSeverity, message: string) => void;
}) {
  const { data: turns, isLoading } = useOperatorTurns(zoneId, conversationId);
  const send = useSendOperatorMessage(zoneId, conversationId);
  const setMode = useSetOperatorConversationMode(zoneId);
  const setAutopilot = useSetOperatorConversationAutopilot(zoneId);
  const { data: autopilotAvailable } = useOperatorAutopilotAvailable();
  const [message, setMessage] = useState("");
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  // The message currently in flight, echoed in the transcript the instant it is sent so the
  // operator's own words never disappear into the round trip. It clears when the send settles and
  // the authoritative turn arrives from the ledger.
  const [inFlight, setInFlight] = useState<PendingOperatorMessage | null>(null);
  // The ordered deliberation stages streamed back while a send is in flight, so the operator
  // watches the Operator reason - triage, read state, plan, review - rather than a blank spinner.
  // Consecutive repeats of a stage are collapsed; the list resets at the start of each send.
  const [stages, setStages] = useState<OperatorProgressStage[]>([]);
  // The answer text accumulated from token deltas while a read or conversational send is in flight,
  // so the operator watches the answer typed out rather than waiting for it to appear all at once.
  // It resets at the start of each send and clears when the authoritative turn arrives.
  const [streamedAnswer, setStreamedAnswer] = useState("");
  // The model's chain of thought accumulated from reasoning deltas while a send is in flight, so a
  // reasoning model's thinking is shown live rather than a blank wait before the answer begins. It
  // resets at the start of each send and clears when the authoritative turn arrives.
  const [streamedReasoning, setStreamedReasoning] = useState("");

  const { items, latestPlan } = useMemo(() => buildTimeline(turns ?? []), [turns]);

  // The tool calls each Operator answer is responsible for, so copying the answer can carry the
  // actions it took. Walking the exchange - the steps of every plan since the last user turn - and
  // pinning them to that turn's Operator replies keeps the copy self-contained without threading the
  // plan through the render.
  const toolCallsByMessage = useMemo(() => collectExchangeToolCalls(items), [items]);

  // This conversation's own prompts, oldest to newest, so the composer can recall them with the
  // up and down arrows without reaching into any other chat's history.
  const promptHistory = useMemo(
    () =>
      items.reduce<string[]>((acc, it) => {
        if (it.kind === "message" && it.role === "user") acc.push(it.text);
        return acc;
      }, []),
    [items],
  );

  // Render only the most recent window of the transcript; long sessions keep every earlier turn
  // but mount this tail so scrolling stays smooth. The window always covers the newest turns -
  // including any actionable plan - because it is taken from the end.
  const [visibleCount, setVisibleCount] = useState(STREAM_WINDOW);
  useEffect(() => setVisibleCount(STREAM_WINDOW), [conversationId]);
  // Errors are surfaced to the transient notice label and the audit log, never stacked in the
  // transcript, so the stream renders only messages and plans.
  const streamItems = useMemo(
    () => items.filter((it): it is MessageItem | PlanItem => it.kind !== "error"),
    [items],
  );
  const visibleItems = useMemo(
    () => streamWindow(streamItems, visibleCount),
    [streamItems, visibleCount],
  );
  const hiddenCount = streamItems.length - visibleItems.length;

  // Execution and system failures are recorded as error turns in the ledger, but they belong with
  // every other notice in the transient label and the audit log - not as a standing block in the
  // transcript. New error turns surface as they arrive; those already present when the conversation
  // loads are treated as history, so reopening a chat never re-flashes a past failure.
  const surfacedErrors = useRef<Set<string>>(new Set());
  const errorsSeeded = useRef(false);
  useEffect(() => {
    if (turns == null) return;
    const errorItems = items.filter((it): it is ErrorItem => it.kind === "error");
    if (!errorsSeeded.current) {
      for (const err of errorItems) surfacedErrors.current.add(err.id);
      errorsSeeded.current = true;
      return;
    }
    for (const err of errorItems) {
      if (surfacedErrors.current.has(err.id)) continue;
      surfacedErrors.current.add(err.id);
      onNotice?.("error", err.message);
    }
  }, [turns, items, onNotice]);

  // Keep the transcript pinned to the newest message only while the operator is already reading
  // the bottom. Once they scroll up to review earlier turns the stream stops yanking them back,
  // and the snap is instant so streaming updates land without flicker or mid-message jumps.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // True from the instant a send is dispatched until it settles. Guards every send path against
  // overlapping the same conversation, independent of the mutation's render-lagged isPending.
  const sending = useRef(false);
  // The controller for the request currently in flight, so a stalled stream can be aborted at the
  // source rather than only clearing the indicator while the fetch leaks on in the background.
  const sendAbort = useRef<AbortController | null>(null);
  // The idle guard for the send in flight: it aborts the stream when no stage, token, or reasoning
  // delta has arrived within the guard window, so a silently stalled stream can never leave the
  // working indicator spinning. Each delta rearms it, so an actively streaming answer is never cut.
  const sendGuard = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Distance from the bottom captured just before earlier turns are revealed, so the viewport can
  // be restored to the same place after the taller list paints instead of jumping.
  const pendingReveal = useRef<number | null>(null);
  const onStreamScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
  }, []);
  useEffect(() => {
    if (!stickToBottom.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleItems, send.isPending, stages, inFlight, streamedAnswer, streamedReasoning]);

  // Reveal an earlier page of turns, holding the operator's place: the distance from the bottom is
  // captured before the window widens and restored once the taller list has painted.
  const showEarlier = useCallback(() => {
    const el = scrollRef.current;
    pendingReveal.current = el ? el.scrollHeight - el.scrollTop : null;
    stickToBottom.current = false;
    setVisibleCount((count) => Math.min(items.length, count + STREAM_WINDOW));
  }, [items.length]);
  useLayoutEffect(() => {
    if (pendingReveal.current === null) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight - pendingReveal.current;
    pendingReveal.current = null;
  }, [visibleItems]);

  function dispatch(text: string, existing?: PendingOperatorMessage) {
    // The mutation's own isPending flips a render late, so this synchronous flag is what actually
    // prevents a second send - a re-fired opening intent or a doubled queue drain - from racing the
    // first into the same conversation, which the server serializes and which leaves the stream
    // stuck on the working indicator. It clears the moment the send settles.
    if (sending.current || !zoneId) return;
    const pending = existing ?? makePendingOperatorMessage(zoneId, conversationId, text);
    sending.current = true;
    savePendingOperatorMessage(pending);
    setInFlight(pending);
    setStages([]);
    setStreamedAnswer("");
    setStreamedReasoning("");
    const controller = new AbortController();
    sendAbort.current = controller;
    // Arm the idle guard and rearm it on every delta below: a stream that keeps producing is never
    // cut, but one that goes silent past the window is aborted so the working indicator settles.
    const armGuard = () => {
      if (sendGuard.current) clearTimeout(sendGuard.current);
      sendGuard.current = setTimeout(() => controller.abort(), SEND_SETTLE_GUARD_MS);
    };
    armGuard();
    send.mutate(
      {
        message: text,
        provider: model ?? undefined,
        clientMessageId: pending.clientMessageId,
        correlationId: pending.correlationId,
        signal: controller.signal,
        onStage: (stage) => {
          armGuard();
          setStages((prev) => (prev[prev.length - 1] === stage ? prev : [...prev, stage]));
        },
        onToken: (chunk) => {
          armGuard();
          setStreamedAnswer((prev) => prev + chunk);
        },
        onReasoning: (chunk) => {
          armGuard();
          setStreamedReasoning((prev) => prev + chunk);
        },
      },
      {
        onSuccess: (result) => {
          if (
            result.usage ||
            result.model ||
            result.provider ||
            result.max_tokens ||
            result.failover ||
            result.tier
          ) {
            onUsage?.(result);
          }
          if (result.message_run) {
            // The server durably recorded this message run, so the refreshed ledger already shows
            // the turn and any plan awaiting approval. The pending marker has done its job and must
            // be cleared for every recorded state, otherwise recovery replays it on each mount. Only
            // a terminal failure needs to be surfaced, since that outcome is not visible in the plan.
            if (
              !messageRunIsActive(result.message_run.state) &&
              result.message_run.state !== "completed"
            ) {
              onNotice?.(
                "error",
                result.message_run.error_detail ??
                  result.message_run.error_code ??
                  "The previous message did not complete.",
              );
            }
          }
          clearPendingOperatorMessage(pending.zoneId, pending.conversationId);
        },
        onError: (err) => {
          if (!(err instanceof Error) || err.name !== "AbortError")
            clearPendingOperatorMessage(pending.zoneId, pending.conversationId);
        },
        onSettled: () => {
          if (sendGuard.current) {
            clearTimeout(sendGuard.current);
            sendGuard.current = null;
          }
          sending.current = false;
          sendAbort.current = null;
          setInFlight(null);
          setStages([]);
          setStreamedAnswer("");
          setStreamedReasoning("");
        },
      },
    );
  }

  // Queue a message when the Operator is busy or earlier messages are still waiting, so a
  // sequence of instructions can be lined up and sent in order; otherwise send it now. With no AI
  // provider the request could only be refused upstream, so the send is held back — not sent or
  // queued — and reported in the error label so the operator sees why nothing happened.
  function submit(text: string) {
    const value = text.trim();
    if (!value) return;
    if (aiUnavailable) {
      onBlockedSend?.();
      return;
    }
    setMessage("");
    stickToBottom.current = true;
    if (sending.current || send.isPending || queued.length > 0) {
      setQueued((prev) => [...prev, { id: crypto.randomUUID(), text: value }]);
      return;
    }
    dispatch(value);
  }

  function removeQueued(id: string) {
    setQueued((prev) => prev.filter((item) => item.id !== id));
  }

  // Send a queued message ahead of the rest: dispatch it now when the Operator is free,
  // otherwise move it to the front so it drains next.
  function sendQueuedNow(id: string) {
    if (!sending.current && !send.isPending) {
      const target = queued.find((item) => item.id === id);
      if (!target) return;
      setQueued((prev) => prev.filter((item) => item.id !== id));
      dispatch(target.text);
      return;
    }
    setQueued((prev) => {
      const target = prev.find((item) => item.id === id);
      if (!target) return prev;
      return [target, ...prev.filter((item) => item.id !== id)];
    });
  }

  // Drain the queue in order: once the Operator is free, send the next queued message.
  useEffect(() => {
    if (sending.current || send.isPending || queued.length === 0) return;
    const next = queued[0];
    setQueued((prev) => prev.slice(1));
    dispatch(next.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send.isPending, queued]);

  // Send the opening intent once when the session was started from the hero. It dispatches
  // directly rather than through submit: the opening message is always the first turn, so it must
  // never take the queue branch and leave a phantom copy to drain later. The dispatch is deferred
  // a tick so it lands after the mount/cleanup/mount commit settles; arming it synchronously would
  // let the unmount-abort cleanup cancel the send's controller before the request is ever sent,
  // stranding the first turn on the working indicator with nothing in flight.
  const openingSent = useRef(false);
  useEffect(() => {
    if (!initialMessage || openingSent.current) return;
    const timer = window.setTimeout(() => {
      openingSent.current = true;
      stickToBottom.current = true;
      dispatch(initialMessage);
      onInitialConsumed?.();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage]);

  const recoveredPendingKey = useRef<string | null>(null);
  useEffect(() => {
    if (!zoneId || initialMessage || sending.current || send.isPending) return;
    const pending = readPendingOperatorMessage(zoneId, conversationId);
    if (!pending) return;
    const key = pending.clientMessageId;
    if (recoveredPendingKey.current === key) return;
    recoveredPendingKey.current = key;
    const timer = window.setTimeout(() => {
      stickToBottom.current = true;
      dispatch(pending.text, pending);
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneId, conversationId, initialMessage, send.isPending]);

  // Surface a failed send through the workspace error banner and clear it when the
  // stream unmounts so a stale failure never lingers on another session.
  useEffect(() => {
    onError?.(send.isError);
    return () => onError?.(false);
  }, [send.isError, onError]);

  // Abort any in-flight send when the stream unmounts - switching conversations or leaving the
  // workspace - so a request never streams on against a pane that is gone. The idle guard armed in
  // dispatch handles a stream that stalls while the pane is still open.
  useEffect(() => {
    return () => {
      sendAbort.current?.abort();
      if (sendGuard.current) clearTimeout(sendGuard.current);
    };
  }, []);

  const empty = !isLoading && items.length === 0 && !send.isPending && !initialMessage;

  // The mode and approval controls now live inside the composer itself - the mode dropdown
  // next to the model selector, the approval dropdown flush below the box - so they are always
  // visible and adjustable, including before the first message is sent. Both patch the live
  // conversation.
  const controls: ComposerControls = {
    mode,
    onModeChange: (next) => setMode.mutate({ id: conversationId, mode: next }),
    modePending: setMode.isPending,
    autopilot,
    onAutopilotChange: (next) => setAutopilot.mutate({ id: conversationId, autopilot: next }),
    autopilotPending: setAutopilot.isPending,
    autopilotAvailable: autopilotAvailable ?? false,
  };

  if (empty) {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <MemoryStrip zoneId={zoneId} conversationId={conversationId} />
        <NewChatHero
          value={message}
          onChange={setMessage}
          onSubmit={() => submit(message)}
          onPick={(text) => submit(text)}
          pending={send.isPending}
          zoneId={zoneId}
          model={model}
          onModelChange={onModelChange}
          controls={controls}
        />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <MemoryStrip zoneId={zoneId} conversationId={conversationId} />

      <div
        ref={scrollRef}
        onScroll={onStreamScroll}
        className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-2.5 overflow-x-hidden overflow-y-auto px-4 py-4"
      >
        {isLoading ? (
          <StreamSkeleton />
        ) : (
          <>
            {hiddenCount > 0 ? (
              <button
                type="button"
                onClick={showEarlier}
                className="mx-auto rounded-full border border-border bg-muted px-3 py-1 text-[11px] text-muted-foreground transition hover:text-foreground"
              >
                Show earlier messages ({hiddenCount})
              </button>
            ) : null}
            {visibleItems.map((item, index) => (
              <StreamEntry
                key={item.id}
                item={item}
                zoneId={zoneId}
                conversationId={conversationId}
                actionable={latestPlan?.id === item.id}
                toolCalls={toolCallsByMessage.get(item.id) ?? EMPTY_TOOL_CALLS}
                showAvatar={
                  !isUserItem(item) && (index === 0 || isUserItem(visibleItems[index - 1]))
                }
              />
            ))}
          </>
        )}

        {send.isPending && inFlight ? (
          <div className="flex justify-end">
            <p className="wrap-anywhere min-w-0 max-w-[82%] rounded-2xl border border-border bg-muted px-3 py-2 text-sm whitespace-pre-wrap text-foreground opacity-60">
              {inFlight.text}
            </p>
          </div>
        ) : null}

        {send.isPending && (streamedReasoning || streamedAnswer) ? (
          <div className="group flex items-start gap-2">
            <img
              src="/chatbot.png"
              alt="Caracal Operator"
              className="h-8 w-8 shrink-0 select-none object-contain"
            />
            <div className="mt-1.5 flex min-w-0 max-w-[82%] flex-col gap-1.5">
              {streamedReasoning ? (
                <Reasoning isStreaming={!streamedAnswer}>
                  <ReasoningTrigger />
                  <ReasoningContent>{streamedReasoning}</ReasoningContent>
                </Reasoning>
              ) : null}
              {streamedAnswer ? <Response>{streamedAnswer}</Response> : null}
            </div>
          </div>
        ) : send.isPending ? (
          <DeliberationTrail stages={stages} seed={items.length} />
        ) : null}
      </div>

      <OperatorQueue
        queued={queued}
        plan={latestPlan}
        onRemove={removeQueued}
        onSendNow={sendQueuedNow}
      />

      <Composer
        value={message}
        onChange={setMessage}
        onSubmit={() => submit(message)}
        pending={send.isPending}
        usage={usage}
        model={model}
        onModelChange={onModelChange}
        controls={controls}
        history={promptHistory}
      />
    </div>
  );
}

/* -------------------------------- queue -------------------------------- */

interface QueuedMessage {
  id: string;
  text: string;
}

// A pinned queue above the composer: outbound messages waiting to send in order, and the
// live checklist of the active plan's steps so progress stays in view while the stream
// scrolls. Queued items are local until sent through the same guarded send API; plan steps
// reflect backend execution state.
function OperatorQueue({
  queued,
  plan,
  onRemove,
  onSendNow,
}: {
  queued: QueuedMessage[];
  plan: PlanItem | null;
  onRemove: (id: string) => void;
  onSendNow: (id: string) => void;
}) {
  const planSteps = plan && plan.decision !== "rejected" && !plan.executed ? plan.steps : [];
  const hasQueued = queued.length > 0;
  const hasTodo = planSteps.length > 0;
  if (!hasQueued && !hasTodo) return null;

  return (
    <div className="scrollbar-thin flex max-h-[40%] flex-shrink-0 flex-col overflow-y-auto border-t border-border bg-card">
      <Queue>
        {hasQueued ? (
          <QueueSection>
            <QueueSectionTrigger>
              <QueueSectionLabel count={queued.length} label="Queued" />
            </QueueSectionTrigger>
            <QueueSectionContent>
              <QueueList>
                {queued.map((item) => (
                  <QueueItem key={item.id}>
                    <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent-purple" />
                    <QueueItemContent>{item.text}</QueueItemContent>
                    <QueueItemActions>
                      <QueueItemAction
                        aria-label="Send now"
                        title="Send now"
                        onClick={() => onSendNow(item.id)}
                      >
                        <ArrowUpGlyph className="h-3.5 w-3.5" />
                      </QueueItemAction>
                      <QueueItemAction
                        aria-label="Remove from queue"
                        title="Remove from queue"
                        onClick={() => onRemove(item.id)}
                      >
                        <TrashGlyph className="h-3.5 w-3.5" />
                      </QueueItemAction>
                    </QueueItemActions>
                  </QueueItem>
                ))}
              </QueueList>
            </QueueSectionContent>
          </QueueSection>
        ) : null}
        {hasTodo ? (
          <QueueSection>
            <QueueSectionTrigger>
              <QueueSectionLabel count={planSteps.length} label="Plan steps" />
            </QueueSectionTrigger>
            <QueueSectionContent>
              <QueueList>
                {planSteps.map((step) => (
                  <QueueItem key={step.id}>
                    <QueueItemIndicator
                      completed={step.status === "succeeded"}
                      failed={step.status === "failed"}
                    />
                    <QueueItemContent completed={step.status === "succeeded"}>
                      {step.summary}
                    </QueueItemContent>
                    {step.mutating ? <QueueItemBadge>changes</QueueItemBadge> : null}
                  </QueueItem>
                ))}
              </QueueList>
            </QueueSectionContent>
          </QueueSection>
        ) : null}
      </Queue>
    </div>
  );
}

// The new-conversation entry point: a centered prompt, the composer, and quick-action pills.
function NewChatHero({
  value,
  onChange,
  onSubmit,
  onPick,
  pending,
  zoneId,
  model,
  onModelChange,
  controls,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onPick: (text: string) => void;
  pending: boolean;
  zoneId: string | null;
  model: string | null;
  onModelChange: (id: string | null) => void;
  controls: ComposerControls;
}) {
  const greeting = useMemo(
    () => HERO_GREETINGS[Math.floor(Math.random() * HERO_GREETINGS.length)],
    [],
  );
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Lead the suggestion strip with the action that fits this zone's setup, leaving the rest in
  // their catalog order. The applications read is React Query cached and skipped until a zone is
  // active, so the empty state never blocks on the network to render.
  const apps = useApplications(zoneId);
  const suggestions = useMemo(() => {
    const lead = leadSuggestion((apps.data?.length ?? 0) > 0);
    const leadItem = SUGGESTIONS.find((item) => item.id === lead);
    if (!leadItem) return SUGGESTIONS;
    return [leadItem, ...SUGGESTIONS.filter((item) => item.id !== lead)];
  }, [apps.data]);

  // Make the suggestion strip scrollable by every natural gesture: a vertical wheel is
  // translated to a sideways scroll (taking over only once an edge is reached so the page
  // still scrolls past it), and a click-drag pans the row. Pointer capture keeps the drag
  // smooth even when the cursor leaves the strip.
  useEffect(() => {
    const row = suggestionsRef.current;
    if (!row) return;

    function onWheel(event: WheelEvent) {
      if (!row) return;
      const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (delta === 0) return;
      const atStart = row.scrollLeft <= 0;
      const atEnd = row.scrollLeft + row.clientWidth >= row.scrollWidth - 1;
      if ((delta > 0 && atEnd) || (delta < 0 && atStart)) return;
      event.preventDefault();
      row.scrollLeft += delta;
    }

    let dragging = false;
    let startX = 0;
    let startScroll = 0;
    let moved = false;

    function onPointerDown(event: PointerEvent) {
      if (!row || event.button !== 0) return;
      dragging = true;
      moved = false;
      startX = event.clientX;
      startScroll = row.scrollLeft;
    }
    function onPointerMove(event: PointerEvent) {
      if (!row || !dragging) return;
      const dx = event.clientX - startX;
      if (Math.abs(dx) > 3) {
        moved = true;
        row.setPointerCapture(event.pointerId);
        row.style.cursor = "grabbing";
      }
      row.scrollLeft = startScroll - dx;
    }
    function endDrag(event: PointerEvent) {
      if (!row) return;
      dragging = false;
      row.style.cursor = "";
      if (row.hasPointerCapture(event.pointerId)) row.releasePointerCapture(event.pointerId);
    }
    // Suppress the click that ends a drag so panning never fires a suggestion.
    function onClickCapture(event: MouseEvent) {
      if (moved) {
        event.preventDefault();
        event.stopPropagation();
        moved = false;
      }
    }

    row.addEventListener("wheel", onWheel, { passive: false });
    row.addEventListener("pointerdown", onPointerDown);
    row.addEventListener("pointermove", onPointerMove);
    row.addEventListener("pointerup", endDrag);
    row.addEventListener("pointercancel", endDrag);
    row.addEventListener("click", onClickCapture, true);
    return () => {
      row.removeEventListener("wheel", onWheel);
      row.removeEventListener("pointerdown", onPointerDown);
      row.removeEventListener("pointermove", onPointerMove);
      row.removeEventListener("pointerup", endDrag);
      row.removeEventListener("pointercancel", endDrag);
      row.removeEventListener("click", onClickCapture, true);
    };
  }, []);

  return (
    <div className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex min-h-full flex-col items-center justify-center px-4 py-12">
        <div className="flex w-full max-w-2xl flex-col items-center gap-8">
          <div className="flex animate-fade-in flex-col items-center gap-2.5 text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              {greeting}
            </h2>
          </div>

          <div className="w-full animate-fade-in">
            <HeroComposer
              value={value}
              onChange={onChange}
              onSubmit={onSubmit}
              pending={pending}
              model={model}
              onModelChange={onModelChange}
              controls={controls}
            />
          </div>

          <div
            className="w-full animate-fade-in"
            style={{
              maskImage:
                "linear-gradient(to right, transparent, black 1.25rem, black calc(100% - 1.25rem), transparent)",
              WebkitMaskImage:
                "linear-gradient(to right, transparent, black 1.25rem, black calc(100% - 1.25rem), transparent)",
            }}
          >
            <div
              ref={suggestionsRef}
              className="scrollbar-none flex cursor-grab items-center gap-2 overflow-x-auto overflow-y-hidden px-5 py-2 [touch-action:pan-x] select-none"
            >
              {suggestions.map((suggestion) => {
                const Icon = suggestion.icon;
                return (
                  <button
                    key={suggestion.title}
                    onClick={() => onPick(suggestion.title)}
                    disabled={pending}
                    title={suggestion.hint}
                    className="group inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3.5 text-xs text-muted-foreground shadow-sm transition-colors hover:border-accent-purple/40 hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    <Icon className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-accent-purple" />
                    {suggestion.title}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Compact recap of what this chat has changed. It floats as a small pill in the top-right of the
// stream so long-session continuity stays reachable without a full-width bar eating vertical space,
// and opens a popover listing each applied change plus any capabilities the Operator is avoiding.
function MemoryStrip({
  zoneId,
  conversationId,
}: {
  zoneId: string | null;
  conversationId: string;
}) {
  const { data } = useOperatorContext(zoneId, conversationId);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const facts = data?.facts;
  if (!facts || (facts.applied_change_count === 0 && facts.rejected_capabilities.length === 0)) {
    return null;
  }

  const appliedPlans = facts.decided_plans.filter((plan) => plan.executed);
  const count = facts.applied_change_count;

  return (
    <div ref={rootRef} className="absolute right-3 top-3 z-20">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Changes made in this chat"
        onClick={() => setOpen((v) => !v)}
        className={cx(
          "inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card/90 px-2.5 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
          open && "text-foreground",
        )}
      >
        <CheckGlyph className="h-3.5 w-3.5 text-emerald-500" />
        {count > 0 ? (
          <span>
            <span className="text-foreground">{count}</span> change{count === 1 ? "" : "s"}
          </span>
        ) : (
          <span>Recap</span>
        )}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Changes made in this chat"
          className="animate-pop-in absolute right-0 top-full z-30 mt-1.5 w-72 overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
        >
          <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Changes in this chat
          </div>
          <div className="scrollbar-thin max-h-72 overflow-y-auto py-1">
            {appliedPlans.length > 0 ? (
              appliedPlans.map((plan) => (
                <div key={plan.seq} className="flex items-start gap-2 px-3 py-1.5">
                  <CheckGlyph className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  <div className="min-w-0">
                    <p className="text-xs leading-snug text-foreground">{plan.summary}</p>
                    {plan.steps_failed > 0 ? (
                      <p className="text-[11px] text-amber-600">
                        {plan.steps_succeeded} applied, {plan.steps_failed} failed
                      </p>
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {count} change{count === 1 ? "" : "s"} applied in this chat.
              </p>
            )}
          </div>
          {facts.rejected_capabilities.length > 0 ? (
            <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              Avoiding{" "}
              <span className="font-mono text-foreground">
                {facts.rejected_capabilities.join(", ")}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// A user turn is the only right-aligned entry; every other timeline item is an Operator-side
// response. The Operator avatar marks where a response begins, so it shows on the first Operator
// item after a user turn and the rest of that turn's items align beneath the same gutter.
function isUserItem(item: TimelineItem): boolean {
  return (item.kind === "message" || item.kind === "note") && item.role === "user";
}

function StreamEntry({
  item,
  zoneId,
  conversationId,
  actionable,
  toolCalls,
  showAvatar,
}: {
  item: MessageItem | PlanItem;
  zoneId: string | null;
  conversationId: string;
  actionable: boolean;
  toolCalls: PlanStepView[];
  showAvatar: boolean;
}) {
  const avatar = showAvatar ? (
    <img
      src="/chatbot.png"
      alt="Caracal Operator"
      className="h-8 w-8 shrink-0 select-none object-contain"
    />
  ) : (
    <div className="h-8 w-8 shrink-0" aria-hidden />
  );

  if (item.kind === "plan") {
    return (
      <div className="flex items-start gap-2">
        {avatar}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {item.deliberation ? <DeliberationReplay stages={item.deliberation} /> : null}
          {actionable ? (
            <PlanArtifact plan={item} zoneId={zoneId} conversationId={conversationId} />
          ) : (
            <PlanHistoryRow plan={item} />
          )}
        </div>
      </div>
    );
  }

  if (item.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="wrap-anywhere min-w-0 max-w-[82%] rounded-2xl border border-border bg-muted px-3 py-2 text-sm whitespace-pre-wrap text-foreground">
          {item.text}
        </p>
      </div>
    );
  }

  // A policy draft is a rich artifact, not prose: it renders in the wide gutter like a plan so its
  // documents, previews, and governed create action have room, with any framing text kept above it.
  if (item.policy) {
    return (
      <div className="flex items-start gap-2">
        {avatar}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {item.deliberation ? <DeliberationReplay stages={item.deliberation} /> : null}
          {item.reasoning ? (
            <Reasoning>
              <ReasoningTrigger />
              <ReasoningContent>{item.reasoning}</ReasoningContent>
            </Reasoning>
          ) : null}
          {item.text.trim() ? <Response>{item.text}</Response> : null}
          <OperatorPolicyDraft
            draft={item.policy}
            zoneId={zoneId}
            conversationId={conversationId}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-2">
      {avatar}
      <div className="mt-1.5 flex min-w-0 max-w-[82%] flex-col gap-1.5">
        {item.deliberation ? <DeliberationReplay stages={item.deliberation} /> : null}
        {item.reasoning ? (
          <Reasoning>
            <ReasoningTrigger />
            <ReasoningContent>{item.reasoning}</ReasoningContent>
          </Reasoning>
        ) : null}
        <Response>{item.text}</Response>
        {item.text.trim() || toolCalls.length > 0 ? (
          <CopyMessageButton text={item.text} toolCalls={toolCalls} />
        ) : null}
      </div>
    </div>
  );
}

// A stable empty list so answers with no tool calls never allocate a fresh array per render.
const EMPTY_TOOL_CALLS: PlanStepView[] = [];

// Associates each Operator answer with the tool calls of its exchange. Walking the timeline in
// order, the steps of every plan since the last user turn accumulate and pin to each Operator reply
// that follows, so copying that reply carries the actions taken in the same exchange.
function collectExchangeToolCalls(items: TimelineItem[]): Map<string, PlanStepView[]> {
  const byMessage = new Map<string, PlanStepView[]>();
  let exchange: PlanStepView[] = [];
  for (const item of items) {
    if (isUserItem(item)) {
      exchange = [];
    } else if (item.kind === "plan") {
      exchange = [...exchange, ...item.steps];
    } else if ((item.kind === "message" || item.kind === "note") && exchange.length > 0) {
      byMessage.set(item.id, exchange);
    }
  }
  return byMessage;
}

// Renders a single argument value as a compact one-liner for the copied tool-call list.
function formatArgValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "object" ? JSON.stringify(entry) : String(entry)))
      .join(", ");
  }
  return JSON.stringify(value);
}

// Formats the tool calls as a clean, numbered list - each with its capability, applied status, and
// arguments - so a pasted response reads as an ordered account of what the Operator did.
function formatToolCalls(steps: PlanStepView[]): string {
  const lines = steps.map((step, index) => {
    const status = step.status === "pending" ? "proposed" : step.status;
    const head = `${index + 1}. ${step.summary} (${step.capability}) — ${status}`;
    const args = Object.entries(step.args)
      .map(([key, value]) => [key.replace(/_/g, " "), formatArgValue(value)] as const)
      .filter(([, value]) => value.length > 0)
      .map(([key, value]) => `   - ${key}: ${value}`);
    return [head, ...args].join("\n");
  });
  return `Tool calls\n${lines.join("\n")}`;
}

// Joins the answer prose and its tool-call list into one copyable block, separated by a rule so the
// actions read as a distinct section beneath the response.
function buildCopyPayload(text: string, toolCalls: PlanStepView[]): string {
  const sections: string[] = [];
  if (text.trim()) sections.push(text);
  if (toolCalls.length > 0) sections.push(formatToolCalls(toolCalls));
  return sections.join("\n\n---\n\n");
}

// A subtle action under each Operator answer that copies the full response as markdown. It
// stays out of the way until the message is hovered or the control is focused, then confirms
// with a check for a moment so the user knows the copy landed. When the answer's turn made tool
// calls, a clean list of them is appended so the copied text carries the actions, not only the
// prose.
function CopyMessageButton({ text, toolCalls }: { text: string; toolCalls: PlanStepView[] }) {
  const [copied, setCopied] = useState(false);
  const payload = useMemo(() => buildCopyPayload(text, toolCalls), [text, toolCalls]);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy response"}
      title={copied ? "Copied" : "Copy response"}
      onClick={() => {
        void navigator.clipboard?.writeText(payload);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
      className={cx(
        "inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-xs outline-none transition-all focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 group-hover:opacity-100",
        copied
          ? "text-emerald-600 opacity-100 dark:text-emerald-400"
          : "text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground",
      )}
    >
      {copied ? <CheckGlyph className="h-3.5 w-3.5" /> : <CopyGlyph className="h-3.5 w-3.5" />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

/* ------------------------------- states -------------------------------- */

function LoadingState() {
  return (
    <div className={cx(SHELL, SHELL_COLUMNS)}>
      <div className="flex flex-col gap-3 bg-background p-4">
        <span className="skeleton h-8 w-2/3" />
        <span className="skeleton h-20 w-full" />
        <span className="skeleton h-8 w-1/2 self-end" />
      </div>
      <div className="hidden flex-col gap-2 border-l border-border bg-card p-3 lg:flex">
        <SessionSkeleton />
      </div>
    </div>
  );
}

function SessionSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-1 py-1">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex flex-col gap-1">
          <span className="skeleton h-3.5 w-3/4" />
          <span className="skeleton h-2.5 w-1/3" />
        </div>
      ))}
    </div>
  );
}

function StreamSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <span className="skeleton h-9 w-1/2 self-end" />
      <span className="skeleton h-16 w-2/3" />
      <span className="skeleton h-24 w-full" />
    </div>
  );
}

function NoZoneState() {
  return (
    <div className={cx(SHELL, "grid place-items-center bg-card px-6 text-center")}>
      <div className="flex max-w-sm flex-col items-center gap-3">
        <span className="grid h-11 w-11 place-items-center border border-border bg-muted text-foreground">
          <ZoneGlyph className="h-5 w-5" />
        </span>
        <p className="text-sm font-medium text-foreground">Select a zone to operate</p>
        <p className="text-sm text-muted-foreground">
          Choose a zone from the console header. The Operator works within that zone and never
          reaches beyond it.
        </p>
      </div>
    </div>
  );
}

function DisabledState() {
  const steps = [
    {
      title: "Describe it",
      body: "Tell the Operator what you want in plain language - connect a provider, grant access, or ask why a request was denied.",
    },
    {
      title: "Review the plan",
      body: "It resolves your intent into concrete steps, validates them, and previews the effect against your live state - nothing changes yet.",
    },
    {
      title: "Approve and apply",
      body: "You approve, and it applies the change through the same guarded APIs you use by hand, within your scope and recorded in the audit log.",
    },
  ];

  return (
    <div className={cx(SHELL, "grid place-items-center bg-card px-6 py-10")}>
      <div className="flex w-full max-w-3xl flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="grid h-12 w-12 place-items-center border border-border bg-muted text-foreground">
            <OperatorGlyph className="h-6 w-6" />
          </span>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold tracking-tight text-foreground">
              The Operator is turned off
            </h3>
            <Badge tone="muted">Disabled</Badge>
          </div>
          <p className="max-w-xl text-sm text-muted-foreground">
            Caracal Operator is optional and currently disabled, so it consumes no compute or AI
            resources. An administrator enables it with{" "}
            <code className="bg-muted px-1 py-0.5 text-xs">API_OPERATOR_ENABLED=true</code> on the
            API service. Your workspace, sessions, and the live capability catalog appear here the
            moment it is on.
          </p>
        </div>
        <div className="grid w-full gap-px border border-border bg-border sm:grid-cols-3 [&>*]:bg-card">
          {steps.map((step, index) => (
            <div key={step.title} className="flex flex-col gap-1.5 p-4">
              <span className="grid h-6 w-6 place-items-center border border-border font-mono text-[11px] text-foreground">
                {index + 1}
              </span>
              <div className="text-sm font-medium text-foreground">{step.title}</div>
              <p className="text-xs leading-relaxed text-muted-foreground">{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
