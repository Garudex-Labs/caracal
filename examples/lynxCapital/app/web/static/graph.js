/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Graph panel: orchestration topology with agents, external service calls,
 * and Caracal permission decisions rendered as a live inline SVG.
 */

const svg       = document.getElementById('graph-svg');
const statusEl  = document.getElementById('graph-status');
const emptyEl   = document.getElementById('graph-empty');

function revealSvg() {
  if (emptyEl && emptyEl.parentNode) emptyEl.style.display = 'none';
  if (svg) svg.style.display = '';
}

const NS = 'http://www.w3.org/2000/svg';

const ROW_H     = 64;
const NODE_W    = 100;
const NODE_H    = 32;
const REGION_GAP = 8;
const BAND_GAP  = 14;
const LEFT_PAD  = 140;
const RIGHT_PAD = 20;
const SVC_ROW_H = 54;
const SVC_NODE_W = 90;
const SVC_NODE_H = 24;

const STATUS_COLOR = {
  spawned:   'var(--statusSpawned)',
  running:   'var(--statusRunning)',
  completed: 'var(--statusCompleted)',
  denied:    'var(--statusDenied)',
  failed:    'var(--statusFailed)',
  cancelled: 'var(--statusCancelled)',
  default:   'var(--border)',
};

const LAYER_ORDER = [
  'finance-control',
  'regional-orchestrator',
  'invoice-intake',
  'ledger-match',
  'policy-check',
  'route-optimization',
  'payment-execution',
  'audit',
  'exception',
];

const LAYER_LABELS = {
  'finance-control':      'Finance Control',
  'regional-orchestrator':'Regional Orchestrators',
  'invoice-intake':       'Invoice Intake',
  'ledger-match':         'Ledger Match',
  'policy-check':         'Policy Check',
  'route-optimization':   'Route Optimization',
  'payment-execution':    'Payment Execution',
  'audit':                'Audit',
  'exception':            'Exception',
};

let nodes    = {};   // agent_id -> {id, role, layer, region, status, parent, perm}
let services = {};   // service_id -> {id, calls, ok, err, lastStatus}
let svcEdges = {};   // `${agent_id}:${service_id}` -> {from, to, count, status}
let runId    = null;

function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function statusColor(status) {
  return STATUS_COLOR[status] || STATUS_COLOR.default;
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len - 1) + '\u2026' : str;
}

function permColor(decision) {
  if (decision === 'allow' || decision === 'allowed') return 'var(--success, #1a7f4b)';
  if (decision === 'deny'  || decision === 'denied')  return 'var(--danger, #c23b3b)';
  return 'var(--text)';
}

