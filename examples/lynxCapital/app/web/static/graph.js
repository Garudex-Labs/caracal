/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Graph panel: zoomable observability topology for live orchestration and provider flows.
 */

const svg = document.getElementById("graph-svg");
const canvas = document.getElementById("graph-canvas");
const statusEl = document.getElementById("graph-status");
const emptyEl = document.getElementById("graph-empty");
const stageRail = document.getElementById("graph-stage-rail");
const stageSummary = document.getElementById("graph-stage-summary");
const inspectorType = document.getElementById("graph-inspector-type");
const inspectorTitle = document.getElementById("graph-inspector-title");
const inspectorCopy = document.getElementById("graph-inspector-copy");
const inspectorMetrics = document.getElementById("graph-inspector-metrics");
const timelineList = document.getElementById("graph-timeline-list");
const timelineCount = document.getElementById("graph-timeline-count");
const zoomOutBtn = document.getElementById("graph-zoom-out");
const zoomInBtn = document.getElementById("graph-zoom-in");
const zoomResetBtn = document.getElementById("graph-zoom-reset");
const fitBtn = document.getElementById("graph-fit");

const NS = "http://www.w3.org/2000/svg";
const VIEW_W = 1800;
const TOP_PAD = 66;
const BOTTOM_PAD = 48;
const ORCH_X = 48;
const ORCH_W = 1068;
const RUNTIME_X = 1166;
const RUNTIME_W = 224;
const SERVICE_X = 1460;
const SERVICE_W = 260;
const STAGE_GAP = 22;
const NODE_W = 182;
const NODE_H = 70;
const NODE_GAP = 18;
const NODE_ROW_GAP = 18;
const SERVICE_H = 78;
const SERVICE_GAP = 16;
const TIMELINE_LIMIT = 80;

const COLORS = {
  spawned: "#4A6FA5",
  running: "#1E5BD8",
  completed: "#1A7F4B",
  failed: "#C0392B",
  cancelled: "#8A9BAE",
  pending: "#B85C00",
  audit: "#8A5800",
  teal: "#0D6E72",
  text: "#1A1F2E",
};

const TOOL_TO_SERVICE = {
  extract_invoice: { serviceId: "ocr-vision", action: "extract_invoice" },
  get_vendor_profile: { serviceId: "vendor-portal", action: "get_vendor_profile" },
  get_fx_rate: { serviceId: "fx-rates", action: "get_rate" },
  netsuite_match_invoice: { serviceId: "netsuite", action: "match_invoice" },
  netsuite_get_vendor_record: { serviceId: "netsuite", action: "get_vendor_record" },
  sap_match_invoice: { serviceId: "sap-erp", action: "match_invoice" },
  sap_get_vendor_record: { serviceId: "sap-erp", action: "get_vendor_record" },
  quickbooks_match_bill: { serviceId: "quickbooks", action: "match_bill" },
  quickbooks_get_vendor: { serviceId: "quickbooks", action: "get_vendor" },
  check_vendor: { serviceId: "compliance-nexus", action: "check_vendor" },
  check_transaction: { serviceId: "compliance-nexus", action: "check_transaction" },
  get_withholding_rate: { serviceId: "tax-rules", action: "get_withholding_rate" },
  validate_tax_id: { serviceId: "tax-rules", action: "validate_tax_id" },
  get_account_balance: { serviceId: "mercury-bank", action: "get_account_balance" },
  get_quote: { serviceId: "wise-payouts", action: "get_quote" },
  submit_payment: { serviceId: "mercury-bank", action: "submit_payment" },
  submit_payout: { serviceId: "wise-payouts", action: "submit_payout" },
  create_outbound_payment: { serviceId: "stripe-treasury", action: "create_outbound_payment" },
  get_contract_terms: { serviceId: "vendor-portal", action: "get_contract_terms" },
  get_payment_status: { serviceId: "netsuite", action: "get_payment_status" },
};

const STAGES = [
  { id: "finance-control", label: "Finance Control", copy: "Root orchestration and approval policy." },
  { id: "regional-orchestrator", label: "Regional Orchestrators", copy: "Regional routing, delegation, and workload control." },
  { id: "invoice-intake", label: "Invoice Intake", copy: "Document extraction and vendor context." },
  { id: "ledger-match", label: "Ledger Match", copy: "ERP and accounting reconciliation." },
  { id: "policy-check", label: "Policy Check", copy: "Tax, compliance, and security decisions." },
  { id: "route-optimization", label: "Route Optimization", copy: "Provider selection and execution planning." },
  { id: "payment-execution", label: "Payment Execution", copy: "Payment submission and settlement tracking." },
  { id: "audit", label: "Audit", copy: "Evidence capture and durable runtime trail." },
  { id: "exception", label: "Exception", copy: "Escalations and intervention paths." },
];

const STAGE_MAP = Object.fromEntries(STAGES.map((stage) => [stage.id, stage]));
const LAYER_ORDER = STAGES.map((stage) => stage.id);

let eventSource = null;
let runId = null;
let runPhase = "idle";
let renderHandle = 0;
let sequence = 0;
let scene = null;
let viewH = 720;
let dragStart = null;
let dragMoved = false;

let nodes = {};
let services = {};
let flows = {};
let timeline = [];
let selected = "run";
let collapsedStages = new Set();
let transform = { scale: 1, x: 0, y: 0 };

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  setAttrs(el, attrs);
  return el;
}

function setAttrs(el, attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) el.setAttribute(key, value);
  }
}

function appendText(parent, x, y, text, attrs = {}) {
  const node = svgEl("text", {
    x,
    y,
    fill: "var(--text)",
    "font-family": "system-ui, -apple-system, sans-serif",
    "font-size": 11,
    ...attrs,
  });
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

function appendWrappedText(parent, x, y, text, options = {}) {
  const { lineLength = 20, maxLines = 2, lineHeight = 13, attrs = {} } = options;
  const node = svgEl("text", {
    x,
    y,
    fill: "var(--text)",
    "font-family": "system-ui, -apple-system, sans-serif",
    "font-size": 11,
    ...attrs,
  });

  wrapLabel(text, lineLength, maxLines).forEach((line, index) => {
    const span = svgEl("tspan", { x, dy: index === 0 ? 0 : lineHeight });
    span.textContent = line;
    node.appendChild(span);
  });

  parent.appendChild(node);
  return node;
}

function addTitle(parent, text) {
  const title = svgEl("title");
  title.textContent = text;
  parent.appendChild(title);
}

function marker(id, color) {
  const node = svgEl("marker", {
    id,
    viewBox: "0 0 10 10",
    refX: "9",
    refY: "5",
    markerWidth: "7",
    markerHeight: "7",
    orient: "auto-start-reverse",
  });
  node.appendChild(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: color }));
  return node;
}

