/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Orchestration map: layered runtime visualization of user intent, Caracal-governed agents, the control plane, and external providers.
 */

const svg = document.getElementById('graph-svg')
const canvas = document.getElementById('graph-canvas')
const statusEl = document.getElementById('graph-status')
const emptyEl = document.getElementById('graph-empty')
const inspectorType = document.getElementById('graph-inspector-type')
const inspectorTitle = document.getElementById('graph-inspector-title')
const inspectorCopy = document.getElementById('graph-inspector-copy')
const inspectorMetrics = document.getElementById('graph-inspector-metrics')
const timelineList = document.getElementById('graph-timeline-list')
const timelineCount = document.getElementById('graph-timeline-count')
const zoomOutBtn = document.getElementById('graph-zoom-out')
const zoomInBtn = document.getElementById('graph-zoom-in')
const zoomResetBtn = document.getElementById('graph-zoom-reset')
const fitBtn = document.getElementById('graph-fit')
const filterBtns = Array.from(document.querySelectorAll('[data-graphfilter]'))

const NS = 'http://www.w3.org/2000/svg'
const VIEW_W = 1500
const CONTENT_TOP = 64
const BOTTOM_PAD = 36
const USER_X = 36
const USER_W = 188
const USER_H = 104
const RT_X = 276
const RT_W = 600
const ORCH_X = RT_X + 18
const ORCH_W = 196
const ORCH_H = 62
const ORCH_GAP = 14
const GRP_X = RT_X + 244
const GRP_W = RT_W - 244 - 18
const ROW_H = 28
const GRP_HEAD = 32
const GRP_GAP = 14
const CP_X = 930
const CP_W = 196
const PV_X = 1190
const PV_W = 250
const PV_H = 58
const PV_GAP = 10
const CAT_HEAD = 24
const CAT_GAP = 18
const DIM = 0.14
const TIMELINE_LIMIT = 140

const C = {
  blue: '#1E5BD8',
  navy: '#0B3D91',
  green: '#1A7F4B',
  red: '#C0392B',
  amber: '#B85C00',
  grey: '#8A9BAE',
  slate: '#4A6FA5',
  purple: '#5D46A3',
  ink: '#1A1F2E',
}

const STATUS_COLOR = {
  spawned: C.slate,
  running: C.blue,
  completed: C.green,
  failed: C.red,
  cancelled: C.grey,
  blocked: C.red,
  pending: C.amber,
}

const ORCH_LAYERS = new Set(['finance-control', 'regional-orchestrator', 'workflow-orchestrator'])

const PROVIDER_CATEGORIES = [
  { id: 'payments', label: 'Payments & Banking', members: ['halcyon-bank', 'meridian-pay', 'quetzal-payouts', 'cordoba-fx', 'keystone-treasury'] },
  { id: 'ledger', label: 'Ledger & ERP', members: ['ironbark-erp', 'tallyhall-books', 'slate-ledger', 'core-billing'] },
  { id: 'compliance', label: 'Compliance & Tax', members: ['aegis-screening', 'verafin-monitor', 'sabre-tax', 'lumen-identity'] },
  { id: 'data', label: 'Data & Documents', members: ['pulse-market', 'inkwell-ocr', 'atlas-vendor'] },
  { id: 'ops', label: 'Operations & CRM', members: ['beacon-crm', 'vela-notify', 'relay-automation', 'junction-procure'] },
  { id: 'other', label: 'Other Providers', members: [] },
]

const CATEGORY_OF = {}
for (const cat of PROVIDER_CATEGORIES) {
  for (const id of cat.members) CATEGORY_OF[id] = cat.id
}

const BLOCK_PATTERN = /lacks scope|denied|forbidden|unauthorized|403/i

let eventSource = null
let renderHandle = 0
let scene = null
let viewH = 660
let dragStart = null
let dragMoved = false
let transform = { scale: 1, x: 0, y: 0 }
let selected = 'run'
let filterMode = 'all'
let focusSet = null
let activeSet = new Set()
let blockedSet = new Set()

const state = freshState()

function freshState() {
  return {
    runId: null,
    phase: 'idle',
    prompt: '',
    startTs: 0,
    endTs: 0,
    sequence: 0,
    agents: {},
    groups: {},
    providers: {},
    flows: {},
    decisions: {
      checks: 0,
      allowed: 0,
      blocked: 0,
      failed: 0,
      approvalsPending: 0,
      approvalsApproved: 0,
      approvalsDenied: 0,
      audits: 0,
    },
    timeline: [],
    providerSeen: new Set(),
  }
}

function resetState() {
  const next = freshState()
  for (const key of Object.keys(state)) state[key] = next[key]
}

/* ---------- svg helpers ---------- */

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) el.setAttribute(key, value)
  }
  return el
}

function appendText(parent, x, y, text, attrs = {}) {
  const node = svgEl('text', {
    x,
    y,
    fill: C.ink,
    'font-family': 'system-ui, -apple-system, sans-serif',
    'font-size': 11,
    ...attrs,
  })
  node.textContent = text
  parent.appendChild(node)
  return node
}

function addTitle(parent, text) {
  const title = svgEl('title')
  title.textContent = text
  parent.appendChild(title)
}

function marker(id, color) {
  const node = svgEl('marker', {
    id,
    viewBox: '0 0 10 10',
    refX: '9',
    refY: '5',
    markerWidth: '6.5',
    markerHeight: '6.5',
    orient: 'auto-start-reverse',
  })
  node.appendChild(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color }))
  return node
}

