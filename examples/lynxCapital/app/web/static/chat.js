/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Chat panel driver: per-agent turn cards, streaming prose, collapsed tool
 * rows, DeepAgents-style plan panel, file memory events, stop button, model
 * switcher, context meter, compaction summaries.
 */

const $ = (id) => document.getElementById(id);

const stream       = $("chat-stream");
const emptyEl      = $("chat-empty");
const agentCount   = $("agent-count");
const startBtn     = $("start-btn");
const stopBtn      = $("stop-btn");
const pauseBtn     = $("pause-btn");
const promptInput  = $("prompt-input");
const modelSelect  = $("model-select");
const memFill      = $("mem-fill");
const memTokens    = $("mem-tokens");
const memAgents    = $("mem-agents");
const memCompactions = $("mem-compactions");
const memFiles     = $("mem-files");
const memToggle    = $("mem-toggle");
const memDetail    = $("mem-detail");
const planPanel    = $("plan-panel");
const planList     = $("plan-list");
const planMeta     = $("plan-meta");

const state = {
  runId: null,
  es: null,
  spawned: 0,
  terminated: 0,
  agents: {},
  turns: {},
  agentMem: {},
  compactions: [],
  files: new Set(),
  plans: {},
  planOwner: null,
  paused: false,
  queue: [],
};

const PLAN_TOOLS = new Set(["write_todos", "write_file", "read_file", "ls_files"]);

function clearEmpty() { if (emptyEl && emptyEl.parentNode) emptyEl.remove(); }
function scrollDown() { stream.scrollTop = stream.scrollHeight; }

