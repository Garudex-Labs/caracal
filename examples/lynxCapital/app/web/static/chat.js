/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Chat panel driver: grouped per-agent turn cards, streaming prose, collapsed
 * tool call rows, model switcher, context meter, memory compaction surfacing.
 */

const $ = (id) => document.getElementById(id);

const stream       = $("chat-stream");
const emptyEl      = $("chat-empty");
const agentCount   = $("agent-count");
const startBtn     = $("start-btn");
const promptInput  = $("prompt-input");
const modelSelect  = $("model-select");
const memFill      = $("mem-fill");
const memTokens    = $("mem-tokens");
const memAgents    = $("mem-agents");
const memCompactions = $("mem-compactions");
const memToggle    = $("mem-toggle");
const memDetail    = $("mem-detail");

const state = {
  runId: null,
  es: null,
  spawned: 0,
  terminated: 0,
  agents: {},       // agent_id -> { label, role: 'fc'|'ro'|'worker', region }
  turns: {},        // `${agent_id}:${message_id}` -> { root, think, tools, meta, groups: {name->row} }
  agentMem: {},     // agent_id -> { tokens_used, tokens_limit, messages, compactions }
  compactions: [],  // [{ agent_id, summary, tokens_before, tokens_after, ts }]
};

/* ---------------- helpers ---------------- */

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

/* ---------------- memory bar ---------------- */

function refreshMemoryBar() {
  // Use the largest single agent memory for the main bar (most pressured).
  let maxUsed = 0, maxLimit = 128_000;
  let totalMessages = 0;
  const ids = Object.keys(state.agentMem);
  for (const id of ids) {
    const m = state.agentMem[id];
    if (!m) continue;
    totalMessages += m.message_count || 0;
    if (m.tokens_used > maxUsed) { maxUsed = m.tokens_used; maxLimit = m.tokens_limit; }
  }
  const pct = maxLimit ? Math.min(100, (maxUsed / maxLimit) * 100) : 0;
  if (memFill) memFill.style.width = pct.toFixed(1) + "%";
  if (memTokens) memTokens.textContent = `${fmtTok(maxUsed)} / ${fmtTok(maxLimit)}`;
  if (memAgents) memAgents.textContent = `${ids.length} agent${ids.length === 1 ? "" : "s"}`;
  if (memCompactions) memCompactions.textContent = `${state.compactions.length} compaction${state.compactions.length === 1 ? "" : "s"}`;
}

function refreshMemDetail() {
  if (!memDetail) return;
  if (state.compactions.length === 0) {
    memDetail.innerHTML = '<div class="mem-detail-empty">No compactions yet. Memory summaries will appear here when context pressure triggers summarization.</div>';
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

/* ---------------- model picker ---------------- */

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
    addInline("error", `Model switch failed`);
  }
});

/* ---------------- rendering primitives ---------------- */

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
  // Group identical-name repeated calls within the same turn.
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
        .filter(([k]) => k !== "focus")
        .map(([k, v]) => `${k}=${String(v).slice(0, 28)}`)
        .join(" ")
    : "";
  body.innerHTML = `<code>${name}</code>${argSummary ? ` <span class="args">\u00b7 ${argSummary}</span>` : ""}`;
  row.append(tk, body);
  turn.tools.append(row);
  turn.groups[name] = { row, count: 1, countPill: null };
  scrollDown();
}

/* ---------------- event handler ---------------- */

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
  // Return the most recently created turn for this agent (for token/meta updates).
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
      // Attach telemetry pill to the most recent turn for this agent.
      const t = findActiveTurn(p.agent_id);
      const label = `<code>${p.model}</code> \u00b7 ${p.latency_ms}ms \u00b7 ${p.input_tokens}\u2192${p.output_tokens} tok${p.tool_calls ? ` \u00b7 ${p.tool_calls} tools` : ""}`;
      if (t) {
        t.meta.innerHTML = label;
      } else {
        addInline("system", `LLM \u00b7 ${label}`);
      }
      break;
    }

    case "tool_call": {
      // Tool call originates from an agent turn. Attach to that agent's most recent turn.
      const t = findActiveTurn(p.agent_id);
      if (p.tool_name === "dispatch_region" && t) {
        appendToolRow(t, "dispatch_region", p.args);
      } else if (t) {
        appendToolRow(t, p.tool_name, p.args);
      }
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

    case "run_end":
      addInline("system", `Run ${p.status || "completed"} <span class="status-pill ${p.status || "completed"}">${p.status || "completed"}</span>`);
      startBtn.disabled = false;
      startBtn.textContent = "Send";
      if (state.es) { state.es.close(); state.es = null; }
      break;

    case "error":
      addInline("error", `Error \u00b7 ${p.message || "unknown"}`);
      break;
  }
}

/* ---------------- run lifecycle ---------------- */

function resetState() {
  state.spawned = 0;
  state.terminated = 0;
  state.agents = {};
  state.turns = {};
  state.agentMem = {};
  state.compactions = [];
  stream.innerHTML = "";
  refreshMemoryBar();
  refreshMemDetail();
}

function startRun() {
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  if (state.es) { state.es.close(); state.es = null; }
  resetState();
  addUser(prompt);
  promptInput.value = "";
  startBtn.disabled = true;
  startBtn.textContent = "Working...";
  if (agentCount) agentCount.textContent = "starting";

  fetch("/api/run/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  })
    .then(r => r.json())
    .then(data => {
      state.runId = data.runId;
      window.dispatchEvent(new CustomEvent("run-started", { detail: { runId: state.runId } }));

      state.es = new EventSource(`/api/run/${state.runId}/events`);
      state.es.onmessage = e => {
        try {
          const ev = JSON.parse(e.data);
          handleEvent(ev);
        } catch (err) {
          /* keepalive */
        }
      };
      state.es.onerror = () => {
        startBtn.disabled = false;
        startBtn.textContent = "Send";
      };
    })
    .catch(() => {
      startBtn.disabled = false;
      startBtn.textContent = "Send";
      addInline("error", "Failed to start run.");
    });
}

startBtn.addEventListener("click", startRun);
promptInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    startRun();
  }
});

loadModelList();
refreshMemoryBar();