function titleCase(value) {
  return String(value || '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function truncate(value, limit = 64) {
  const text = String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function shortId(value) {
  return String(value || '').slice(0, 8)
}

function clampVal(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function statusColor(status) {
  return STATUS_COLOR[status] || C.slate
}

function statusLabel(status) {
  if (status === 'running') return 'Active'
  return titleCase(status || 'spawned')
}

/* ---------- state accessors ---------- */

function ensureGroup(role) {
  if (!state.groups[role]) {
    state.groups[role] = { role, order: state.sequence++, agentIds: [] }
  }
  return state.groups[role]
}

function ensureProvider(providerId) {
  if (!state.providers[providerId]) {
    state.providers[providerId] = {
      id: providerId,
      order: state.sequence++,
      category: CATEGORY_OF[providerId] || 'other',
      calls: 0,
      active: 0,
      ok: 0,
      blocked: 0,
      failed: 0,
      lastAction: '',
    }
  }
  return state.providers[providerId]
}

function ensureFlow(agentId, providerId) {
  const key = `${agentId}::${providerId}`
  if (!state.flows[key]) {
    state.flows[key] = {
      key,
      order: state.sequence++,
      agentId,
      providerId,
      calls: 0,
      active: 0,
      ok: 0,
      blocked: 0,
      failed: 0,
      lastAction: '',
      lastReason: '',
    }
  }
  return state.flows[key]
}

function flowState(flow) {
  if (flow.active > 0) return 'running'
  if (flow.blocked > 0) return 'blocked'
  if (flow.failed > 0) return 'failed'
  if (flow.ok > 0) return 'completed'
  return 'pending'
}

function agentFlows(agentId) {
  return Object.values(state.flows).filter((flow) => flow.agentId === agentId)
}

function providerFlows(providerId) {
  return Object.values(state.flows).filter((flow) => flow.providerId === providerId)
}

function milestone(kind, label, ref, ts) {
  state.timeline.unshift({ kind, label, ref: ref || 'run', ts: ts || Date.now() / 1000 })
  if (state.timeline.length > TIMELINE_LIMIT) state.timeline.length = TIMELINE_LIMIT
}

/* ---------- event ingestion ---------- */

function classifyResult(result) {
  const r = result || {}
  const text = JSON.stringify(r)
  if (r.status === 'denied' || BLOCK_PATTERN.test(String(r.error || ''))) return 'blocked'
  if (typeof r.status === 'number' && r.status === 403) return 'blocked'
  if (r.error || r.status === 'error' || r.status === 'failed') return 'failed'
  if (typeof r.status === 'number' && r.status >= 400) return 'failed'
  if (BLOCK_PATTERN.test(text) && r.data === undefined) return 'blocked'
  return 'ok'
}

function settleFlow(flow, outcome, reason) {
  flow.active = Math.max(0, flow.active - 1)
  const provider = ensureProvider(flow.providerId)
  provider.active = Math.max(0, provider.active - 1)
  if (outcome === 'blocked') {
    flow.blocked += 1
    provider.blocked += 1
    state.decisions.blocked += 1
    flow.lastReason = reason || 'Blocked by policy'
    milestone('blocked', `Blocked: ${titleCase(flow.providerId)} · ${flow.lastReason}`, `flow:${flow.key}`)
  } else if (outcome === 'failed') {
    flow.failed += 1
    provider.failed += 1
    state.decisions.failed += 1
    flow.lastReason = reason || 'Provider error'
  } else {
    flow.ok += 1
    provider.ok += 1
    state.decisions.allowed += 1
  }
}

function settleOpenFlows(agentId, outcome, reason) {
  for (const flow of agentFlows(agentId)) {
    while (flow.active > 0) settleFlow(flow, outcome, reason)
  }
}

function handleEvent(event) {
  const p = event.payload || {}

  switch (event.kind) {
    case 'run_start':
      state.phase = 'running'
      state.prompt = String(p.prompt || '')
      state.startTs = event.ts
      milestone('request', 'Request received', 'user', event.ts)
      revealSvg()
      break

    case 'agent_spawn': {
      const agent = {
        id: p.agent_id,
        role: p.role,
        layer: p.layer,
        region: p.region || null,
        parent: p.parent_id || null,
        scope: p.scope || '',
        status: 'spawned',
        removed: false,
        order: state.sequence++,
        spawnTs: event.ts,
        endTs: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        tokensUsed: 0,
        tokensLimit: 0,
        model: '',
      }
      state.agents[agent.id] = agent
      if (!ORCH_LAYERS.has(agent.layer)) ensureGroup(agent.role).agentIds.push(agent.id)
      milestone('agent', `${titleCase(p.role)} spawned${p.region ? ` · ${p.region}` : ''}`, `agent:${p.agent_id}`, event.ts)
      revealSvg()
      break
    }

    case 'delegation':
      if (state.agents[p.child_id]) state.agents[p.child_id].scope = p.scope || state.agents[p.child_id].scope
      break

    case 'agent_start':
      if (state.agents[p.agent_id]) state.agents[p.agent_id].status = 'running'
      break

    case 'agent_end':
      if (state.agents[p.agent_id] && state.agents[p.agent_id].status === 'running') {
        state.agents[p.agent_id].status = 'completed'
      }
      break

    case 'agent_terminate': {
      const agent = state.agents[p.agent_id]
      if (agent) {
        agent.status = p.status || 'completed'
        agent.removed = true
        agent.endTs = event.ts
        if (agent.status === 'failed') {
          milestone('error', `${titleCase(agent.role)} failed`, `agent:${agent.id}`, event.ts)
        } else if (ORCH_LAYERS.has(agent.layer)) {
          milestone('agent', `${titleCase(agent.role)} ${agent.status} · removed`, `agent:${agent.id}`, event.ts)
        }
      }
      break
    }

    case 'tool_call':
      if (state.agents[p.agent_id]) state.agents[p.agent_id].toolCalls += 1
      break

    case 'tool_retry':
      if (BLOCK_PATTERN.test(String(p.error || ''))) {
        settleOpenFlows(p.agent_id, 'blocked', truncate(String(p.error || ''), 90))
      } else {
        settleOpenFlows(p.agent_id, 'failed', truncate(String(p.error || ''), 90))
      }
      break

    case 'tool_result': {
      const text = JSON.stringify(p.result || {})
      if (/"error"/.test(text)) {
        settleOpenFlows(p.agent_id, BLOCK_PATTERN.test(text) ? 'blocked' : 'failed', 'Tool reported an error')
      }
      break
    }

    case 'service_call': {
      const flow = ensureFlow(p.agent_id, p.service_id)
      const provider = ensureProvider(p.service_id)
      flow.calls += 1
      flow.active += 1
      flow.lastAction = p.action || ''
      provider.calls += 1
      provider.active += 1
      provider.lastAction = p.action || ''
      state.decisions.checks += 1
      if (!state.providerSeen.has(p.service_id)) {
        state.providerSeen.add(p.service_id)
        milestone('provider', `${titleCase(p.service_id)} accessed`, `provider:${p.service_id}`, event.ts)
      }
      revealSvg()
      break
    }

    case 'service_result': {
      const flow = ensureFlow(p.agent_id, p.service_id)
      if (flow.active > 0) {
        const outcome = classifyResult(p.result)
        const reason = p.result && (p.result.error || p.result.reason)
        settleFlow(flow, outcome, reason ? truncate(String(reason), 90) : '')
      }
      break
    }

    case 'llm_call':
      if (state.agents[p.agent_id]) {
        const agent = state.agents[p.agent_id]
        agent.inputTokens += Number(p.input_tokens || 0)
        agent.outputTokens += Number(p.output_tokens || 0)
        agent.model = p.model || agent.model
      }
      break

    case 'memory_update':
      if (state.agents[p.agent_id]) {
        state.agents[p.agent_id].tokensUsed = p.tokens_used || 0
        state.agents[p.agent_id].tokensLimit = p.tokens_limit || 0
      }
      break

    case 'approval_required':
      state.decisions.approvalsPending += 1
      milestone('approval', `Approval requested · ${titleCase(p.action)}`, 'plane', event.ts)
      break

    case 'approval_resolved':
      state.decisions.approvalsPending = Math.max(0, state.decisions.approvalsPending - 1)
      if (p.approved) {
        state.decisions.approvalsApproved += 1
        milestone('approval', 'Approval granted', 'plane', event.ts)
      } else {
        state.decisions.approvalsDenied += 1
        state.decisions.blocked += 1
        milestone('blocked', `Approval denied${p.reason ? ` · ${truncate(p.reason, 60)}` : ''}`, 'plane', event.ts)
      }
      break

    case 'audit_record':
      state.decisions.audits += 1
      milestone('audit', 'Audit record captured', 'plane', event.ts)
      break

    case 'error':
      state.phase = 'failed'
      if (p.agent_id && state.agents[p.agent_id]) state.agents[p.agent_id].status = 'failed'
      milestone('error', truncate(String(p.message || 'Runtime error'), 80), p.agent_id ? `agent:${p.agent_id}` : 'run', event.ts)
      break

    case 'run_cancelled':
      state.phase = 'cancelled'
      milestone('done', 'Run cancelled', 'run', event.ts)
      break

    case 'run_end':
      state.phase = p.status || 'completed'
      state.endTs = event.ts
      milestone('done', `Run ${state.phase}`, 'run', event.ts)
      break

    default:
      return
  }

  scheduleRender()
}

/* ---------- layout ---------- */

function computeLayout() {
  const agents = Object.values(state.agents)
  const orchestrators = agents
    .filter((agent) => ORCH_LAYERS.has(agent.layer))
    .sort((a, b) => a.order - b.order)
  const groups = Object.values(state.groups).sort((a, b) => a.order - b.order)

  const layout = {
    orch: {},
    rows: {},
    groupRects: [],
    providerRects: {},
    categories: [],
  }

  let orchY = CONTENT_TOP + 50
  for (const agent of orchestrators) {
    layout.orch[agent.id] = { x: ORCH_X, y: orchY, w: ORCH_W, h: ORCH_H }
    orchY += ORCH_H + ORCH_GAP
  }
  const orchBottom = orchY - ORCH_GAP

  let groupY = CONTENT_TOP + 50
  for (const group of groups) {
    const h = GRP_HEAD + group.agentIds.length * ROW_H + 8
    layout.groupRects.push({ role: group.role, x: GRP_X, y: groupY, w: GRP_W, h })
    group.agentIds.forEach((agentId, index) => {
      layout.rows[agentId] = {
        x: GRP_X,
        y: groupY + GRP_HEAD + index * ROW_H,
        w: GRP_W,
        h: ROW_H,
      }
    })
    groupY += h + GRP_GAP
  }
  const groupBottom = groupY - GRP_GAP

  const runtimeBottom = Math.max(orchBottom, groupBottom, CONTENT_TOP + 200)
  layout.runtime = { x: RT_X, y: CONTENT_TOP, w: RT_W, h: runtimeBottom - CONTENT_TOP + 16 }

  const presentCategories = PROVIDER_CATEGORIES.filter((cat) =>
    Object.values(state.providers).some((provider) => provider.category === cat.id),
  )
  let pvY = CONTENT_TOP + 28
  for (const cat of presentCategories) {
    const members = Object.values(state.providers)
      .filter((provider) => provider.category === cat.id)
      .sort((a, b) => a.order - b.order)
    layout.categories.push({ label: cat.label, y: pvY })
    pvY += CAT_HEAD
    for (const provider of members) {
      layout.providerRects[provider.id] = { x: PV_X, y: pvY, w: PV_W, h: PV_H }
      pvY += PV_H + PV_GAP
    }
    pvY += CAT_GAP - PV_GAP
  }
  const providerBottom = presentCategories.length ? pvY - CAT_GAP : CONTENT_TOP + 160

  viewH = Math.max(660, layout.runtime.y + layout.runtime.h + BOTTOM_PAD, providerBottom + BOTTOM_PAD)
  layout.band = { x: CP_X, y: CONTENT_TOP, w: CP_W, h: viewH - CONTENT_TOP - BOTTOM_PAD }
  layout.user = { x: USER_X, y: CONTENT_TOP + 50, w: USER_W, h: USER_H }
  return layout
}

function flowSource(layout, agentId) {
  const orch = layout.orch[agentId]
  if (orch) return { x: orch.x + orch.w, y: orch.y + orch.h / 2 }
  const row = layout.rows[agentId]
  if (row) return { x: row.x + row.w, y: row.y + row.h / 2 }
  return null
}

/* ---------- focus and filter ---------- */

function computeFocusSet() {
  const [kind, rawId = ''] = String(selected || 'run').split(/:(.*)/s)

  if (kind === 'agent' && state.agents[rawId]) {
    const set = new Set([`agent:${rawId}`, 'plane'])
    let cursor = state.agents[rawId]
    while (cursor && cursor.parent && state.agents[cursor.parent]) {
      set.add(`agent:${cursor.parent}`)
      cursor = state.agents[cursor.parent]
    }
    for (const flow of agentFlows(rawId)) {
      set.add(`flow:${flow.key}`)
      set.add(`provider:${flow.providerId}`)
    }
    return set
  }

  if (kind === 'provider' && state.providers[rawId]) {
    const set = new Set([`provider:${rawId}`, 'plane'])
    for (const flow of providerFlows(rawId)) {
      set.add(`flow:${flow.key}`)
      set.add(`agent:${flow.agentId}`)
      set.add(`group:${state.agents[flow.agentId]?.role || ''}`)
    }
    return set
  }

  if (kind === 'flow' && state.flows[rawId]) {
    const flow = state.flows[rawId]
    return new Set([
      `flow:${flow.key}`,
      `agent:${flow.agentId}`,
      `group:${state.agents[flow.agentId]?.role || ''}`,
      `provider:${flow.providerId}`,
      'plane',
    ])
  }

  if (kind === 'group' && state.groups[rawId]) {
    const set = new Set([`group:${rawId}`, 'plane'])
    for (const agentId of state.groups[rawId].agentIds) {
      set.add(`agent:${agentId}`)
      for (const flow of agentFlows(agentId)) {
        set.add(`flow:${flow.key}`)
        set.add(`provider:${flow.providerId}`)
      }
    }
    return set
  }

  return null
}

function computeFilterSets() {
  activeSet = new Set(['plane', 'user'])
  blockedSet = new Set(['plane'])

  for (const agent of Object.values(state.agents)) {
    if (agent.status === 'running' || agent.status === 'spawned') {
      activeSet.add(`agent:${agent.id}`)
      activeSet.add(`group:${agent.role}`)
    }
    if (agent.status === 'failed') {
      blockedSet.add(`agent:${agent.id}`)
      blockedSet.add(`group:${agent.role}`)
    }
  }
  for (const flow of Object.values(state.flows)) {
    if (flow.active > 0) {
      activeSet.add(`flow:${flow.key}`)
      activeSet.add(`agent:${flow.agentId}`)
      activeSet.add(`group:${state.agents[flow.agentId]?.role || ''}`)
      activeSet.add(`provider:${flow.providerId}`)
    }
    if (flow.blocked > 0) {
      blockedSet.add(`flow:${flow.key}`)
      blockedSet.add(`agent:${flow.agentId}`)
      blockedSet.add(`group:${state.agents[flow.agentId]?.role || ''}`)
      blockedSet.add(`provider:${flow.providerId}`)
    }
  }
}

function opacityFor(key) {
  if (focusSet && !focusSet.has(key)) return DIM
  if (!focusSet && filterMode === 'active' && !activeSet.has(key)) return DIM
  if (!focusSet && filterMode === 'blocked' && !blockedSet.has(key)) return DIM
  return 1
}

/* ---------- drawing ---------- */

function revealSvg() {
  if (emptyEl) emptyEl.style.display = 'none'
  if (svg) svg.style.display = ''
}

function applyTransform(smooth = false) {
  if (!scene) return
  scene.style.transition = smooth ? 'transform 0.22s ease' : ''
  scene.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`
  if (zoomResetBtn) zoomResetBtn.textContent = `${Math.round(transform.scale * 100)}%`
}

function resetSvg() {
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${viewH}`)
  svg.innerHTML = ''
  const defs = svgEl('defs')
  defs.append(
    marker('arrow-running', C.blue),
    marker('arrow-completed', C.green),
    marker('arrow-failed', C.amber),
    marker('arrow-blocked', C.red),
    marker('arrow-pending', C.grey),
    marker('arrow-delegate', 'rgba(30, 91, 216, 0.45)'),
  )
  const cardFill = svgEl('linearGradient', { id: 'card-fill', x1: '0', y1: '0', x2: '0', y2: '1' })
  cardFill.append(
    svgEl('stop', { offset: '0%', 'stop-color': '#FFFFFF' }),
    svgEl('stop', { offset: '100%', 'stop-color': '#F5F8FE' }),
  )
  const bandFill = svgEl('linearGradient', { id: 'band-fill', x1: '0', y1: '0', x2: '0', y2: '1' })
  bandFill.append(
    svgEl('stop', { offset: '0%', 'stop-color': 'rgba(11, 61, 145, 0.085)' }),
    svgEl('stop', { offset: '100%', 'stop-color': 'rgba(30, 91, 216, 0.05)' }),
  )
  defs.append(cardFill, bandFill)
  scene = svgEl('g', { id: 'graph-scene' })
  svg.append(defs, scene)
  applyTransform()
}

function drawCaptions() {
  const captions = [
    { x: USER_X, text: 'Request' },
    { x: RT_X, text: 'Caracal-Governed Runtime' },
    { x: CP_X, text: 'Control Plane' },
    { x: PV_X, text: 'External Providers' },
  ]
  for (const cap of captions) {
    appendText(scene, cap.x + 2, CONTENT_TOP - 14, cap.text.toUpperCase(), {
      fill: 'rgba(26, 31, 46, 0.42)',
      'font-size': 9.5,
      'font-weight': 800,
      'letter-spacing': '0.1em',
    })
  }
}

function drawRuntimeFrame(layout) {
  const r = layout.runtime
  const group = svgEl('g')
  group.appendChild(
    svgEl('rect', {
      x: r.x,
      y: r.y,
      width: r.w,
      height: r.h,
      rx: 18,
      fill: 'rgba(30, 91, 216, 0.028)',
      stroke: 'rgba(30, 91, 216, 0.18)',
      'stroke-width': 1,
      'vector-effect': 'non-scaling-stroke',
    }),
  )
  appendText(group, r.x + 18, r.y + 24, 'Runtime agents', {
    fill: C.navy,
    'font-size': 12,
    'font-weight': 800,
  })
  appendText(group, r.x + 18, r.y + 40, 'Ephemeral workers spawned under delegated Caracal authority', {
    fill: 'rgba(26, 31, 46, 0.5)',
    'font-size': 9.5,
  })
  const agentTotal = Object.keys(state.agents).length
  const liveTotal = Object.values(state.agents).filter((agent) => !agent.removed).length
  appendText(group, r.x + r.w - 18, r.y + 24, `${liveTotal} live · ${agentTotal} total`, {
    fill: 'rgba(26, 31, 46, 0.5)',
    'font-size': 10,
    'font-weight': 700,
    'text-anchor': 'end',
  })
  scene.appendChild(group)
}

function drawProviderFrame(layout) {
  if (!layout.categories.length) return
  const top = CONTENT_TOP + 4
  const bottom = viewH - BOTTOM_PAD
  scene.appendChild(
    svgEl('rect', {
      x: PV_X - 16,
      y: top,
      width: PV_W + 32,
      height: bottom - top,
      rx: 18,
      fill: 'none',
      stroke: 'rgba(138, 155, 174, 0.5)',
      'stroke-width': 1,
      'stroke-dasharray': '7 6',
      'vector-effect': 'non-scaling-stroke',
    }),
  )
}

function drawBandBase(layout) {
  const b = layout.band
  scene.appendChild(
    svgEl('rect', {
      x: b.x,
      y: b.y,
      width: b.w,
      height: b.h,
      rx: 20,
      fill: 'url(#band-fill)',
      stroke: 'rgba(11, 61, 145, 0.4)',
      'stroke-width': 1.5,
      'vector-effect': 'non-scaling-stroke',
    }),
  )
}

function drawBandContent(layout) {
  const b = layout.band
  const d = state.decisions
  const group = svgEl('g', { 'data-select': 'plane', tabindex: '0', opacity: opacityFor('plane') })

  appendText(group, b.x + b.w / 2, b.y + 28, 'CARACAL', {
    fill: C.navy,
    'font-size': 14,
    'font-weight': 800,
    'letter-spacing': '0.18em',
    'text-anchor': 'middle',
  })
  appendText(group, b.x + b.w / 2, b.y + 44, 'Every call passes through here', {
    fill: 'rgba(11, 61, 145, 0.6)',
    'font-size': 9,
    'text-anchor': 'middle',
  })

  const tallyW = (b.w - 40) / 2
  const tallies = [
    { x: b.x + 14, label: 'ALLOWED', value: d.allowed, color: C.green },
    { x: b.x + 26 + tallyW, label: 'BLOCKED', value: d.blocked, color: C.red },
  ]
  for (const tally of tallies) {
    group.appendChild(
      svgEl('rect', {
        x: tally.x,
        y: b.y + 56,
        width: tallyW,
        height: 40,
        rx: 10,
        fill: '#fff',
        stroke: tally.color,
        'stroke-width': 1.2,
        opacity: 0.96,
        'vector-effect': 'non-scaling-stroke',
      }),
    )
    appendText(group, tally.x + tallyW / 2, b.y + 74, String(tally.value), {
      fill: tally.color,
      'font-size': 15,
      'font-weight': 800,
      'text-anchor': 'middle',
    })
    appendText(group, tally.x + tallyW / 2, b.y + 89, tally.label, {
      fill: tally.color,
      'font-size': 8,
      'font-weight': 800,
      'letter-spacing': '0.08em',
      'text-anchor': 'middle',
    })
  }

  const cards = [
    { label: 'Authorization', copy: 'mandates · scoped access', value: `${d.checks} checks` },
    { label: 'Policy', copy: 'scope + delegation rules', value: d.blocked ? `${d.blocked} denied` : 'no denials', alert: d.blocked > 0 },
    {
      label: 'Approvals',
      copy: 'human-in-the-loop',
      value: d.approvalsPending
        ? `${d.approvalsPending} pending`
        : `${d.approvalsApproved} approved · ${d.approvalsDenied} denied`,
      live: d.approvalsPending > 0,
    },
    { label: 'Audit', copy: 'evidence trail', value: `${d.audits} records` },
  ]
  let cardY = b.y + 110
  for (const card of cards) {
    group.appendChild(
      svgEl('rect', {
        x: b.x + 14,
        y: cardY,
        width: b.w - 28,
        height: 52,
        rx: 12,
        fill: '#fff',
        stroke: card.alert ? 'rgba(192, 57, 43, 0.5)' : card.live ? 'rgba(184, 92, 0, 0.55)' : 'rgba(11, 61, 145, 0.18)',
        'stroke-width': 1,
        opacity: 0.96,
        'vector-effect': 'non-scaling-stroke',
      }),
    )
    appendText(group, b.x + 28, cardY + 19, card.label, {
      fill: C.navy,
      'font-size': 11,
      'font-weight': 800,
    })
    appendText(group, b.x + 28, cardY + 32, card.copy, {
      fill: 'rgba(26, 31, 46, 0.48)',
      'font-size': 8.5,
    })
    appendText(group, b.x + 28, cardY + 45, card.value, {
      fill: card.alert ? C.red : card.live ? C.amber : 'rgba(26, 31, 46, 0.66)',
      'font-size': 9,
      'font-weight': 700,
      'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
    })
    cardY += 62
  }

  addTitle(group, 'Caracal control plane\nPolicy, authorization, delegation, approvals, and audit for every provider call.')
  scene.appendChild(group)
}

function drawUser(layout) {
  const u = layout.user
  const group = svgEl('g', { 'data-select': 'user', tabindex: '0', opacity: opacityFor('user') })
  group.appendChild(
    svgEl('rect', {
      x: u.x,
      y: u.y,
      width: u.w,
      height: u.h,
      rx: 14,
      fill: 'url(#card-fill)',
      stroke: selected === 'user' ? C.blue : 'rgba(11, 61, 145, 0.16)',
      'stroke-width': selected === 'user' ? 2 : 1,
      filter: 'drop-shadow(0 8px 16px rgba(11, 61, 145, 0.07))',
      'vector-effect': 'non-scaling-stroke',
    }),
  )
  group.appendChild(svgEl('circle', { cx: u.x + 20, cy: u.y + 22, r: 6, fill: statusColor(state.phase === 'running' ? 'running' : state.phase) }))
  appendText(group, u.x + 34, u.y + 26, 'User request', {
    fill: C.ink,
    'font-size': 12,
    'font-weight': 800,
  })
  const promptLines = wrapText(state.prompt || 'Waiting for a task', 30, 3)
  promptLines.forEach((line, index) => {
    appendText(group, u.x + 14, u.y + 48 + index * 14, line, {
      fill: 'rgba(26, 31, 46, 0.6)',
      'font-size': 9.5,
    })
  })
  appendText(group, u.x + 14, u.y + u.h - 10, state.startTs ? formatTime(state.startTs) : '', {
    fill: 'rgba(26, 31, 46, 0.4)',
    'font-size': 8.5,
    'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
  })
  addTitle(group, `User request\n${state.prompt || 'No task yet'}`)
  scene.appendChild(group)
}

function wrapText(value, limit, maxLines) {
  const words = String(value || '').split(/\s+/).filter(Boolean)
  const lines = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length <= limit) current = candidate
    else {
      if (current) lines.push(current)
      current = word
      if (lines.length === maxLines - 1) break
    }
  }
  if (current && lines.length < maxLines) lines.push(current)
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = truncate(lines[maxLines - 1], limit)
  }
  return lines.length ? lines : ['']
}

