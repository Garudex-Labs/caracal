/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Chat panel driver: template-based live stream rendering with batched
 * updates, structured execution blocks, and persistent run history.
 */

const $ = (id) => document.getElementById(id);

const stream = $("chat-stream");
const emptyEl = $("chat-empty");
const agentCount = $("agent-count");
const startBtn = $("start-btn");
const stopBtn = $("stop-btn");
const pauseBtn = $("pause-btn");
const promptInput = $("prompt-input");
const modelSelect = $("model-select");
const memFill = $("mem-fill");
const memTokens = $("mem-tokens");
const memAgents = $("mem-agents");
const memCompactions = $("mem-compactions");
const memFiles = $("mem-files");
const memToggle = $("mem-toggle");
const memDetail = $("mem-detail");
const planPanel = $("plan-panel");
const planList = $("plan-list");
const planMeta = $("plan-meta");
const planStatus = $("plan-status");
const planToggle = $("plan-toggle");
const planActivePreview = $("plan-active-preview");
const clearChatBtn = $("clear-chat-btn");
const newChatBtn = $("new-chat-btn");

const tplUserMessage = $("tpl-user-message");
const tplAgentTurn = $("tpl-agent-turn");
const tplEventBlock = $("tpl-event-block");
const tplPlanItem = $("tpl-plan-item");

const PLAN_TOOLS = new Set(["write_todos", "write_file", "read_file", "ls_files"]);
const FRAME_EVENT_LIMIT = 180;

const state = {
  runId: null,
  active: false,
  es: null,
  spawned: 0,
  terminated: 0,
  agents: {},
  turns: {},
  turnOrder: [],
  lastTurnByAgent: {},
  agentMem: {},
  compactions: [],
  files: new Set(),
  plans: {},
  planOwner: null,
  paused: false,
  queue: [],
  pendingEvents: [],
  flushHandle: 0,
  dirtyTurns: new Set(),
  pendingScrollForce: false,
  pendingScrollSmooth: false,
  autoScroll: true,
};

function cloneTemplate(template) {
  return template.content.firstElementChild.cloneNode(true);
}