function buildLayout() {
  const byLayer = {};
  for (const n of Object.values(nodes)) {
    (byLayer[n.layer] = byLayer[n.layer] || []).push(n);
  }

  const layers = LAYER_ORDER.filter(l => byLayer[l]);
  const svcList = Object.values(services);
  const showSvc = svcList.length > 0;
  const totalW = 960;
  const agentsH = layers.length * (ROW_H + BAND_GAP) + BAND_GAP;
  const svcH = showSvc ? SVC_ROW_H + BAND_GAP : 0;
  const viewH = agentsH + svcH;

  svg.setAttribute('viewBox', `0 0 ${totalW} ${viewH}`);
  svg.setAttribute('height', viewH);
  svg.innerHTML = '';

  svg.appendChild(svgEl('defs', {}));

  const layerCY = {};

  layers.forEach((layerId, li) => {
    const bandY = BAND_GAP + li * (ROW_H + BAND_GAP);
    const bandNodes = byLayer[layerId];
    const cy = bandY + ROW_H / 2;
    layerCY[layerId] = cy;

    svg.appendChild(svgEl('rect', {
      x: 0, y: bandY, width: totalW, height: ROW_H,
      fill: 'none', stroke: 'var(--border)', 'stroke-width': 0.5, rx: 3,
    }));

    const labelEl = svgEl('text', {
      x: LEFT_PAD - 10, y: cy + 4,
      fill: 'var(--text)', 'font-size': 11, 'text-anchor': 'end',
      'font-family': 'system-ui, sans-serif', opacity: 0.7,
    });
    labelEl.textContent = LAYER_LABELS[layerId] || layerId;
    svg.appendChild(labelEl);

    const byRegion = {};
    for (const n of bandNodes) {
      const key = n.region || '_';
      (byRegion[key] = byRegion[key] || []).push(n);
    }

    const regions = Object.keys(byRegion);
    const usableW = totalW - LEFT_PAD - RIGHT_PAD;
    const regionSlotW = usableW / (regions.length || 1);

    regions.forEach((region, ri) => {
      const regionNodes = byRegion[region];
      const slotX = LEFT_PAD + ri * regionSlotW;

      if (region !== '_') {
        const rlEl = svgEl('text', {
          x: slotX + regionSlotW / 2, y: bandY + 9,
          fill: 'var(--primary)', 'font-size': 9, 'text-anchor': 'middle',
          'font-family': 'system-ui, sans-serif', opacity: 0.55, 'font-weight': 600,
        });
        rlEl.textContent = region;
        svg.appendChild(rlEl);
      }

      const nodeAreaW = regionSlotW - REGION_GAP * 2;
      const perRow = Math.max(1, Math.floor(nodeAreaW / (NODE_W + 6)));
      const displayNodes = regionNodes.slice(0, perRow);
      const hiddenCount = regionNodes.length - displayNodes.length;

      displayNodes.forEach((n, ni) => {
        const nodeX = slotX + REGION_GAP + ni * (NODE_W + 6) + (nodeAreaW - perRow * (NODE_W + 6)) / 2;
        const nodeY = bandY + (ROW_H - NODE_H) / 2;

        const g = svgEl('g', {'data-id': n.id});

        g.appendChild(svgEl('rect', {
          x: nodeX, y: nodeY, width: NODE_W, height: NODE_H,
          fill: '#fff', stroke: statusColor(n.status || 'spawned'),
          'stroke-width': 1.5, rx: 3,
        }));

        const roleText = svgEl('text', {
          x: nodeX + NODE_W / 2, y: nodeY + NODE_H / 2 - 3,
          fill: 'var(--text)', 'font-size': 9.5, 'text-anchor': 'middle',
          'font-family': 'system-ui, sans-serif', 'font-weight': 600,
        });
        roleText.textContent = truncate(n.role || '', 14);
        g.appendChild(roleText);

        const statusText = svgEl('text', {
          x: nodeX + NODE_W / 2, y: nodeY + NODE_H / 2 + 8,
          fill: statusColor(n.status || 'spawned'), 'font-size': 8.5,
          'text-anchor': 'middle', 'font-family': 'system-ui, sans-serif',
        });
        statusText.textContent = n.status || 'spawned';
        g.appendChild(statusText);

        // Permission badge — small lock with fill colored by Caracal decision.
        if (n.perm) {
          const bx = nodeX + NODE_W - 13;
          const by = nodeY + 3;
          const fill = permColor(n.perm.decision);
          g.appendChild(svgEl('rect', {
            x: bx, y: by, width: 10, height: 10, rx: 2,
            fill: fill, opacity: 0.85,
          }));
          const lock = svgEl('text', {
            x: bx + 5, y: by + 8,
            fill: '#fff', 'font-size': 8, 'text-anchor': 'middle',
            'font-family': 'system-ui, sans-serif', 'font-weight': 700,
          });
          lock.textContent = n.perm.decision === 'deny' ? '!' : '\u2713';
          g.appendChild(lock);
          const t = svgEl('title', {});
          t.textContent = `Caracal: ${n.perm.decision} \u00b7 ${n.perm.enforce_count || 0} enforced`;
          g.appendChild(t);
        }

        n._cx = nodeX + NODE_W / 2;
        n._cy_bot = nodeY + NODE_H;
        n._cy_top = nodeY;

        svg.appendChild(g);
      });

      if (hiddenCount > 0) {
        const bx = slotX + REGION_GAP + displayNodes.length * (NODE_W + 6) + 2;
        const by = bandY + (ROW_H - NODE_H) / 2;
        const badge = svgEl('text', {
          x: bx, y: by + NODE_H / 2 + 4,
          fill: 'var(--accent)', 'font-size': 9, 'font-weight': 600,
          'font-family': 'system-ui, sans-serif', opacity: 0.7,
        });
        badge.textContent = `+${hiddenCount}`;
        svg.appendChild(badge);
      }
    });
  });

  // Parent -> child fan-out edges between adjacent layers.
  for (let i = 0; i < layers.length - 1; i++) {
    const fromLayer = layers[i];
    const toLayer = layers[i + 1];
    const fromNodes = (byLayer[fromLayer] || []).filter(n => n._cx !== undefined);
    const toNodes   = (byLayer[toLayer]   || []).filter(n => n._cx !== undefined);
    if (!fromNodes.length || !toNodes.length) continue;

    const fx = fromNodes.reduce((s, n) => s + n._cx, 0) / fromNodes.length;
    const fy = layerCY[fromLayer] + ROW_H / 2 - 2;
    const tx = toNodes.reduce((s, n) => s + n._cx, 0) / toNodes.length;
    const ty = layerCY[toLayer] - ROW_H / 2 + NODE_H / 2;
    const midY = (fy + ty) / 2;
    const strokeW = Math.min(4, Math.max(1, Math.sqrt(toNodes.length) * 0.6));

    svg.insertBefore(svgEl('path', {
      d: `M ${fx} ${fy} C ${fx} ${midY}, ${tx} ${midY}, ${tx} ${ty}`,
      fill: 'none', stroke: 'var(--border)', 'stroke-width': strokeW, opacity: 0.55,
    }), svg.firstChild);
  }

  // External services band + agent->service edges.
  if (showSvc) {
    const svcY = agentsH + BAND_GAP / 2;
    svg.appendChild(svgEl('rect', {
      x: 0, y: svcY, width: totalW, height: SVC_ROW_H,
      fill: '#FBFCFE', stroke: 'var(--border)', 'stroke-width': 0.5, rx: 3,
    }));

    const labelEl = svgEl('text', {
      x: LEFT_PAD - 10, y: svcY + SVC_ROW_H / 2 + 4,
      fill: 'var(--teal, #0D6E72)', 'font-size': 11, 'text-anchor': 'end',
      'font-family': 'system-ui, sans-serif', opacity: 0.85, 'font-weight': 600,
    });
    labelEl.textContent = 'External services';
    svg.appendChild(labelEl);

    const usableW = totalW - LEFT_PAD - RIGHT_PAD;
    const slotW = usableW / svcList.length;
    svcList.forEach((s, i) => {
      const nodeX = LEFT_PAD + i * slotW + (slotW - SVC_NODE_W) / 2;
      const nodeY = svcY + (SVC_ROW_H - SVC_NODE_H) / 2;
      const color = s.err > 0 ? statusColor('failed') : (s.calls > 0 ? 'var(--teal, #0D6E72)' : 'var(--border)');

      const g = svgEl('g', {'data-svc': s.id});
      g.appendChild(svgEl('rect', {
        x: nodeX, y: nodeY, width: SVC_NODE_W, height: SVC_NODE_H, rx: 3,
        fill: '#fff', stroke: color, 'stroke-width': 1.5,
      }));
      const nameText = svgEl('text', {
        x: nodeX + SVC_NODE_W / 2, y: nodeY + SVC_NODE_H / 2 - 2,
        fill: 'var(--text)', 'font-size': 9, 'text-anchor': 'middle',
        'font-family': 'system-ui, sans-serif', 'font-weight': 600,
      });
      nameText.textContent = truncate(s.id, 13);
      g.appendChild(nameText);

      const countText = svgEl('text', {
        x: nodeX + SVC_NODE_W / 2, y: nodeY + SVC_NODE_H / 2 + 8,
        fill: color, 'font-size': 8.5, 'text-anchor': 'middle',
        'font-family': 'ui-monospace, monospace',
      });
      countText.textContent = `${s.calls} call${s.calls === 1 ? '' : 's'}${s.err ? ` \u00b7 ${s.err} err` : ''}`;
      g.appendChild(countText);

      s._cx = nodeX + SVC_NODE_W / 2;
      s._cy_top = nodeY;
      svg.appendChild(g);
    });

    // Agent -> service edges.
    for (const key of Object.keys(svcEdges)) {
      const [aid, sid] = key.split('::');
      const agent = nodes[aid];
      const svc = services[sid];
      if (!agent || !svc || agent._cx === undefined) continue;
      const info = svcEdges[key];
      const strokeW = Math.min(3.5, 1 + Math.log2(1 + info.count));
      const fy = agent._cy_bot;
      const ty = svc._cy_top;
      const midY = (fy + ty) / 2;
      svg.insertBefore(svgEl('path', {
        d: `M ${agent._cx} ${fy} C ${agent._cx} ${midY}, ${svc._cx} ${midY}, ${svc._cx} ${ty}`,
        fill: 'none',
        stroke: info.status === 'error' ? statusColor('failed') : 'var(--teal, #0D6E72)',
        'stroke-width': strokeW,
        opacity: 0.55,
      }), svg.firstChild);
    }
  }
}