function drawUserEdge(layout) {
  const orchIds = Object.keys(layout.orch)
  if (!orchIds.length) return
  const target = layout.orch[orchIds[0]]
  const u = layout.user
  const sx = u.x + u.w
  const sy = u.y + u.h / 2
  const tx = target.x
  const ty = target.y + target.h / 2
  scene.appendChild(
    svgEl('path', {
      d: `M ${sx} ${sy} C ${sx + 36} ${sy}, ${tx - 36} ${ty}, ${tx} ${ty}`,
      fill: 'none',
      stroke: 'rgba(30, 91, 216, 0.4)',
      'stroke-width': 1.8,
      'marker-end': 'url(#arrow-delegate)',
      'vector-effect': 'non-scaling-stroke',
    }),
  )
}

function drawDelegationEdges(layout) {
  for (const [agentId, rect] of Object.entries(layout.orch)) {
    const agent = state.agents[agentId]
    if (!agent || !agent.parent || !layout.orch[agent.parent]) continue
    const parentRect = layout.orch[agent.parent]
    const px = parentRect.x - 9
    const opacity = Math.min(opacityFor(`agent:${agentId}`), opacityFor(`agent:${agent.parent}`))
    const path = svgEl('path', {
      d: [
        `M ${parentRect.x} ${parentRect.y + parentRect.h / 2}`,
        `L ${px} ${parentRect.y + parentRect.h / 2}`,
        `L ${px} ${rect.y + rect.h / 2}`,
        `L ${rect.x} ${rect.y + rect.h / 2}`,
      ].join(' '),
      fill: 'none',
      stroke: 'rgba(30, 91, 216, 0.32)',
      'stroke-width': 1.4,
      'marker-end': 'url(#arrow-delegate)',
      opacity,
      'vector-effect': 'non-scaling-stroke',
    })
    addTitle(path, `${titleCase(state.agents[agent.parent]?.role)} delegates to ${titleCase(agent.role)}${agent.scope ? `\nScope: ${agent.scope}` : ''}`)
    scene.appendChild(path)
  }

  const groupParents = {}
  for (const group of Object.values(state.groups)) {
    const parents = new Set()
    for (const agentId of group.agentIds) {
      const parent = state.agents[agentId]?.parent
      if (parent && layout.orch[parent]) parents.add(parent)
    }
    groupParents[group.role] = parents
  }
  for (const grpRect of layout.groupRects) {
    for (const parentId of groupParents[grpRect.role] || []) {
      const parentRect = layout.orch[parentId]
      const sx = parentRect.x + parentRect.w
      const sy = parentRect.y + parentRect.h / 2
      const tx = grpRect.x
      const ty = Math.min(Math.max(sy, grpRect.y + 16), grpRect.y + grpRect.h - 16)
      const opacity = Math.min(opacityFor(`group:${grpRect.role}`), opacityFor(`agent:${parentId}`))
      const path = svgEl('path', {
        d: `M ${sx} ${sy} C ${sx + 24} ${sy}, ${tx - 24} ${ty}, ${tx} ${ty}`,
        fill: 'none',
        stroke: 'rgba(30, 91, 216, 0.26)',
        'stroke-width': 1.3,
        'marker-end': 'url(#arrow-delegate)',
        opacity,
        'vector-effect': 'non-scaling-stroke',
      })
      addTitle(path, `${titleCase(state.agents[parentId]?.role)} delegates ${titleCase(grpRect.role)} work`)
      scene.appendChild(path)
    }
  }
}