function fmtTok(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function shortId(id) {
  return String(id || "").slice(0, 8);
}

function formatTime(ts = Date.now()) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function titleCase(value) {
  return String(value || "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function truncate(value, limit = 180) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

function summarizeObject(value, limit = 180) {
  if (value == null) return "";
  if (typeof value === "string") return truncate(value, limit);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return truncate(value.map((item) => summarizeObject(item, 40)).join(", "), limit);
  const parts = Object.entries(value)
    .slice(0, 6)
    .map(([key, val]) => `${key}: ${truncate(formatScalar(val), 48)}`);
  return truncate(parts.join(" | "), limit);
}

function formatScalar(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "";
  return truncate(
    Object.entries(args)
      .filter(([key]) => key !== "focus" && key !== "content")
      .map(([key, value]) => `${key}=${truncate(formatScalar(value), 36)}`)
      .join("  "),
    180,
  );
}

function clearEmpty() {
  if (emptyEl && emptyEl.parentNode) emptyEl.remove();
}

function isNearBottom() {
  return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 72;
}

function requestScroll({ force = false, smooth = false } = {}) {
  state.pendingScrollForce = state.pendingScrollForce || force;
  state.pendingScrollSmooth = state.pendingScrollSmooth || smooth;
}

function flushScroll() {
  const shouldScroll = state.pendingScrollForce || state.autoScroll;
  if (!shouldScroll) {
    state.pendingScrollForce = false;
    state.pendingScrollSmooth = false;
    return;
  }
  stream.scrollTo({
    top: stream.scrollHeight,
    behavior: state.pendingScrollSmooth ? "smooth" : "auto",
  });
  state.pendingScrollForce = false;
  state.pendingScrollSmooth = false;
}

function planStatusLabel(status) {
  if (status === "in_progress") return "Running";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  return "Pending";
}

function planStatusClass(status) {
  if (status === "in_progress") return "running";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "pending";
}

function computeOverallPlanStatus(items) {
  if (!items.length) return "pending";
  if (items.some((item) => item.status === "failed")) return "failed";
  if (items.some((item) => item.status === "in_progress")) return "running";
  if (items.every((item) => item.status === "completed")) return "completed";
  return "pending";
}

function layerLabel(agent) {
  if (!agent) return "Agent";
  const raw = agent.layer || agent.label || "agent";
  return titleCase(raw);
}

function agentLabel(agent) {
  if (!agent) return "Agent";
  const base = layerLabel(agent);
  return agent.region ? `${base} ${agent.region}` : base;
}

function toneClass(agent) {
  if (!agent) return "tone-worker";
  if (agent.layer === "finance-control") return "tone-fc";
  if (agent.layer === "regional-orchestrator") return "tone-ro";
  return "tone-worker";
}

function updateHeaderCount() {
  if (!agentCount) return;
  if (!state.spawned) {
    agentCount.textContent = state.active ? "Starting..." : "Idle";
    return;
  }
  const running = Math.max(0, state.spawned - state.terminated);
  agentCount.textContent = running
    ? `${running} running / ${state.spawned} total`
    : `${state.spawned} total - ${state.terminated} finished`;
}

function refreshMemoryBar() {
  let maxUsed = 0;
  let maxLimit = 128_000;
  const ids = Object.keys(state.agentMem);

  for (const id of ids) {
    const mem = state.agentMem[id];
    if (!mem) continue;
    if (mem.tokens_used > maxUsed) {
      maxUsed = mem.tokens_used;
      maxLimit = mem.tokens_limit;
    }
  }

  const pct = maxLimit ? Math.min(100, (maxUsed / maxLimit) * 100) : 0;
  if (memFill) memFill.style.width = `${pct.toFixed(1)}%`;
  if (memTokens) memTokens.textContent = `${fmtTok(maxUsed)} / ${fmtTok(maxLimit)}`;
  if (memAgents) memAgents.textContent = `${ids.length} agent${ids.length === 1 ? "" : "s"}`;
  if (memCompactions) memCompactions.textContent = `${state.compactions.length} compaction${state.compactions.length === 1 ? "" : "s"}`;
  if (memFiles) memFiles.textContent = `${state.files.size} file${state.files.size === 1 ? "" : "s"}`;
}

function refreshMemDetail() {
  if (!memDetail) return;
  if (!state.compactions.length) {
    memDetail.innerHTML = '<div class="mem-detail-empty">No compactions yet.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const compaction of state.compactions) {
    const item = document.createElement("div");
    item.className = "mem-detail-item";

    const head = document.createElement("div");
    head.className = "mem-detail-head";
    const agent = state.agents[compaction.agent_id];
    head.textContent = `${agentLabel(agent)} - ${fmtTok(compaction.tokens_before)} -> ${fmtTok(compaction.tokens_after)}`;

    const body = document.createElement("div");
    body.textContent = compaction.summary;

    item.append(head, body);
    frag.append(item);
  }

  memDetail.replaceChildren(frag);
}

function renderPlan() {
  const ownerId = state.planOwner || findFinanceControlId();
  const plan = ownerId ? state.plans[ownerId] : null;
  if (!ownerId || !plan || plan.items.length === 0) {
    planPanel.hidden = true;
    return;
  }

  const owner = state.agents[ownerId];
  const done = plan.items.filter((item) => item.status === "completed").length;
  const overall = computeOverallPlanStatus(plan.items);

  planPanel.hidden = false;
  planMeta.textContent = `${done}/${plan.items.length}`;
  planStatus.className = `plan-status status-${overall}`;
  planStatus.textContent = titleCase(overall);

  let activeText = "";
  const frag = document.createDocumentFragment();
  plan.items.forEach((item, index) => {
    if (item.status === "in_progress" || (item.status === "pending" && !activeText)) {
      activeText = item.content;
    }
    const row = cloneTemplate(tplPlanItem);
    const statusClass = planStatusClass(item.status);
    row.className = `plan-item status-${statusClass}`;
    row.querySelector(".plan-step-index").textContent = String(index + 1) + ".";
    row.querySelector(".plan-step-text").textContent = item.content;
    frag.append(row);
  });
  
  planActivePreview.textContent = activeText ? `Next up: ${activeText.substring(0, 35)}...` : "";
  planList.replaceChildren(frag);
}

function findFinanceControlId() {
  for (const [id, agent] of Object.entries(state.agents)) {
    if (agent.layer === "finance-control") return id;
  }
  return null;
}

function registerAgent(payload) {
  state.agents[payload.agent_id] = {
    role: payload.role,
    label: payload.role,
    layer: payload.layer,
    region: payload.region || null,
  };
}

function createEventBlock(kind, options = {}) {
  const block = cloneTemplate(tplEventBlock);
  block.classList.remove("kind-system");
  block.classList.add(`kind-${kind}`);
  if (options.surface) block.classList.add(`event-block-${options.surface}`);

  const kicker = block.querySelector(".event-kicker");
  const title = block.querySelector(".event-title");
  const pill = block.querySelector(".event-pill");
  const meta = block.querySelector(".event-meta");
  const body = block.querySelector(".event-body");

  kicker.textContent = options.kicker || "";
  title.textContent = options.title || "";
  meta.textContent = options.meta || "";

  if (options.pill) {
    pill.hidden = false;
    pill.textContent = options.pill;
  }

  if (options.body) {
    body.hidden = false;
    body.textContent = options.body;
  }

  return block;
}

function addInline(kind, options) {
  clearEmpty();
  stream.append(createEventBlock(kind, { surface: "stream", meta: formatTime(), ...options }));
  requestScroll({ smooth: true });
}

function addUser(text) {
  clearEmpty();
  const node = cloneTemplate(tplUserMessage);
  node.querySelector(".message-time").textContent = formatTime();
  node.querySelector(".message-bubble").textContent = text;
  stream.append(node);
  requestScroll({ force: true, smooth: true });
}

function setTurnStatus(turn, label, stateClass) {
  turn.status.textContent = label;
  turn.status.className = `message-status-pill state-${stateClass}`;
}

function ensureTurn(agentId, messageId) {
  const key = `${agentId}:${messageId}`;
  if (state.turns[key]) return state.turns[key];

  clearEmpty();

  const agent = state.agents[agentId] || { layer: "agent" };
  const node = cloneTemplate(tplAgentTurn);
  node.classList.remove("tone-worker");
  node.classList.add(toneClass(agent));

  node.querySelector(".message-author").textContent = agentLabel(agent);
  const timeNode = node.querySelector(".message-time");
  if (timeNode) timeNode.textContent = formatTime();
  node.querySelector(".message-subtitle").textContent = agent.region
    ? `${layerLabel(agent)} - ${agent.region}`
    : layerLabel(agent);

  const turn = {
    key,
    agentId,
    root: node,
    status: node.querySelector(".message-status-pill"),
    telemetry: node.querySelector(".message-telemetry"),
    reasoningSection: node.querySelector(".message-section-reasoning"),
    reasoningBody: node.querySelector(".reasoning-body"),
    executionSection: node.querySelector(".message-section-execution"),
    executionList: node.querySelector(".execution-list"),
    reasoningText: "",
    pendingText: "",
    finalText: "",
    streaming: true,
  };

  setTurnStatus(turn, "Thinking", "thinking");

  state.turns[key] = turn;
  state.lastTurnByAgent[agentId] = key;
  state.turnOrder.push(key);

  stream.append(node);
  requestScroll({ smooth: true });
  return turn;
}

function findActiveTurn(agentId) {
  const key = state.lastTurnByAgent[agentId];
  return key ? state.turns[key] : null;
}

function appendExecutionEvent(turn, kind, options) {
  turn.executionSection.hidden = false;
  turn.executionList.append(createEventBlock(kind, { surface: "turn", meta: formatTime(), ...options }));
  requestScroll({ smooth: true });
}

function markTurnDirty(turn) {
  state.dirtyTurns.add(turn);
}

function flushDirtyTurns() {
  if (!state.dirtyTurns.size) return;

  for (const turn of state.dirtyTurns) {
    if (turn.pendingText) {
      turn.reasoningText += turn.pendingText;
      turn.pendingText = "";
    }

    if (turn.finalText && turn.finalText.length > turn.reasoningText.length) {
      turn.reasoningText = turn.finalText;
    } else if (!turn.reasoningText && turn.finalText) {
      turn.reasoningText = turn.finalText;
    }

    turn.reasoningSection.hidden = !turn.reasoningText;
    turn.reasoningBody.textContent = turn.reasoningText;
    turn.reasoningBody.classList.toggle("is-streaming", turn.streaming);
  }

  state.dirtyTurns.clear();
}

function describeToolResult(toolName, result) {
  const body = summarizeObject(result);
  return body || `${toolName} returned successfully`;
}

function queueIncomingEvent(event) {
  state.pendingEvents.push(event);
  scheduleFlush();
}

function scheduleFlush() {
  if (state.flushHandle) return;
  state.flushHandle = window.requestAnimationFrame(flushEventQueue);
}

function flushEventQueue() {
  state.flushHandle = 0;
  const batch = state.pendingEvents.splice(0, FRAME_EVENT_LIMIT);
  for (const event of batch) handleEvent(event);
  flushDirtyTurns();
  flushScroll();
  if (state.pendingEvents.length) scheduleFlush();
}

function handleEvent(event) {
  const payload = event.payload || {};

  switch (event.kind) {
    case "run_start":
      addInline("system", {
        kicker: "Run",
        title: "Execution started",
        body: payload.prompt ? truncate(payload.prompt, 220) : "",
      });
      break;

    case "agent_spawn": {
      state.spawned += 1;
      registerAgent(payload);
      updateHeaderCount();
      addInline("spawn", {
        kicker: "Spawn",
        title: `${agentLabel(state.agents[payload.agent_id])} spawned`,
        body: payload.scope ? `Scope: ${payload.scope}` : "",
      });
      break;
    }

    case "delegation": {
      const parent = state.agents[payload.parent_id];
      const child = state.agents[payload.child_id];
      addInline("spawn", {
        kicker: "Delegation",
        title: `${agentLabel(parent)} delegated to ${agentLabel(child)}`,
        body: payload.scope ? `Scope: ${payload.scope}` : "",
      });
      break;
    }

    case "agent_terminate": {
      state.terminated += 1;
      updateHeaderCount();
      const agent = state.agents[payload.agent_id];
      addInline(payload.status === "failed" || payload.status === "denied" ? "error" : "system", {
        kicker: "Agent",
        title: `${agentLabel(agent)} finished`,
        pill: titleCase(payload.status || "completed"),
      });
      break;
    }

    case "chat_user":
      break;

    case "chat_token": {
      const turn = ensureTurn(payload.agent_id, payload.message_id);
      turn.streaming = true;
      turn.pendingText += payload.token;
      setTurnStatus(turn, "Thinking", "thinking");
      markTurnDirty(turn);
      requestScroll();
      break;
    }

    case "chat_message": {
      const turn = ensureTurn(payload.agent_id, payload.message_id);
      turn.streaming = false;
      turn.finalText = payload.text || "";
      markTurnDirty(turn);
      setTurnStatus(turn, "Response ready", "ready");
      break;
    }

    case "llm_call": {
      const turn = findActiveTurn(payload.agent_id);
      const summary = `${payload.model} | ${payload.latency_ms}ms | ${payload.input_tokens}\u2192${payload.output_tokens} tok`;
      if (turn) {
        turn.telemetry.textContent = payload.tool_calls
          ? `${summary} | ${payload.tool_calls} tools`
          : summary;
        if (payload.tool_calls) {
          setTurnStatus(turn, `Prepared ${payload.tool_calls} action${payload.tool_calls === 1 ? "" : "s"}`, "ready");
        }
      } else {
        addInline("system", {
          kicker: "Model",
          title: "LLM completed a response",
          body: summary,
        });
      }
      break;
    }

    case "tool_call": {
      if (PLAN_TOOLS.has(payload.tool_name)) break;
      const turn = findActiveTurn(payload.agent_id);
      if (!turn) break;
      setTurnStatus(turn, "Executing", "executing");
      appendExecutionEvent(turn, "tool", {
        kicker: "Tool call",
        title: payload.tool_name,
        body: summarizeArgs(payload.args),
      });
      break;
    }

    case "service_call": {
      const turn = findActiveTurn(payload.agent_id);
      if (!turn) break;
      appendExecutionEvent(turn, "tool", {
        kicker: "Service",
        title: `${payload.service_id} - ${payload.action}`,
        body: summarizeArgs(payload.payload),
      });
      break;
    }

    case "service_result": {
      const turn = findActiveTurn(payload.agent_id);
      if (!turn) break;
      appendExecutionEvent(turn, "result", {
        kicker: "Service result",
        title: `${payload.service_id} completed`,
        body: summarizeObject(payload.result),
      });
      break;
    }

    case "tool_result": {
      if (PLAN_TOOLS.has(payload.tool_name)) break;
      const turn = findActiveTurn(payload.agent_id);
      if (!turn) break;
      appendExecutionEvent(turn, "result", {
        kicker: "Tool result",
        title: payload.tool_name,
        body: describeToolResult(payload.tool_name, payload.result),
      });
      setTurnStatus(turn, "Response ready", "ready");
      break;
    }

    case "plan_update": {
      state.plans[payload.agent_id] = { revision: payload.revision, items: payload.todos || [] };
      const financeControl = findFinanceControlId();
      if (payload.agent_id === financeControl) state.planOwner = payload.agent_id;
      else if (!state.planOwner) state.planOwner = payload.agent_id;

      renderPlan();

      const agent = state.agents[payload.agent_id];
      const done = (payload.todos || []).filter((item) => item.status === "completed").length;
      addInline("plan", {
        kicker: "Plan",
        title: `${agentLabel(agent)} updated the checklist`,
        body: `${done}/${(payload.todos || []).length} complete - rev ${payload.revision}`,
      });
      break;
    }

    case "file_write": {
      state.files.add(payload.path);
      refreshMemoryBar();
      addInline("file", {
        kicker: "File write",
        title: payload.path,
        body: `${payload.size}B - ${agentLabel(state.agents[payload.agent_id])}`,
      });
      break;
    }

    case "file_read":
      addInline("file", {
        kicker: "File read",
        title: payload.path,
        body: `${payload.size}B - ${agentLabel(state.agents[payload.agent_id])}`,
      });
      break;

    case "memory_update":
      state.agentMem[payload.agent_id] = {
        tokens_used: payload.tokens_used,
        tokens_limit: payload.tokens_limit,
        message_count: payload.message_count,
        compactions: payload.compactions,
      };
      refreshMemoryBar();
      break;

    case "memory_compaction": {
      state.compactions.push({
        agent_id: payload.agent_id,
        summary: payload.summary,
        tokens_before: payload.tokens_before,
        tokens_after: payload.tokens_after,
        ts: event.ts,
      });
      refreshMemoryBar();
      if (memToggle?.getAttribute("aria-expanded") === "true") refreshMemDetail();
      addInline("memory", {
        kicker: "Memory",
        title: `${agentLabel(state.agents[payload.agent_id])} compacted context`,
        body: `${fmtTok(payload.tokens_before)} -> ${fmtTok(payload.tokens_after)} tokens`,
      });
      break;
    }

    case "caracal_bind":
      addInline("caracal", {
        kicker: "Caracal",
        title: `${agentLabel(state.agents[payload.agent_id])} bound to policy scope`,
        body: payload.reason || payload.decision || "",
      });
      break;

    case "caracal_enforce":
      addInline(payload.decision === "deny" ? "error" : "caracal", {
        kicker: "Policy",
        title: `${payload.decision === "deny" ? "Denied" : "Allowed"} ${payload.tool_id || "tool access"}`,
        body: payload.reason || "",
      });
      break;

    case "audit_record":
      addInline("audit", {
        kicker: "Audit",
        title: "Audit record created",
        body: summarizeObject(payload.record),
      });
      break;

    case "model_change":
      addInline("system", {
        kicker: "Model",
        title: `Switched from ${payload.prior} to ${payload.model}`,
      });
      break;

    case "run_cancelled":
      addInline("system", {
        kicker: "Run",
        title: "Run cancelled by user",
      });
      break;

    case "run_end":
      addInline(payload.status === "failed" ? "error" : "system", {
        kicker: "Run",
        title: "Execution finished",
        pill: titleCase(payload.status || "completed"),
      });
      finishRun();
      break;

    case "error":
      addInline("error", {
        kicker: "Error",
        title: payload.message || "Unknown error",
      });
      break;
  }
}

function resetState() {
  state.active = false;
  state.spawned = 0;
  state.terminated = 0;
  state.agents = {};
  state.turns = {};
  state.turnOrder = [];
  state.lastTurnByAgent = {};
  state.agentMem = {};
  state.compactions = [];
  state.files = new Set();
  state.plans = {};
  state.planOwner = null;
  state.paused = false;
  state.queue = [];
  state.pendingEvents = [];
  state.dirtyTurns.clear();
  state.pendingScrollForce = false;
  state.pendingScrollSmooth = false;

  if (stream.children.length > 0) {
    const separator = document.createElement("div");
    separator.className = "run-separator";
    separator.textContent = "New run";
    stream.append(separator);
  }

  planPanel.hidden = true;
  planList.replaceChildren();
  planMeta.textContent = "";
  planStatus.className = "plan-status status-pending";
  planStatus.textContent = "Pending";

  if (pauseBtn) {
    pauseBtn.hidden = true;
    pauseBtn.textContent = "Pause";
  }

  refreshMemoryBar();
  refreshMemDetail();
  updateHeaderCount();
}

function finishRun() {
  state.active = false;
  startBtn.hidden = false;
  startBtn.disabled = false;
  startBtn.textContent = "Send";
  stopBtn.hidden = true;
  stopBtn.disabled = false;
  stopBtn.textContent = "Cancel";

  if (pauseBtn) {
    pauseBtn.hidden = true;
    pauseBtn.textContent = "Pause";
  }

  state.paused = false;
  if (state.es) {
    state.es.close();
    state.es = null;
  }

  updateHeaderCount();
}

async function stopRun() {
  if (!state.runId) return;
  stopBtn.disabled = true;
  stopBtn.textContent = "Cancelling...";
  try {
    await fetch(`/api/run/${state.runId}/cancel`, { method: "POST" });
  } catch {
    addInline("error", {
      kicker: "Error",
      title: "Cancel request failed",
    });
  }
}

function autoResizeInput() {
  promptInput.style.height = "0px";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 200)}px`;
}

function startRun() {
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  if (state.es) {
    state.es.close();
    state.es = null;
  }

  resetState();
  addUser(prompt);
  promptInput.value = "";
  autoResizeInput();

  state.active = true;
  startBtn.hidden = true;
  stopBtn.hidden = false;
  stopBtn.disabled = false;
  stopBtn.textContent = "Cancel";
  if (pauseBtn) pauseBtn.hidden = false;
  if (agentCount) agentCount.textContent = "Starting...";

  fetch("/api/run/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  })
    .then((response) => response.json())
    .then((data) => {
      state.runId = data.runId;
      try {
        localStorage.setItem("lynx.runId", data.runId);
      } catch {
        /* ignore local storage errors */
      }
      window.dispatchEvent(new CustomEvent("run-started", { detail: { runId: state.runId } }));
      attachStream(state.runId, true);
    })
    .catch(() => {
      finishRun();
      addInline("error", {
        kicker: "Error",
        title: "Failed to start run",
      });
    });
}

function attachStream(runId, active) {
  state.es = new EventSource(`/api/run/${runId}/events`);
  state.active = active;

  state.es.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data);
      if (state.paused) state.queue.push(event);
      else queueIncomingEvent(event);
    } catch {
      /* keepalive */
    }
  };

  state.es.onerror = () => {
    /* server closes the stream on completion */
  };

  if (!active) {
    stopBtn.hidden = true;
    startBtn.hidden = false;
    updateHeaderCount();
  }
}

async function tryResume() {
  let saved = null;
  try {
    saved = localStorage.getItem("lynx.runId");
  } catch {
    return;
  }
  if (!saved) return;

  try {
    const response = await fetch(`/api/run/${saved}/status`);
    if (!response.ok) {
      localStorage.removeItem("lynx.runId");
      return;
    }

    const data = await response.json();
    state.runId = saved;
    addInline("system", {
      kicker: "Run",
      title: `Reattached to ${shortId(saved)}`,
      body: data.active ? `Still running - replaying ${data.events} events` : `${titleCase(data.status)} - replaying ${data.events} events`,
    });

    if (data.active) {
      state.active = true;
      startBtn.hidden = true;
      stopBtn.hidden = false;
      stopBtn.disabled = false;
      stopBtn.textContent = "Cancel";
      if (pauseBtn) pauseBtn.hidden = false;
      if (agentCount) agentCount.textContent = "Reattaching...";
    }

    window.dispatchEvent(new CustomEvent("run-started", { detail: { runId: saved } }));
    attachStream(saved, data.active);
  } catch {
    try {
      localStorage.removeItem("lynx.runId");
    } catch {
      /* ignore */
    }
  }
}

async function loadModelList() {
  if (!modelSelect) return;
  try {
    const response = await fetch("/api/system/model");
    const data = await response.json();
    modelSelect.replaceChildren();

    for (const model of data.allowed) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      if (model === data.model) option.selected = true;
      modelSelect.append(option);
    }
  } catch {
    modelSelect.innerHTML = "<option>gpt-4o</option>";
  }
}

memToggle?.addEventListener("click", () => {
  const expanded = memToggle.getAttribute("aria-expanded") === "true";
  memToggle.setAttribute("aria-expanded", expanded ? "false" : "true");
  memDetail.hidden = expanded;
  if (!expanded) refreshMemDetail();
});

modelSelect?.addEventListener("change", async () => {
  const model = modelSelect.value;
  try {
    const response = await fetch("/api/system/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (!response.ok) throw new Error("bad response");
    addInline("system", {
      kicker: "Model",
      title: `Switched to ${model} for the next run`,
    });
  } catch {
    addInline("error", {
      kicker: "Model",
      title: "Model switch failed",
    });
  }
});

planToggle.addEventListener("click", () => {
  planPanel.classList.toggle("plan-collapsed");
  planActivePreview.style.display = planPanel.classList.contains("plan-collapsed") ? "" : "none";
});

clearChatBtn.addEventListener("click", () => {
  if (confirm("Clear current chat history view?")) {
    stream.replaceChildren();
    emptyEl.style.display = "flex";
    stream.appendChild(emptyEl);
  }
});

newChatBtn.addEventListener("click", async () => {
  if (confirm("Start a completely new session?")) {
    try {
      await fetch("/api/memories", { method: "DELETE" });
      location.reload();
    } catch(e) {
      console.error(e);
      location.reload();
    }
  }
});

startBtn.addEventListener("click", startRun);
stopBtn.addEventListener("click", stopRun);

pauseBtn?.addEventListener("click", () => {
  state.paused = !state.paused;
  pauseBtn.textContent = state.paused ? "Resume" : "Pause";
  if (!state.paused) {
    const queued = state.queue.splice(0);
    for (const event of queued) queueIncomingEvent(event);
  }
});

promptInput.addEventListener("input", autoResizeInput);
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    startRun();
  }
});

stream.addEventListener("scroll", () => {
  state.autoScroll = isNearBottom();
});

loadModelList();
refreshMemoryBar();
refreshMemDetail();
updateHeaderCount();
tryResume();
autoResizeInput();

window.runActive = () => state.active;
