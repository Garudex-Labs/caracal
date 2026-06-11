/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Demo chat driver streaming Caracal run events into the workspace UI.
 */

const $ = (id) => document.getElementById(id)

const AppState = {
  runId: null,
  active: false,
  es: null,
  streamingStatus: 'idle',
  startedAt: 0,
  timerHandle: 0,

  promptRendered: false,
  agents: {},
  turns: {},
  blocks: {},
  lastBlock: null,
  pendingTools: {},
  agentMem: {},
  compactions: [],
  files: new Set(),
  plans: {},
  planOwner: null,

  messages: [],
  paused: false,
  queue: [],
  pendingEvents: [],
  flushHandle: 0,
  dirtyTurns: new Set(),
  pendingScrollForce: false,
  pendingScrollSmooth: false,
  autoScroll: true,

  metrics: { events: 0, tools: 0, services: 0, audits: 0, approvals: 0 },

  reconnectTimer: null,
}

const stream = $('chat-stream')
const emptyEl = $('chat-empty')
const startBtn = $('start-btn')
const stopBtn = $('stop-btn')
const pauseBtn = $('pause-btn')
const promptInput = $('prompt-input')
const modelSelect = $('model-select')
const memFill = $('mem-fill')
const memTokens = $('mem-tokens')
const memAgents = $('mem-agents')
const memCompactions = $('mem-compactions')
const memFiles = $('mem-files')
const memDetail = $('mem-detail')
const planPanel = $('plan-panel')
const planEmpty = $('plan-empty')
const planList = $('plan-list')
const planMeta = $('plan-meta')
const planStatus = $('plan-status')
const planActivePreview = $('plan-active-preview')
const runtimeFeed = $('runtime-feed')
const feedCount = $('feed-count')
const statusChip = $('run-status-chip')
const runtimeState = $('runtime-state')
const runtimeDot = $('runtime-dot')
const sessionDot = $('session-dot')

const tplUserMessage = $('tpl-user-message')
const tplAssistantMessage = $('tpl-assistant-message')
const tplStepGroup = $('tpl-step-group')
const tplToolCard = $('tpl-tool-card')
const tplSystemRow = $('tpl-system-row')
const tplSecurityCard = $('tpl-security-card')
const tplApprovalCard = $('tpl-approval-card')
const tplPlanItem = $('tpl-plan-item')
const tplEventBlock = $('tpl-event-block')

const PLAN_TOOLS = new Set(['write_todos', 'write_file', 'read_file', 'ls_files'])
const FRAME_EVENT_LIMIT = 180
const RUNTIME_FEED_LIMIT = 90
const MESSAGE_LIMIT = 500

function cloneTemplate(template) {
  return template.content.firstElementChild.cloneNode(true)
}