function drawFlows(layout) {
  const byProvider = {}
  for (const flow of Object.values(state.flows)) {
    if (!byProvider[flow.providerId]) byProvider[flow.providerId] = []
    byProvider[flow.providerId].push(flow)
  }

  for (const [providerId, flowList] of Object.entries(byProvider)) {
    const pvRect = layout.providerRects[providerId]
    if (!pvRect) continue
    flowList.sort((a, b) => {
      const ay = flowSource(layout, a.agentId)?.y || 0
      const by = flowSource(layout, b.agentId)?.y || 0
      return ay - by || a.order - b.order
    })

    flowList.forEach((flow, index) => {
      const src = flowSource(layout, flow.agentId)
      if (!src) return
      const fs = flowState(flow)
      const color = fs === 'failed' ? C.amber : statusColor(fs)
      const provY = pvRect.y + pvRect.h / 2 + (index - (flowList.length - 1) / 2) * 10
      const isSelected = selected === `flow:${flow.key}`
      const opacity = opacityFor(`flow:${flow.key}`)
      const d = [
        `M ${src.x} ${src.y}`,
        `C ${src.x + 46} ${src.y}, ${CP_X - 46} ${src.y}, ${CP_X} ${src.y}`,
        `L ${CP_X + CP_W} ${provY}`,
        `C ${CP_X + CP_W + 46} ${provY}, ${pvRect.x - 40} ${provY}, ${pvRect.x} ${provY}`,
      ].join(' ')

      const group = svgEl('g', { 'data-select': `flow:${flow.key}`, opacity })
      const path = svgEl('path', {
        d,
        fill: 'none',
        stroke: color,
        'stroke-width': isSelected ? 3 : clampVal(1.4 + Math.log2(1 + flow.calls) * 0.6, 1.4, 3),
        'stroke-dasharray': fs === 'running' ? '8 6' : fs === 'blocked' ? '4 5' : '',
        opacity: isSelected ? 1 : 0.7,
        'marker-end': `url(#arrow-${fs === 'failed' ? 'failed' : fs})`,
        'vector-effect': 'non-scaling-stroke',
      })
      if (fs === 'running') {
        path.appendChild(
          svgEl('animate', { attributeName: 'stroke-dashoffset', from: '28', to: '0', dur: '0.9s', repeatCount: 'indefinite' }),
        )
      }
      group.appendChild(path)
      if (fs === 'running') {
        const particle = svgEl('circle', { r: 3, fill: color, opacity: 0.9 })
        particle.appendChild(svgEl('animateMotion', { dur: '1.7s', repeatCount: 'indefinite', path: d }))
        group.appendChild(particle)
      }
      group.appendChild(
        svgEl('path', {
          d,
          fill: 'none',
          stroke: 'transparent',
          'stroke-width': 14,
          'pointer-events': 'stroke',
          'vector-effect': 'non-scaling-stroke',
        }),
      )

      const gateColor = fs === 'blocked' ? C.red : fs === 'failed' ? C.amber : fs === 'running' ? C.blue : fs === 'completed' ? C.green : C.grey
      const gate = svgEl('g')
      gate.appendChild(
        svgEl('circle', {
          cx: CP_X + CP_W,
          cy: provY,
          r: 7,
          fill: '#fff',
          stroke: gateColor,
          'stroke-width': 1.6,
          'vector-effect': 'non-scaling-stroke',
        }),
      )
      const glyph = fs === 'blocked' ? '✕' : fs === 'running' ? '·' : fs === 'pending' ? '·' : fs === 'failed' ? '!' : '✓'
      appendText(gate, CP_X + CP_W, provY + 2.8, glyph, {
        fill: gateColor,
        'font-size': 8.5,
        'font-weight': 800,
        'text-anchor': 'middle',
      })
      group.appendChild(gate)

      if (isSelected) {
        const label = `${titleCase(flow.lastAction || flow.providerId)} · ${flow.calls}`
        const labelW = label.length * 5.4 + 16
        group.appendChild(
          svgEl('rect', {
            x: CP_X + CP_W / 2 - labelW / 2,
            y: (src.y + provY) / 2 - 19,
            width: labelW,
            height: 18,
            rx: 9,
            fill: '#fff',
            stroke: color,
            'stroke-width': 1,
            'vector-effect': 'non-scaling-stroke',
          }),
        )
        appendText(group, CP_X + CP_W / 2, (src.y + provY) / 2 - 6, label, {
          fill: color,
          'font-size': 8.8,
          'font-weight': 800,
          'text-anchor': 'middle',
        })
      }

      const agent = state.agents[flow.agentId]
      addTitle(
        group,
        [
          `${titleCase(agent?.role || 'agent')} → ${titleCase(flow.providerId)}`,
          `Last action: ${flow.lastAction || '—'}`,
          `Status: ${statusLabel(fs)}`,
          `Calls: ${flow.calls} (${flow.ok} ok · ${flow.blocked} blocked · ${flow.failed} failed)`,
          flow.lastReason ? `Detail: ${flow.lastReason}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      scene.appendChild(group)
    })
  }
}

function drawOrchestrators(layout) {
  for (const [agentId, rect] of Object.entries(layout.orch)) {
    const agent = state.agents[agentId]
    if (!agent) continue
    const color = statusColor(agent.status)
    const isSelected = selected === `agent:${agentId}`
    const group = svgEl('g', { 'data-select': `agent:${agentId}`, tabindex: '0', opacity: opacityFor(`agent:${agentId}`) })

    group.appendChild(
      svgEl('rect', {
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        rx: 12,
        fill: 'url(#card-fill)',
        stroke: isSelected ? C.blue : agent.status === 'running' ? 'rgba(30, 91, 216, 0.45)' : 'rgba(11, 61, 145, 0.14)',
        'stroke-width': isSelected ? 2 : 1,
        filter: 'drop-shadow(0 6px 14px rgba(11, 61, 145, 0.06))',
        opacity: agent.removed && agent.status !== 'failed' ? 0.62 : 1,
        'vector-effect': 'non-scaling-stroke',
      }),
    )
    group.appendChild(svgEl('circle', { cx: rect.x + 15, cy: rect.y + 18, r: 4.5, fill: color }))
    if (agent.status === 'running') {
      const pulse = svgEl('circle', { cx: rect.x + 15, cy: rect.y + 18, r: 4.5, fill: 'none', stroke: color, 'stroke-width': 1.6, opacity: 0.7 })
      pulse.appendChild(svgEl('animate', { attributeName: 'r', values: '4.5;11', dur: '1.2s', repeatCount: 'indefinite' }))
      pulse.appendChild(svgEl('animate', { attributeName: 'opacity', values: '0.7;0', dur: '1.2s', repeatCount: 'indefinite' }))
      group.appendChild(pulse)
    }
    appendText(group, rect.x + 26, rect.y + 21, truncate(titleCase(agent.role), 24), {
      fill: C.ink,
      'font-size': 11,
      'font-weight': 800,
    })
    appendText(group, rect.x + 14, rect.y + 38, agent.region || truncate(agent.scope, 28) || 'global', {
      fill: 'rgba(26, 31, 46, 0.52)',
      'font-size': 9,
    })
    appendText(group, rect.x + 14, rect.y + 52, `${statusLabel(agent.status)}${agent.removed ? ' · removed' : ''}`, {
      fill: color,
      'font-size': 9,
      'font-weight': 800,
    })
    appendText(group, rect.x + rect.w - 12, rect.y + 52, shortId(agentId), {
      fill: 'rgba(26, 31, 46, 0.38)',
      'font-size': 8.5,
      'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
      'text-anchor': 'end',
    })
    addTitle(
      group,
      [
        `${titleCase(agent.role)} (${shortId(agentId)})`,
        agent.region ? `Region: ${agent.region}` : '',
        agent.scope ? `Delegated scope: ${agent.scope}` : '',
        `Lifecycle: ${lifecycleLabel(agent)}`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    scene.appendChild(group)
  }
}

function lifecycleLabel(agent) {
  const steps = ['Spawned']
  if (agent.status === 'running' || agent.endTs || agent.status === 'completed' || agent.status === 'failed' || agent.status === 'cancelled') {
    steps.push('Active')
  }
  if (agent.status === 'completed') steps.push('Completed')
  if (agent.status === 'failed') steps.push('Failed')
  if (agent.status === 'cancelled') steps.push('Cancelled')
  if (agent.removed) steps.push('Removed')
  return steps.join(' → ')
}

function drawGroups(layout) {
  for (const grpRect of layout.groupRects) {
    const group = state.groups[grpRect.role]
    if (!group) continue
    const live = group.agentIds.filter((id) => !state.agents[id]?.removed).length
    const isSelected = selected === `group:${grpRect.role}`
    const node = svgEl('g', { 'data-select': `group:${grpRect.role}`, tabindex: '0', opacity: opacityFor(`group:${grpRect.role}`) })

    node.appendChild(
      svgEl('rect', {
        x: grpRect.x,
        y: grpRect.y,
        width: grpRect.w,
        height: grpRect.h,
        rx: 12,
        fill: '#fff',
        stroke: isSelected ? C.blue : 'rgba(11, 61, 145, 0.13)',
        'stroke-width': isSelected ? 2 : 1,
        filter: 'drop-shadow(0 6px 14px rgba(11, 61, 145, 0.05))',
        'vector-effect': 'non-scaling-stroke',
      }),
    )
    appendText(node, grpRect.x + 14, grpRect.y + 21, truncate(titleCase(grpRect.role), 26), {
      fill: C.navy,
      'font-size': 11,
      'font-weight': 800,
    })
    appendText(node, grpRect.x + grpRect.w - 12, grpRect.y + 21, live ? `${live} live` : 'done', {
      fill: live ? C.blue : 'rgba(26, 31, 46, 0.42)',
      'font-size': 9,
      'font-weight': 700,
      'text-anchor': 'end',
    })
    node.appendChild(
      svgEl('line', {
        x1: grpRect.x + 10,
        y1: grpRect.y + GRP_HEAD - 3,
        x2: grpRect.x + grpRect.w - 10,
        y2: grpRect.y + GRP_HEAD - 3,
        stroke: 'rgba(11, 61, 145, 0.08)',
        'stroke-width': 1,
        'vector-effect': 'non-scaling-stroke',
      }),
    )
    scene.appendChild(node)

    for (const agentId of group.agentIds) {
      const row = layout.rows[agentId]
      const agent = state.agents[agentId]
      if (!row || !agent) continue
      const color = statusColor(agent.status)
      const isRowSelected = selected === `agent:${agentId}`
      const rowNode = svgEl('g', {
        'data-select': `agent:${agentId}`,
        tabindex: '0',
        opacity: Math.min(opacityFor(`agent:${agentId}`), agent.removed && agent.status !== 'failed' ? 0.55 : 1),
      })
      if (isRowSelected) {
        rowNode.appendChild(
          svgEl('rect', {
            x: row.x + 6,
            y: row.y + 2,
            width: row.w - 12,
            height: row.h - 4,
            rx: 7,
            fill: 'rgba(30, 91, 216, 0.07)',
            stroke: 'rgba(30, 91, 216, 0.4)',
            'stroke-width': 1,
            'vector-effect': 'non-scaling-stroke',
          }),
        )
      } else {
        rowNode.appendChild(
          svgEl('rect', {
            x: row.x + 6,
            y: row.y + 2,
            width: row.w - 12,
            height: row.h - 4,
            rx: 7,
            fill: 'transparent',
            'pointer-events': 'all',
          }),
        )
      }
      rowNode.appendChild(svgEl('circle', { cx: row.x + 19, cy: row.y + row.h / 2, r: 3.6, fill: color }))
      if (agent.status === 'running') {
        const pulse = svgEl('circle', { cx: row.x + 19, cy: row.y + row.h / 2, r: 3.6, fill: 'none', stroke: color, 'stroke-width': 1.4, opacity: 0.7 })
        pulse.appendChild(svgEl('animate', { attributeName: 'r', values: '3.6;9', dur: '1.2s', repeatCount: 'indefinite' }))
        pulse.appendChild(svgEl('animate', { attributeName: 'opacity', values: '0.7;0', dur: '1.2s', repeatCount: 'indefinite' }))
        rowNode.appendChild(pulse)
      }
      appendText(rowNode, row.x + 30, row.y + row.h / 2 + 3.4, truncate(agent.scope || titleCase(agent.role), 28), {
        fill: 'rgba(26, 31, 46, 0.74)',
        'font-size': 9.4,
        'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
      })
      appendText(rowNode, row.x + row.w - 14, row.y + row.h / 2 + 3.4, agent.removed ? `${statusLabel(agent.status)} · removed` : statusLabel(agent.status), {
        fill: color,
        'font-size': 8.4,
        'font-weight': 800,
        'text-anchor': 'end',
      })
      addTitle(rowNode, [`${titleCase(agent.role)} (${shortId(agentId)})`, agent.scope ? `Scope: ${agent.scope}` : '', `Lifecycle: ${lifecycleLabel(agent)}`].filter(Boolean).join('\n'))
      scene.appendChild(rowNode)
    }
  }
}

function drawProviders(layout) {
  for (const cat of layout.categories) {
    appendText(scene, PV_X + 2, cat.y + 12, cat.label.toUpperCase(), {
      fill: 'rgba(26, 31, 46, 0.42)',
      'font-size': 8.5,
      'font-weight': 800,
      'letter-spacing': '0.09em',
    })
  }

  for (const [providerId, rect] of Object.entries(layout.providerRects)) {
    const provider = state.providers[providerId]
    if (!provider) continue
    const pState = provider.active > 0 ? 'running' : provider.blocked > 0 ? 'blocked' : provider.failed > 0 ? 'failed' : provider.ok > 0 ? 'completed' : 'pending'
    const color = pState === 'failed' ? C.amber : statusColor(pState)
    const isSelected = selected === `provider:${providerId}`
    const group = svgEl('g', { 'data-select': `provider:${providerId}`, tabindex: '0', opacity: opacityFor(`provider:${providerId}`) })

    group.appendChild(
      svgEl('rect', {
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        rx: 12,
        fill: 'url(#card-fill)',
        stroke: isSelected ? C.blue : pState === 'running' ? 'rgba(30, 91, 216, 0.4)' : provider.blocked ? 'rgba(192, 57, 43, 0.4)' : 'rgba(11, 61, 145, 0.13)',
        'stroke-width': isSelected ? 2 : 1,
        filter: 'drop-shadow(0 6px 14px rgba(11, 61, 145, 0.05))',
        'vector-effect': 'non-scaling-stroke',
      }),
    )
    group.appendChild(svgEl('circle', { cx: rect.x + 16, cy: rect.y + 19, r: 4.5, fill: color }))
    appendText(group, rect.x + 28, rect.y + 22, titleCase(providerId), {
      fill: C.ink,
      'font-size': 11,
      'font-weight': 800,
    })
    const stats = [`${provider.calls} calls`]
    if (provider.active) stats.push(`${provider.active} active`)
    if (provider.blocked) stats.push(`${provider.blocked} blocked`)
    if (provider.failed) stats.push(`${provider.failed} failed`)
    appendText(group, rect.x + 14, rect.y + 41, stats.join(' · '), {
      fill: provider.blocked ? C.red : 'rgba(26, 31, 46, 0.55)',
      'font-size': 8.8,
      'font-weight': 700,
      'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
    })
    addTitle(
      group,
      [
        titleCase(providerId),
        `Category: ${PROVIDER_CATEGORIES.find((cat) => cat.id === provider.category)?.label || 'Provider'}`,
        `Calls: ${provider.calls} (${provider.ok} ok · ${provider.blocked} blocked · ${provider.failed} failed)`,
        provider.lastAction ? `Last action: ${provider.lastAction}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    scene.appendChild(group)
  }
}

/* ---------- render orchestration ---------- */

function scheduleRender() {
  if (renderHandle) return
  renderHandle = window.requestAnimationFrame(() => {
    renderHandle = 0
    render()
  })
}

function render() {
  updateStatus()
  renderTimeline()
  renderInspector()
  if (!Object.keys(state.agents).length && !Object.keys(state.providers).length && !state.runId) return

  focusSet = computeFocusSet()
  computeFilterSets()
  const layout = computeLayout()
  resetSvg()
  drawCaptions()
  drawRuntimeFrame(layout)
  drawProviderFrame(layout)
  drawBandBase(layout)
  drawUserEdge(layout)
  drawDelegationEdges(layout)
  drawFlows(layout)
  drawBandContent(layout)
  drawUser(layout)
  drawOrchestrators(layout)
  drawGroups(layout)
  drawProviders(layout)
}

function updateStatus() {
  if (!state.runId) {
    statusEl.textContent = 'idle'
    return
  }
  const active = Object.values(state.agents).filter((agent) => agent.status === 'running').length
  const parts = [statusLabel(state.phase === 'running' ? 'running' : state.phase)]
  if (active) parts.push(`${active} active`)
  parts.push(`${Object.keys(state.agents).length} agents`, `${Object.keys(state.providers).length} providers`)
  if (state.decisions.blocked) parts.push(`${state.decisions.blocked} blocked`)
  statusEl.textContent = parts.join(' · ')
}

/* ---------- timeline rail ---------- */

const TIMELINE_KIND_LABEL = {
  request: 'Request',
  agent: 'Agent',
  provider: 'Provider',
  approval: 'Approval',
  audit: 'Audit',
  blocked: 'Blocked',
  error: 'Error',
  done: 'Run',
}

function renderTimeline() {
  timelineList.replaceChildren()
  timelineCount.textContent = state.timeline.length
    ? `${state.timeline.length} milestone${state.timeline.length === 1 ? '' : 's'}`
    : 'Waiting for a task'

  if (!state.timeline.length) {
    const item = document.createElement('li')
    item.className = 'graph-timeline-item kind-request'
    const label = document.createElement('span')
    label.className = 'graph-timeline-label'
    label.textContent = 'Execution milestones appear here as the run progresses.'
    item.appendChild(label)
    timelineList.appendChild(item)
    return
  }

  for (const entry of state.timeline) {
    const item = document.createElement('li')
    item.className = `graph-timeline-item kind-${entry.kind}`
    item.tabIndex = 0
    item.addEventListener('click', () => {
      selected = entry.ref || 'run'
      scheduleRender()
    })
    const kind = document.createElement('span')
    kind.className = 'graph-timeline-kind'
    kind.textContent = TIMELINE_KIND_LABEL[entry.kind] || 'Event'
    const label = document.createElement('span')
    label.className = 'graph-timeline-label'
    label.textContent = entry.label
    const meta = document.createElement('span')
    meta.className = 'graph-timeline-meta'
    meta.textContent = formatTime(entry.ts)
    item.append(kind, label, meta)
    timelineList.appendChild(item)
  }
}

/* ---------- inspector ---------- */

function addMetric(label, value) {
  const row = document.createElement('div')
  const dt = document.createElement('dt')
  const dd = document.createElement('dd')
  dt.textContent = label
  dd.textContent = value
  row.append(dt, dd)
  inspectorMetrics.appendChild(row)
}

function renderInspector() {
  inspectorMetrics.replaceChildren()
  const [kind, rawId = ''] = String(selected || 'run').split(/:(.*)/s)

  if (kind === 'agent' && state.agents[rawId]) {
    const agent = state.agents[rawId]
    inspectorType.textContent = ORCH_LAYERS.has(agent.layer) ? 'Orchestrator' : 'Agent'
    inspectorTitle.textContent = titleCase(agent.role)
    inspectorCopy.textContent = agent.scope
      ? `Ephemeral agent operating under the delegated scope “${agent.scope}”.`
      : 'Ephemeral agent operating under Caracal-delegated authority.'
    addMetric('Lifecycle', lifecycleLabel(agent))
    addMetric('Status', statusLabel(agent.status))
    if (agent.region) addMetric('Region', agent.region)
    addMetric('Agent ID', shortId(agent.id))
    addMetric('Parent', agent.parent ? titleCase(state.agents[agent.parent]?.role || shortId(agent.parent)) : 'Root')
    addMetric('Tool calls', String(agent.toolCalls))
    addMetric('Providers', String(agentFlows(agent.id).length))
    if (agent.model) addMetric('Model', agent.model)
    addMetric('Tokens', `${agent.inputTokens} in / ${agent.outputTokens} out`)
    if (agent.spawnTs) addMetric('Spawned', formatTime(agent.spawnTs))
    if (agent.endTs) addMetric('Removed', formatTime(agent.endTs))
    return
  }

  if (kind === 'group' && state.groups[rawId]) {
    const group = state.groups[rawId]
    const members = group.agentIds.map((id) => state.agents[id]).filter(Boolean)
    inspectorType.textContent = 'Worker pool'
    inspectorTitle.textContent = titleCase(rawId)
    inspectorCopy.textContent = 'Ephemeral workers spawned for this role, each scoped to a single task and removed on completion.'
    addMetric('Spawned', String(members.length))
    addMetric('Live', String(members.filter((agent) => !agent.removed).length))
    addMetric('Completed', String(members.filter((agent) => agent.status === 'completed').length))
    addMetric('Failed', String(members.filter((agent) => agent.status === 'failed').length))
    return
  }

  if (kind === 'provider' && state.providers[rawId]) {
    const provider = state.providers[rawId]
    inspectorType.textContent = 'External provider'
    inspectorTitle.textContent = titleCase(rawId)
    inspectorCopy.textContent = 'Outside the trust boundary. Every call is authorized, policy-checked, and audited by Caracal before it reaches this system.'
    addMetric('Category', PROVIDER_CATEGORIES.find((cat) => cat.id === provider.category)?.label || 'Provider')
    addMetric('Calls', String(provider.calls))
    addMetric('Allowed', String(provider.ok))
    addMetric('Blocked', String(provider.blocked))
    addMetric('Failed', String(provider.failed))
    addMetric('Active now', String(provider.active))
    if (provider.lastAction) addMetric('Last action', provider.lastAction)
    return
  }

  if (kind === 'flow' && state.flows[rawId]) {
    const flow = state.flows[rawId]
    const agent = state.agents[flow.agentId]
    inspectorType.textContent = 'Provider access'
    inspectorTitle.textContent = `${titleCase(agent?.role || 'Agent')} → ${titleCase(flow.providerId)}`
    inspectorCopy.textContent = 'A governed call path. Caracal mints a scoped mandate, evaluates policy, and records the decision before the provider is reached.'
    addMetric('Status', statusLabel(flowState(flow)))
    addMetric('Calls', String(flow.calls))
    addMetric('Allowed', String(flow.ok))
    addMetric('Blocked', String(flow.blocked))
    addMetric('Failed', String(flow.failed))
    if (flow.lastAction) addMetric('Last action', flow.lastAction)
    if (flow.lastReason) addMetric('Detail', flow.lastReason)
    return
  }

  if (kind === 'plane') {
    const d = state.decisions
    inspectorType.textContent = 'Control plane'
    inspectorTitle.textContent = 'Caracal'
    inspectorCopy.textContent = 'The orchestration boundary. Policy evaluation, authorization, delegation, approvals, and audit for every runtime action.'
    addMetric('Policy checks', String(d.checks))
    addMetric('Allowed', String(d.allowed))
    addMetric('Blocked', String(d.blocked))
    addMetric('Approvals', `${d.approvalsApproved} approved · ${d.approvalsDenied} denied`)
    addMetric('Pending', String(d.approvalsPending))
    addMetric('Audit records', String(d.audits))
    return
  }

  if (kind === 'user') {
    inspectorType.textContent = 'Request'
    inspectorTitle.textContent = 'User request'
    inspectorCopy.textContent = state.prompt || 'The originating intent for this run.'
    addMetric('Phase', statusLabel(state.phase))
    if (state.startTs) addMetric('Received', formatTime(state.startTs))
    if (state.endTs) addMetric('Finished', formatTime(state.endTs))
    return
  }

  selected = 'run'
  inspectorType.textContent = 'Overview'
  inspectorTitle.textContent = state.runId ? `Run ${shortId(state.runId)}` : 'Nothing selected'
  inspectorCopy.textContent = state.runId
    ? 'Live execution map. Select an agent, provider, gate, or connection to inspect it.'
    : 'Select an item on the orchestration map to see what it does.'
  addMetric('Phase', statusLabel(state.phase))
  addMetric('Agents', String(Object.keys(state.agents).length))
  addMetric('Providers', String(Object.keys(state.providers).length))
  addMetric('Allowed', String(state.decisions.allowed))
  addMetric('Blocked', String(state.decisions.blocked))
  addMetric('Audit records', String(state.decisions.audits))
}

/* ---------- stream attachment ---------- */

function attachStream(nextRunId) {
  resetState()
  state.runId = nextRunId
  state.phase = 'running'
  selected = 'run'
  filterMode = 'all'
  for (const btn of filterBtns) btn.classList.toggle('is-active', btn.dataset.graphfilter === 'all')
  transform = { scale: 1, x: 0, y: 0 }

  if (eventSource) eventSource.close()
  if (renderHandle) {
    window.cancelAnimationFrame(renderHandle)
    renderHandle = 0
  }

  svg.innerHTML = ''
  scene = null
  if (emptyEl) emptyEl.style.display = ''
  if (svg) svg.style.display = 'none'
  statusEl.textContent = 'running…'
  renderTimeline()
  renderInspector()

  eventSource = new EventSource(`/api/run/${nextRunId}/events`)
  eventSource.onmessage = (message) => {
    try {
      handleEvent(JSON.parse(message.data))
    } catch {
      scheduleRender()
    }
  }
  eventSource.onerror = () => {
    eventSource.close()
    eventSource = null
  }
}

/* ---------- interactions ---------- */

function zoomAt(nextScale, clientX, clientY, smooth = false) {
  const rect = svg.getBoundingClientRect()
  const x = ((clientX - rect.left) / rect.width) * VIEW_W
  const y = ((clientY - rect.top) / rect.height) * viewH
  const scale = clampVal(nextScale, 0.42, 2.4)
  const ratio = scale / transform.scale
  transform.x = x - (x - transform.x) * ratio
  transform.y = y - (y - transform.y) * ratio
  transform.scale = scale
  applyTransform(smooth)
}

function resetZoom() {
  transform = { scale: 1, x: 0, y: 0 }
  applyTransform(true)
}

if (svg) {
  svg.addEventListener('click', (event) => {
    if (dragMoved) return
    const target = event.target.closest('[data-select]')
    selected = target ? target.getAttribute('data-select') : 'run'
    scheduleRender()
  })
}

if (canvas) {
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!scene) return
      event.preventDefault()
      const delta = event.deltaY > 0 ? 0.9 : 1.1
      zoomAt(transform.scale * delta, event.clientX, event.clientY)
    },
    { passive: false },
  )

  canvas.addEventListener('pointerdown', (event) => {
    if (!scene || event.button !== 0) return
    dragStart = { x: event.clientX, y: event.clientY, tx: transform.x, ty: transform.y }
    dragMoved = false
    canvas.classList.add('is-panning')
    canvas.setPointerCapture(event.pointerId)
  })

  canvas.addEventListener('pointermove', (event) => {
    if (!dragStart) return
    const rect = svg.getBoundingClientRect()
    const dx = ((event.clientX - dragStart.x) / rect.width) * VIEW_W
    const dy = ((event.clientY - dragStart.y) / rect.height) * viewH
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true
    transform.x = dragStart.tx + dx
    transform.y = dragStart.ty + dy
    applyTransform()
  })

  canvas.addEventListener('pointerup', (event) => {
    if (!dragStart) return
    dragStart = null
    canvas.classList.remove('is-panning')
    canvas.releasePointerCapture(event.pointerId)
    window.setTimeout(() => {
      dragMoved = false
    }, 0)
  })

  canvas.addEventListener('pointercancel', () => {
    dragStart = null
    canvas.classList.remove('is-panning')
  })
}

for (const btn of filterBtns) {
  btn.addEventListener('click', () => {
    filterMode = btn.dataset.graphfilter
    for (const other of filterBtns) other.classList.toggle('is-active', other === btn)
    scheduleRender()
  })
}

if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => zoomAt(transform.scale * 0.88, window.innerWidth / 2, window.innerHeight / 2, true))
if (zoomInBtn) zoomInBtn.addEventListener('click', () => zoomAt(transform.scale * 1.12, window.innerWidth / 2, window.innerHeight / 2, true))
if (zoomResetBtn) zoomResetBtn.addEventListener('click', resetZoom)
if (fitBtn) fitBtn.addEventListener('click', resetZoom)

window.addEventListener('run-started', (event) => attachStream(event.detail.runId))
renderTimeline()
renderInspector()
