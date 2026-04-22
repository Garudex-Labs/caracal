/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Chat panel: subscribes to the per-run SSE stream and renders events.
 */

const stream     = document.getElementById('chat-stream');
const emptyEl    = document.getElementById('chat-empty');
const agentCount = document.getElementById('agent-count');
const startBtn   = document.getElementById('start-btn');
const cancelBtn  = document.getElementById('cancel-btn');
const runStatus  = document.getElementById('run-status');
const promptInput = document.getElementById('prompt-input');

let currentRunId = null;
let es = null;
let spawned = 0;
let terminated = 0;

function ts(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleTimeString('en-US', {hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit'}) +
         '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function pill(status) {
  return `<span class="status-pill ${status}">${status}</span>`;
}

function appendEntry(category, html, tsStr) {
  if (emptyEl) emptyEl.style.display = 'none';
  const div = document.createElement('div');
  div.className = `chat-entry ${category}`;
  div.innerHTML = `<div class="ts">${tsStr || ''}</div>${html}`;
  stream.appendChild(div);
  stream.scrollTop = stream.scrollHeight;
}

function summarize(ev) {
  const p = ev.payload || {};
  switch (ev.kind) {
    case 'run_start':    return `<span class="badge">run</span> Run started`;
    case 'run_end':      return `<span class="badge">run</span> Run ${p.status || 'ended'}`;
    case 'agent_spawn':  return `<span class="badge">spawn</span> ${p.role} &mdash; ${p.region || 'global'} ${pill('spawned')}`;
    case 'agent_start':  return `<span class="badge">start</span> Agent active ${pill('running')}`;
    case 'agent_end':    return `<span class="badge">end</span> Agent finished ${pill('completed')}`;
    case 'agent_terminate': return `<span class="badge">term</span> ${pill(p.status || 'completed')}`;
    case 'tool_call':    return `<span class="badge tool">tool</span> ${p.tool_name}`;
    case 'tool_result':  return `<span class="badge tool">result</span> ${p.tool_name} returned`;
    case 'service_call': return `<span class="badge tool">svc</span> ${p.service_id} &rarr; ${p.action}`;
    case 'delegation':   return `<span class="badge">delegate</span> scope: ${p.scope || ''}`;
    case 'audit_record': return `<span class="badge audit">audit</span> record logged`;
    default:             return `<span class="badge">${ev.kind}</span>`;
  }
}

const SHOWN_KINDS = new Set([
  'run_start', 'run_end', 'agent_spawn', 'agent_terminate',
  'tool_call', 'tool_result', 'audit_record', 'error',
]);

function handleEvent(ev) {
  if (ev.kind === 'agent_spawn') spawned++;
  if (ev.kind === 'agent_terminate') terminated++;
  agentCount.textContent = `${terminated}/${spawned} agents`;

  if (!SHOWN_KINDS.has(ev.kind)) return;
  appendEntry(ev.category, summarize(ev), ts(ev.ts));
}

function startRun() {
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  if (es) { es.close(); es = null; }
  spawned = 0; terminated = 0;
  stream.innerHTML = '';
  runStatus.textContent = 'Starting...';
  startBtn.disabled = true;
  cancelBtn.disabled = false;

  fetch('/api/run/start', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({prompt}),
  })
  .then(r => r.json())
  .then(data => {
    currentRunId = data.runId;
    runStatus.textContent = `Run ${currentRunId.slice(0, 8)}...`;

    // Dispatch event so graph.js can pick up the run ID.
    window.dispatchEvent(new CustomEvent('run-started', {detail: {runId: currentRunId}}));

    es = new EventSource(`/api/run/${currentRunId}/events`);
    es.onmessage = e => {
      try { handleEvent(JSON.parse(e.data)); } catch {}
    };
    es.addEventListener('run_end', () => {
      runStatus.textContent = 'Completed';
      startBtn.disabled = false;
      cancelBtn.disabled = true;
      es.close(); es = null;
    });
    es.onerror = () => {
      startBtn.disabled = false;
      cancelBtn.disabled = true;
      runStatus.textContent = '';
    };
  })
  .catch(() => {
    startBtn.disabled = false;
    cancelBtn.disabled = true;
    runStatus.textContent = 'Failed to start.';
  });
}

startBtn.addEventListener('click', startRun);
cancelBtn.addEventListener('click', () => {
  if (es) { es.close(); es = null; }
  startBtn.disabled = false;
  cancelBtn.disabled = true;
  runStatus.textContent = 'Cancelled.';
});
promptInput.addEventListener('keydown', e => { if (e.key === 'Enter') startRun(); });
