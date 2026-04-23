/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Chat panel: user bubbles, streaming assistant bubbles, inline lifecycle notes.
 */

const stream      = document.getElementById('chat-stream');
const emptyEl     = document.getElementById('chat-empty');
const agentCount  = document.getElementById('agent-count');
const startBtn    = document.getElementById('start-btn');
const promptInput = document.getElementById('prompt-input');

let currentRunId = null;
let es = null;
let spawned = 0;
let terminated = 0;
let assistantBubbles = {};

function clearEmpty() {
  if (emptyEl && emptyEl.parentNode) emptyEl.remove();
}

function scrollDown() {
  stream.scrollTop = stream.scrollHeight;
}

function addUser(text) {
  clearEmpty();
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  wrap.innerHTML = `<div class="author">You</div><div class="bubble"></div>`;
  wrap.querySelector('.bubble').textContent = text;
  stream.appendChild(wrap);
  scrollDown();
}

function ensureAssistant(messageId) {
  if (assistantBubbles[messageId]) return assistantBubbles[messageId];
  clearEmpty();
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML = `<div class="author">Finance Control</div><div class="bubble empty"></div>`;
  stream.appendChild(wrap);
  scrollDown();
  const bubble = wrap.querySelector('.bubble');
  assistantBubbles[messageId] = bubble;
  return bubble;
}

function addInline(cls, html) {
  clearEmpty();
  const div = document.createElement('div');
  div.className = `inline-event ${cls}`;
  div.innerHTML = `<span class="dot"></span>${html}`;
  stream.appendChild(div);
  scrollDown();
}

function handleEvent(ev) {
  const p = ev.payload || {};

  if (ev.kind === 'agent_spawn') spawned++;
  if (ev.kind === 'agent_terminate') terminated++;
  if (agentCount) agentCount.textContent = spawned ? `${terminated}/${spawned} agents` : 'running';

  switch (ev.kind) {
    case 'chat_user':
      break;
    case 'chat_token': {
      const bubble = ensureAssistant(p.message_id);
      bubble.classList.remove('empty');
      bubble.textContent = (bubble.textContent || '') + p.token;
      scrollDown();
      break;
    }
    case 'chat_message': {
      const bubble = ensureAssistant(p.message_id);
      bubble.classList.remove('empty');
      if (p.text && !bubble.textContent) bubble.textContent = p.text;
      break;
    }
    case 'tool_call':
      addInline('tool', `Calling <code>${p.tool_name}</code>${p.args && p.args.region ? ` \u00b7 region <code>${p.args.region}</code>` : ''}`);
      break;
    case 'agent_spawn':
      if (p.layer === 'regional-orchestrator') {
        addInline('agent', `Regional orchestrator spawned \u00b7 <code>${p.region}</code>`);
      } else if (p.layer === 'finance-control') {
        addInline('agent', `Finance Control spawned`);
      }
      break;
    case 'audit_record':
      addInline('audit', `Audit recorded \u00b7 <code>${(p.record && p.record.region) || ''}</code>`);
      break;
    case 'run_end':
      addInline('system', `Run ${p.status || 'completed'} <span class="status-pill ${p.status || 'completed'}">${p.status || 'completed'}</span>`);
      startBtn.disabled = false;
      startBtn.textContent = 'Send';
      if (es) { es.close(); es = null; }
      break;
    case 'error':
      addInline('system', `Error: ${p.message || 'unknown'}`);
      break;
  }
}

function startRun() {
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  if (es) { es.close(); es = null; }
  spawned = 0;
  terminated = 0;
  assistantBubbles = {};
  stream.innerHTML = '';
  addUser(prompt);
  promptInput.value = '';
  startBtn.disabled = true;
  startBtn.textContent = 'Working...';
  if (agentCount) agentCount.textContent = 'starting';

  fetch('/api/run/start', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({prompt}),
  })
  .then(r => r.json())
  .then(data => {
    currentRunId = data.runId;
    window.dispatchEvent(new CustomEvent('run-started', {detail: {runId: currentRunId}}));

    es = new EventSource(`/api/run/${currentRunId}/events`);
    es.onmessage = e => {
      try {
        const ev = JSON.parse(e.data);
        handleEvent(ev);
      } catch (err) {
        // keepalive comments and parse errors are harmless
      }
    };
    es.onerror = () => {
      startBtn.disabled = false;
      startBtn.textContent = 'Send';
    };
  })
  .catch(() => {
    startBtn.disabled = false;
    startBtn.textContent = 'Send';
    addInline('system', 'Failed to start run.');
  });
}

startBtn.addEventListener('click', startRun);
promptInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    startRun();
  }
});
