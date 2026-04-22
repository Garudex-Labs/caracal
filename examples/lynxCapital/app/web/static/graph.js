/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Graph panel: renders the orchestration topology with layer/region grouping
 * and fan-out edges as inline SVG. Updates live as events arrive.
 */

const svg       = document.getElementById('graph-svg');
const statusEl  = document.getElementById('graph-status');

const NS = 'http://www.w3.org/2000/svg';

// Layout constants
const ROW_H     = 64;   // height per layer band
const BAND_PAD  = 10;   // top padding inside a band
const NODE_W    = 100;
const NODE_H    = 32;
const REGION_GAP = 8;
const BAND_GAP  = 14;
const LEFT_PAD  = 140;  // label column width
const RIGHT_PAD = 20;

// Status -> color map
const STATUS_COLOR = {
  spawned:   'var(--statusSpawned)',
  running:   'var(--statusRunning)',
  completed: 'var(--statusCompleted)',
  denied:    'var(--statusDenied)',
  failed:    'var(--statusFailed)',
  cancelled: 'var(--statusCancelled)',
  default:   'var(--border)',
};

// Layer render order and label
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

let nodes = {};      // id -> {id, role, layer, region, status, parent}
let runId = null;
let pollTimer = null;

function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function statusColor(status) {
  return STATUS_COLOR[status] || STATUS_COLOR.default;
}

// Group nodes by layer, then by region within each layer.
function buildLayout() {
  const byLayer = {};
  for (const n of Object.values(nodes)) {
    (byLayer[n.layer] = byLayer[n.layer] || []).push(n);
  }

  const layers = LAYER_ORDER.filter(l => byLayer[l]);
  const totalW = 960;
  const viewH = layers.length * (ROW_H + BAND_GAP) + BAND_GAP;

  svg.setAttribute('viewBox', `0 0 ${totalW} ${viewH}`);
  svg.setAttribute('height', viewH);
  svg.innerHTML = '';

  const defs = svgEl('defs', {});
  svg.appendChild(defs);

  // Per-layer center y positions for edge routing
  const layerCY = {};

  layers.forEach((layerId, li) => {
    const bandY = BAND_GAP + li * (ROW_H + BAND_GAP);
    const bandNodes = byLayer[layerId];
    const cy = bandY + ROW_H / 2;
    layerCY[layerId] = cy;

    // Band background
    const band = svgEl('rect', {
      x: 0, y: bandY, width: totalW, height: ROW_H,
      fill: 'none', stroke: 'var(--border)', 'stroke-width': 0.5,
      rx: 3,
    });
    svg.appendChild(band);

    // Layer label
    const labelEl = svgEl('text', {
      x: LEFT_PAD - 10, y: cy + 4,
      fill: 'var(--text)', 'font-size': 11, 'text-anchor': 'end',
      'font-family': 'system-ui, sans-serif', opacity: 0.7,
    });
    labelEl.textContent = LAYER_LABELS[layerId] || layerId;
    svg.appendChild(labelEl);

    // Group nodes by region
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

      // Region label (skip global _)
      if (region !== '_') {
        const rlEl = svgEl('text', {
          x: slotX + regionSlotW / 2, y: bandY + 9,
          fill: 'var(--primary)', 'font-size': 9, 'text-anchor': 'middle',
          'font-family': 'system-ui, sans-serif', opacity: 0.55,
          'font-weight': 600,
        });
        rlEl.textContent = region;
        svg.appendChild(rlEl);
      }

      // Distribute nodes horizontally within the region slot
      const nodeAreaW = regionSlotW - REGION_GAP * 2;
      const perRow = Math.max(1, Math.floor(nodeAreaW / (NODE_W + 6)));
      const displayNodes = regionNodes.slice(0, perRow);
      const hiddenCount = regionNodes.length - displayNodes.length;

      displayNodes.forEach((n, ni) => {
        const nodeX = slotX + REGION_GAP + ni * (NODE_W + 6) + (nodeAreaW - perRow * (NODE_W + 6)) / 2;
        const nodeY = bandY + (ROW_H - NODE_H) / 2;

        const g = svgEl('g', {'data-id': n.id});

        const rect = svgEl('rect', {
          x: nodeX, y: nodeY, width: NODE_W, height: NODE_H,
          fill: '#fff', stroke: statusColor(n.status || 'spawned'),
          'stroke-width': 1.5, rx: 3,
        });
        g.appendChild(rect);

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

        // Store center for edge routing
        n._cx = nodeX + NODE_W / 2;
        n._cy = nodeY + NODE_H;  // bottom center

        svg.appendChild(g);
      });

      // Overflow badge
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

  // Draw fan-out edges between adjacent layers
  for (let i = 0; i < layers.length - 1; i++) {
    const fromLayer = layers[i];
    const toLayer = layers[i + 1];
    const fromNodes = (byLayer[fromLayer] || []).filter(n => n._cx !== undefined);
    const toNodes   = (byLayer[toLayer]   || []).filter(n => n._cx !== undefined);

    if (!fromNodes.length || !toNodes.length) continue;

    // Bundle: draw one bezier from midpoint of parent group to midpoint of child group
    const fx = fromNodes.reduce((s, n) => s + n._cx, 0) / fromNodes.length;
    const fy = layerCY[fromLayer] + ROW_H / 2 - 2;
    const tx = toNodes.reduce((s, n) => s + n._cx, 0) / toNodes.length;
    const ty = layerCY[toLayer] - ROW_H / 2 + NODE_H / 2;

    const midY = (fy + ty) / 2;
    const strokeW = Math.min(4, Math.max(1, Math.sqrt(toNodes.length) * 0.6));

    const path = svgEl('path', {
      d: `M ${fx} ${fy} C ${fx} ${midY}, ${tx} ${midY}, ${tx} ${ty}`,
      fill: 'none', stroke: 'var(--border)', 'stroke-width': strokeW,
      opacity: 0.55,
    });
    svg.insertBefore(path, svg.firstChild);
  }
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len - 1) + '\u2026' : str;
}

function updateNode(id, status) {
  nodes[id] = {...nodes[id], status};
  // Patch the stroke on the node rect in place
  const g = svg.querySelector(`[data-id="${id}"]`);
  if (!g) { buildLayout(); return; }
  const rect = g.querySelector('rect');
  const txt  = g.querySelectorAll('text')[1];
  if (rect) rect.setAttribute('stroke', statusColor(status));
  if (txt) { txt.setAttribute('fill', statusColor(status)); txt.textContent = status; }
}

function handleEvent(ev) {
  const p = ev.payload || {};
  if (ev.kind === 'agent_spawn') {
    nodes[p.agent_id] = {
      id: p.agent_id, role: p.role, layer: p.layer,
      region: p.region, parent: p.parent_id, status: 'spawned',
    };
    buildLayout();
  } else if (ev.kind === 'agent_start') {
    updateNode(p.agent_id, 'running');
  } else if (ev.kind === 'agent_terminate') {
    updateNode(p.agent_id, p.status || 'completed');
  } else if (ev.kind === 'run_end') {
    statusEl.textContent = `done - ${Object.keys(nodes).length} agents`;
  }
}

function attachStream(rid) {
  runId = rid;
  nodes = {};
  svg.innerHTML = '';
  statusEl.textContent = 'running...';

  const es = new EventSource(`/api/run/${rid}/events`);
  es.onmessage = e => {
    try { handleEvent(JSON.parse(e.data)); } catch {}
  };
  es.addEventListener('run_end', () => es.close());
  es.onerror = () => es.close();
}

window.addEventListener('run-started', e => attachStream(e.detail.runId));