function titleCase(value) {
  return String(value || "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function truncate(value, limit = 120) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function shortId(value) {
  return String(value || "").slice(0, 8);
}

function shortScope(scope) {
  if (!scope) return "";
  return truncate(String(scope).replace(/^batch:/, "").replace(/^scope:/, ""), 22);
}

function wrapLabel(value, limit, maxLines = 2) {
  const words = String(value || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  if (!lines.length) lines.push("");
  if (lines.length <= maxLines) return lines;
  const trimmed = lines.slice(0, maxLines);
  trimmed[maxLines - 1] = truncate(trimmed[maxLines - 1], limit);
  return trimmed;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function statusColor(status) {
  return COLORS[status] || COLORS.spawned;
}

function statusLabel(status) {
  if (status === "in_progress") return "Running";
  return titleCase(status || "spawned");
}

function flowState(flow) {
  if (flow.activeService > 0) return "running";
  if (flow.failed > 0) return "failed";
  if (flow.completed > 0) return "completed";
  return "pending";
}

function shortAction(action) {
  return truncate(titleCase(String(action || "").replace(/_/g, " ")), 24);
}

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function revealSvg() {
  if (emptyEl) emptyEl.style.display = "none";
  if (svg) svg.style.display = "";
}

function applyTransform() {
  if (!scene) return;
  scene.setAttribute("transform", `matrix(${transform.scale} 0 0 ${transform.scale} ${transform.x} ${transform.y})`);
  if (zoomResetBtn) zoomResetBtn.textContent = `${Math.round(transform.scale * 100)}%`;
}

function scheduleRender() {
  if (renderHandle) return;
  renderHandle = window.requestAnimationFrame(() => {
    renderHandle = 0;
    buildLayout();
  });
}

function ensureService(serviceId) {
  if (!services[serviceId]) {
    services[serviceId] = {
      id: serviceId,
      order: sequence++,
      lastAction: "",
      lastPayload: null,
      lastResult: null,
      _flowKeys: new Set(),
    };
  }
  return services[serviceId];
}

function flowKey(agentId, serviceId, action) {
  return `${agentId}::${serviceId}::${action}`;
}

function ensureFlow(agentId, serviceId, action, toolName = "") {
  const key = flowKey(agentId, serviceId, action);
  if (!flows[key]) {
    flows[key] = {
      key,
      order: sequence++,
      agentId,
      serviceId,
      action,
      toolName,
      count: 0,
      activeService: 0,
      completed: 0,
      failed: 0,
      pendingToolCalls: 0,
      lastReason: "",
      lastPayload: null,
      lastResult: null,
      lastTs: sequence,
    };
  }

  const service = ensureService(serviceId);
  service._flowKeys.add(key);
  if (toolName) flows[key].toolName = toolName;
  return flows[key];
}

function serviceMetrics(serviceId) {
  const linkedFlows = Object.values(flows).filter((flow) => flow.serviceId === serviceId);
  const metrics = {
    active: 0,
    completed: 0,
    failed: 0,
    total: 0,
    lastState: "pending",
  };

  for (const flow of linkedFlows) {
    metrics.active += flow.activeService;
    metrics.completed += flow.completed;
    metrics.failed += flow.failed;
    metrics.total += flow.count;
  }

  if (metrics.active > 0) metrics.lastState = "running";
  else if (metrics.failed > 0) metrics.lastState = "failed";
  else if (metrics.completed > 0) metrics.lastState = "completed";
  return metrics;
}

function stageStats(stageId) {
  const stageNodes = Object.values(nodes).filter((node) => node.layer === stageId);
  const stats = {
    total: stageNodes.length,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    flows: 0,
    calls: 0,
  };

  for (const node of stageNodes) {
    if (node.status === "running") stats.running += 1;
    if (node.status === "completed") stats.completed += 1;
    if (node.status === "failed") stats.failed += 1;
    if (node.status === "cancelled") stats.cancelled += 1;
  }

  for (const flow of Object.values(flows)) {
    const node = nodes[flow.agentId];
    if (!node || node.layer !== stageId) continue;
    stats.flows += 1;
    stats.calls += flow.count;
  }

  return stats;
}

function resetSvg() {
  svg.setAttribute("viewBox", `0 0 ${VIEW_W} ${viewH}`);
  svg.innerHTML = "";

  const defs = svgEl("defs");
  defs.append(
    marker("arrow-running", COLORS.running),
    marker("arrow-completed", COLORS.completed),
    marker("arrow-failed", COLORS.failed),
    marker("arrow-pending", COLORS.pending),
  );

  scene = svgEl("g", { id: "graph-scene" });
  svg.append(defs, scene);
  applyTransform();
}

function drawZone(x, y, width, height, label, copy, color) {
  const group = svgEl("g");
  group.appendChild(svgEl("rect", {
    x,
    y,
    width,
    height,
    rx: 24,
    fill: "rgba(255, 255, 255, 0.66)",
    stroke: color,
    "stroke-width": 1,
    "vector-effect": "non-scaling-stroke",
  }));
  appendText(group, x + 22, y + 30, label, {
    fill: "var(--primary)",
    "font-size": 13,
    "font-weight": 800,
  });
  appendText(group, x + 22, y + 50, copy, {
    fill: "rgba(26, 31, 46, 0.56)",
    "font-size": 10.5,
  });
  scene.appendChild(group);
}

function drawFrames() {
  const frameTop = 18;
  const frameH = viewH - 38;
  drawZone(ORCH_X - 20, frameTop, ORCH_W + 40, frameH, "Internal orchestration", "Agent hierarchy, delegation scopes, and execution state.", "rgba(30, 91, 216, 0.12)");
  drawZone(RUNTIME_X - 20, frameTop, RUNTIME_W + 40, frameH, "Service runtime", "Resilience, retries, telemetry, audit.", "rgba(93, 70, 163, 0.16)");
  drawZone(SERVICE_X - 20, frameTop, SERVICE_W + 70, frameH, "External systems", "Providers, ledgers, banks, tax, and compliance services.", "rgba(13, 110, 114, 0.14)");
}

function stageData(stageId) {
  const grouped = {};
  const stageNodes = Object.values(nodes)
    .filter((node) => node.layer === stageId)
    .sort((a, b) => {
      if ((a.region || "") !== (b.region || "")) return String(a.region || "").localeCompare(String(b.region || ""));
      const aParent = nodes[a.parent]?._cx || 0;
      const bParent = nodes[b.parent]?._cx || 0;
      if (aParent !== bParent) return aParent - bParent;
      return a.id.localeCompare(b.id);
    });

  for (const node of stageNodes) {
    const key = node.region || "Global";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(node);
  }

  const regions = Object.keys(grouped).sort((a, b) => {
    if (a === "Global") return -1;
    if (b === "Global") return 1;
    return a.localeCompare(b);
  });
  let maxRows = 1;

  for (const region of regions) {
    const slotW = (ORCH_W - 48 - NODE_GAP * Math.max(0, regions.length - 1)) / Math.max(1, regions.length);
    const cols = Math.max(1, Math.floor((slotW + NODE_GAP) / (NODE_W + NODE_GAP)));
    maxRows = Math.max(maxRows, Math.ceil(grouped[region].length / cols));
  }

  return { grouped, regions, maxRows, count: stageNodes.length };
}

function placeInternalNodes(stageLayouts) {
  for (const [stageId, layout] of Object.entries(stageLayouts)) {
    const data = layout.data;
    if (layout.collapsed) {
      for (const region of data.regions) {
        for (const node of data.grouped[region]) clearNodeLayout(node);
      }
      continue;
    }

    const slotCount = Math.max(1, data.regions.length);
    const slotW = (ORCH_W - 48 - NODE_GAP * Math.max(0, slotCount - 1)) / slotCount;

    data.regions.forEach((region, slotIndex) => {
      const slotX = ORCH_X + 24 + slotIndex * (slotW + NODE_GAP);
      const nodesInRegion = data.grouped[region] || [];
      const cols = Math.max(1, Math.floor((slotW + NODE_GAP) / (NODE_W + NODE_GAP)));
      const totalW = Math.min(cols, nodesInRegion.length) * NODE_W + Math.max(0, Math.min(cols, nodesInRegion.length) - 1) * NODE_GAP;
      const startX = slotX + Math.max(0, (slotW - totalW) / 2);

      nodesInRegion.forEach((node, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        node._x = startX + col * (NODE_W + NODE_GAP);
        node._y = layout.y + 78 + row * (NODE_H + NODE_ROW_GAP);
        node._cx = node._x + NODE_W / 2;
        node._cy = node._y + NODE_H / 2;
        node._left = node._x;
        node._right = node._x + NODE_W;
      });
    });
  }
}

function clearNodeLayout(node) {
  delete node._x;
  delete node._y;
  delete node._cx;
  delete node._cy;
  delete node._left;
  delete node._right;
}

function placeServices() {
  const serviceList = Object.values(services);
  const minY = TOP_PAD + 24;
  const maxY = viewH - BOTTOM_PAD - SERVICE_H;

  for (const service of serviceList) {
    const linkedYs = Object.values(flows)
      .filter((flow) => flow.serviceId === service.id)
      .map((flow) => nodes[flow.agentId]?._cy)
      .filter((value) => Number.isFinite(value));
    service._idealY = linkedYs.length
      ? linkedYs.reduce((sum, value) => sum + value, 0) / linkedYs.length - SERVICE_H / 2
      : (minY + maxY) / 2;
  }

  serviceList.sort((a, b) => {
    if (a._idealY !== b._idealY) return a._idealY - b._idealY;
    return a.order - b.order;
  });

  let y = minY;
  for (const service of serviceList) {
    service._y = Math.max(y, Math.min(service._idealY, maxY));
    y = service._y + SERVICE_H + SERVICE_GAP;
  }

  if (serviceList.length) {
    const overflow = serviceList[serviceList.length - 1]._y - maxY;
    if (overflow > 0) {
      for (let index = serviceList.length - 1; index >= 0; index -= 1) {
        const nextY = index === serviceList.length - 1
          ? maxY
          : Math.min(serviceList[index]._y - overflow, serviceList[index + 1]._y - SERVICE_H - SERVICE_GAP);
        serviceList[index]._y = Math.max(minY, nextY);
      }
    }
  }

  for (const service of serviceList) {
    service._x = SERVICE_X;
    service._cx = service._x + SERVICE_W / 2;
    service._cy = service._y + SERVICE_H / 2;
  }
}

function drawRuntimeSpine() {
  const gateX = RUNTIME_X + RUNTIME_W / 2;
  const top = TOP_PAD + 14;
  const bottom = viewH - BOTTOM_PAD - 12;

  scene.appendChild(svgEl("line", {
    x1: gateX,
    y1: top,
    x2: gateX,
    y2: bottom,
    stroke: "rgba(93, 70, 163, 0.28)",
    "stroke-width": 2,
    "stroke-dasharray": "10 9",
    "vector-effect": "non-scaling-stroke",
  }));

  const cards = [
    { label: "Intercept", copy: "tool + service boundary", y: top + 10 },
    { label: "Policy", copy: "scope and approvals", y: top + 96 },
    { label: "Telemetry", copy: "tokens, latency, memory", y: top + 182 },
    { label: "Audit", copy: "trace and evidence", y: top + 268 },
  ];

  for (const card of cards) {
    const group = svgEl("g");
    group.appendChild(svgEl("rect", {
      x: RUNTIME_X + 18,
      y: card.y,
      width: RUNTIME_W - 36,
      height: 58,
      rx: 14,
      fill: "#fff",
      stroke: "rgba(93, 70, 163, 0.18)",
      "stroke-width": 1,
      "vector-effect": "non-scaling-stroke",
    }));
    appendText(group, RUNTIME_X + 34, card.y + 23, card.label, {
      fill: "rgba(93, 70, 163, 0.94)",
      "font-size": 11.5,
      "font-weight": 800,
    });
    appendText(group, RUNTIME_X + 34, card.y + 40, card.copy, {
      fill: "rgba(26, 31, 46, 0.54)",
      "font-size": 9.5,
    });
    scene.appendChild(group);
  }
}

function drawStageBands(stageLayouts) {
  for (const [stageId, layout] of Object.entries(stageLayouts)) {
    const stats = stageStats(stageId);
    const stage = STAGE_MAP[stageId] || { label: titleCase(stageId), copy: "Runtime stage." };
    const group = svgEl("g", { "data-select": `stage:${stageId}`, tabindex: "0" });
    const selectedStage = selected === `stage:${stageId}`;

    group.appendChild(svgEl("rect", {
      x: ORCH_X,
      y: layout.y,
      width: ORCH_W,
      height: layout.h,
      rx: 18,
      fill: layout.collapsed ? "rgba(245, 247, 250, 0.88)" : "#fff",
      stroke: selectedStage ? "rgba(30, 91, 216, 0.55)" : "rgba(11, 61, 145, 0.1)",
      "stroke-width": selectedStage ? 2 : 1,
      "vector-effect": "non-scaling-stroke",
    }));
    group.appendChild(svgEl("rect", {
      x: ORCH_X,
      y: layout.y,
      width: 5,
      height: layout.h,
      rx: 2.5,
      fill: stats.running ? COLORS.running : stats.failed ? COLORS.failed : stats.completed ? COLORS.completed : COLORS.spawned,
      opacity: 0.9,
    }));

    appendText(group, ORCH_X + 22, layout.y + 26, stage.label, {
      fill: "var(--primary)",
      "font-size": 13,
      "font-weight": 800,
    });
    appendText(group, ORCH_X + 22, layout.y + 45, stage.copy, {
      fill: "rgba(26, 31, 46, 0.56)",
      "font-size": 10,
    });
    appendText(group, ORCH_X + ORCH_W - 22, layout.y + 29, layout.collapsed ? "Collapsed" : `${stats.total} agents`, {
      fill: "rgba(26, 31, 46, 0.5)",
      "font-size": 10,
      "font-weight": 800,
      "text-anchor": "end",
    });

    if (!layout.collapsed) {
      layout.data.regions.forEach((region, index) => {
        const slotCount = Math.max(1, layout.data.regions.length);
        const slotW = (ORCH_W - 48 - NODE_GAP * Math.max(0, slotCount - 1)) / slotCount;
        const x = ORCH_X + 24 + index * (slotW + NODE_GAP) + slotW / 2;
        appendText(group, x, layout.y + 66, region, {
          fill: "rgba(11, 61, 145, 0.56)",
          "font-size": 9.5,
          "font-weight": 800,
          "text-anchor": "middle",
        });
      });
    } else {
      appendText(group, ORCH_X + 22, layout.y + 68, `${stats.running} running · ${stats.calls} external calls`, {
        fill: "rgba(26, 31, 46, 0.58)",
        "font-size": 10.5,
        "font-weight": 700,
      });
    }

    addTitle(group, `${stage.label}\n${stage.copy}\nAgents: ${stats.total}\nCalls: ${stats.calls}`);
    scene.appendChild(group);
  }
}

function drawInternalEdges() {
  for (const node of Object.values(nodes)) {
    if (!node.parent || !nodes[node.parent] || node._cx == null) continue;

    const parent = nodes[node.parent];
    if (parent._cx == null) continue;
    const color = selected === `node:${node.id}` || selected === `node:${parent.id}`
      ? "rgba(30, 91, 216, 0.58)"
      : "rgba(30, 91, 216, 0.22)";
    const midY = (parent._cy + node._cy) / 2;
    const path = svgEl("path", {
      d: `M ${parent._cx} ${parent._y + NODE_H} C ${parent._cx} ${midY}, ${node._cx} ${midY}, ${node._cx} ${node._y}`,
      fill: "none",
      stroke: color,
      "stroke-width": 2,
      "vector-effect": "non-scaling-stroke",
    });
    addTitle(path, `${parent.role} -> ${node.role}${node.scope ? `\nScope: ${node.scope}` : ""}`);
    scene.appendChild(path);
  }
}

function drawFlows() {
  const serviceFlowMap = {};
  for (const flow of Object.values(flows)) {
    if (!serviceFlowMap[flow.serviceId]) serviceFlowMap[flow.serviceId] = [];
    serviceFlowMap[flow.serviceId].push(flow);
  }

  for (const [serviceId, flowList] of Object.entries(serviceFlowMap)) {
    const service = services[serviceId];
    if (!service || service._cy == null) continue;
    flowList.sort((a, b) => {
      const ay = nodes[a.agentId]?._cy || 0;
      const by = nodes[b.agentId]?._cy || 0;
      if (ay !== by) return ay - by;
      return a.order - b.order;
    });
    const offsets = flowList.map((_, index) => (index - (flowList.length - 1) / 2) * 13);

    flowList.forEach((flow, index) => {
      const agent = nodes[flow.agentId];
      if (!agent || agent._right == null) return;
      const state = flowState(flow);
      const color = statusColor(state);
      const gateX = RUNTIME_X + RUNTIME_W / 2;
      const serviceY = service._cy + offsets[index] * 0.35;
      const startX = agent._right;
      const startY = agent._cy;
      const endX = service._x;
      const selectedFlow = selected === `flow:${flow.key}`;
      const d = [
        `M ${startX} ${startY}`,
        `C ${startX + 58} ${startY}, ${gateX - 68} ${startY}, ${gateX} ${startY}`,
        `L ${gateX} ${serviceY}`,
        `C ${gateX + 68} ${serviceY}, ${endX - 58} ${serviceY}, ${endX} ${serviceY}`,
      ].join(" ");

      const group = svgEl("g", { "data-select": `flow:${flow.key}` });
      const path = svgEl("path", {
        d,
        fill: "none",
        stroke: color,
        "stroke-width": selectedFlow ? 3.4 : Math.min(3, 1.4 + Math.log2(1 + flow.count) * 0.7),
        "stroke-dasharray": state === "running" ? "9 7" : state === "pending" ? "6 7" : "",
        opacity: selectedFlow ? 0.98 : 0.76,
        "marker-end": `url(#arrow-${state})`,
        "vector-effect": "non-scaling-stroke",
      });

      if (state === "running") {
        path.appendChild(svgEl("animate", {
          attributeName: "stroke-dashoffset",
          from: "32",
          to: "0",
          dur: "1s",
          repeatCount: "indefinite",
        }));
      }

      group.appendChild(path);
      group.appendChild(svgEl("path", {
        d,
        fill: "none",
        stroke: "transparent",
        "stroke-width": 16,
        "pointer-events": "stroke",
        "vector-effect": "non-scaling-stroke",
      }));

      const badgeText = `${shortAction(flow.action)} · ${flow.count}`;
      const badgeW = Math.max(64, badgeText.length * 5.7 + 18);
      const badgeX = gateX - badgeW / 2;
      const badgeY = startY < serviceY ? startY + Math.min(38, (serviceY - startY) / 2) : startY - Math.min(38, (startY - serviceY) / 2);
      group.appendChild(svgEl("rect", {
        x: badgeX,
        y: badgeY - 10,
        width: badgeW,
        height: 20,
        rx: 10,
        fill: "#fff",
        stroke: color,
        "stroke-width": 1,
        opacity: selectedFlow || state === "running" ? 1 : 0.84,
        "vector-effect": "non-scaling-stroke",
      }));
      appendText(group, gateX, badgeY + 4, badgeText, {
        fill: color,
        "font-size": 9.2,
        "font-weight": 800,
        "text-anchor": "middle",
      });
      addTitle(group, [
        `${agent.role} -> ${service.id}`,
        `Action: ${flow.action}`,
        `Status: ${statusLabel(state)}`,
        `Calls: ${flow.count}`,
        flow.lastReason ? `Detail: ${flow.lastReason}` : "",
      ].filter(Boolean).join("\n"));
      scene.appendChild(group);
    });
  }
}

function drawAgentNodes() {
  for (const node of Object.values(nodes)) {
    if (node._x == null) continue;
    const selectedNode = selected === `node:${node.id}`;
    const color = statusColor(node.status);
    const group = svgEl("g", { "data-select": `node:${node.id}`, tabindex: "0" });
    const flowCount = Object.values(flows).filter((flow) => flow.agentId === node.id).length;

    group.appendChild(svgEl("rect", {
      x: node._x,
      y: node._y,
      width: NODE_W,
      height: NODE_H,
      rx: 14,
      fill: "#fff",
      stroke: selectedNode ? "var(--accent)" : "rgba(11, 61, 145, 0.12)",
      "stroke-width": selectedNode ? 2.4 : 1,
      filter: selectedNode ? "drop-shadow(0 16px 22px rgba(30, 91, 216, 0.16))" : "drop-shadow(0 10px 18px rgba(11, 61, 145, 0.06))",
      "vector-effect": "non-scaling-stroke",
    }));
    group.appendChild(svgEl("rect", {
      x: node._x,
      y: node._y,
      width: NODE_W,
      height: 4,
      rx: 2,
      fill: color,
    }));
    group.appendChild(svgEl("circle", {
      cx: node._x + 16,
      cy: node._y + 20,
      r: 5,
      fill: color,
    }));
    if (node.status === "running") {
      const pulse = svgEl("circle", {
        cx: node._x + 16,
        cy: node._y + 20,
        r: 5,
        fill: "none",
        stroke: color,
        "stroke-width": 2,
        opacity: 0.7,
      });
      pulse.appendChild(svgEl("animate", { attributeName: "r", values: "5;13", dur: "1.2s", repeatCount: "indefinite" }));
      pulse.appendChild(svgEl("animate", { attributeName: "opacity", values: "0.7;0", dur: "1.2s", repeatCount: "indefinite" }));
      group.appendChild(pulse);
    }

    appendWrappedText(group, node._x + 28, node._y + 22, titleCase(node.role || node.layer), {
      lineLength: 21,
      maxLines: 2,
      lineHeight: 12,
      attrs: {
        fill: "var(--text)",
        "font-size": 11,
        "font-weight": 800,
      },
    });
    appendText(group, node._x + 14, node._y + 48, node.region || shortScope(node.scope) || "internal", {
      fill: "rgba(26, 31, 46, 0.56)",
      "font-size": 9.6,
    });
    appendText(group, node._x + 14, node._y + 62, `${statusLabel(node.status)} · ${flowCount} flows`, {
      fill: color,
      "font-size": 9.4,
      "font-weight": 800,
    });
    appendText(group, node._x + NODE_W - 12, node._y + 62, shortId(node.id), {
      fill: "rgba(26, 31, 46, 0.4)",
      "font-size": 9,
      "font-family": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      "text-anchor": "end",
    });
    addTitle(group, [
      `${node.role} (${shortId(node.id)})`,
      `Layer: ${node.layer}`,
      node.region ? `Region: ${node.region}` : "",
      node.scope ? `Delegation scope: ${node.scope}` : "",
      `Status: ${statusLabel(node.status)}`,
    ].filter(Boolean).join("\n"));
    scene.appendChild(group);
  }
}

function serviceGroup(serviceId) {
  if (/bank|wise|stripe|payment|payout|treasury/i.test(serviceId)) return "Payments";
  if (/net|sap|quick|ledger|erp/i.test(serviceId)) return "Ledger";
  if (/compliance|tax|policy|risk/i.test(serviceId)) return "Controls";
  if (/ocr|vendor|fx|rate/i.test(serviceId)) return "Data";
  return "Provider";
}

function drawServices() {
  for (const service of Object.values(services)) {
    if (service._y == null) continue;
    const metrics = serviceMetrics(service.id);
    const state = metrics.lastState;
    const color = statusColor(state);
    const selectedService = selected === `service:${service.id}`;
    const group = svgEl("g", { "data-select": `service:${service.id}`, tabindex: "0" });

    group.appendChild(svgEl("rect", {
      x: service._x,
      y: service._y,
      width: SERVICE_W,
      height: SERVICE_H,
      rx: 16,
      fill: "#fff",
      stroke: selectedService ? "var(--teal)" : "rgba(13, 110, 114, 0.16)",
      "stroke-width": selectedService ? 2.3 : 1,
      filter: selectedService ? "drop-shadow(0 16px 22px rgba(13, 110, 114, 0.16))" : "drop-shadow(0 10px 18px rgba(11, 61, 145, 0.05))",
      "vector-effect": "non-scaling-stroke",
    }));
    group.appendChild(svgEl("circle", { cx: service._x + 18, cy: service._y + 22, r: 6, fill: color }));
    appendText(group, service._x + 34, service._y + 24, titleCase(service.id), {
      fill: "var(--text)",
      "font-size": 12,
      "font-weight": 800,
    });
    appendText(group, service._x + 34, service._y + 42, serviceGroup(service.id), {
      fill: "rgba(26, 31, 46, 0.52)",
      "font-size": 9.5,
      "font-weight": 800,
      "letter-spacing": "0.08em",
      "text-transform": "uppercase",
    });
    appendText(group, service._x + 14, service._y + 63, `${metrics.total} calls · ${metrics.active} active · ${metrics.failed} failed`, {
      fill: color,
      "font-size": 9.6,
      "font-weight": 800,
    });
    addTitle(group, [
      service.id,
      `Group: ${serviceGroup(service.id)}`,
      `Calls: ${metrics.total}`,
      `Active: ${metrics.active}`,
      `Completed: ${metrics.completed}`,
      `Failed: ${metrics.failed}`,
    ].join("\n"));
    scene.appendChild(group);
  }
}

function buildStageLayouts() {
  const present = LAYER_ORDER.filter((stageId) => Object.values(nodes).some((node) => node.layer === stageId));
  const layouts = {};
  let y = TOP_PAD;

  for (const stageId of present) {
    const data = stageData(stageId);
    const collapsed = collapsedStages.has(stageId);
    const h = collapsed ? 86 : Math.max(134, 84 + data.maxRows * (NODE_H + NODE_ROW_GAP));
    layouts[stageId] = { y, h, data, collapsed };
    y += h + STAGE_GAP;
  }

  viewH = Math.max(720, y + BOTTOM_PAD);
  return layouts;
}

function buildLayout() {
  const stageLayouts = buildStageLayouts();
  const serviceCount = Object.keys(services).length;
  if (!Object.keys(stageLayouts).length && !serviceCount) {
    updateStatus();
    renderStageRail();
    renderInspector();
    renderTimeline();
    return;
  }

  revealSvg();
  placeInternalNodes(stageLayouts);
  const serviceH = serviceCount ? serviceCount * SERVICE_H + Math.max(0, serviceCount - 1) * SERVICE_GAP : 0;
  viewH = Math.max(viewH, TOP_PAD + serviceH + BOTTOM_PAD + 36);
  placeServices();

  resetSvg();
  drawFrames();
  drawStageBands(stageLayouts);
  drawRuntimeSpine();
  drawInternalEdges();
  drawFlows();
  drawAgentNodes();
  drawServices();
  updateStatus();
  renderStageRail();
  renderInspector();
  renderTimeline();
}

function updateStatus() {
  const agentCount = Object.keys(nodes).length;
  const serviceCount = Object.keys(services).length;
  const flowCount = Object.keys(flows).length;
  const active = Object.values(nodes).filter((node) => node.status === "running").length;
  statusEl.textContent = runId
    ? `${statusLabel(runPhase)} · ${active} active · ${agentCount} agents · ${serviceCount} services · ${flowCount} flows`
    : "idle";
}

function renderStageRail() {
  stageRail.replaceChildren();
  const present = LAYER_ORDER.filter((stageId) => Object.values(nodes).some((node) => node.layer === stageId));
  const totalAgents = Object.keys(nodes).length;
  const totalCalls = Object.values(flows).reduce((sum, flow) => sum + flow.count, 0);
  stageSummary.textContent = totalAgents ? `${totalAgents} agents · ${totalCalls} calls` : "Waiting for a run";

  if (!present.length) {
    const empty = document.createElement("div");
    empty.className = "graph-stage-meta";
    empty.textContent = "Stages appear as agents spawn.";
    stageRail.appendChild(empty);
    return;
  }

  for (const stageId of present) {
    const stage = STAGE_MAP[stageId] || { label: titleCase(stageId) };
    const stats = stageStats(stageId);
    const done = stats.total ? Math.round(((stats.completed + stats.failed + stats.cancelled) / stats.total) * 100) : 0;
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "graph-stage-card",
      selected === `stage:${stageId}` ? "is-selected" : "",
      collapsedStages.has(stageId) ? "is-collapsed" : "",
    ].filter(Boolean).join(" ");
    button.addEventListener("click", (event) => {
      if (event.target.classList.contains("graph-stage-toggle")) {
        toggleStage(stageId);
        return;
      }
      selected = `stage:${stageId}`;
      renderInspector();
      scheduleRender();
    });
    button.addEventListener("dblclick", () => {
      toggleStage(stageId);
    });

    const top = document.createElement("div");
    top.className = "graph-stage-top";
    const name = document.createElement("span");
    name.className = "graph-stage-name";
    name.textContent = stage.label;
    const toggle = document.createElement("span");
    toggle.className = "graph-stage-toggle";
    toggle.textContent = collapsedStages.has(stageId) ? "+" : "−";
    top.append(name, toggle);

    const meta = document.createElement("div");
    meta.className = "graph-stage-meta";
    const count = document.createElement("span");
    count.textContent = `${stats.total} agents`;
    const activity = document.createElement("span");
    activity.textContent = stats.running ? `${stats.running} running` : `${stats.calls} calls`;
    meta.append(count, activity);

    const bar = document.createElement("div");
    bar.className = "graph-stage-bar";
    const fill = document.createElement("div");
    fill.className = "graph-stage-fill";
    fill.style.width = `${done}%`;
    bar.appendChild(fill);

    button.append(top, meta, bar);
    stageRail.appendChild(button);
  }
}

function toggleStage(stageId) {
  if (collapsedStages.has(stageId)) collapsedStages.delete(stageId);
  else collapsedStages.add(stageId);
  scheduleRender();
}

function addMetric(label, value) {
  const row = document.createElement("div");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = label;
  dd.textContent = value;
  row.append(dt, dd);
  inspectorMetrics.appendChild(row);
}

function renderInspector() {
  inspectorMetrics.replaceChildren();
  const [kind, rawId = ""] = String(selected || "run").split(/:(.*)/s);

  if (kind === "node" && nodes[rawId]) {
    const node = nodes[rawId];
    const relatedFlows = Object.values(flows).filter((flow) => flow.agentId === node.id);
    inspectorType.textContent = "Agent";
    inspectorTitle.textContent = titleCase(node.role || node.layer);
    inspectorCopy.textContent = node.scope
      ? `Delegated scope: ${node.scope}`
      : "Runtime agent participating in the orchestration hierarchy.";
    addMetric("Status", statusLabel(node.status));
    addMetric("Layer", STAGE_MAP[node.layer]?.label || titleCase(node.layer));
    addMetric("Region", node.region || "Global");
    addMetric("Agent ID", shortId(node.id));
    addMetric("Parent", node.parent ? shortId(node.parent) : "Root");
    addMetric("Flows", String(relatedFlows.length));
    addMetric("Tool calls", String(node.toolCalls || 0));
    addMetric("Tokens", `${node.inputTokens || 0} in / ${node.outputTokens || 0} out`);
    addMetric("Memory", node.tokensUsed ? `${node.tokensUsed} / ${node.tokensLimit || 0}` : "No updates");
    return;
  }

  if (kind === "service" && services[rawId]) {
    const service = services[rawId];
    const metrics = serviceMetrics(service.id);
    inspectorType.textContent = "Service";
    inspectorTitle.textContent = titleCase(service.id);
    inspectorCopy.textContent = "External dependency reached through the service runtime boundary.";
    addMetric("Group", serviceGroup(service.id));
    addMetric("Status", statusLabel(metrics.lastState));
    addMetric("Calls", String(metrics.total));
    addMetric("Active", String(metrics.active));
    addMetric("Completed", String(metrics.completed));
    addMetric("Failed", String(metrics.failed));
    addMetric("Last action", service.lastAction || "None");
    return;
  }

  if (kind === "flow" && flows[rawId]) {
    const flow = flows[rawId];
    const agent = nodes[flow.agentId];
    inspectorType.textContent = "Flow";
    inspectorTitle.textContent = shortAction(flow.action);
    inspectorCopy.textContent = "Service communication routed through the service runtime's resilience, telemetry, and audit controls.";
    addMetric("Status", statusLabel(flowState(flow)));
    addMetric("Agent", agent ? titleCase(agent.role) : shortId(flow.agentId));
    addMetric("Service", titleCase(flow.serviceId));
    addMetric("Action", flow.action);
    addMetric("Calls", String(flow.count));
    addMetric("Active", String(flow.activeService));
    addMetric("Completed", String(flow.completed));
    addMetric("Failed", String(flow.failed));
    if (flow.lastReason) addMetric("Detail", flow.lastReason);
    return;
  }

  if (kind === "stage" && STAGE_MAP[rawId]) {
    const stats = stageStats(rawId);
    inspectorType.textContent = "Stage";
    inspectorTitle.textContent = STAGE_MAP[rawId].label;
    inspectorCopy.textContent = STAGE_MAP[rawId].copy;
    addMetric("Agents", String(stats.total));
    addMetric("Running", String(stats.running));
    addMetric("Completed", String(stats.completed));
    addMetric("Failed", String(stats.failed));
    addMetric("External flows", String(stats.flows));
    addMetric("Service calls", String(stats.calls));
    addMetric("View", collapsedStages.has(rawId) ? "Collapsed" : "Expanded");
    return;
  }

  selected = "run";
  inspectorType.textContent = "Overview";
  inspectorTitle.textContent = runId ? `Run ${shortId(runId)}` : "No run selected";
  inspectorCopy.textContent = runId
    ? "Live topology showing runtime control, agent coordination, provider communication, and execution telemetry."
    : "Select a stage, agent, service, or connection to inspect runtime state.";
  addMetric("Phase", statusLabel(runPhase));
  addMetric("Agents", String(Object.keys(nodes).length));
  addMetric("Services", String(Object.keys(services).length));
  addMetric("Flows", String(Object.keys(flows).length));
  addMetric("Events", String(timeline.length));
}

function renderTimeline() {
  timelineList.replaceChildren();
  timelineCount.textContent = `${timeline.length} event${timeline.length === 1 ? "" : "s"}`;

  if (!timeline.length) {
    const item = document.createElement("li");
    item.className = "graph-timeline-item";
    const kind = document.createElement("span");
    kind.className = "graph-timeline-kind";
    kind.textContent = "Waiting";
    const text = document.createElement("span");
    text.textContent = "Runtime events appear here as the run progresses.";
    item.append(kind, text);
    timelineList.appendChild(item);
    return;
  }

  for (const event of timeline.slice(0, 40)) {
    const item = document.createElement("li");
    item.className = `graph-timeline-item kind-${event.category || event.kind}`;
    item.addEventListener("click", () => selectEventTarget(event));

    const kind = document.createElement("span");
    kind.className = "graph-timeline-kind";
    kind.textContent = titleCase(event.kind);
    const label = document.createElement("span");
    label.textContent = eventLabel(event);
    const meta = document.createElement("span");
    meta.className = "graph-timeline-meta";
    meta.textContent = formatTime(event.ts);
    item.append(kind, label, meta);
    timelineList.appendChild(item);
  }
}

function eventLabel(event) {
  const payload = event.payload || {};
  if (event.kind === "agent_spawn") return `${titleCase(payload.role)} spawned${payload.region ? ` in ${payload.region}` : ""}`;
  if (event.kind === "agent_start") return `${shortId(payload.agent_id)} started`;
  if (event.kind === "agent_terminate") return `${shortId(payload.agent_id)} ${payload.status || "completed"}`;
  if (event.kind === "delegation") return `${shortId(payload.parent_id)} delegated ${shortScope(payload.scope)}`;
  if (event.kind === "tool_call") return `${titleCase(payload.tool_name)} requested`;
  if (event.kind === "service_call") return `${titleCase(payload.service_id)} · ${shortAction(payload.action)}`;
  if (event.kind === "service_result") return `${titleCase(payload.service_id)} returned ${shortAction(payload.action)}`;
  if (event.kind === "llm_call") return `${payload.model || "model"} · ${payload.latency_ms || 0}ms`;
  if (event.kind === "memory_update") return `${shortId(payload.agent_id)} memory ${payload.tokens_used || 0}/${payload.tokens_limit || 0}`;
  if (event.kind === "audit_record") return `${shortId(payload.agent_id)} audit record`;
  if (event.kind === "error") return String(payload.message || "Runtime error");
  if (event.kind === "run_end") return statusLabel(payload.status || "done");
  return titleCase(event.category || "event");
}

function selectEventTarget(event) {
  const payload = event.payload || {};
  if (payload.agent_id && nodes[payload.agent_id]) selected = `node:${payload.agent_id}`;
  else if (payload.service_id && services[payload.service_id]) selected = `service:${payload.service_id}`;
  else selected = "run";
  scheduleRender();
}

function recordEvent(event) {
  timeline.unshift(event);
  if (timeline.length > TIMELINE_LIMIT) timeline.length = TIMELINE_LIMIT;
}

function updateNodeStatus(agentId, status) {
  if (!nodes[agentId]) return;
  nodes[agentId].status = status;
}

function handleEvent(event) {
  const payload = event.payload || {};
  recordEvent(event);

  switch (event.kind) {
    case "run_start":
      runPhase = "running";
      scheduleRender();
      break;

    case "agent_spawn":
      nodes[payload.agent_id] = {
        id: payload.agent_id,
        role: payload.role,
        layer: payload.layer,
        region: payload.region || null,
        parent: payload.parent_id || null,
        scope: payload.scope || "",
        status: "spawned",
        startedAt: null,
        endedAt: null,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        streamedChars: 0,
        audits: 0,
      };
      revealSvg();
      scheduleRender();
      break;

    case "delegation":
      if (nodes[payload.child_id]) nodes[payload.child_id].scope = payload.scope || nodes[payload.child_id].scope;
      scheduleRender();
      break;

    case "agent_start":
      updateNodeStatus(payload.agent_id, "running");
      if (nodes[payload.agent_id]) nodes[payload.agent_id].startedAt = event.ts;
      scheduleRender();
      break;

    case "agent_terminate":
      updateNodeStatus(payload.agent_id, payload.status || "completed");
      if (nodes[payload.agent_id]) nodes[payload.agent_id].endedAt = event.ts;
      scheduleRender();
      break;

    case "tool_call": {
      const mapping = TOOL_TO_SERVICE[payload.tool_name];
      if (nodes[payload.agent_id]) nodes[payload.agent_id].toolCalls += 1;
      if (!mapping) {
        scheduleRender();
        break;
      }
      const flow = ensureFlow(payload.agent_id, mapping.serviceId, mapping.action, payload.tool_name);
      flow.count += 1;
      flow.pendingToolCalls += 1;
      flow.lastTs = sequence++;
      scheduleRender();
      break;
    }

    case "service_call": {
      const flow = ensureFlow(payload.agent_id, payload.service_id, payload.action);
      if (flow.pendingToolCalls > 0) flow.pendingToolCalls -= 1;
      else flow.count += 1;
      flow.activeService += 1;
      flow.lastPayload = payload.payload || null;
      flow.lastTs = sequence++;
      const service = ensureService(payload.service_id);
      service.lastAction = payload.action;
      service.lastPayload = payload.payload || null;
      revealSvg();
      scheduleRender();
      break;
    }

    case "service_result": {
      const flow = ensureFlow(payload.agent_id, payload.service_id, payload.action);
      flow.activeService = Math.max(0, flow.activeService - 1);
      flow.lastResult = payload.result || null;
      flow.lastTs = sequence++;
      const failed = Boolean(
        payload.result && (payload.result.status === "error" || payload.result.status === "failed" || payload.result.error),
      );
      if (failed) {
        flow.failed += 1;
        flow.lastReason = payload.result?.error || payload.result?.message || "Service returned an error";
      } else {
        flow.completed += 1;
      }
      const service = ensureService(payload.service_id);
      service.lastResult = payload.result || null;
      scheduleRender();
      break;
    }

    case "llm_call":
      if (nodes[payload.agent_id]) {
        nodes[payload.agent_id].inputTokens += Number(payload.input_tokens || 0);
        nodes[payload.agent_id].outputTokens += Number(payload.output_tokens || 0);
        nodes[payload.agent_id].toolCalls += Number(payload.tool_calls || 0);
        nodes[payload.agent_id].streamedChars += Number(payload.streamed_chars || 0);
        nodes[payload.agent_id].model = payload.model || nodes[payload.agent_id].model;
        nodes[payload.agent_id].latencyMs = payload.latency_ms || nodes[payload.agent_id].latencyMs;
      }
      scheduleRender();
      break;

    case "memory_update":
      if (nodes[payload.agent_id]) {
        nodes[payload.agent_id].tokensUsed = payload.tokens_used || 0;
        nodes[payload.agent_id].tokensLimit = payload.tokens_limit || 0;
        nodes[payload.agent_id].messageCount = payload.message_count || 0;
        nodes[payload.agent_id].compactions = payload.compactions || 0;
      }
      scheduleRender();
      break;

    case "audit_record":
      if (nodes[payload.agent_id]) nodes[payload.agent_id].audits += 1;
      scheduleRender();
      break;

    case "error":
      runPhase = "failed";
      if (payload.agent_id) updateNodeStatus(payload.agent_id, "failed");
      scheduleRender();
      break;

    case "run_end":
      runPhase = payload.status || "done";
      scheduleRender();
      break;

    default:
      renderTimeline();
      break;
  }
}

function attachStream(nextRunId) {
  runId = nextRunId;
  nodes = {};
  services = {};
  flows = {};
  timeline = [];
  sequence = 0;
  runPhase = "running";
  selected = "run";
  collapsedStages = new Set();
  transform = { scale: 1, x: 0, y: 0 };

  if (eventSource) eventSource.close();
  if (renderHandle) {
    window.cancelAnimationFrame(renderHandle);
    renderHandle = 0;
  }

  svg.innerHTML = "";
  scene = null;
  if (emptyEl) emptyEl.style.display = "";
  if (svg) svg.style.display = "none";
  statusEl.textContent = "running...";
  renderStageRail();
  renderInspector();
  renderTimeline();

  eventSource = new EventSource(`/api/run/${nextRunId}/events`);
  eventSource.onmessage = (message) => {
    try {
      handleEvent(JSON.parse(message.data));
    } catch {
      renderTimeline();
    }
  };
  eventSource.onerror = () => {
    eventSource.close();
    eventSource = null;
  };
}

function zoomAt(nextScale, clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * VIEW_W;
  const y = ((clientY - rect.top) / rect.height) * viewH;
  const scale = clamp(nextScale, 0.42, 2.4);
  const ratio = scale / transform.scale;
  transform.x = x - (x - transform.x) * ratio;
  transform.y = y - (y - transform.y) * ratio;
  transform.scale = scale;
  applyTransform();
}

function resetZoom() {
  transform = { scale: 1, x: 0, y: 0 };
  applyTransform();
}

function fitGraph() {
  resetZoom();
}

if (svg) {
  svg.addEventListener("click", (event) => {
    if (dragMoved) return;
    const target = event.target.closest("[data-select]");
    if (!target) {
      selected = "run";
    } else {
      selected = target.getAttribute("data-select");
    }
    scheduleRender();
  });
}

if (canvas) {
  canvas.addEventListener("wheel", (event) => {
    if (!scene) return;
    event.preventDefault();
    const delta = event.deltaY > 0 ? 0.9 : 1.1;
    zoomAt(transform.scale * delta, event.clientX, event.clientY);
  }, { passive: false });

  canvas.addEventListener("pointerdown", (event) => {
    if (!scene || event.button !== 0) return;
    dragStart = {
      x: event.clientX,
      y: event.clientY,
      tx: transform.x,
      ty: transform.y,
    };
    dragMoved = false;
    canvas.classList.add("is-panning");
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!dragStart) return;
    const rect = svg.getBoundingClientRect();
    const dx = ((event.clientX - dragStart.x) / rect.width) * VIEW_W;
    const dy = ((event.clientY - dragStart.y) / rect.height) * viewH;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;
    transform.x = dragStart.tx + dx;
    transform.y = dragStart.ty + dy;
    applyTransform();
  });

  canvas.addEventListener("pointerup", (event) => {
    if (!dragStart) return;
    dragStart = null;
    canvas.classList.remove("is-panning");
    canvas.releasePointerCapture(event.pointerId);
    window.setTimeout(() => {
      dragMoved = false;
    }, 0);
  });

  canvas.addEventListener("pointercancel", () => {
    dragStart = null;
    canvas.classList.remove("is-panning");
  });
}

if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => zoomAt(transform.scale * 0.88, window.innerWidth / 2, window.innerHeight / 2));
if (zoomInBtn) zoomInBtn.addEventListener("click", () => zoomAt(transform.scale * 1.12, window.innerWidth / 2, window.innerHeight / 2));
if (zoomResetBtn) zoomResetBtn.addEventListener("click", resetZoom);
if (fitBtn) fitBtn.addEventListener("click", fitGraph);

window.addEventListener("run-started", (event) => attachStream(event.detail.runId));
renderStageRail();
renderInspector();
renderTimeline();
