// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Operator composer subsystem: the natural-language input, model selector, usage meter, mode and approval menus, and the pinned composer.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  ModelSelector,
  ModelSelectorCheck,
  ModelSelectorContent,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import {
  ArrowUpGlyph,
  BoltGlyph,
  CheckGlyph,
  ChevronDownGlyph,
  EyeGlyph,
  StarGlyph,
  StopGlyph,
  UserCheckGlyph,
  type Glyph,
} from "@/components/console/OperatorGlyphs";
import { cx } from "@/lib/cx";
import { useOperatorAiStatus } from "@/platform/api/hooks";
import type { OperatorConversationMode } from "@/platform/api/types";

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  maxTokens: number;
  // Whether Caracal fell back from its primary AI provider to a secondary one for any reply this
  // session. Sticky once seen, so a flaky primary stays visible rather than flickering away.
  failover: boolean;
}

export const ZERO_USAGE: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  model: null,
  maxTokens: 0,
  failover: false,
};

export interface ComposerControls {
  mode: OperatorConversationMode;
  onModeChange: (mode: OperatorConversationMode) => void;
  modePending: boolean;
  autopilot: boolean;
  onAutopilotChange: (autopilot: boolean) => void;
  autopilotPending: boolean;
  autopilotAvailable: boolean;
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
}: {
  value: T;
  options: ComposerMenuOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  align?: "left" | "right";
  pending?: boolean;
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
          "inline-flex h-8 items-center gap-1.5 rounded-full border border-transparent px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60",
          open
            ? "bg-accent text-foreground"
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
  { value: "agent", label: "Agent", icon: StarGlyph },
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
    />
  );
}

// The approval-mode picker, shown inside the composer next to the mode selector. The Autopilot
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
    />
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
          {usage.failover ? (
            <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-500" />
              <span>
                Primary model unavailable for a reply this session; Caracal used a fallback.
              </span>
            </p>
          ) : null}
        </ContextContentBody>
        <ContextContentFooter />
      </ContextContent>
    </Context>
  );
}