function fmtTok(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function shortId(id) {
  return String(id || '').slice(0, 8)
}

function formatTime(ts = Date.now()) {
  const value = typeof ts === 'number' && ts < 10_000_000_000 ? ts * 1000 : ts
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function titleCase(value) {
  return String(value || '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function truncate(value, limit = 160) {
  const text = String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function formatScalar(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return ''
  return truncate(
    Object.entries(args)
      .map(([key, value]) => `${key}=${truncate(formatScalar(value), 32)}`)
      .join(' '),
    140,
  )
}

function renderJson(value) {
  if (value == null || value === '') return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function detachEmpty() {
  if (emptyEl.parentNode) emptyEl.remove()
}

function restoreEmpty() {
  if (!emptyEl.parentNode) stream.append(emptyEl)
}

function isNearBottom() {
  return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 72
}

function requestScroll({ force = false, smooth = false } = {}) {
  AppState.pendingScrollForce = AppState.pendingScrollForce || force
  AppState.pendingScrollSmooth = AppState.pendingScrollSmooth || smooth
}

function flushScroll() {
  const shouldScroll = AppState.pendingScrollForce || AppState.autoScroll
  AppState.pendingScrollForce = false
  const smooth = AppState.pendingScrollSmooth
  AppState.pendingScrollSmooth = false
  if (!shouldScroll) return
  stream.scrollTo({ top: stream.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
}

// AGENT REGISTRY
function registerAgent(payload) {
  AppState.agents[payload.agent_id] = {
    role: payload.role,
    layer: payload.layer,
    region: payload.region || null,
  }
}

function layerLabel(agent) {
  if (!agent) return 'Agent'
  return titleCase(agent.layer || agent.role || 'agent')
}

function agentLabel(agent) {
  if (!agent) return 'Agent'
  const base = layerLabel(agent)
  return agent.region ? `${base} · ${agent.region}` : base
}

function agentInitials(agent) {
  const words = layerLabel(agent).split(/\s+/).filter(Boolean)
  if (!words.length) return 'A'
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('')
}

// MARKDOWN
function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function inlineMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
}

function renderMarkdown(raw) {
  const lines = escapeHtml(raw).split('\n')
  const out = []
  let list = null
  let table = false
  let code = false

  const closeList = () => {
    if (list) {
      out.push(list.tag === 'ol' ? '</ol>' : '</ul>')
      list = null
    }
  }
  const closeTable = () => {
    if (table) {
      out.push('</tbody></table>')
      table = false
    }
  }

  for (const line of lines) {
    if (code) {
      if (/^```/.test(line.trim())) {
        out.push('</code></pre>')
        code = false
      } else {
        out.push(line)
      }
      continue
    }
    const trimmed = line.trim()
    if (/^```/.test(trimmed)) {
      closeList()
      closeTable()
      code = true
      out.push('<pre class="md-code"><code>')
      continue
    }
    if (/^\|.*\|$/.test(trimmed)) {
      closeList()
      const cells = trimmed.slice(1, -1).split('|').map((cell) => inlineMarkdown(cell.trim()))
      if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue
      if (!table) {
        table = true
        out.push('<table class="md-table"><thead><tr>')
        out.push(cells.map((cell) => `<th>${cell}</th>`).join(''))
        out.push('</tr></thead><tbody>')
        continue
      }
      out.push(`<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
      continue
    }
    closeTable()
    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      closeList()
      const depth = Math.min(6, heading[1].length + 2)
      out.push(`<h${depth}>${inlineMarkdown(heading[2])}</h${depth}>`)
      continue
    }
    const bullet = trimmed.match(/^[-*]\s+(.*)$/)
    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/)
    if (bullet || numbered) {
      const tag = numbered ? 'ol' : 'ul'
      if (!list || list.tag !== tag) {
        closeList()
        list = { tag }
        out.push(tag === 'ol' ? '<ol>' : '<ul>')
      }
      out.push(`<li>${inlineMarkdown((bullet || numbered)[1])}</li>`)
      continue
    }
    closeList()
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      out.push('<hr>')
      continue
    }
    if (!trimmed) continue
    out.push(`<p>${inlineMarkdown(trimmed)}</p>`)
  }
  closeList()
  closeTable()
  if (code) out.push('</code></pre>')
  return out.join('\n')
}

function toneClass(agent) {
  if (!agent) return 'tone-worker'
  if (agent.layer === 'finance-control') return 'tone-fc'
  if (agent.layer === 'regional-orchestrator') return 'tone-ro'
  return 'tone-worker'
}

// STATUS STATE MACHINE
const STATUS_META = {
  idle: { chip: 'Idle', chipClass: 'state-idle', label: 'Ready', dot: 'online' },
  connecting: { chip: 'Connecting', chipClass: 'state-running', label: 'Connecting', dot: 'busy' },
  streaming: { chip: 'Running', chipClass: 'state-running', label: 'Run in progress', dot: 'busy' },
  tool_executing: { chip: 'Running tools', chipClass: 'state-running', label: 'Executing tools', dot: 'busy' },
  awaiting_approval: { chip: 'Needs approval', chipClass: 'state-waiting', label: 'Waiting on you', dot: 'waiting' },
  paused: { chip: 'Paused', chipClass: 'state-waiting', label: 'Stream paused', dot: 'waiting' },
  error: { chip: 'Reconnecting', chipClass: 'state-error', label: 'Connection lost', dot: 'error' },
  done: { chip: 'Finished', chipClass: 'state-done', label: 'Run complete', dot: 'online' },
}

function setStreamingStatus(status) {
  AppState.streamingStatus = status
  const meta = STATUS_META[status] || STATUS_META.idle

  statusChip.textContent = meta.chip
  statusChip.className = `run-status-chip ${meta.chipClass}`
  runtimeState.textContent = meta.label
  runtimeDot.className = `status-indicator-dot ${meta.dot}`
  sessionDot.className = `session-dot ${meta.dot}`

  const locked = status === 'connecting'
  promptInput.disabled = locked
  startBtn.disabled = locked
  startBtn.classList.toggle('is-busy', locked)
}

// SESSION METER
function refreshMetrics() {
  const turns = AppState.messages.filter((m) => m.type === 'assistant' || m.type === 'user').length
  $('session-msg-count').textContent = String(turns)
  $('session-tool-count').textContent = String(AppState.metrics.tools)
  $('event-count').textContent = String(AppState.metrics.events)
  $('tool-count').textContent = String(AppState.metrics.tools)
  $('service-count').textContent = String(AppState.metrics.services)
  $('audit-count').textContent = String(AppState.metrics.audits)
  $('security-count').textContent = String(AppState.metrics.approvals)
  $('agent-count').textContent = String(Object.keys(AppState.agents).length)
}

function countEvent(event) {
  AppState.metrics.events += 1
  if (event.kind === 'tool_call') AppState.metrics.tools += 1
  if (event.kind === 'service_call') AppState.metrics.services += 1
  if (event.kind === 'audit_record') AppState.metrics.audits += 1
  if (event.kind === 'approval_required') AppState.metrics.approvals += 1
}

function updateRunMeta() {
  $('session-run-id').textContent = AppState.runId ? `Run ${shortId(AppState.runId)}` : 'No task running'
  $('active-session-card').classList.toggle('active', AppState.active)
}

function startTimer() {
  stopTimer()
  AppState.startedAt = Date.now()
  const tick = () => {
    $('session-time').textContent = formatElapsed(Date.now() - AppState.startedAt)
  }
  tick()
  AppState.timerHandle = window.setInterval(tick, 1000)
}

function stopTimer() {
  if (AppState.timerHandle) {
    window.clearInterval(AppState.timerHandle)
    AppState.timerHandle = 0
  }
}

// MEMORY PANEL
function refreshMemoryBar() {
  let total = 0
  let limit = 131072
  for (const item of Object.values(AppState.agentMem)) {
    total = Math.max(total, item.tokens_used)
    limit = Math.max(limit, item.tokens_limit)
  }
  memTokens.textContent = `${fmtTok(total)} / ${fmtTok(limit)}`
  memFill.style.width = `${Math.min(100, (total / limit) * 100)}%`
  memFill.classList.toggle('is-high', total / limit > 0.8)
  memAgents.textContent = `${Object.keys(AppState.agents).length} agents`
  memCompactions.textContent = `${AppState.compactions.length} summaries`
  memFiles.textContent = `${AppState.files.size} files`
}

function renderCompactions() {
  if (!AppState.compactions.length) {
    memDetail.innerHTML = '<span class="panel-empty">No compactions yet.</span>'
    return
  }
  const frag = document.createDocumentFragment()
  for (const item of AppState.compactions.slice(-6)) {
    const row = document.createElement('div')
    row.className = 'mem-compaction-row'
    row.innerHTML = `<span class="mem-compaction-delta">${fmtTok(item.before)} → ${fmtTok(item.after)}</span>`
    const text = document.createElement('span')
    text.className = 'mem-compaction-summary'
    text.textContent = truncate(item.summary, 140)
    row.append(text)
    frag.append(row)
  }
  memDetail.replaceChildren(frag)
}

// PLAN PANEL
function planStatusLabel(status) {
  if (status === 'in_progress') return 'Running'
  if (status === 'completed') return 'Completed'
  if (status === 'failed') return 'Failed'
  return 'Pending'
}

function planStatusClass(status) {
  if (status === 'in_progress') return 'running'
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  return 'pending'
}

function computeOverallPlanStatus(items) {
  if (!items.length) return 'pending'
  if (items.some((item) => item.status === 'failed')) return 'failed'
  if (items.some((item) => item.status === 'in_progress')) return 'in_progress'
  if (items.every((item) => item.status === 'completed')) return 'completed'
  return 'pending'
}

function findFinanceControlId() {
  for (const [id, agent] of Object.entries(AppState.agents)) {
    if (agent.layer === 'finance-control') return id
  }
  return null
}

function renderPlan() {
  const ownerId = AppState.planOwner || findFinanceControlId()
  const plan = ownerId ? AppState.plans[ownerId] : null
  if (!plan || !plan.items.length) {
    planPanel.hidden = true
    planEmpty.hidden = false
    return
  }

  const done = plan.items.filter((item) => item.status === 'completed').length
  const overall = computeOverallPlanStatus(plan.items)

  planPanel.hidden = false
  planEmpty.hidden = true
  planMeta.textContent = `${done}/${plan.items.length} done`
  planStatus.className = `plan-status status-${planStatusClass(overall)}`
  planStatus.textContent = planStatusLabel(overall)

  let activeText = ''
  const frag = document.createDocumentFragment()
  plan.items.forEach((item, index) => {
    if (!activeText && (item.status === 'in_progress' || item.status === 'pending')) {
      activeText = item.content
    }
    const row = cloneTemplate(tplPlanItem)
    row.className = `plan-item status-${planStatusClass(item.status)}`
    row.querySelector('.plan-step-index').textContent = `${index + 1}`
    row.querySelector('.plan-step-text').textContent = item.content
    frag.append(row)
  })
  planActivePreview.textContent = activeText ? truncate(activeText, 60) : ''
  planList.replaceChildren(frag)
}

// LIVE ACTIVITY FEED
const FEED_META = {
  run_start: (p) => ({ kind: 'system', kicker: 'run', title: 'Task started' }),
  run_end: (p) => ({ kind: p.status === 'failed' ? 'error' : 'result', kicker: 'run', title: `Task ${p.status}` }),
  run_cancelled: () => ({ kind: 'error', kicker: 'run', title: 'Task cancelled' }),
  error: (p) => ({ kind: 'error', kicker: 'error', title: truncate(p.message, 90) }),
  agent_spawn: (p, a) => ({ kind: 'spawn', kicker: 'agent', title: `${a} spawned` }),
  agent_terminate: (p, a) => ({ kind: 'system', kicker: 'agent', title: `${a} ${p.status}` }),
  delegation: () => ({ kind: 'spawn', kicker: 'delegate', title: 'Authority delegated' }),
  tool_call: (p) => ({ kind: 'tool', kicker: 'tool', title: p.tool_name }),
  tool_result: (p) => ({ kind: 'result', kicker: 'tool done', title: p.tool_name }),
  tool_retry: (p) => ({ kind: 'error', kicker: 'retry', title: `${p.tool_name} attempt ${p.attempt}` }),
  service_call: (p) => ({ kind: 'tool', kicker: 'service', title: `${p.service_id} · ${p.action}` }),
  service_result: (p) => ({ kind: 'result', kicker: 'service done', title: `${p.service_id} · ${p.action}` }),
  audit_record: (p) => ({
    kind: 'audit',
    kicker: 'policy',
    title: truncate((p.record || {}).reason || (p.record || {}).decision || 'Decision recorded', 90),
  }),
  approval_required: (p) => ({ kind: 'audit', kicker: 'approval', title: truncate(p.action, 90) }),
  approval_resolved: (p) => ({ kind: p.approved ? 'result' : 'error', kicker: 'approval', title: p.approved ? 'Approved' : 'Rejected' }),
  stage_start: (p) => ({ kind: 'system', kicker: 'stage', title: truncate(p.stage, 90) }),
  stage_end: (p) => ({ kind: 'result', kicker: 'stage done', title: truncate(p.stage, 90) }),
  replan: (p) => ({ kind: 'system', kicker: 'replan', title: truncate(p.reason, 90) }),
  memory_compaction: (p) => ({ kind: 'system', kicker: 'memory', title: `Compacted ${fmtTok(p.tokens_before)} → ${fmtTok(p.tokens_after)}` }),
  model_change: (p) => ({ kind: 'system', kicker: 'model', title: `${p.prior} → ${p.model}` }),
  file_write: (p) => ({ kind: 'tool', kicker: 'file', title: `write ${p.path}` }),
  file_read: (p) => ({ kind: 'tool', kicker: 'file', title: `read ${p.path}` }),
  worker_acquire: (p) => ({ kind: 'spawn', kicker: 'worker', title: `${p.role} acquired` }),
  worker_release: () => ({ kind: 'result', kicker: 'worker', title: 'Worker released' }),
  job_started: (p) => ({ kind: 'tool', kicker: 'job', title: `${p.kind} · ${p.target}` }),
  job_completed: (p) => ({ kind: p.status === 'failed' ? 'error' : 'result', kicker: 'job', title: `${p.status}` }),
  blackboard_post: (p) => ({ kind: 'system', kicker: 'note', title: truncate(p.content, 90) }),
}

let feedTotal = 0

function appendRuntimeEvent(event) {
  const builder = FEED_META[event.kind]
  if (!builder) return
  const payload = event.payload || {}
  const agent = agentLabel(AppState.agents[payload.agent_id])
  const summary = builder(payload, agent)

  const emptyNode = runtimeFeed.querySelector('.runtime-feed-empty')
  if (emptyNode) emptyNode.remove()

  const node = cloneTemplate(tplEventBlock)
  node.className = `event-block kind-${summary.kind}`
  node.querySelector('.event-kicker').textContent = summary.kicker
  node.querySelector('.event-title').textContent = summary.title || ''
  node.querySelector('.event-time').textContent = formatTime(event.ts)
  node.querySelector('.event-body').textContent = renderJson(payload)
  runtimeFeed.prepend(node)

  feedTotal += 1
  feedCount.textContent = String(feedTotal)

  while (runtimeFeed.children.length > RUNTIME_FEED_LIMIT) {
    runtimeFeed.removeChild(runtimeFeed.lastElementChild)
  }
}

// MESSAGE RENDER ENGINE
function renderMessage(type, data = {}, parent = null) {
  if (!parent) detachEmpty()

  const templates = {
    user: tplUserMessage,
    assistant: tplAssistantMessage,
    tool: tplToolCard,
    system: tplSystemRow,
    security: tplSecurityCard,
    approval: tplApprovalCard,
  }
  const node = cloneTemplate(templates[type])

  const timeEl = node.querySelector('.msg-time')
  if (timeEl) timeEl.textContent = data.time || formatTime(data.ts)

  const contentEl = node.querySelector('.msg-content')
  if (contentEl && data.content !== undefined) contentEl.textContent = data.content

  if (type === 'assistant') {
    const agent = AppState.agents[data.agentId]
    node.classList.remove('tone-worker', 'tone-ro', 'tone-fc')
    node.classList.add(toneClass(agent))
    node.querySelector('.msg-avatar').textContent = agentInitials(agent)
    node.querySelector('.msg-author').textContent = agentLabel(agent)
    node.querySelector('.msg-model-tag').textContent = data.model || ''
    node.querySelector('.msg-status-indicator').textContent = data.status || 'Working'
  }

  if (type === 'tool') {
    node.querySelector('.msg-tool-name').textContent = data.name || 'tool_call'
    node.querySelector('.msg-tool-summary').textContent = data.summary || ''
    const badge = node.querySelector('.msg-tool-status-badge')
    badge.textContent = data.status || 'executing'
    badge.className = `msg-tool-status-badge status-${data.status || 'executing'}`
    node.querySelector('.msg-tool-args .msg-json-block').textContent = renderJson(data.args || {})
    if (data.serviceCall) node.classList.add('is-service')
  }

  if (type === 'system') {
    node.querySelector('.msg-system-text').textContent = data.text || ''
    node.querySelector('.msg-system-kicker').textContent = data.kicker || 'SYSTEM'
    if (data.variant) node.classList.add(`variant-${data.variant}`)
  }

  if (type === 'security') {
    node.querySelector('.msg-security-rule').textContent = data.rule || 'Policy check'
    node.querySelector('.msg-security-reason').textContent = truncate(data.reason || '', 110)
    const badge = node.querySelector('.msg-security-action-badge')
    badge.textContent = data.action || 'checked'
    badge.className = `msg-security-action-badge action-${String(data.action || 'checked').toLowerCase()}`
    const policyEl = node.querySelector('.msg-security-policy')
    policyEl.textContent = ''
    if (data.policy) {
      policyEl.append('Policy: ')
      const code = document.createElement('code')
      code.textContent = data.policy
      policyEl.append(code)
    }
    node.querySelector('.msg-json-block').textContent = renderJson(data.details || {})
  }

  if (type === 'approval') {
    node.querySelector('.msg-approval-context').textContent = data.context || ''
    node.querySelector('.btn-approve').onclick = () => handleApprovalAction(data.approvalId, true, node)
    node.querySelector('.btn-reject').onclick = () => handleApprovalAction(data.approvalId, false, node)
  }

  if (parent) {
    parent.append(node)
    requestScroll()
    return node
  }

  if (type !== 'assistant') AppState.lastBlock = null
  stream.append(node)
  requestScroll({ smooth: type === 'user' })

  AppState.messages.push({ type, data, node })
  if (AppState.messages.length > MESSAGE_LIMIT) {
    const removed = AppState.messages.shift()
    if (removed.node && removed.node.parentNode === stream) removed.node.remove()
  }
  refreshMetrics()
  return node
}

// AGENT BLOCKS — one chat block per contiguous span of agent activity
function ensureBlock(agentId, ts) {
  const existing = AppState.blocks[agentId]
  if (existing && AppState.lastBlock === existing) return existing

  const node = renderMessage('assistant', { agentId, ts, status: 'Working' })
  const block = {
    agentId,
    node,
    flowEl: node.querySelector('.msg-flow'),
    statusEl: node.querySelector('.msg-status-indicator'),
    modelEl: node.querySelector('.msg-model-tag'),
    steps: null,
    runningSteps: 0,
    streamingTurns: 0,
  }
  AppState.blocks[agentId] = block
  AppState.lastBlock = block
  return block
}

function refreshBlockStatus(block) {
  const busy = block.streamingTurns > 0 || block.runningSteps > 0
  block.statusEl.textContent = busy ? 'Working' : 'Done'
  block.node.classList.toggle('is-complete', !busy)
}

function ensureSteps(block) {
  if (block.steps && block.steps.node === block.flowEl.lastElementChild) return block.steps

  const node = cloneTemplate(tplStepGroup)
  const steps = {
    node,
    bodyEl: node.querySelector('.msg-steps-body'),
    titleEl: node.querySelector('.msg-steps-title'),
    running: 0,
    total: 0,
  }
  block.flowEl.append(node)
  block.steps = steps
  return steps
}

function stepStarted(block, steps, label) {
  steps.running += 1
  steps.total += 1
  block.runningSteps += 1
  steps.node.classList.add('is-running')
  steps.titleEl.textContent = `Running ${label}`
  refreshBlockStatus(block)
}

function stepSettled(block, steps) {
  steps.running = Math.max(0, steps.running - 1)
  block.runningSteps = Math.max(0, block.runningSteps - 1)
  if (steps.running === 0) {
    steps.node.classList.remove('is-running')
    steps.titleEl.textContent = steps.total === 1 ? '1 step' : `${steps.total} steps`
  }
  refreshBlockStatus(block)
}

// STREAMED ASSISTANT TURNS
function ensureTurn(agentId, messageId, ts) {
  const key = `${agentId}:${messageId}`
  if (AppState.turns[key]) return AppState.turns[key]

  const block = ensureBlock(agentId, ts)
  const contentEl = document.createElement('div')
  contentEl.className = 'msg-content'
  block.flowEl.append(contentEl)
  block.streamingTurns += 1
  refreshBlockStatus(block)

  const turn = {
    key,
    block,
    contentEl,
    pendingText: '',
    text: '',
    finalText: '',
    streaming: true,
    settled: false,
  }
  AppState.turns[key] = turn
  return turn
}

function markTurnDirty(turn) {
  AppState.dirtyTurns.add(turn)
}

function flushDirtyTurns() {
  for (const turn of AppState.dirtyTurns) {
    if (turn.pendingText) {
      turn.text += turn.pendingText
      turn.pendingText = ''
    }
    if (turn.finalText && turn.finalText.length >= turn.text.length) {
      turn.text = turn.finalText
    }
    if (turn.streaming) {
      turn.contentEl.classList.remove('md')
      turn.contentEl.textContent = turn.text
    } else {
      turn.contentEl.classList.add('md')
      turn.contentEl.innerHTML = renderMarkdown(turn.text)
      if (!turn.text.trim()) turn.contentEl.remove()
      if (!turn.settled) {
        turn.settled = true
        turn.block.streamingTurns = Math.max(0, turn.block.streamingTurns - 1)
        refreshBlockStatus(turn.block)
      }
    }
    turn.contentEl.classList.toggle('is-streaming', turn.streaming)
  }
  AppState.dirtyTurns.clear()
}

// TOOL CALL PAIRING
function trackToolCall(payload, node, { serviceCall = false, block = null, steps = null } = {}) {
  const key = serviceCall
    ? `svc:${payload.agent_id}:${payload.service_id}:${payload.action}`
    : `tool:${payload.agent_id}:${payload.tool_name}`
  if (!AppState.pendingTools[key]) AppState.pendingTools[key] = []
  AppState.pendingTools[key].push({ node, startTs: performance.now(), block, steps })
}

function resolveToolCall(payload, result, status, serviceCall = false) {
  const key = serviceCall
    ? `svc:${payload.agent_id}:${payload.service_id}:${payload.action}`
    : `tool:${payload.agent_id}:${payload.tool_name}`
  const queue = AppState.pendingTools[key]
  const entry = queue && queue.shift()
  if (!entry) return

  const { node, startTs, block, steps } = entry
  const badge = node.querySelector('.msg-tool-status-badge')
  badge.textContent = status
  badge.className = `msg-tool-status-badge status-${status}`

  const duration = node.querySelector('.msg-tool-duration')
  duration.textContent = `${Math.max(1, Math.round(performance.now() - startTs))}ms`

  if (block && steps) stepSettled(block, steps)

  if (result !== undefined) {
    const outputBlock = node.querySelector('.msg-tool-output')
    outputBlock.hidden = false
    outputBlock.querySelector('.msg-json-block').textContent = renderJson(result)
  }
}

// APPROVALS
const approvalCards = new Map()

async function handleApprovalAction(requestId, approved, cardNode) {
  const actions = cardNode.querySelector('.msg-approval-actions')
  actions.innerHTML = '<span class="msg-approval-pending">Submitting…</span>'
  try {
    const res = await fetch(`/api/run/${AppState.runId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, approved }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (error) {
    actions.innerHTML = '<span class="msg-approval-failed">Submission failed — retry below</span>'
    renderMessage('system', { kicker: 'APPROVAL', variant: 'error', text: `Decision not delivered: ${error.message}` })
  }
}

function settleApprovalCard(card, approved) {
  card.classList.add(approved ? 'is-approved' : 'is-rejected')
  card.querySelector('.msg-approval-state').textContent = approved ? 'Approved' : 'Rejected'
  card.querySelector('.msg-approval-actions').innerHTML = approved
    ? '<span class="msg-approval-decision decision-approved">Approved</span>'
    : '<span class="msg-approval-decision decision-rejected">Rejected</span>'
}

// EVENT PIPELINE
function queueIncomingEvent(event) {
  AppState.pendingEvents.push(event)
  scheduleFlush()
}

function scheduleFlush() {
  if (AppState.flushHandle) return
  AppState.flushHandle = window.requestAnimationFrame(flushEventQueue)
}

function flushEventQueue() {
  AppState.flushHandle = 0
  const batch = AppState.pendingEvents.splice(0, FRAME_EVENT_LIMIT)
  for (const event of batch) handleEvent(event)
  flushDirtyTurns()
  flushScroll()
  refreshMetrics()
  if (AppState.pendingEvents.length) scheduleFlush()
}

function handleEvent(event) {
  const payload = event.payload || {}
  countEvent(event)
  appendRuntimeEvent(event)

  switch (event.kind) {
    case 'run_start':
      setStreamingStatus('streaming')
      break

    case 'chat_user':
      if (!AppState.promptRendered) {
        AppState.promptRendered = true
        renderMessage('user', { ts: event.ts, content: payload.text })
      }
      break

    case 'agent_spawn':
      registerAgent(payload)
      refreshMemoryBar()
      break

    case 'agent_end':
    case 'agent_terminate': {
      const block = AppState.blocks[payload.agent_id]
      if (block) {
        block.streamingTurns = 0
        block.runningSteps = 0
        refreshBlockStatus(block)
      }
      break
    }

    case 'chat_token': {
      const turn = ensureTurn(payload.agent_id, payload.message_id, event.ts)
      turn.streaming = true
      turn.pendingText += payload.token
      markTurnDirty(turn)
      requestScroll()
      break
    }

    case 'chat_message': {
      const text = payload.text || ''
      if (!text.trim() && !AppState.turns[`${payload.agent_id}:${payload.message_id}`]) break
      const turn = ensureTurn(payload.agent_id, payload.message_id, event.ts)
      turn.streaming = false
      turn.finalText = text
      markTurnDirty(turn)
      break
    }

    case 'llm_call': {
      const block = AppState.blocks[payload.agent_id]
      if (block && payload.model) block.modelEl.textContent = payload.model
      break
    }

    case 'tool_call': {
      if (PLAN_TOOLS.has(payload.tool_name)) {
        if (payload.tool_name === 'write_file' && payload.args && payload.args.path) {
          AppState.files.add(payload.args.path)
          refreshMemoryBar()
        }
        break
      }
      setStreamingStatus('tool_executing')
      const block = ensureBlock(payload.agent_id, event.ts)
      const steps = ensureSteps(block)
      const node = renderMessage('tool', {
        ts: event.ts,
        name: payload.tool_name,
        summary: summarizeArgs(payload.args),
        args: payload.args,
        status: 'executing',
      }, steps.bodyEl)
      stepStarted(block, steps, payload.tool_name)
      trackToolCall(payload, node, { block, steps })
      break
    }

    case 'tool_result':
      if (PLAN_TOOLS.has(payload.tool_name)) break
      setStreamingStatus('streaming')
      resolveToolCall(payload, payload.result, 'completed')
      break

    case 'tool_retry':
      resolveToolCall(payload, { error: payload.error, attempt: payload.attempt }, 'retrying')
      break

    case 'service_call': {
      const block = ensureBlock(payload.agent_id, event.ts)
      const steps = ensureSteps(block)
      const node = renderMessage('tool', {
        ts: event.ts,
        name: `${payload.service_id}.${payload.action}`,
        summary: summarizeArgs(payload.payload),
        args: payload.payload,
        status: 'executing',
        serviceCall: true,
      }, steps.bodyEl)
      stepStarted(block, steps, payload.service_id)
      trackToolCall(payload, node, { serviceCall: true, block, steps })
      break
    }

    case 'service_result':
      resolveToolCall(payload, payload.result, 'completed', true)
      break

    case 'audit_record': {
      const record = payload.record || {}
      const decision = String(record.decision || '').toLowerCase()
      const denied = /denied|blocked|reject/.test(decision)
      const sink = !denied && AppState.lastBlock
        ? ensureSteps(AppState.lastBlock).bodyEl
        : null
      renderMessage('security', {
        ts: event.ts,
        rule: record.rule_id || 'Policy check',
        action: record.decision || 'checked',
        policy: record.policy_id || '',
        reason: record.reason || '',
        details: record,
      }, sink)
      break
    }

    case 'approval_required': {
      setStreamingStatus('awaiting_approval')
      const card = renderMessage('approval', {
        ts: event.ts,
        approvalId: payload.request_id,
        context: `${payload.action} — ${summarizeArgs(payload.detail) || 'no detail provided'}`,
      })
      approvalCards.set(payload.request_id, card)
      requestScroll({ force: true, smooth: true })
      break
    }

    case 'approval_resolved': {
      const card = approvalCards.get(payload.request_id)
      if (card) {
        settleApprovalCard(card, !!payload.approved)
        approvalCards.delete(payload.request_id)
      }
      setStreamingStatus('streaming')
      break
    }

    case 'plan_update': {
      AppState.plans[payload.agent_id] = { revision: payload.revision, items: payload.todos || [] }
      const fcId = findFinanceControlId()
      if (payload.agent_id === fcId) AppState.planOwner = payload.agent_id
      else if (!AppState.planOwner) AppState.planOwner = payload.agent_id
      renderPlan()
      break
    }

    case 'replan':
      renderMessage('system', {
        ts: event.ts,
        kicker: 'REPLAN',
        variant: 'warn',
        text: `Plan revised (rev ${payload.revision}): ${truncate(payload.reason, 140)}`,
      })
      break

    case 'stage_start':
    case 'stage_end':
      break

    case 'memory_update':
      AppState.agentMem[payload.agent_id] = {
        tokens_used: payload.tokens_used,
        tokens_limit: payload.tokens_limit,
      }
      refreshMemoryBar()
      break

    case 'memory_compaction':
      AppState.compactions.push({
        summary: payload.summary,
        before: payload.tokens_before,
        after: payload.tokens_after,
      })
      refreshMemoryBar()
      renderCompactions()
      break

    case 'model_change':
      renderMessage('system', { ts: event.ts, kicker: 'MODEL', text: `Model switched: ${payload.prior} → ${payload.model}` })
      break

    case 'file_write':
    case 'file_read':
      AppState.files.add(payload.path)
      refreshMemoryBar()
      break

    case 'error':
      renderMessage('system', { ts: event.ts, kicker: 'ERROR', variant: 'error', text: truncate(payload.message, 240) })
      break

    case 'run_cancelled':
      setStreamingStatus('idle')
      renderMessage('system', { ts: event.ts, kicker: 'CANCELLED', variant: 'warn', text: 'Run cancelled by operator.' })
      finishRun()
      break

    case 'run_end':
      setStreamingStatus(payload.status === 'failed' ? 'error' : 'done')
      renderMessage('system', {
        ts: event.ts,
        kicker: 'FINISHED',
        variant: payload.status === 'failed' ? 'error' : 'ok',
        text: `Run finished: ${payload.status}.`,
      })
      finishRun()
      break
  }
}

// SSE LIFECYCLE
function attachStream(runId, active) {
  if (AppState.reconnectTimer) {
    clearTimeout(AppState.reconnectTimer)
    AppState.reconnectTimer = null
  }

  AppState.es = new EventSource(`/api/run/${runId}/events`)
  AppState.active = active

  AppState.es.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data)
      if (AppState.paused) AppState.queue.push(event)
      else queueIncomingEvent(event)
    } catch {
      // keepalive
    }
  }

  AppState.es.onerror = () => {
    AppState.es.close()
    AppState.es = null
    if (!AppState.active) return
    setStreamingStatus('error')
    AppState.reconnectTimer = setTimeout(() => attachStream(runId, true), 3000)
  }
}

function resetState() {
  AppState.active = false
  AppState.promptRendered = false
  AppState.agents = {}
  AppState.turns = {}
  AppState.blocks = {}
  AppState.lastBlock = null
  AppState.pendingTools = {}
  AppState.agentMem = {}
  AppState.compactions = []
  AppState.files = new Set()
  AppState.plans = {}
  AppState.planOwner = null
  AppState.paused = false
  AppState.queue = []
  AppState.pendingEvents = []
  AppState.dirtyTurns.clear()
  AppState.metrics = { events: 0, tools: 0, services: 0, audits: 0, approvals: 0 }
  approvalCards.clear()
  feedTotal = 0

  planPanel.hidden = true
  planEmpty.hidden = false
  planList.replaceChildren()
  planMeta.textContent = ''
  planActivePreview.textContent = ''
  planStatus.className = 'plan-status status-pending'
  planStatus.textContent = 'Pending'

  runtimeFeed.innerHTML = '<div class="runtime-feed-empty">Service calls, file activity, and approval decisions appear here as they happen.</div>'
  feedCount.textContent = '0'

  pauseBtn.hidden = true
  pauseBtn.textContent = 'Pause'

  stopTimer()
  $('session-time').textContent = '--:--'

  renderCompactions()
  refreshMemoryBar()
  refreshMetrics()
  updateRunMeta()
}

function clearConversation() {
  for (const message of AppState.messages) {
    if (message.node && message.node.parentNode === stream) message.node.remove()
  }
  AppState.messages = []
  restoreEmpty()
  refreshMetrics()
}

function finishRun() {
  AppState.active = false
  startBtn.hidden = false
  startBtn.disabled = false
  startBtn.classList.remove('is-busy')
  stopBtn.hidden = true
  stopBtn.disabled = false
  stopBtn.textContent = 'Cancel'
  pauseBtn.hidden = true
  pauseBtn.textContent = 'Pause'
  AppState.paused = false
  stopTimer()
  if (AppState.es) {
    AppState.es.close()
    AppState.es = null
  }
  updateRunMeta()
}

async function stopRun() {
  if (!AppState.runId) return
  stopBtn.disabled = true
  stopBtn.textContent = 'Cancelling…'
  try {
    await fetch(`/api/run/${AppState.runId}/cancel`, { method: 'POST' })
  } catch {
    renderMessage('system', { kicker: 'ERROR', variant: 'error', text: 'Cancel request failed.' })
    stopBtn.disabled = false
    stopBtn.textContent = 'Cancel'
  }
}

function startRun() {
  const prompt = promptInput.value.trim()
  if (!prompt || AppState.streamingStatus === 'connecting') return

  if (AppState.es) {
    AppState.es.close()
    AppState.es = null
  }

  resetState()
  AppState.promptRendered = true
  renderMessage('user', { content: prompt })
  promptInput.value = ''
  autoResizeInput()

  AppState.active = true
  startBtn.hidden = true
  stopBtn.hidden = false
  pauseBtn.hidden = false
  setStreamingStatus('connecting')
  startTimer()

  fetch('/api/run/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    })
    .then((data) => {
      AppState.runId = data.runId
      updateRunMeta()
      try {
        localStorage.setItem('lynx.runId', data.runId)
      } catch {
        // storage unavailable
      }
      setStreamingStatus('streaming')
      window.dispatchEvent(new CustomEvent('run-started', { detail: { runId: AppState.runId } }))
      attachStream(AppState.runId, true)
    })
    .catch(() => {
      finishRun()
      setStreamingStatus('idle')
      renderMessage('system', { kicker: 'ERROR', variant: 'error', text: 'Failed to start the run. Check that the API is reachable.' })
    })
}

async function tryResume() {
  let saved = null
  try {
    saved = localStorage.getItem('lynx.runId')
  } catch {
    return
  }
  if (!saved) return

  try {
    const response = await fetch(`/api/run/${saved}/status`)
    if (!response.ok) {
      localStorage.removeItem('lynx.runId')
      return
    }
    const data = await response.json()
    AppState.runId = saved
    renderMessage('system', { kicker: 'RESUME', text: `Reattached to run ${shortId(saved)} (${data.status}).` })

    if (data.active) {
      AppState.active = true
      startBtn.hidden = true
      stopBtn.hidden = false
      pauseBtn.hidden = false
      setStreamingStatus('streaming')
      startTimer()
    }
    updateRunMeta()
    window.dispatchEvent(new CustomEvent('run-started', { detail: { runId: saved } }))
    attachStream(saved, data.active)
  } catch {
    try {
      localStorage.removeItem('lynx.runId')
    } catch {
      // ignore
    }
  }
}

async function loadModelList() {
  try {
    const response = await fetch('/api/system/model')
    const data = await response.json()
    modelSelect.replaceChildren()
    for (const model of data.allowed) {
      const option = document.createElement('option')
      option.value = model
      option.textContent = model
      if (model === data.model) option.selected = true
      modelSelect.append(option)
    }
  } catch {
    modelSelect.innerHTML = '<option>unavailable</option>'
  }
}

function autoResizeInput() {
  promptInput.style.height = '0px'
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`
}

// PANEL COLLAPSE
document.querySelectorAll('.section-title-bar').forEach((bar) => {
  bar.addEventListener('click', (event) => {
    if (event.target.closest('summary, button:not(.section-toggle-btn)')) return
    bar.closest('.inspector-section').classList.toggle('is-collapsed')
  })
})

// RESPONSIVE GRAPH TOGGLE
const toggleGraphBtn = $('toggle-graph-btn')
const mainViewport = document.querySelector('.main-viewport')
toggleGraphBtn.addEventListener('click', () => {
  const showingGraph = mainViewport.classList.toggle('show-graph')
  toggleGraphBtn.textContent = showingGraph ? 'Chat' : 'Graph'
})

// WIRING
$('clear-chat-btn').addEventListener('click', () => {
  clearConversation()
})

$('new-chat-btn').addEventListener('click', async () => {
  if (AppState.es) {
    AppState.es.close()
    AppState.es = null
  }
  try {
    localStorage.removeItem('lynx.runId')
  } catch {
    // ignore
  }
  try {
    await fetch('/api/memories', { method: 'DELETE' })
  } catch {
    // proceed with reload regardless
  }
  location.reload()
})

startBtn.addEventListener('click', startRun)
stopBtn.addEventListener('click', stopRun)

pauseBtn.addEventListener('click', () => {
  AppState.paused = !AppState.paused
  pauseBtn.textContent = AppState.paused ? 'Resume' : 'Pause'
  setStreamingStatus(AppState.paused ? 'paused' : 'streaming')
  if (!AppState.paused) {
    const queued = AppState.queue.splice(0)
    for (const event of queued) queueIncomingEvent(event)
  }
})

promptInput.addEventListener('input', autoResizeInput)
promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    startRun()
  }
})

modelSelect.addEventListener('change', async () => {
  const requested = modelSelect.value
  modelSelect.disabled = true
  try {
    const response = await fetch('/api/system/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: requested }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    if (!AppState.active) {
      renderMessage('system', { kicker: 'MODEL', text: `Model set to ${data.model}.` })
    }
  } catch (error) {
    renderMessage('system', { kicker: 'MODEL', variant: 'error', text: `Could not switch to ${requested}: ${error.message}` })
    await loadModelList()
  } finally {
    modelSelect.disabled = false
  }
})

stream.addEventListener('scroll', () => {
  AppState.autoScroll = isNearBottom()
})

loadModelList()
setStreamingStatus('idle')
refreshMemoryBar()
refreshMetrics()
updateRunMeta()
tryResume()
autoResizeInput()

const handoff = sessionStorage.getItem('lynxPromptHandoff')
if (handoff) {
  sessionStorage.removeItem('lynxPromptHandoff')
  promptInput.value = handoff
  autoResizeInput()
  promptInput.focus()
}

window.runActive = () => AppState.active
