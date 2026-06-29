/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Caracal Operator route, the Community Edition workspace for operating the control plane in natural language.
*/
import { createFileRoute } from "@tanstack/react-router";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { ModulePage } from "@/components/console/ModulePage";
import { OperatorErrorLog, type OperatorNoticeEvent } from "@/components/console/OperatorErrorLog";
import type { OperatorNoticeSeverity } from "@/platform/state/operatorNotices";
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger,
} from "@/components/ai-elements/context";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
  TaskTrigger,
} from "@/components/ai-elements/task";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationCarousel,
  InlineCitationCarouselContent,
  InlineCitationCarouselHeader,
  InlineCitationCarouselIndex,
  InlineCitationCarouselItem,
  InlineCitationCarouselNext,
  InlineCitationCarouselPrev,
  InlineCitationSource,
  InlineCitationText,
} from "@/components/ai-elements/inline-citation";
import {
  ModelSelector,
  ModelSelectorCheck,
  ModelSelectorContent,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
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
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolState,
} from "@/components/ai-elements/tool";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
  type ConfirmationApproval,
} from "@/components/ai-elements/confirmation";
import {
  Agent,
  AgentContent,
  AgentHeader,
  AgentInstructions,
  AgentOutput,
  AgentTool,
  AgentTools,
} from "@/components/ai-elements/agent";
import { Badge, Button, ConfirmDialog, Tooltip, useToast } from "@/components/ui";
import { cx } from "@/lib/cx";
import {
  useActiveZone,
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
  type PlanAdvisoryView,
  type PlanItem,
  type PlanStepView,
  type TimelineItem,
} from "@/platform/operator/timeline";
import { planCitations } from "@/platform/operator/citations";
import type {
  OperatorConversation,
  OperatorConversationMode,
  OperatorUsageMeta,
} from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/ai")({
  component: CaracalOperatorPage,
});

// The same dithered shader backdrop used by empty states across the console.
const DitherBackdrop = lazy(() =>
  import("@/components/ui/neon-dither").then((m) => ({ default: m.DitherBackdrop })),
);

type Glyph = (props: { className?: string }) => ReactNode;

const SUGGESTIONS: { title: string; hint: string; icon: Glyph }[] = [
  { title: "Create a zone for the payments team", hint: "Spin up a new zone", icon: PlugGlyph },
  {
    title: "Register an application called Worker",
    hint: "Register a managed application",
    icon: LinkGlyph,
  },
  {
    title: "Give the finance app read-only access to invoices",
    hint: "Grant scoped access",
    icon: KeyGlyph,
  },
  { title: "Rotate an application's credentials", hint: "Issue a fresh secret", icon: RotateGlyph },
  { title: "What zones do I have?", hint: "Read current state", icon: TrimGlyph },
  { title: "Why was that request denied?", hint: "Explain a policy decision", icon: HelpGlyph },
];

function CaracalOperatorPage() {
  const { data: enabled, isLoading } = useOperatorStatus();

  return (
    <ModulePage
      title="Caracal Operator"
      description="Operate your entire Caracal control plane in natural language. Describe what you want; the Operator resolves it into concrete changes, shows the plan, previews the effect against live state, and applies it through the same guarded APIs you use by hand - within your operator scope and recorded in the audit log."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Caracal Operator" }]}
      titleAccessory={
        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent-purple">
          Beta
        </span>
      }
      actions={<SecureByCaracal />}
      fill
    >
      {isLoading ? <LoadingState /> : enabled === true ? <OperatorWorkspace /> : <DisabledState />}
    </ModulePage>
  );
}

// A trust marker pinned to the page header that reassures operators the chat runs
// under Caracal's brokered authority. Hovering reveals what that guarantee means.
function SecureByCaracal() {
  return (
    <Tooltip
      label="This chat uses Caracal for its multi-agent authority."
      side="bottom"
      align="end"
    >
      <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground">
        <StarGlyph className="h-3.5 w-3.5 text-[#a855f7]" />
        <span
          className="animate-rainbow bg-size-[200%] bg-clip-text font-semibold text-transparent"
          style={{
            backgroundImage: "linear-gradient(90deg, #7c3aed, #a855f7, #d946ef, #a855f7, #7c3aed)",
          }}
        >
          Secure by Caracal
        </span>
      </span>
    </Tooltip>
  );
}

function StarGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 2.5c.32 0 .61.2.72.5l2.06 5.5 5.5 2.06a.77.77 0 0 1 0 1.44l-5.5 2.06-2.06 5.5a.77.77 0 0 1-1.44 0l-2.06-5.5-5.5-2.06a.77.77 0 0 1 0-1.44l5.5-2.06 2.06-5.5c.11-.3.4-.5.72-.5z" />
    </svg>
  );
}

/* -------------------------------- shell -------------------------------- */

// Full-width surface that fills the remaining content height through the flex chain, so
// the workspace sits flush under the navbar and beside the utility rail rather than
// guessing a viewport offset. The negative margins cancel the Console main padding so
// the panes read as one full-bleed workspace.
const SHELL = "min-h-0 flex-1 border-t border-border -mx-5 -mb-6 md:-mx-8";
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
const RAIL_COLLAPSED_WIDTH = "2.75rem";

// The mode and autopilot chosen for the last new conversation are remembered so a fresh chat
// opens the way the operator last worked. Mode defaults to the safer read-only "ask".
const DRAFT_MODE_KEY = "caracal.operator.draftMode";
const DRAFT_AUTOPILOT_KEY = "caracal.operator.draftAutopilot";

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

/* ------------------------------ workspace ------------------------------ */

