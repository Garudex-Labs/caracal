/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Logs page: subscribes to /api/logs/stream, renders color-coded log lines
 * with category filter chips.
 */

const logsBody  = document.getElementById('logs-body');
const countEl   = document.getElementById('log-count');
const pauseBtn  = document.getElementById('pause-btn');
const clearBtn  = document.getElementById('clear-btn');

let paused    = false;
let lineCount = 0;
let es        = null;

// Active category filter set (initialized from chip state)
const active = new Set();
document.querySelectorAll('.chip').forEach(c => {
  if (c.classList.contains('active')) active.add(c.dataset.cat);
  c.addEventListener('click', () => {
    c.classList.toggle('active');
    if (active.has(c.dataset.cat)) active.delete(c.dataset.cat);
    else active.add(c.dataset.cat);
  });
});

const CAT_CSS = {
  system:     'cat-system',
  agent:      'cat-agent',
  tool:       'cat-tool',
  service:    'cat-service',
  audit:      'cat-audit',
  caracal:    'cat-caracal',
  delegation: 'cat-delegation',
  chat:       'cat-chat',
};

function ts(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleTimeString('en-US', {hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit'}) +
         '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function summarize(ev) {
  const p = ev.payload || {};
  const role  = p.role   || '';
  const agent = p.agent_id ? p.agent_id.slice(0, 8) : '';
  switch (ev.kind) {
    case 'run_start':       return `Run started  run_id=${ev.run_id.slice(0, 8)}`;
    case 'run_end':         return `Run ended  status=${p.status || '?'}`;
    case 'error':           return `Error: ${p.message || ''}`;
    case 'agent_spawn':     return `Spawn  ${role}  ${p.region || ''}  id=${agent}`;
    case 'agent_start':     return `Start  id=${agent}`;
    case 'agent_end':       return `End    id=${agent}`;
    case 'agent_terminate': return `Term   id=${agent}  status=${p.status || '?'}`;
    case 'delegation':      return `Delegation  parent=${(p.parent_id||'').slice(0,8)}  child=${(p.child_id||'').slice(0,8)}`;
    case 'tool_call':       return `Tool call   ${p.tool_name}  agent=${agent}`;
    case 'tool_result':     return `Tool result ${p.tool_name}  agent=${agent}`;
    case 'service_call':    return `SVC call    ${p.service_id} -> ${p.action}`;
    case 'service_result':  return `SVC result  ${p.service_id}`;
    case 'audit_record':    return `Audit record  agent=${agent}`;
    case 'caracal_bind':    return `Caracal bind  decision=${p.decision}  agent=${agent}`;
    case 'caracal_enforce': return `Caracal enforce  ${p.tool_id}  decision=${p.decision}`;
    case 'chat_user':       return `User  ${(p.text || '').slice(0, 80)}`;
    case 'chat_token':      return `Token  ${JSON.stringify(p.token || '')}`;
    case 'chat_message':    return `Message  ${(p.text || '').slice(0, 80)}`;
    case 'llm_call':        return `LLM call  ${p.model}  ${p.latency_ms}ms  in=${p.input_tokens}tok out=${p.output_tokens}tok  tools=${p.tool_calls}  agent=${agent}`;
    default:                return ev.kind;
  }
}

function appendLine(ev) {
  if (!active.has(ev.category)) return;
  if (paused) return;

  lineCount++;
  countEl.textContent = `${lineCount} events`;

  const wrapper = document.createElement('div');

  const line = document.createElement('div');
  line.className = 'log-line';

  const tsEl = document.createElement('span');
  tsEl.className = 'ts';
  tsEl.textContent = ts(ev.ts);

  const catEl = document.createElement('span');
  catEl.className = `cat ${CAT_CSS[ev.category] || 'cat-system'}`;
  catEl.textContent = ev.category;

  const kindEl = document.createElement('span');
  kindEl.className = 'kind';
  kindEl.textContent = ev.kind;

  const bodyEl = document.createElement('span');
  bodyEl.className = 'body';
  bodyEl.textContent = summarize(ev);

  line.appendChild(tsEl);
  line.appendChild(catEl);
  line.appendChild(kindEl);
  line.appendChild(bodyEl);

  const expandEl = document.createElement('div');
  expandEl.className = 'expand';
  expandEl.textContent = JSON.stringify(ev.payload, null, 2);

  line.addEventListener('click', () => wrapper.classList.toggle('open'));

  wrapper.appendChild(line);
  wrapper.appendChild(expandEl);
  logsBody.appendChild(wrapper);

  // Keep at most 2000 lines to avoid memory pressure
  while (logsBody.children.length > 2000) {
    logsBody.removeChild(logsBody.firstChild);
  }

  logsBody.scrollTop = logsBody.scrollHeight;
}

function connect() {
  if (es) es.close();
  es = new EventSource('/api/logs/stream');
  es.onmessage = e => {
    try { appendLine(JSON.parse(e.data)); } catch {}
  };
  es.onerror = () => {
    setTimeout(connect, 3000);
  };
}

pauseBtn.addEventListener('click', () => {
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
});

clearBtn.addEventListener('click', () => {
  logsBody.innerHTML = '';
  lineCount = 0;
  countEl.textContent = '0 events';
});

connect();