function updateNode(id, status) {
  if (!nodes[id]) return;
  nodes[id] = {...nodes[id], status};
  const g = svg.querySelector(`[data-id="${id}"]`);
  if (!g) { buildLayout(); return; }
  const rect = g.querySelector('rect');
  const txt  = g.querySelectorAll('text')[1];
  if (rect) rect.setAttribute('stroke', statusColor(status));
  if (txt) { txt.setAttribute('fill', statusColor(status)); txt.textContent = status; }
}

function handleEvent(ev) {
  const p = ev.payload || {};
  switch (ev.kind) {
    case 'agent_spawn':
      nodes[p.agent_id] = {
        id: p.agent_id, role: p.role, layer: p.layer,
        region: p.region, parent: p.parent_id, status: 'spawned',
      };
      revealSvg();
      buildLayout();
      break;
    case 'agent_start':
      updateNode(p.agent_id, 'running');
      break;
    case 'agent_terminate':
      updateNode(p.agent_id, p.status || 'completed');
      break;
    case 'service_call': {
      const sid = p.service_id;
      if (!sid) break;
      if (!services[sid]) services[sid] = { id: sid, calls: 0, ok: 0, err: 0, lastStatus: null };
      services[sid].calls += 1;
      const aid = p.agent_id;
      if (aid) {
        const key = `${aid}::${sid}`;
        if (!svcEdges[key]) svcEdges[key] = { agent: aid, svc: sid, count: 0, status: 'ok' };
        svcEdges[key].count += 1;
      }
      revealSvg();
      buildLayout();
      break;
    }
    case 'service_result': {
      const sid = p.service_id;
      if (!sid || !services[sid]) break;
      const isErr = p.result && (p.result.status === 'error' || p.result.status === 'failed' || p.result.error);
      if (isErr) services[sid].err += 1;
      else services[sid].ok += 1;
      services[sid].lastStatus = isErr ? 'error' : 'ok';
      const aid = p.agent_id;
      if (aid) {
        const key = `${aid}::${sid}`;
        if (svcEdges[key]) svcEdges[key].status = isErr ? 'error' : 'ok';
      }
      buildLayout();
      break;
    }
    case 'caracal_bind': {
      const aid = p.agent_id;
      if (!aid || !nodes[aid]) break;
      nodes[aid].perm = { decision: p.decision, enforce_count: (nodes[aid].perm?.enforce_count || 0) };
      buildLayout();
      break;
    }
    case 'caracal_enforce': {
      const aid = p.agent_id;
      if (!aid || !nodes[aid]) break;
      const prior = nodes[aid].perm || { decision: p.decision, enforce_count: 0 };
      nodes[aid].perm = {
        decision: p.decision === 'deny' ? 'deny' : prior.decision,
        enforce_count: (prior.enforce_count || 0) + 1,
      };
      buildLayout();
      break;
    }
    case 'run_end':
      statusEl.textContent = `${p.status || 'done'} \u00b7 ${Object.keys(nodes).length} agents \u00b7 ${Object.keys(services).length} services`;
      break;
  }
}

function attachStream(rid) {
  runId = rid;
  nodes = {};
  services = {};
  svcEdges = {};
  svg.innerHTML = '';
  if (emptyEl) emptyEl.style.display = '';
  if (svg) svg.style.display = 'none';
  statusEl.textContent = 'running...';

  const es = new EventSource(`/api/run/${rid}/events`);
  es.onmessage = e => {
    try { handleEvent(JSON.parse(e.data)); } catch {}
  };
  es.addEventListener('run_end', () => es.close());
  es.onerror = () => es.close();
}

window.addEventListener('run-started', e => attachStream(e.detail.runId));