function OperatorWorkspace() {
  const { activeZone } = useActiveZone();
  const zoneId = activeZone?.id ?? null;
  const toast = useToast();

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
        },
      };
    });
  }

  // Creating an empty session from the rail; the stream then opens on the hero. The draft
  // mode and autopilot chosen on the landing hero are applied to the new conversation.
  function startSession(title: string) {
    const name = title.trim();
    if (!name || create.isPending) return;
    create.mutate(
      { title: name, mode: draftMode, autopilot: draftMode === "agent" && draftAutopilot },
      { onSuccess: (conversation) => setSelectedId(conversation.id) },
    );
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
        onSuccess: (conversation) => setSelectedId(conversation.id),
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
        if (selectedId === id) setSelectedId(null);
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
        if (selectedId === id) setSelectedId(null);
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
        {fullscreen ? (
          <div className="pointer-events-none absolute left-3 top-2 z-30 hidden items-center lg:flex">
            <img
              src="/caracal_light.png"
              alt="Caracal"
              className="h-25 w-auto select-none dark:hidden"
            />
            <img
              src="/caracal_dark.png"
              alt="Caracal"
              className="hidden h-25 w-auto select-none dark:block"
            />
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setFullscreen((value) => !value)}
          aria-pressed={fullscreen}
          aria-label={fullscreen ? "Exit full screen" : "Full screen chat"}
          title={fullscreen ? "Exit full screen" : "Full screen chat"}
          className="absolute right-2 top-2 z-30 hidden h-8 w-8 place-items-center rounded-md border border-border bg-card/80 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 lg:grid"
        >
          {fullscreen ? <ShrinkGlyph className="h-4 w-4" /> : <ExpandGlyph className="h-4 w-4" />}
        </button>
        <OperatorErrorLog event={operatorNotice} />
        <SessionStrip
          conversations={conversations.data ?? []}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onCreate={() => startSession("New session")}
          creating={create.isPending}
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
          />
        ) : (
          <NewChatHero
            value={heroDraft}
            onChange={setHeroDraft}
            onSubmit={() => startFromIntent(heroDraft)}
            onPick={(text) => startFromIntent(text)}
            pending={create.isPending}
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
        onSelect={setSelectedId}
        onCreate={startSession}
        onRename={renameSession}
        onArchive={archiveSession}
        onRestore={restoreSession}
        onDelete={deleteSession}
        view={view}
        onChangeView={setView}
        creating={create.isPending}
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

// Real cumulative token usage observed for one session this page load, with the model
// and its context window from the most recent answered message.
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  maxTokens: number;
}

// A concise session title derived from the opening intent.
function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 48 ? `${clean.slice(0, 47).trimEnd()}…` : clean;
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
  creating,
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
  onCreate: (title: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  view: "active" | "archived";
  onChangeView: (view: "active" | "archived") => void;
  creating: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onResizeStart: (event: React.PointerEvent) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<OperatorConversation | null>(null);

  const groups = useMemo(() => groupConversations(conversations), [conversations]);
  const archived = view === "archived";

  function commit() {
    if (draft === null) return;
    const name = draft.trim();
    if (name) onCreate(name);
    setDraft(null);
  }

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
          onClick={() => onCreate("New session")}
          disabled={creating}
          aria-label="New session"
          title="New session"
          className="grid h-8 w-8 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <PlusGlyph className="h-4 w-4" />
        </button>
      </div>
    );
  }

  // New session window: the rail trades its list for a focused composer so naming and
  // starting a session reads as its own surface rather than a field wedged above the
  // sessions. Back returns to the list without creating anything.
  if (draft !== null) {
    const name = draft.trim();
    return (
      <div className="relative hidden min-h-0 flex-col border-l border-border bg-card lg:flex">
        <div
          onPointerDown={onResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sessions"
          className="absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize bg-transparent transition-colors hover:bg-accent-purple/40"
        />
        <div className="flex flex-shrink-0 items-center gap-2 px-3 py-2.5">
          <button
            onClick={() => setDraft(null)}
            aria-label="Back to sessions"
            title="Back to sessions"
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <CloseGlyph className="h-4 w-4" />
          </button>
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            New session
          </span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              if (event.key === "Escape") setDraft(null);
            }}
            placeholder="Name this session"
            aria-label="New session name"
            className="h-8 w-full border border-input bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          />
          <button
            onClick={commit}
            disabled={creating || !name}
            className="h-8 w-full rounded bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Create session
          </button>
        </div>
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
            onClick={() => setDraft("")}
            disabled={creating}
            aria-label="New session"
            title="New session"
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
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
                      "group/session relative flex items-center border-l-2 transition-colors",
                      selected
                        ? "border-foreground bg-accent"
                        : "border-transparent hover:bg-accent/50",
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
interface SessionGroup {
  label: string;
  items: OperatorConversation[];
}

// Bucket sessions by last activity into the familiar Today / Yesterday / recent
// windows so a long history stays scannable. Empty buckets are dropped and the API
// order is preserved within each bucket.
function groupConversations(conversations: OperatorConversation[]): SessionGroup[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  const buckets = [
    { label: "Today", min: startOfToday },
    { label: "Yesterday", min: startOfToday - day },
    { label: "Previous 7 days", min: startOfToday - 7 * day },
    { label: "Previous 30 days", min: startOfToday - 30 * day },
    { label: "Older", min: -Infinity },
  ].map((bucket) => ({ ...bucket, items: [] as OperatorConversation[] }));
  for (const conversation of conversations) {
    const time = new Date(conversation.last_activity_at).getTime();
    const bucket = buckets.find((entry) => time >= entry.min) ?? buckets[buckets.length - 1];
    bucket.items.push(conversation);
  }
  return buckets
    .filter((bucket) => bucket.items.length > 0)
    .map(({ label, items }) => ({ label, items }));
}

// Horizontal session switcher shown only below the sessions rail breakpoint.
function SessionStrip({
  conversations,
  selectedId,
  onSelect,
  onCreate,
  creating,
}: {
  conversations: OperatorConversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  creating: boolean;
}) {
  return (
    <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-border bg-card px-2 py-1.5 lg:hidden">
      <button
        onClick={onCreate}
        disabled={creating}
        className="inline-flex flex-shrink-0 items-center gap-1 border border-border bg-background px-2 py-1 text-xs font-medium text-foreground disabled:opacity-50"
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

// The conversation's session controls: a single compact bar carrying the operation mode and, in
// agent mode, the autopilot engage switch. Mode is Caracal-enforced at both the skill layer and the
// write routes, so this only sets the conversation's setting; it never relaxes enforcement.
// Autopilot is shown in agent mode so the capability is discoverable: it is a working switch when
// the deployment has an autopilot policy, and a clear "unavailable" hint when it does not. Engaging
// autopilot only flips the conversation's engage flag - what may be auto-approved is set in Caracal.
// The mode and approval-mode controls threaded into both the hero and the active composer,
// so a conversation's mode and autopilot are always adjustable from the same place.
interface ComposerControls {
  mode: OperatorConversationMode;
  onModeChange: (mode: OperatorConversationMode) => void;
  modePending: boolean;
  autopilot: boolean;
  onAutopilotChange: (autopilot: boolean) => void;
  autopilotPending: boolean;
  autopilotAvailable: boolean;
}

// The approval-mode dropdown placed flush below the chat box, always visible so the operator
// can see and set how changes are approved before any are proposed. When autopilot is engaged a
// short reminder sits beside it that the Operator acts on its own judgement for low-risk changes.
function AutopilotRow({ controls }: { controls: ComposerControls }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5">
      <AutopilotMenu
        autopilot={controls.autopilot}
        available={controls.autopilotAvailable}
        pending={controls.autopilotPending}
        onChange={controls.onAutopilotChange}
      />
      {controls.autopilot ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-500">
          <AlertGlyph className="h-3 w-3 flex-shrink-0" />
          Autopilot gives AI autonomy to take actions. (Secured by Caracal)
        </span>
      ) : null}
    </div>
  );
}

// A compact icon-led dropdown used inside the composer for mode and autopilot. It opens
// upward so it never collides with the page below the chat box, closes on outside click or
// Escape, and renders each option as an icon and label. A disabled option stays visible with
// an explanatory tooltip rather than disappearing.
interface ComposerMenuOption<T extends string> {
  value: T;
  label: string;
  icon: Glyph;
  disabled?: boolean;
  disabledHint?: string;
}

function ComposerMenu<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  align = "left",
  pending,
  tone = "outline",
}: {
  value: T;
  options: ComposerMenuOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  align?: "left" | "right";
  pending?: boolean;
  tone?: "outline" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

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

  const SelectedIcon = selected.icon;

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={pending}
        onClick={() => setOpen((v) => !v)}
        className={cx(
          "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60",
          tone === "ghost" ? "border border-transparent" : "border border-border",
          open
            ? "border-foreground/20 bg-accent text-foreground"
            : "text-muted-foreground hover:bg-surface hover:text-foreground",
        )}
      >
        <SelectedIcon className="h-3.5 w-3.5" />
        <span className="max-w-[9rem] truncate">{selected.label}</span>
        <ChevronDownGlyph className={cx("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label={ariaLabel}
          className={cx(
            "animate-pop-in absolute bottom-full z-50 mb-1.5 w-44 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-xl",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {options.map((option) => {
            const Icon = option.icon;
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                disabled={option.disabled}
                title={option.disabled ? option.disabledHint : undefined}
                onClick={() => {
                  if (option.disabled) return;
                  onChange(option.value);
                  setOpen(false);
                }}
                className={cx(
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors",
                  option.disabled
                    ? "cursor-not-allowed opacity-55"
                    : active
                      ? "bg-accent/60"
                      : "hover:bg-accent/50",
                )}
              >
                <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-foreground">{option.label}</span>
                {active ? (
                  <CheckGlyph className="h-3.5 w-3.5 flex-shrink-0 text-accent-purple" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

const MODE_OPTIONS: ComposerMenuOption<OperatorConversationMode>[] = [
  { value: "agent", label: "Agent", icon: BoltGlyph },
  { value: "ask", label: "Ask", icon: EyeGlyph },
];

// The conversation mode picker, shown inside the composer next to the model selector.
function ModeMenu({
  mode,
  pending,
  onChange,
}: {
  mode: OperatorConversationMode;
  pending: boolean;
  onChange: (mode: OperatorConversationMode) => void;
}) {
  return (
    <ComposerMenu
      value={mode}
      options={MODE_OPTIONS}
      onChange={onChange}
      ariaLabel="Operation mode"
      pending={pending}
      tone="ghost"
    />
  );
}

// The approval-mode picker, shown flush below the chat box in agent mode. The Autopilot
// option is kept visible but disabled with a hint when the deployment has not enabled an
// autopilot policy, so the boundary stays discoverable without being selectable.
function AutopilotMenu({
  autopilot,
  available,
  pending,
  onChange,
}: {
  autopilot: boolean;
  available: boolean;
  pending: boolean;
  onChange: (autopilot: boolean) => void;
}) {
  const options: ComposerMenuOption<"human" | "auto">[] = [
    { value: "human", label: "Human approval", icon: UserCheckGlyph },
    {
      value: "auto",
      label: "Autopilot",
      icon: BoltGlyph,
      disabled: !available,
      disabledHint:
        "Not enabled for this deployment. Configure an autopilot policy in Caracal to allow auto-approval of low-risk changes.",
    },
  ];
  return (
    <ComposerMenu
      value={autopilot ? "auto" : "human"}
      options={options}
      onChange={(next) => onChange(next === "auto")}
      ariaLabel="Approval mode"
      pending={pending}
      tone="ghost"
    />
  );
}

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
}) {
  const { data: turns, isLoading } = useOperatorTurns(zoneId, conversationId);
  const send = useSendOperatorMessage(zoneId, conversationId);
  const setMode = useSetOperatorConversationMode(zoneId);
  const setAutopilot = useSetOperatorConversationAutopilot(zoneId);
  const { data: autopilotAvailable } = useOperatorAutopilotAvailable();
  const [message, setMessage] = useState("");
  const [queued, setQueued] = useState<QueuedMessage[]>([]);

  const { items, latestPlan } = useMemo(() => buildTimeline(turns ?? []), [turns]);

  function dispatch(text: string) {
    send.mutate(
      { message: text, provider: model ?? undefined },
      { onSuccess: (result) => onUsage?.(result) },
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
    if (send.isPending || queued.length > 0) {
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
    if (!send.isPending) {
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
    if (send.isPending || queued.length === 0) return;
    const next = queued[0];
    setQueued((prev) => prev.slice(1));
    dispatch(next.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send.isPending, queued]);

  // Send the opening intent once when the session was started from the hero.
  const openingSent = useRef(false);
  useEffect(() => {
    if (initialMessage && !openingSent.current) {
      openingSent.current = true;
      submit(initialMessage);
      onInitialConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage]);

  // Surface a failed send through the workspace error banner and clear it when the
  // stream unmounts so a stale failure never lingers on another session.
  useEffect(() => {
    onError?.(send.isError);
    return () => onError?.(false);
  }, [send.isError, onError]);

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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MemoryStrip zoneId={zoneId} conversationId={conversationId} />
        <NewChatHero
          value={message}
          onChange={setMessage}
          onSubmit={() => submit(message)}
          onPick={(text) => submit(text)}
          pending={send.isPending}
          model={model}
          onModelChange={onModelChange}
          controls={controls}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <MemoryStrip zoneId={zoneId} conversationId={conversationId} />

      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-4">
        {isLoading ? (
          <StreamSkeleton />
        ) : (
          items.map((item) => (
            <StreamEntry
              key={item.id}
              item={item}
              zoneId={zoneId}
              conversationId={conversationId}
              actionable={latestPlan?.id === item.id}
            />
          ))
        )}

        {send.isPending ? (
          <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-purple" />
            The Operator is working…
          </div>
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

// Auto-growing message box: the textarea expands with content up to a ceiling, the
// signature feel of a modern assistant composer.
function useAutoResizeTextarea({ minHeight, maxHeight }: { minHeight: number; maxHeight: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const adjust = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = `${minHeight}px`;
    el.style.height = `${Math.max(minHeight, Math.min(el.scrollHeight, maxHeight))}px`;
  }, [minHeight, maxHeight]);
  return { ref, adjust };
}

// The Operator's natural-language input. The compact variant is the pinned follow-up
// bar; the elevated variant is the glassy hero composer. Both auto-resize, send on
// Enter (Shift+Enter for a newline), and carry a circular send control.
function OperatorInput({
  value,
  onChange,
  onSubmit,
  pending,
  minHeight,
  autoFocus,
  elevated,
  usage,
  model,
  onModelChange,
  leftSlot,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
  minHeight: number;
  autoFocus?: boolean;
  elevated?: boolean;
  usage?: SessionUsage;
  model?: string | null;
  onModelChange?: (id: string | null) => void;
  leftSlot?: ReactNode;
}) {
  const { ref, adjust } = useAutoResizeTextarea({ minHeight, maxHeight: 220 });
  useEffect(() => {
    adjust();
  }, [value, adjust]);

  const canSend = !pending && value.trim().length > 0;

  const textarea = (
    <textarea
      ref={ref}
      autoFocus={autoFocus}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onSubmit();
        }
      }}
      rows={1}
      placeholder="Describe what you want, or ask a question…"
      aria-label="Message the Operator"
      className="scrollbar-thin w-full resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
      style={{ height: minHeight }}
    />
  );

  const sendButton = (
    <button
      type="button"
      aria-label="Send"
      onClick={onSubmit}
      disabled={!canSend}
      aria-busy={pending || undefined}
      className={cx(
        "grid flex-shrink-0 place-items-center rounded-full transition-all",
        elevated ? "h-9 w-9" : "h-8 w-8",
        canSend
          ? "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 active:scale-95"
          : "cursor-not-allowed bg-muted text-muted-foreground",
      )}
    >
      {pending ? (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        <ArrowUpGlyph className="h-4 w-4" />
      )}
    </button>
  );

  if (elevated) {
    return (
      <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 shadow-xl shadow-black/10 transition-colors focus-within:border-accent-purple/40 focus-within:ring-2 focus-within:ring-accent-purple/20">
        <div className="px-1 pt-0.5">{textarea}</div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            {onModelChange ? (
              <OperatorModelSelector value={model ?? null} onChange={onModelChange} />
            ) : null}
            {leftSlot}
          </div>
          <div className="flex items-center gap-1.5">
            {usage ? <UsageMeter usage={usage} /> : null}
            {sendButton}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 border border-input bg-card px-2 py-2 transition-colors focus-within:border-foreground/30 focus-within:ring-2 focus-within:ring-ring/30">
      <div className="min-w-0 px-1">{textarea}</div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {onModelChange ? (
            <OperatorModelSelector value={model ?? null} onChange={onModelChange} />
          ) : null}
          {leftSlot}
        </div>
        <div className="flex items-center gap-1.5">
          {usage ? <UsageMeter usage={usage} /> : null}
          {sendButton}
        </div>
      </div>
    </div>
  );
}

// The model picker shown in the composer, fed by the real configured providers. Limited
// to the four highest-priority providers so the choice stays focused; selecting one
// routes the next message to it while the conversation memory is unchanged.
function OperatorModelSelector({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const { data } = useOperatorAiStatus(true);
  const providers = useMemo(
    () => (data?.providers ?? []).filter((provider) => provider.available).slice(0, 4),
    [data],
  );
  const [open, setOpen] = useState(false);

  // With no configured providers the Operator runs without a chosen model, so the picker
  // shows a clearly non-interactive "Auto" chip. It stays visible to anchor the composer's
  // left edge and signals a model can be chosen once a provider is configured.
  if (providers.length === 0) {
    return (
      <span
        className="inline-flex h-8 flex-shrink-0 cursor-default items-center gap-1.5 rounded-full border border-dashed border-border bg-transparent px-2.5 text-xs text-muted-foreground"
        title="No AI provider is configured, so the Operator selects automatically. Configure API_OPERATOR_AI_PROVIDERS to choose a model."
      >
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
        Auto
      </span>
    );
  }

  const selected = providers.find((provider) => provider.id === value) ?? providers[0];

  return (
    <ModelSelector className="flex-shrink-0" open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger>
        <ModelSelectorLogo provider={selected.id} />
        <ModelSelectorName className="max-w-[8rem]">{selected.model}</ModelSelectorName>
      </ModelSelectorTrigger>
      <ModelSelectorContent placement="top">
        <ModelSelectorInput />
        <ModelSelectorList>
          {providers.map((provider) => (
            <ModelSelectorItem
              key={provider.id}
              value={`${provider.model} ${provider.id}`}
              onSelect={() => {
                onChange(provider.id);
                setOpen(false);
              }}
            >
              <ModelSelectorLogo provider={provider.id} />
              <div className="min-w-0">
                <div className="truncate text-sm text-foreground">{provider.model}</div>
                <div className="truncate text-[10px] text-muted-foreground">{provider.id}</div>
              </div>
              <ModelSelectorCheck active={provider.id === selected.id} />
            </ModelSelectorItem>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

// The model context-usage gauge shown beside the send control: a circular ring that
// reveals the real per-session token breakdown on hover.
function UsageMeter({ usage }: { usage: SessionUsage }) {
  const total = usage.inputTokens + usage.outputTokens;
  return (
    <Context
      className="flex-shrink-0"
      maxTokens={usage.maxTokens}
      usedTokens={total}
      modelId={usage.model}
      usage={{
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: total,
      }}
    >
      <ContextTrigger />
      <ContextContent placement="top">
        <ContextContentHeader />
        <ContextContentBody>
          <ContextInputUsage />
          <ContextOutputUsage />
          <ContextReasoningUsage />
          <ContextCacheUsage />
          {total === 0 ? (
            <p className="text-xs text-muted-foreground">
              No tokens used yet this session. Usage appears as the Operator answers.
            </p>
          ) : null}
        </ContextContentBody>
        <ContextContentFooter />
      </ContextContent>
    </Context>
  );
}

const ZERO_USAGE: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  model: null,
  maxTokens: 0,
};

// The pinned composer used once a conversation has started.
function Composer({
  value,
  onChange,
  onSubmit,
  pending,
  usage,
  model,
  onModelChange,
  controls,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
  usage?: SessionUsage;
  model: string | null;
  onModelChange: (id: string | null) => void;
  controls: ComposerControls;
}) {
  return (
    <div className="flex-shrink-0 border-t border-border bg-card px-3 py-3">
      <OperatorInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        pending={pending}
        minHeight={40}
        usage={usage ?? ZERO_USAGE}
        model={model}
        onModelChange={onModelChange}
        leftSlot={
          <ModeMenu
            mode={controls.mode}
            pending={controls.modePending}
            onChange={controls.onModeChange}
          />
        }
      />
      <AutopilotRow controls={controls} />
      <p className="mt-1.5 px-0.5 text-[10px] text-muted-foreground">
        Enter to send · Shift+Enter for a new line - nothing changes until you approve the plan.
      </p>
    </div>
  );
}

// A time-of-day greeting paired with a thoughtful opening line, so the empty state
// feels like a considered welcome rather than a generic prompt.
function greetingForNow(): { greeting: string; message: string } {
  const hour = new Date().getHours();
  if (hour < 5) {
    return {
      greeting: "Burning the midnight oil",
      message: "The quiet hours are good for careful work. Tell me what to set in motion.",
    };
  }
  if (hour < 12) {
    return {
      greeting: "Good morning",
      message: "A fresh start. Describe what you'd like to put in place and I'll plan it out.",
    };
  }
  if (hour < 17) {
    return {
      greeting: "Good afternoon",
      message:
        "Let's keep things moving. Tell me what you want to operate and I'll handle the how.",
    };
  }
  if (hour < 21) {
    return {
      greeting: "Good evening",
      message:
        "Winding down the day. Describe what you need and I'll turn it into a reviewable plan.",
    };
  }
  return {
    greeting: "Working late",
    message:
      "Take your time. Tell me what you want to change and I'll lay out the steps before anything happens.",
  };
}

// The new-conversation entry point: an atmospheric, centered greeting with a glassy
// composer and quick-action pills - the way a modern operational assistant opens.
function NewChatHero({
  value,
  onChange,
  onSubmit,
  onPick,
  pending,
  model,
  onModelChange,
  controls,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onPick: (text: string) => void;
  pending: boolean;
  model: string | null;
  onModelChange: (id: string | null) => void;
  controls: ComposerControls;
}) {
  const { greeting, message } = useMemo(() => greetingForNow(), []);
  const suggestionsRef = useRef<HTMLDivElement>(null);

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
    <div className="scrollbar-thin relative flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Suspense fallback={null}>
        <DitherBackdrop />
      </Suspense>
      <div className="relative z-10 flex min-h-full flex-col items-center justify-center px-4 py-12">
        <div className="flex w-full max-w-2xl flex-col items-center gap-8">
          <div className="flex animate-fade-in flex-col items-center gap-2.5 text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl dark:bg-gradient-to-b dark:from-foreground dark:to-foreground/55 dark:bg-clip-text dark:text-transparent">
              {greeting}
            </h2>
            <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{message}</p>
          </div>

          <div className="w-full animate-fade-in">
            <OperatorInput
              value={value}
              onChange={onChange}
              onSubmit={onSubmit}
              pending={pending}
              minHeight={60}
              autoFocus
              elevated
              usage={ZERO_USAGE}
              model={model}
              onModelChange={onModelChange}
              leftSlot={
                <ModeMenu
                  mode={controls.mode}
                  pending={controls.modePending}
                  onChange={controls.onModeChange}
                />
              }
            />
            <AutopilotRow controls={controls} />
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
              {SUGGESTIONS.map((suggestion) => {
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

// Compact memory recap shown inside the stream so long-session continuity (applied
// changes, rejected operations) stays visible without scrolling the timeline.
function MemoryStrip({
  zoneId,
  conversationId,
}: {
  zoneId: string | null;
  conversationId: string;
}) {
  const { data } = useOperatorContext(zoneId, conversationId);
  const facts = data?.facts;
  if (!facts || (facts.applied_change_count === 0 && facts.rejected_capabilities.length === 0)) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground">
      {facts.applied_change_count > 0 ? (
        <span>
          <span className="font-medium text-foreground">{facts.applied_change_count}</span> change
          {facts.applied_change_count === 1 ? "" : "s"} applied
        </span>
      ) : null}
      {facts.rejected_capabilities.length > 0 ? (
        <span>
          Avoiding{" "}
          <span className="font-mono text-foreground">
            {facts.rejected_capabilities.join(", ")}
          </span>
        </span>
      ) : null}
    </div>
  );
}

function StreamEntry({
  item,
  zoneId,
  conversationId,
  actionable,
}: {
  item: TimelineItem;
  zoneId: string | null;
  conversationId: string;
  actionable: boolean;
}) {
  if (item.kind === "plan") {
    return actionable ? (
      <PlanArtifact plan={item} zoneId={zoneId} conversationId={conversationId} />
    ) : (
      <PlanHistoryRow plan={item} />
    );
  }

  if (item.kind === "error") {
    return (
      <div className="border-l-2 border-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {item.message}
      </div>
    );
  }

  if (item.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[82%] whitespace-pre-wrap border border-border bg-muted px-3 py-2 text-sm text-foreground">
          {item.text}
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 grid h-6 w-6 flex-shrink-0 place-items-center border border-border bg-muted text-foreground">
        <OperatorGlyph className="h-3.5 w-3.5" />
      </span>
      <div className="flex min-w-0 max-w-[82%] flex-col gap-1.5">
        {item.reasoning ? (
          <Reasoning>
            <ReasoningTrigger />
            <ReasoningContent>{item.reasoning}</ReasoningContent>
          </Reasoning>
        ) : null}
        <p className="whitespace-pre-wrap text-sm text-foreground">{item.text}</p>
      </div>
    </div>
  );
}

/* -------------------------------- plans -------------------------------- */

function planDecision(plan: PlanItem): { tone: BadgeTone; label: string } {
  if (plan.decision === "approved") {
    if (plan.executed) return { tone: "success", label: "Applied" };
    return plan.approvedByAutopilot
      ? { tone: "success", label: "Approved by autopilot" }
      : { tone: "success", label: "Approved" };
  }
  if (plan.decision === "rejected") return { tone: "danger", label: "Rejected" };
  return { tone: "warning", label: "Awaiting approval" };
}

// Maps a step's ledger status to the tool lifecycle state: a rejected plan denies
// every step, an executed step reports its success or failure, and an undecided step
// reads as ready to run.
function stepToolState(step: PlanStepView, plan: PlanItem): ToolState {
  if (plan.decision === "rejected") return "output-denied";
  if (step.status === "succeeded") return "output-available";
  if (step.status === "failed") return "output-error";
  return "input-available";
}

function planApproval(plan: PlanItem): ConfirmationApproval {
  if (plan.decision === "approved") return { id: plan.id, approved: true };
  if (plan.decision === "rejected") {
    return {
      id: plan.id,
      approved: false,
      ...(plan.rejectionReason ? { reason: plan.rejectionReason } : {}),
    };
  }
  return { id: plan.id };
}

function planConfirmationState(plan: PlanItem): ToolState {
  if (plan.decision === "pending") return "approval-requested";
  if (plan.decision === "rejected") return "output-denied";
  return plan.executed ? "output-available" : "approval-responded";
}

// Maps an advisory severity to a badge tone. The review is informational, so even a warning is a
// caution to weigh, not a block - the human still decides.
function advisoryTone(severity: PlanAdvisoryView["findings"][number]["severity"]): BadgeTone {
  if (severity === "warning") return "danger";
  if (severity === "caution") return "warning";
  return "muted";
}

// The advisory security review surfaced above the approval controls, so the reviewer weighs
// over-grant and blast-radius before approving. It never gates the decision - the approve and
// reject controls are unchanged whether or not findings are present.
function PlanAdvisory({ advisory }: { advisory: PlanAdvisoryView }) {
  return (
    <div className="border-t border-border bg-surface px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <AlertGlyph className="h-3 w-3 text-muted-foreground" />
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Security review
        </span>
      </div>
      <p className="mt-1.5 text-xs text-foreground">{advisory.summary}</p>
      {advisory.findings.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {advisory.findings.map((finding, index) => (
            <li key={index} className="flex items-start gap-2">
              <Badge tone={advisoryTone(finding.severity)}>{finding.severity}</Badge>
              <span className="text-xs text-muted-foreground">{finding.concern}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// An honest, human message for why applying a plan failed, so a refused execution never fails
// silently. Governed execution is bound to one zone, so a conversation in any other zone cannot
// apply changes; that case is named plainly rather than shown as a generic error.
function executeErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case "governed_execution_unconfigured":
      return "Caracal can't apply changes in this zone - governed execution isn't configured here.";
    case "zone_forbidden":
      return "This zone is internal to Caracal, so the Operator can't apply changes here.";
    case "mode_forbidden":
      return "This conversation is in ask mode, so it can explain but not apply changes.";
    case "plan_already_executed":
      return "This plan was already applied.";
    case "plan_not_approved":
      return "Approve the plan before applying it.";
    case "plan_rejected":
      return "This plan was rejected, so it can't be applied.";
    case "conversation_archived":
      return "This conversation is archived, so it can't apply changes.";
    default:
      return "Couldn't apply the changes. Please try again.";
  }
}

// The active execution plan rendered as a first-class operational artifact: steps,
// per-step effect, live progress, and the approve / reject / apply controls.
function PlanArtifact({
  plan,
  zoneId,
  conversationId,
}: {
  plan: PlanItem;
  zoneId: string | null;
  conversationId: string;
}) {
  const decide = useDecideOperatorPlan(zoneId, conversationId);
  const execute = useExecuteOperatorPlan(zoneId, conversationId);
  const busy = decide.isPending || execute.isPending;
  const decision = planDecision(plan);
  const mutatingCount = plan.steps.filter((step) => step.mutating).length;
  const catalog = useOperatorCapabilities().data ?? [];
  const sources = planCitations(plan, catalog);

  return (
    <div className="border border-border bg-card shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-border px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-5 w-5 flex-shrink-0 place-items-center border border-border bg-muted">
            <PlanGlyph className="h-3 w-3 text-foreground" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">{plan.summary}</div>
            <div className="text-[11px] text-muted-foreground">
              {plan.steps.length} step{plan.steps.length === 1 ? "" : "s"}
              {mutatingCount > 0 ? ` · ${mutatingCount} change state` : " · read-only"}
            </div>
          </div>
        </div>
        <Badge tone={decision.tone}>{decision.label}</Badge>
      </div>

      <div className="flex flex-col">
        {plan.steps.map((step) => (
          <Tool key={step.id} className="border-b border-border last:border-b-0">
            <ToolHeader
              type={`tool-${step.capability}`}
              title={step.summary}
              state={stepToolState(step, plan)}
            />
            <ToolContent>
              <ToolInput input={step.args} />
              {step.detail ? (
                <ToolOutput
                  output={step.status === "failed" ? undefined : step.detail}
                  errorText={step.status === "failed" ? step.detail : undefined}
                />
              ) : null}
            </ToolContent>
          </Tool>
        ))}
      </div>

      {plan.advisory ? <PlanAdvisory advisory={plan.advisory} /> : null}

      {plan.canDecide || plan.decision !== "pending" ? (
        <Confirmation approval={planApproval(plan)} state={planConfirmationState(plan)}>
          <ConfirmationTitle>
            <ConfirmationRequest>
              {mutatingCount > 0
                ? `Approve to apply ${mutatingCount} change${mutatingCount === 1 ? "" : "s"} in this zone - nothing runs until you do.`
                : "Approve to run these read-only steps in this zone."}
            </ConfirmationRequest>
            <ConfirmationAccepted>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span>{plan.executed ? "Applied" : "Approved"}</span>
            </ConfirmationAccepted>
            <ConfirmationRejected>
              <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
              <span>{plan.rejectionReason ? `Rejected: ${plan.rejectionReason}` : "Rejected"}</span>
            </ConfirmationRejected>
          </ConfirmationTitle>
          <ConfirmationActions>
            <ConfirmationAction
              variant="outline"
              disabled={busy}
              onClick={() => decide.mutate({ plan_seq: plan.seq, decision: "rejected" })}
            >
              Reject
            </ConfirmationAction>
            <ConfirmationAction
              variant="default"
              disabled={busy}
              onClick={() => decide.mutate({ plan_seq: plan.seq, decision: "approved" })}
            >
              Approve
            </ConfirmationAction>
          </ConfirmationActions>
        </Confirmation>
      ) : null}

      {plan.canExecute ? (
        <div className="flex flex-col gap-1.5 border-t border-border bg-surface px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => execute.mutate(plan.seq)} disabled={busy}>
              Apply changes
            </Button>
            {busy ? (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-purple" />{" "}
                Working…
              </span>
            ) : null}
          </div>
          {execute.isError ? (
            <span className="text-[11px] text-destructive">
              {executeErrorMessage(execute.error)}
            </span>
          ) : null}
        </div>
      ) : null}

      {sources.length > 0 ? (
        <div className="border-t border-border px-3.5 py-2.5 text-[11px] text-muted-foreground">
          <InlineCitation>
            <InlineCitationText>
              This plan touches {sources.length} Console item{sources.length === 1 ? "" : "s"}.
            </InlineCitationText>
            <InlineCitationCard>
              <InlineCitationCardTrigger sources={sources.map((source) => source.title)} />
              <InlineCitationCardBody>
                <InlineCitationCarousel>
                  <InlineCitationCarouselHeader>
                    <InlineCitationCarouselPrev />
                    <InlineCitationCarouselNext />
                    <InlineCitationCarouselIndex />
                  </InlineCitationCarouselHeader>
                  <InlineCitationCarouselContent>
                    {sources.map((source) => (
                      <InlineCitationCarouselItem key={source.key}>
                        <InlineCitationSource source={source} />
                      </InlineCitationCarouselItem>
                    ))}
                  </InlineCitationCarouselContent>
                </InlineCitationCarousel>
              </InlineCitationCardBody>
            </InlineCitationCard>
          </InlineCitation>
        </div>
      ) : null}
    </div>
  );
}

// Earlier, already-decided plans collapse to a single outcome row so the stream
// reads as an execution history. Expanding the row reveals the executed steps and
// their per-step capability and outcome straight from the turn ledger.
function PlanHistoryRow({ plan }: { plan: PlanItem }) {
  const decision = planDecision(plan);
  return (
    <Task defaultOpen={false} className="border border-border bg-card/60">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <TaskTrigger title={plan.summary} className="min-w-0 flex-1 text-xs" />
        <div className="flex shrink-0 items-center gap-1">
          {plan.steps.map((step) => (
            <StepStatusDot key={step.id} status={step.status} />
          ))}
        </div>
        <Badge tone={decision.tone}>{decision.label}</Badge>
      </div>
      <TaskContent className="mt-0 px-3 pb-2.5">
        {plan.steps.map((step) => (
          <TaskItem key={step.id} className="flex items-start gap-2">
            <StepStatusDot status={step.status} />
            <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="text-foreground">{step.summary}</span>
              <TaskItemFile>
                <span className="font-mono">{step.capability}</span>
              </TaskItemFile>
              {step.detail ? (
                <span className="text-[11px] text-muted-foreground">{step.detail}</span>
              ) : null}
            </span>
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}

function StepStatusDot({ status }: { status: "pending" | "succeeded" | "failed" }) {
  const tone =
    status === "succeeded"
      ? "bg-emerald-500"
      : status === "failed"
        ? "bg-destructive"
        : "bg-muted-foreground/40";
  return (
    <span className={cx("mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full", tone)} title={status} />
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

/* ------------------------------- helpers ------------------------------- */

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "muted";

function formatRelative(value: string): string {
  const date = new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return value;
  const diff = Date.now() - time;
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

/* -------------------------------- glyphs ------------------------------- */

function OperatorGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3l1.7 4.7L18 9l-4.3 1.6L12 15l-1.7-4.4L6 9z" />
      <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17z" />
    </svg>
  );
}

function PlanGlyph({ className }: { className?: string }) {
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
      <path d="M9 6h11" />
      <path d="M9 12h11" />
      <path d="M9 18h11" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  );
}

function ZoneGlyph({ className }: { className?: string }) {
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
      <path d="M12 2 2 7l10 5 10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  );
}

function PlusGlyph({ className }: { className?: string }) {
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
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function AlertGlyph({ className }: { className?: string }) {
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
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function CloseGlyph({ className }: { className?: string }) {
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

function ExpandGlyph({ className }: { className?: string }) {
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
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </svg>
  );
}

function ShrinkGlyph({ className }: { className?: string }) {
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
      <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
    </svg>
  );
}

function PanelGlyph({ className }: { className?: string }) {
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
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </svg>
  );
}

function PencilGlyph({ className }: { className?: string }) {
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
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

function ArchiveGlyph({ className }: { className?: string }) {
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

function RestoreGlyph({ className }: { className?: string }) {
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
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function LinkGlyph({ className }: { className?: string }) {
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
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
    </svg>
  );
}

function KeyGlyph({ className }: { className?: string }) {
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
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.7 12.3 21 2" />
      <path d="M16 7l3 3" />
    </svg>
  );
}

function PlugGlyph({ className }: { className?: string }) {
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
      <path d="M9 2v6M15 2v6" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0z" />
      <path d="M12 17v5" />
    </svg>
  );
}

function HelpGlyph({ className }: { className?: string }) {
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
      <circle cx="12" cy="12" r="10" />
      <path d="M9.2 9a2.8 2.8 0 0 1 5.4 1c0 2-2.8 2.5-2.8 3.5" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function RotateGlyph({ className }: { className?: string }) {
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
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v4h-4" />
    </svg>
  );
}

function TrimGlyph({ className }: { className?: string }) {
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
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8" />
    </svg>
  );
}

function ArrowUpGlyph({ className }: { className?: string }) {
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
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

function TrashGlyph({ className }: { className?: string }) {
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
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}

function ChevronDownGlyph({ className }: { className?: string }) {
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
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

function EyeGlyph({ className }: { className?: string }) {
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
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function BoltGlyph({ className }: { className?: string }) {
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
      <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
    </svg>
  );
}

function UserCheckGlyph({ className }: { className?: string }) {
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
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="m16 11 2 2 4-4" />
    </svg>
  );
}