// The Operator's natural-language input: one glassy composer shared by the pinned
// follow-up bar and the hero entry point. It auto-resizes, sends on Enter (Shift+Enter
// for a newline), and carries a circular send control.
export function OperatorInput({
  value,
  onChange,
  onSubmit,
  onStop,
  pending,
  minHeight,
  autoFocus,
  usage,
  model,
  onModelChange,
  leftSlot,
  history,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  // Stops the send in flight. When provided, the send control becomes a stop control while a
  // message is pending, so the operator can settle a long or runaway turn instead of waiting it out.
  onStop?: () => void;
  pending: boolean;
  minHeight: number;
  autoFocus?: boolean;
  usage?: SessionUsage;
  model?: string | null;
  onModelChange?: (id: string | null) => void;
  leftSlot?: ReactNode;
  history?: string[];
}) {
  const { ref, adjust } = useAutoResizeTextarea({ minHeight, maxHeight: 220 });
  // Where the arrow keys are in this chat's prompt history: null means the live draft, a number
  // indexes an earlier prompt. The draft is stashed on the first recall so arrowing back down past
  // the newest prompt restores exactly what was being typed.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draft = useRef("");
  const caretToEnd = useRef(false);
  const prompts = history ?? [];

  useEffect(() => {
    adjust();
    if (caretToEnd.current && ref.current) {
      const end = ref.current.value.length;
      ref.current.setSelectionRange(end, end);
      caretToEnd.current = false;
    }
  }, [value, adjust, ref]);

  // A fresh set of prompts (a sent message, or switching chats) drops any in-progress recall so the
  // next arrow press starts again from the newest prompt of the current chat.
  useEffect(() => {
    setHistoryIndex(null);
  }, [history]);

  const recall = (index: number | null) => {
    onChange(index === null ? draft.current : prompts[index]);
    setHistoryIndex(index);
    caretToEnd.current = true;
  };

  const canSend = !pending && value.trim().length > 0;

  const textarea = (
    <textarea
      ref={ref}
      autoFocus={autoFocus}
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
        setHistoryIndex(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onSubmit();
          return;
        }
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        if (prompts.length === 0) return;
        const el = event.currentTarget;
        if (el.selectionStart !== el.selectionEnd) return;
        const caret = el.selectionStart;
        if (event.key === "ArrowUp") {
          if (value.slice(0, caret).includes("\n")) return;
          event.preventDefault();
          if (historyIndex === null) {
            draft.current = value;
            recall(prompts.length - 1);
          } else if (historyIndex > 0) {
            recall(historyIndex - 1);
          }
          return;
        }
        if (historyIndex === null) return;
        if (value.slice(caret).includes("\n")) return;
        event.preventDefault();
        recall(historyIndex < prompts.length - 1 ? historyIndex + 1 : null);
      }}
      rows={1}
      placeholder="Describe what you want, or ask a question…"
      aria-label="Message the Operator"
      className="scrollbar-thin w-full resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
      style={{ height: minHeight }}
    />
  );

  const sendButton =
    pending && onStop ? (
      <button
        type="button"
        aria-label="Stop"
        title="Stop"
        onClick={onStop}
        className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-full bg-foreground text-background shadow-sm transition-all hover:bg-foreground/85 active:scale-95"
      >
        <StopGlyph className="h-4 w-4" />
      </button>
    ) : (
      <button
        type="button"
        aria-label="Send"
        onClick={onSubmit}
        disabled={!canSend}
        aria-busy={pending || undefined}
        className={cx(
          "grid h-9 w-9 flex-shrink-0 place-items-center rounded-full transition-all",
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

// The pinned composer used once a conversation has started.
export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  pending,
  usage,
  model,
  onModelChange,
  controls,
  history,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  pending: boolean;
  usage?: SessionUsage;
  model: string | null;
  onModelChange: (id: string | null) => void;
  controls: ComposerControls;
  history?: string[];
}) {
  return (
    <div className="flex-shrink-0 border-t border-border bg-card px-3 py-3">
      <OperatorInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        onStop={onStop}
        pending={pending}
        minHeight={40}
        usage={usage ?? ZERO_USAGE}
        model={model}
        onModelChange={onModelChange}
        history={history}
        leftSlot={
          <>
            <ModeMenu
              mode={controls.mode}
              pending={controls.modePending}
              onChange={controls.onModeChange}
            />
            {controls.mode === "agent" ? (
              <AutopilotMenu
                autopilot={controls.autopilot}
                available={controls.autopilotAvailable}
                pending={controls.autopilotPending}
                onChange={controls.onAutopilotChange}
              />
            ) : null}
          </>
        }
      />
    </div>
  );
}

// The new-conversation hero composer: the same mode and approval menus and auto-resizing
// input as the pinned composer, sized taller and auto-focused for an empty session, and
// without the pinned border so it sits inside the centered welcome layout.
export function HeroComposer({
  value,
  onChange,
  onSubmit,
  pending,
  model,
  onModelChange,
  controls,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
  model: string | null;
  onModelChange: (id: string | null) => void;
  controls: ComposerControls;
}) {
  return (
    <>
      <OperatorInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        pending={pending}
        minHeight={60}
        autoFocus
        usage={ZERO_USAGE}
        model={model}
        onModelChange={onModelChange}
        leftSlot={
          <>
            <ModeMenu
              mode={controls.mode}
              pending={controls.modePending}
              onChange={controls.onModeChange}
            />
            {controls.mode === "agent" ? (
              <AutopilotMenu
                autopilot={controls.autopilot}
                available={controls.autopilotAvailable}
                pending={controls.autopilotPending}
                onChange={controls.onAutopilotChange}
              />
            ) : null}
          </>
        }
      />
    </>
  );
}