function fmtTok(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function agentLabel(a) {
  if (!a) return "Agent";
  if (a.role === "fc") return "Finance Control";
  if (a.role === "ro") return `Regional Orchestrator \u00b7 ${a.region || "?"}`;
  return a.label || "Agent";
}

function updateHeaderCount() {
  if (!agentCount) return;
  agentCount.textContent = state.spawned
    ? `${state.terminated}/${state.spawned} agents`
    : "idle";
}

function refreshMemoryBar() {
  let maxUsed = 0, maxLimit = 128_000;
  const ids = Object.keys(state.agentMem);
  for (const id of ids) {
    const m = state.agentMem[id];
    if (!m) continue;
    if (m.tokens_used > maxUsed) { maxUsed = m.tokens_used; maxLimit = m.tokens_limit; }
  }
  const pct = maxLimit ? Math.min(100, (maxUsed / maxLimit) * 100) : 0;
  if (memFill) memFill.style.width = pct.toFixed(1) + "%";
  if (memTokens) memTokens.textContent = `${fmtTok(maxUsed)} / ${fmtTok(maxLimit)}`;
  if (memAgents) memAgents.textContent = `${ids.length} agent${ids.length === 1 ? "" : "s"}`;
  if (memCompactions) memCompactions.textContent = `${state.compactions.length} compaction${state.compactions.length === 1 ? "" : "s"}`;
  if (memFiles) memFiles.textContent = `${state.files.size} file${state.files.size === 1 ? "" : "s"}`;
}

function refreshMemDetail() {
  if (!memDetail) return;
  if (state.compactions.length === 0) {
    memDetail.innerHTML = '<div class="mem-detail-empty">No compactions yet.</div>';
    return;
  }
  memDetail.innerHTML = "";
  for (const c of state.compactions) {
    const a = state.agents[c.agent_id];
    const label = a ? agentLabel(a) : (c.agent_id || "agent").slice(0, 8);
    const item = document.createElement("div");
    item.className = "mem-detail-item";
    const head = document.createElement("div");
    head.className = "mem-detail-head";
    head.textContent = `${label} \u00b7 ${fmtTok(c.tokens_before)} \u2192 ${fmtTok(c.tokens_after)}`;
    const body = document.createElement("div");
    body.textContent = c.summary;
    item.append(head, body);
    memDetail.append(item);
  }
}

memToggle?.addEventListener("click", () => {
  const open = memToggle.getAttribute("aria-expanded") === "true";
  memToggle.setAttribute("aria-expanded", open ? "false" : "true");
  memDetail.hidden = open;
  if (!open) refreshMemDetail();
});

function fcAgentId() {
  for (const [id, a] of Object.entries(state.agents)) {
    if (a.role === "fc") return id;
  }
  return null;
}

function renderPlan() {
  const ownerId = state.planOwner || fcAgentId();
  if (!ownerId || !state.plans[ownerId]) {
    if (planPanel) planPanel.hidden = true;
    return;
  }
  const plan = state.plans[ownerId];
  const agent = state.agents[ownerId];
  planPanel.hidden = false;
  const done = plan.items.filter(i => i.status === "completed").length;
  planMeta.textContent = `${agentLabel(agent)} \u00b7 rev ${plan.revision} \u00b7 ${done}/${plan.items.length}`;
  planList.innerHTML = "";
  for (const it of plan.items) {
    const li = document.createElement("li");
    li.className = `plan-item status-${it.status}`;
    const box = document.createElement("span");
    box.className = "box";
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = it.content;
    li.append(box, text);
    planList.append(li);
  }
}

async function loadModelList() {
  if (!modelSelect) return;
  try {
    const r = await fetch("/api/system/model");
    const data = await r.json();
    modelSelect.innerHTML = "";
    for (const m of data.allowed) {
      const opt = document.createElement("option");
      opt.value = m; opt.textContent = m;
      if (m === data.model) opt.selected = true;
      modelSelect.append(opt);
    }
  } catch (err) {
    modelSelect.innerHTML = '<option>gpt-4o</option>';
  }
}

modelSelect?.addEventListener("change", async () => {
  const model = modelSelect.value;
  try {
    const r = await fetch("/api/system/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (!r.ok) throw new Error("bad");
    addInline("system", `Model switched to <code>${model}</code> for the next run.`);
  } catch (err) {
    addInline("error", "Model switch failed");
  }
});

function addUser(text) {
  clearEmpty();
  const wrap = document.createElement("div");
  wrap.className = "msg-user";
  wrap.innerHTML = `<div class="author">You</div><div class="bubble"></div>`;
  wrap.querySelector(".bubble").textContent = text;
  stream.append(wrap);
  scrollDown();
}

function addInline(kind, html) {
  clearEmpty();
  const div = document.createElement("div");
  div.className = `inline-event kind-${kind}`;
  div.innerHTML = `<span class="dot"></span><span>${html}</span>`;
  stream.append(div);
  scrollDown();
}

function ensureTurn(agentId, messageId) {
  const key = `${agentId}:${messageId}`;
  if (state.turns[key]) return state.turns[key];
  clearEmpty();

  const agent = state.agents[agentId] || { role: "worker" };
  const root = document.createElement("div");
  root.className = `turn role-${agent.role || "worker"}`;

  const head = document.createElement("div");
  head.className = "turn-head";
  const role = document.createElement("span");
  role.className = "turn-role";
  role.textContent = agentLabel(agent);
  const meta = document.createElement("span");
  meta.className = "turn-meta";
  meta.textContent = "thinking...";
  head.append(role, meta);

  const think = document.createElement("div");
  think.className = "turn-think empty streaming";

  const tools = document.createElement("div");
  tools.className = "turn-tools";

  root.append(head, think, tools);
  stream.append(root);

  const t = { root, head, think, tools, meta, groups: {} };
  state.turns[key] = t;
  scrollDown();
  return t;
}

function appendToolRow(turn, name, args) {
  if (PLAN_TOOLS.has(name)) return;

  let group = turn.groups[name];
  if (group) {
    group.count += 1;
    if (!group.countPill) {
      group.countPill = document.createElement("span");
      group.countPill.className = "tool-count";
      group.row.append(group.countPill);
      group.row.classList.add("grouped");
    }
    group.countPill.textContent = `\u00d7${group.count}`;
    return;
  }

  const row = document.createElement("div");
  row.className = "tool-row kind-call";
  const tk = document.createElement("span");
  tk.className = "tk";
  tk.textContent = "call";
  const body = document.createElement("span");
  const argSummary = args
    ? Object.entries(args)
        .filter(([k]) => k !== "focus" && k !== "content")
        .map(([k, v]) => `${k}=${String(v).slice(0, 28)}`)
        .join(" ")
    : "";
  body.innerHTML = `<code>${name}</code>${argSummary ? ` <span class="args">\u00b7 ${argSummary}</span>` : ""}`;
  row.append(tk, body);
  turn.tools.append(row);
  turn.groups[name] = { row, count: 1, countPill: null };
  scrollDown();
}

function registerAgent(p) {
  let role = "worker";
  if (p.layer === "finance-control") role = "fc";
  else if (p.layer === "regional-orchestrator") role = "ro";
  state.agents[p.agent_id] = {
    role,
    region: p.region || null,
    label: p.role,
    layer: p.layer,
  };
}

function findActiveTurn(agentId) {
  const keys = Object.keys(state.turns).filter(k => k.startsWith(agentId + ":"));
  if (!keys.length) return null;
  return state.turns[keys[keys.length - 1]];
}

function handleEvent(ev) {
  const p = ev.payload || {};

  switch (ev.kind) {
    case "agent_spawn": {
      state.spawned++;
      registerAgent(p);
      if (p.layer === "finance-control") {
        addInline("agent", `Finance Control spawned`);
      } else if (p.layer === "regional-orchestrator") {
        addInline("agent", `Regional Orchestrator spawned \u00b7 <code>${p.region}</code>`);
      }
      updateHeaderCount();
      break;
    }
    case "agent_terminate": {
      state.terminated++;
      updateHeaderCount();
      const status = p.status;
      if (status === "denied" || status === "failed" || status === "cancelled") {
        const a = state.agents[p.agent_id];
        if (a && (a.layer === "finance-control" || a.layer === "regional-orchestrator")) {
          const kind = status === "cancelled" ? "system" : "error";
          addInline(kind, `${agentLabel(a)} <span class="status-pill ${status}">${status}</span>`);
        }
      }
      break;
    }
    case "caracal_bind": {
      const a = state.agents[p.agent_id];
      if (a && (a.layer === "finance-control" || a.layer === "regional-orchestrator")) {
        addInline("caracal", `Caracal bind \u00b7 ${agentLabel(a)} \u00b7 <code>${p.reason || p.decision}</code>`);
      }
      break;
    }
    case "caracal_enforce": {
      if (p.decision === "deny") {
        const a = state.agents[p.agent_id];
        const who = a ? agentLabel(a) : (p.agent_id || "").slice(0, 8);
        addInline("error", `Caracal denied \u00b7 ${who} \u00b7 <code>${p.tool_id || ""}</code>`);
      }
      break;
    }
    case "chat_user":
      break;
    case "chat_token": {
      const t = ensureTurn(p.agent_id, p.message_id);
      t.think.classList.remove("empty");
      t.think.classList.add("streaming");
      t.think.textContent = (t.think.textContent || "") + p.token;
      scrollDown();
      break;
    }
    case "chat_message": {
      const t = ensureTurn(p.agent_id, p.message_id);
      t.think.classList.remove("streaming");
      if (!t.think.textContent && p.text) t.think.textContent = p.text;
      if (!t.think.textContent) t.think.classList.add("empty");
      break;
    }
    case "llm_call": {
      const t = findActiveTurn(p.agent_id);
      const label = `<code>${p.model}</code> \u00b7 ${p.latency_ms}ms \u00b7 ${p.input_tokens}\u2192${p.output_tokens} tok${p.tool_calls ? ` \u00b7 ${p.tool_calls} tools` : ""}`;
      if (t) t.meta.innerHTML = label;
      else addInline("system", `LLM \u00b7 ${label}`);
      break;
    }
    case "tool_call": {
      const t = findActiveTurn(p.agent_id);
      if (t) appendToolRow(t, p.tool_name, p.args);
      break;
    }
    case "tool_result":
      break;
    case "plan_update": {
      state.plans[p.agent_id] = { revision: p.revision, items: p.todos };
      const fc = fcAgentId();
      if (p.agent_id === fc) state.planOwner = p.agent_id;
      else if (!state.planOwner) state.planOwner = p.agent_id;
      renderPlan();
      const agent = state.agents[p.agent_id];
      const who = agent ? agentLabel(agent) : "agent";
      const done = p.todos.filter(t => t.status === "completed").length;
      addInline("plan", `Plan \u00b7 ${who} \u00b7 ${done}/${p.todos.length} done \u00b7 rev ${p.revision}`);
      break;
    }
    case "file_write": {
      state.files.add(p.path);
      refreshMemoryBar();
      const agent = state.agents[p.agent_id];
      addInline("file", `File write \u00b7 <code>${p.path}</code> \u00b7 ${p.size}B \u00b7 ${agent ? agentLabel(agent) : ""}`);
      break;
    }
    case "file_read": {
      const agent = state.agents[p.agent_id];
      addInline("file", `File read \u00b7 <code>${p.path}</code> \u00b7 ${p.size}B \u00b7 ${agent ? agentLabel(agent) : ""}`);
      break;
    }
    case "audit_record":
      addInline("audit", `Audit recorded \u00b7 <code>${(p.record && p.record.region) || ""}</code>`);
      break;
    case "memory_update": {
      state.agentMem[p.agent_id] = {
        tokens_used: p.tokens_used,
        tokens_limit: p.tokens_limit,
        message_count: p.message_count,
        compactions: p.compactions,
      };
      refreshMemoryBar();
      break;
    }
    case "memory_compaction": {
      state.compactions.push({
        agent_id: p.agent_id,
        summary: p.summary,
        tokens_before: p.tokens_before,
        tokens_after: p.tokens_after,
        ts: ev.ts,
      });
      const a = state.agents[p.agent_id];
      const label = a ? agentLabel(a) : "agent";
      addInline("memory", `Memory compacted \u00b7 ${label} \u00b7 ${fmtTok(p.tokens_before)} \u2192 ${fmtTok(p.tokens_after)} tokens`);
      refreshMemoryBar();
      if (memToggle?.getAttribute("aria-expanded") === "true") refreshMemDetail();
      break;
    }
    case "model_change":
      addInline("system", `Model changed: <code>${p.prior}</code> \u2192 <code>${p.model}</code>`);
      break;
    case "run_cancelled":
      addInline("system", `Run cancelled by user.`);
      break;
    case "run_end":
      addInline("system", `Run <span class="status-pill ${p.status || "completed"}">${p.status || "completed"}</span>`);
      finishRun();
      break;
    case "error":
      addInline("error", `Error \u00b7 ${p.message || "unknown"}`);
      break;
  }
}

function resetState() {
  state.spawned = 0;
  state.terminated = 0;
  state.agents = {};
  state.turns = {};
  state.agentMem = {};
  state.compactions = [];
  state.files = new Set();
  state.plans = {};
  state.planOwner = null;
  state.paused = false;
  state.queue = [];
  stream.innerHTML = "";
  planPanel.hidden = true;
  planList.innerHTML = "";
  if (pauseBtn) { pauseBtn.hidden = true; pauseBtn.textContent = "Pause"; }
  refreshMemoryBar();
  refreshMemDetail();
}

function finishRun() {
  startBtn.hidden = false;
  startBtn.disabled = false;
  startBtn.textContent = "Send";
  stopBtn.hidden = true;
  if (pauseBtn) { pauseBtn.hidden = true; pauseBtn.textContent = "Pause"; }
  state.paused = false;
  if (state.es) { state.es.close(); state.es = null; }
}

async function stopRun() {
  if (!state.runId) return;
  stopBtn.disabled = true;
  stopBtn.textContent = "Cancelling...";
  try {
    await fetch(`/api/run/${state.runId}/cancel`, { method: "POST" });
  } catch (err) {
    addInline("error", "Cancel request failed.");
  }
}

function startRun() {
  const prompt = promptInput.value.trim();
  if (!prompt) return;
  if (state.es) { state.es.close(); state.es = null; }
  resetState();
  addUser(prompt);
  promptInput.value = "";
  startBtn.hidden = true;
  stopBtn.hidden = false;
  stopBtn.disabled = false;
  stopBtn.textContent = "Cancel";
  if (pauseBtn) pauseBtn.hidden = false;
  if (agentCount) agentCount.textContent = "starting";

  fetch("/api/run/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  })
    .then(r => r.json())
    .then(data => {
      state.runId = data.runId;
      try { localStorage.setItem("lynx.runId", data.runId); } catch (_) {}
      window.dispatchEvent(new CustomEvent("run-started", { detail: { runId: state.runId } }));
      attachStream(state.runId, /*active=*/true);
    })
    .catch(() => {
      finishRun();
      addInline("error", "Failed to start run.");
    });
}

function attachStream(runId, active) {
  state.es = new EventSource(`/api/run/${runId}/events`);
  state.es.onmessage = e => {
    try {
      const ev = JSON.parse(e.data);
      if (state.paused) { state.queue.push(ev); }
      else { handleEvent(ev); }
    }
    catch (err) { /* keepalive */ }
  };
  state.es.onerror = () => { /* server closes on completion */ };
  if (!active) {
    // The run already ended server-side; replay will arrive, then stream closes.
    stopBtn.hidden = true;
    startBtn.hidden = false;
  }
}

async function tryResume() {
  let saved = null;
  try { saved = localStorage.getItem("lynx.runId"); } catch (_) { return; }
  if (!saved) return;
  try {
    const r = await fetch(`/api/run/${saved}/status`);
    if (!r.ok) { localStorage.removeItem("lynx.runId"); return; }
    const data = await r.json();
    state.runId = saved;
    clearEmpty();
    addInline("system", `Reattached to run <code>${saved.slice(0, 8)}</code> \u00b7 ${data.active ? "still running" : data.status} \u00b7 replaying ${data.events} events`);
    if (data.active) {
      startBtn.hidden = true;
      stopBtn.hidden = false;
      stopBtn.disabled = false;
      stopBtn.textContent = "Cancel";
      if (pauseBtn) pauseBtn.hidden = false;
      if (agentCount) agentCount.textContent = "resuming";
    }
    window.dispatchEvent(new CustomEvent("run-started", { detail: { runId: saved } }));
    attachStream(saved, data.active);
  } catch (err) {
    /* run expired or server restarted */
    try { localStorage.removeItem("lynx.runId"); } catch (_) {}
  }
}

startBtn.addEventListener("click", startRun);
stopBtn.addEventListener("click", stopRun);
pauseBtn?.addEventListener("click", () => {
  state.paused = !state.paused;
  pauseBtn.textContent = state.paused ? "Resume" : "Pause";
  if (!state.paused) {
    const queued = state.queue.splice(0);
    for (const ev of queued) handleEvent(ev);
  }
});
promptInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    startRun();
  }
});

loadModelList();
refreshMemoryBar();
tryResume();
