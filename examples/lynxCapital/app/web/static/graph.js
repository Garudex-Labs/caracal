/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Graph panel: real-time topology showing Lynx internal execution, Caracal
 * enforcement, and external providers without pre-drawn orchestration.
 */

const svg = document.getElementById("graph-svg");
const statusEl = document.getElementById("graph-status");
const emptyEl = document.getElementById("graph-empty");

const NS = "http://www.w3.org/2000/svg";

const VIEW_W = 1180;
const TOP_PAD = 56;
const BOTTOM_PAD = 22;
const SECTION_TOP = 30;

const LYNX_LEFT = 112;
const LYNX_RIGHT = 666;
const CARACAL_LEFT = 714;
const CARACAL_RIGHT = 746;
const SERVICE_LEFT = 792;
const SERVICE_RIGHT = 1128;
const CARACAL_X = Math.round((CARACAL_LEFT + CARACAL_RIGHT) / 2);

const LAYER_BAND_H = 62;
const LAYER_GAP = 12;
const NODE_W = 126;
const NODE_H = 40;
const NODE_GAP = 10;
const REGION_GAP = 12;

const SERVICE_W = 168;
const SERVICE_H = 40;
const SERVICE_GAP = 10;
const FLOW_OFFSET_STEP = 8;

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

const STATUS_COLOR = {
  spawned: "var(--statusSpawned)",
  running: "var(--statusRunning)",
  completed: "var(--statusCompleted)",
  denied: "var(--statusDenied)",
  failed: "var(--statusFailed)",
  cancelled: "var(--statusCancelled)",
  default: "var(--border)",
};

const FLOW_STYLE = {
  pending: { color: "var(--warning, #B85C00)", marker: "url(#arrow-pending)", dash: "6 4" },
  in_progress: { color: "var(--statusRunning, #1E5BD8)", marker: "url(#arrow-progress)", dash: "" },
  allowed: { color: "var(--statusCompleted, #1A7F4B)", marker: "url(#arrow-allowed)", dash: "" },
  denied: { color: "var(--statusDenied, #C0392B)", marker: "url(#arrow-denied)", dash: "" },
};

const LAYER_ORDER = [
  "finance-control",
  "regional-orchestrator",
  "invoice-intake",
  "ledger-match",
  "policy-check",
  "route-optimization",
  "payment-execution",
  "audit",
  "exception",
];

const LAYER_LABELS = {
  "finance-control": "Finance Control",
  "regional-orchestrator": "Regional Orchestrators",
  "invoice-intake": "Invoice Intake",
  "ledger-match": "Ledger Match",
  "policy-check": "Policy Check",
  "route-optimization": "Route Optimization",
  "payment-execution": "Payment Execution",
  audit: "Audit",
  exception: "Exception",
};

let eventSource = null;
let runId = null;
let renderHandle = 0;
let sequence = 0;
let runPhase = "idle";

let nodes = {};
let services = {};
let flows = {};

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function revealSvg() {
  if (emptyEl) emptyEl.style.display = "none";
  if (svg) svg.style.display = "";
}

function statusColor(status) {
  return STATUS_COLOR[status] || STATUS_COLOR.default;
}

function truncate(value, limit) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function titleCase(value) {
  return String(value || "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function shortId(value) {
  return String(value || "").slice(0, 8);
}

function shortScope(scope) {
  if (!scope) return "";
  return truncate(scope.replace(/^batch:/, "").replace(/^scope:/, ""), 18);
}

function flowState(flow) {
  if (flow.pendingAuth > 0) return "pending";
  if (flow.activeService > 0 || flow.state === "in_progress") return "in_progress";
  if (flow.state === "denied" || flow.failed > 0) return "denied";
  if (flow.completed > 0 || flow.allowed > 0) return "allowed";
  return "pending";
}

function shortAction(action) {
  return truncate(action.replace(/_/g, " "), 16);
}

function parseToolId(toolId) {
  const match = String(toolId || "").match(/^provider:([^:]+):resource:[^:]+:action:(.+)$/);
  if (!match) return null;
  return { serviceId: match[1], action: match[2] };
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
      pendingAuth: 0,
      activeService: 0,
      allowed: 0,
      denied: 0,
      completed: 0,
      failed: 0,
      state: "pending",
      lastReason: "",
      lastTs: sequence,
    };
  }
  const service = ensureService(serviceId);
  service._flowKeys.add(key);
  if (toolName) flows[key].toolName = toolName;
  return flows[key];
}

function updateStatus() {
  const agentCount = Object.keys(nodes).length;
  const serviceCount = Object.keys(services).length;
  const flowCount = Object.keys(flows).length;
  statusEl.textContent = runId
    ? `${runPhase} - ${agentCount} agents - ${serviceCount} services - ${flowCount} flows`
    : "idle";
}

function serviceMetrics(serviceId) {
  const linkedFlows = Object.values(flows).filter((flow) => flow.serviceId === serviceId);
  const metrics = {
    pending: 0,
    active: 0,
    allowed: 0,
    denied: 0,
    completed: 0,
    total: 0,
    lastState: "pending",
  };

  for (const flow of linkedFlows) {
    metrics.pending += flow.pendingAuth;
    metrics.active += flow.activeService;
    metrics.allowed += flow.allowed;
    metrics.denied += flow.denied + flow.failed;
    metrics.completed += flow.completed;
    metrics.total += flow.count;
  }

  if (metrics.pending > 0) metrics.lastState = "pending";
  else if (metrics.active > 0) metrics.lastState = "in_progress";
  else if (metrics.denied > 0) metrics.lastState = "denied";
  else if (metrics.allowed > 0 || metrics.completed > 0) metrics.lastState = "allowed";

  return metrics;
}

function drawText(x, y, text, attrs = {}) {
  const node = svgEl("text", {
    x,
    y,
    fill: "var(--text)",
    "font-family": "system-ui, sans-serif",
    "font-size": 11,
    ...attrs,
  });
  node.textContent = text;
  svg.appendChild(node);
  return node;
}

function addTitle(parent, text) {
  const title = svgEl("title");
  title.textContent = text;
  parent.appendChild(title);
}

function marker(id, color) {
  const m = svgEl("marker", {
    id,
    viewBox: "0 0 8 8",
    refX: "7",
    refY: "4",
    markerWidth: "7",
    markerHeight: "7",
    orient: "auto-start-reverse",
  });
  m.appendChild(svgEl("path", { d: "M 0 0 L 8 4 L 0 8 z", fill: color }));
  return m;
}

function resetSvg(viewH) {
  svg.setAttribute("viewBox", `0 0 ${VIEW_W} ${viewH}`);
  svg.setAttribute("height", String(viewH));
  svg.innerHTML = "";

  const defs = svgEl("defs");
  defs.append(
    marker("arrow-allowed", FLOW_STYLE.allowed.color),
    marker("arrow-denied", FLOW_STYLE.denied.color),
    marker("arrow-progress", FLOW_STYLE.in_progress.color),
    marker("arrow-pending", FLOW_STYLE.pending.color),
  );
  svg.appendChild(defs);
}

function drawSectionFrame(viewH) {
  const bodyTop = SECTION_TOP + 12;
  const bodyBottom = viewH - BOTTOM_PAD;

  svg.appendChild(svgEl("line", {
    x1: CARACAL_X,
    y1: bodyTop,
    x2: CARACAL_X,
    y2: bodyBottom,
    stroke: "rgba(184, 92, 0, 0.38)",
    "stroke-width": 2,
    "stroke-dasharray": "4 4",
  }));

  svg.appendChild(svgEl("line", {
    x1: SERVICE_LEFT - 18,
    y1: bodyTop,
    x2: SERVICE_LEFT - 18,
    y2: bodyBottom,
    stroke: "rgba(13, 110, 114, 0.16)",
    "stroke-width": 1,
  }));

  drawText(LYNX_LEFT, 22, "Lynx", {
    fill: "var(--primary)",
    "font-size": 12.5,
    "font-weight": 700,
  });
  drawText(LYNX_LEFT + 36, 22, "internal execution", {
    fill: "rgba(26, 31, 46, 0.58)",
    "font-size": 10,
  });

  drawText(CARACAL_X, 22, "Caracal", {
    fill: "var(--warning, #B85C00)",
    "font-size": 12.5,
    "font-weight": 700,
    "text-anchor": "middle",
  });
  drawText(CARACAL_X, 36, "policy intercept", {
    fill: "rgba(26, 31, 46, 0.58)",
    "font-size": 9.5,
    "text-anchor": "middle",
  });

  drawText(SERVICE_LEFT, 22, "External", {
    fill: "var(--teal, #0D6E72)",
    "font-size": 12.5,
    "font-weight": 700,
  });
  drawText(SERVICE_LEFT + 54, 22, "services", {
    fill: "rgba(26, 31, 46, 0.58)",
    "font-size": 10,
  });

  drawText((LYNX_RIGHT + CARACAL_LEFT) / 2, 22, "runtime boundary", {
    fill: "rgba(26, 31, 46, 0.46)",
    "font-size": 9.5,
    "font-weight": 700,
    "letter-spacing": "0.08em",
    "text-anchor": "middle",
  });

  const legendX = SERVICE_RIGHT - 176;
  const legendItems = [
    { label: "Allowed", color: FLOW_STYLE.allowed.color },
    { label: "Denied", color: FLOW_STYLE.denied.color },
    { label: "Pending / active", color: FLOW_STYLE.in_progress.color },
  ];

  legendItems.forEach((item, index) => {
    const y = 18 + index * 12;
    svg.appendChild(svgEl("circle", { cx: legendX, cy: y - 3, r: 4, fill: item.color }));
    drawText(legendX + 10, y, item.label, {
      fill: "rgba(26, 31, 46, 0.72)",
      "font-size": 9.5,
    });
  });
}

function placeInternalNodes(layers) {
  const innerLeft = LYNX_LEFT + 14;
  const innerRight = LYNX_RIGHT - 14;
  const innerWidth = innerRight - innerLeft;

  layers.forEach((layerId, index) => {
    const bandY = TOP_PAD + index * (LAYER_BAND_H + LAYER_GAP);
    const band = svgEl("rect", {
      x: LYNX_LEFT + 2,
      y: bandY,
      width: LYNX_RIGHT - LYNX_LEFT - 6,
      height: LAYER_BAND_H,
      rx: 8,
      fill: "#fff",
      stroke: "rgba(11, 61, 145, 0.08)",
      "stroke-width": 1,
    });
    svg.appendChild(band);

    drawText(LYNX_LEFT + 14, bandY + 16, LAYER_LABELS[layerId] || titleCase(layerId), {
      fill: "rgba(26, 31, 46, 0.82)",
      "font-size": 10.5,
      "font-weight": 700,
    });

    const grouped = {};
    for (const node of Object.values(nodes).filter((item) => item.layer === layerId)) {
      const key = node.region || "_";
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(node);
    }

    const regions = Object.keys(grouped).sort((a, b) => {
      if (a === "_") return -1;
      if (b === "_") return 1;
      return a.localeCompare(b);
    });

    const slotCount = Math.max(regions.length, 1);
    const slotW = (innerWidth - REGION_GAP * (slotCount - 1)) / slotCount;

    regions.forEach((region, slotIndex) => {
      const slotX = innerLeft + slotIndex * (slotW + REGION_GAP);
      const slotCenter = slotX + slotW / 2;
      const nodeList = grouped[region].sort((a, b) => {
        const aParent = nodes[a.parent]?._cx || 0;
        const bParent = nodes[b.parent]?._cx || 0;
        if (aParent !== bParent) return aParent - bParent;
        return a.id.localeCompare(b.id);
      });
      const maxVisible = Math.max(1, Math.floor((slotW + NODE_GAP) / (NODE_W + NODE_GAP)));
      const visibleNodes = nodeList.slice(0, maxVisible);
      const hiddenCount = nodeList.length - visibleNodes.length;

      if (region !== "_") {
        drawText(slotCenter, bandY + 16, region, {
          fill: "rgba(11, 61, 145, 0.62)",
          "font-size": 9.5,
          "font-weight": 700,
          "text-anchor": "middle",
        });
      }

      const totalW = visibleNodes.length * NODE_W + Math.max(0, visibleNodes.length - 1) * NODE_GAP;
      const startX = slotX + Math.max(0, (slotW - totalW) / 2);
      const nodeY = bandY + (region === "_" ? 12 : 20);

      visibleNodes.forEach((node, nodeIndex) => {
        node._x = startX + nodeIndex * (NODE_W + NODE_GAP);
        node._y = nodeY;
        node._cx = node._x + NODE_W / 2;
        node._cy = node._y + NODE_H / 2;
        node._left = node._x;
        node._right = node._x + NODE_W;
      });

      nodeList.slice(maxVisible).forEach((node) => {
        delete node._x;
        delete node._y;
        delete node._cx;
        delete node._cy;
        delete node._left;
        delete node._right;
      });

      if (hiddenCount > 0) {
        drawText(slotX + slotW - 6, nodeY + NODE_H / 2 + 3, `+${hiddenCount} more`, {
          fill: "rgba(30, 91, 216, 0.72)",
          "font-size": 9,
          "font-weight": 700,
          "text-anchor": "end",
        });
      }
    });
  });
}

function placeServices(viewH) {
  const serviceList = Object.values(services);
  const minY = TOP_PAD + 6;
  const maxY = viewH - BOTTOM_PAD - SERVICE_H;

  serviceList.forEach((service) => {
    const linked = Object.values(flows).filter((flow) => flow.serviceId === service.id);
    const linkedYs = linked
      .map((flow) => nodes[flow.agentId]?._cy)
      .filter((value) => Number.isFinite(value));

    service._idealY = linkedYs.length
      ? linkedYs.reduce((sum, value) => sum + value, 0) / linkedYs.length - SERVICE_H / 2
      : (minY + maxY) / 2;
  });

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
          : Math.min(
              serviceList[index]._y - overflow,
              serviceList[index + 1]._y - SERVICE_H - SERVICE_GAP,
            );
        serviceList[index]._y = Math.max(minY, nextY);
      }
    }
  }

  serviceList.forEach((service) => {
    service._x = SERVICE_LEFT + 10;
    service._cx = service._x + SERVICE_W / 2;
    service._cy = service._y + SERVICE_H / 2;
    service._gateX = CARACAL_X;
    service._gateCx = CARACAL_X;
    service._gateCy = service._cy;
  });
}

function drawInternalEdges() {
  Object.values(nodes).forEach((node) => {
    if (!node.parent || !nodes[node.parent] || nodes[node.parent]._cx == null) return;

    const parent = nodes[node.parent];
    const midY = (parent._cy + node._cy) / 2;
    const path = svgEl("path", {
      d: `M ${parent._cx} ${parent._y + NODE_H} C ${parent._cx} ${midY}, ${node._cx} ${midY}, ${node._cx} ${node._y}`,
      fill: "none",
      stroke: "rgba(30, 91, 216, 0.32)",
      "stroke-width": 2,
    });
    addTitle(path, `${parent.role} -> ${node.role}${node.scope ? `\nScope: ${node.scope}` : ""}`);
    svg.appendChild(path);

    if (node.scope) {
      const label = truncate(shortScope(node.scope), 16);
      const chipW = Math.max(48, label.length * 6.4 + 16);
      const chipX = Math.min(LYNX_RIGHT - chipW - 20, Math.max(LYNX_LEFT + 20, node._cx - chipW / 2));
      const chipY = midY - 9;
      svg.appendChild(svgEl("rect", {
        x: chipX,
        y: chipY,
        width: chipW,
        height: 18,
        rx: 9,
        fill: "rgba(30, 91, 216, 0.10)",
        stroke: "rgba(30, 91, 216, 0.20)",
        "stroke-width": 1,
      }));
      drawText(chipX + chipW / 2, chipY + 12, label, {
        fill: "var(--accent)",
        "font-size": 9.5,
        "font-weight": 700,
        "text-anchor": "middle",
      });
    }
  });
}

function drawFlowPath(points, attrs, title) {
  const path = svgEl("path", attrs);
  addTitle(path, title);
  svg.appendChild(path);
}

function drawFlowBadge(x, y, text, color) {
  const width = Math.max(40, text.length * 6.2 + 14);
  svg.appendChild(svgEl("rect", {
    x,
    y: y - 9,
    width,
    height: 18,
    rx: 6,
    fill: "#fff",
    stroke: color,
    "stroke-width": 1,
  }));
  drawText(x + width / 2, y + 4, text, {
    fill: color,
    "font-size": 9.5,
    "font-weight": 700,
    "text-anchor": "middle",
  });
}

function drawPolicyBadge(flow, x, y, color) {
  const state = flowState(flow);
  const label = `${state === "in_progress" ? "live" : state}${flow.count > 1 ? ` x${flow.count}` : ""}`;
  const width = Math.max(44, label.length * 6 + 12);
  svg.appendChild(svgEl("rect", {
    x: x - width / 2,
    y: y - 8,
    width,
    height: 16,
    rx: 5,
    fill: "#fff",
    stroke: color,
    "stroke-width": 1,
  }));
  drawText(x, y + 3, label, {
    fill: color,
    "font-size": 8.8,
    "font-weight": 700,
    "text-anchor": "middle",
  });
}

function drawFlows() {
  const serviceFlowMap = {};
  for (const flow of Object.values(flows)) {
    if (!serviceFlowMap[flow.serviceId]) serviceFlowMap[flow.serviceId] = [];
    serviceFlowMap[flow.serviceId].push(flow);
  }

  Object.entries(serviceFlowMap).forEach(([serviceId, flowList]) => {
    const service = services[serviceId];
    if (!service) return;

    flowList.sort((a, b) => {
      const aNode = nodes[a.agentId];
      const bNode = nodes[b.agentId];
      const ay = aNode?._cy || 0;
      const by = bNode?._cy || 0;
      if (ay !== by) return ay - by;
      return a.order - b.order;
    });

    const offsets = flowList.map((_, index) => (index - (flowList.length - 1) / 2) * FLOW_OFFSET_STEP);

    flowList.forEach((flow, index) => {
      const agent = nodes[flow.agentId];
      if (!agent || service._cy == null) return;

      const state = flowState(flow);
      const style = FLOW_STYLE[state];
      const gateY = service._gateCy + offsets[index];
      const serviceY = service._cy + offsets[index] * 0.35;
      const startX = agent._right;
      const startY = agent._cy;
      const gateX = service._gateX;
      const serviceX = service._x;
      const endX = serviceX;
      const startCurve = Math.max(18, (gateX - startX) * 0.28);
      const endCurve = Math.max(18, (endX - gateX) * 0.28);

      const baseTitle = [
        `${agent.role} -> ${service.id}`,
        `Action: ${flow.action}`,
        `Status: ${state}`,
        `Calls: ${flow.count}`,
        agent.bind?.mandateId ? `Mandate: ${agent.bind.mandateId}` : "",
      ];
      if (flow.lastReason) baseTitle.push(`Detail: ${flow.lastReason}`);

      if (state === "denied" || state === "pending") {
        drawFlowPath(
          {
            d: `M ${startX} ${startY} C ${startX + startCurve} ${startY}, ${gateX - 12} ${gateY}, ${gateX} ${gateY}`,
            fill: "none",
            stroke: style.color,
            "stroke-width": Math.min(3.2, 1.5 + Math.log2(1 + flow.count) * 0.8),
            "stroke-dasharray": style.dash,
            opacity: 0.88,
            "marker-end": style.marker,
          },
          baseTitle.join("\n"),
        );
      } else {
        drawFlowPath(
          {
            d: `M ${startX} ${startY} C ${startX + startCurve} ${startY}, ${gateX - 14} ${gateY}, ${gateX} ${gateY} S ${endX - endCurve} ${serviceY}, ${endX} ${serviceY}`,
            fill: "none",
            stroke: style.color,
            "stroke-width": Math.min(3.2, 1.5 + Math.log2(1 + flow.count) * 0.8),
            opacity: 0.84,
            "marker-end": style.marker,
          },
          baseTitle.join("\n"),
        );

        if (flow.completed > 0 || flow.failed > 0) {
          const returnColor = flow.failed > 0 ? FLOW_STYLE.denied.color : FLOW_STYLE.allowed.color;
          drawFlowPath(
            {
              d: `M ${endX + SERVICE_W} ${serviceY + 6} C ${endX + SERVICE_W - endCurve} ${serviceY + 6}, ${gateX + 18} ${gateY + 6}, ${gateX} ${gateY + 6} S ${agent._right + startCurve} ${startY + 6}, ${agent._right} ${startY + 6}`,
              fill: "none",
              stroke: returnColor,
              "stroke-width": 1.35,
              "stroke-dasharray": "4 4",
              opacity: 0.68,
              "marker-end": flow.failed > 0 ? FLOW_STYLE.denied.marker : FLOW_STYLE.allowed.marker,
            },
            `${baseTitle.join("\n")}\nReturn: ${flow.failed > 0 ? "failed" : "completed"}`,
          );
        }
      }

      drawPolicyBadge(flow, gateX, gateY - 14, style.color);

      if (flow.count > 1 || state !== "allowed") {
        const badgeX = gateX + 48;
        const badgeText = shortAction(flow.action);
        drawFlowBadge(badgeX, gateY + 14, badgeText, style.color);
      }
    });
  });
}

function drawAgentNodes() {
  Object.values(nodes).forEach((node) => {
    if (node._x == null) return;

    const group = svgEl("g", { "data-id": node.id });
    const stroke = statusColor(node.status || "spawned");
    group.appendChild(svgEl("rect", {
      x: node._x,
      y: node._y,
      width: NODE_W,
      height: NODE_H,
      rx: 8,
      fill: "#fff",
      stroke,
      "stroke-width": 1.6,
    }));

    drawText(node._x + 10, node._y + 14, truncate(titleCase(node.role || node.layer), 18), {
      fill: "var(--text)",
      "font-size": 9.8,
      "font-weight": 700,
    });

    const meta = node.region || shortScope(node.scope) || "internal";
    drawText(node._x + 10, node._y + 26, truncate(meta, 22), {
      fill: "rgba(26, 31, 46, 0.54)",
      "font-size": 8.9,
    });

    drawText(node._x + 10, node._y + 37, titleCase(node.status || "spawned"), {
      fill: stroke,
      "font-size": 8.8,
      "font-weight": 700,
    });

    if (node.bind) {
      const badgeX = node._x + NODE_W - 24;
      const badgeY = node._y + 10;
      const badgeColor = node.bind.decision === "deny" ? FLOW_STYLE.denied.color : FLOW_STYLE.allowed.color;
      group.appendChild(svgEl("circle", { cx: badgeX, cy: badgeY, r: 7, fill: badgeColor, opacity: 0.92 }));
      const badgeText = svgEl("text", {
        x: badgeX,
        y: badgeY + 3,
        fill: "#fff",
        "font-size": 8,
        "font-weight": 700,
        "text-anchor": "middle",
        "font-family": "system-ui, sans-serif",
      });
      badgeText.textContent = node.bind.decision === "deny" ? "!" : "C";
      group.appendChild(badgeText);
    }

    addTitle(
      group,
      [
        `${node.role} (${shortId(node.id)})`,
        `Layer: ${node.layer}`,
        node.region ? `Region: ${node.region}` : "",
        node.scope ? `Delegation scope: ${node.scope}` : "",
        node.bind?.reason ? `Authority: ${node.bind.reason}` : "",
      ].filter(Boolean).join("\n"),
    );

    svg.appendChild(group);
  });
}

function drawCaracalAndServices() {
  Object.values(services).forEach((service) => {
    if (service._y == null) return;

    const metrics = serviceMetrics(service.id);
    const state = metrics.lastState;
    const color = FLOW_STYLE[state]?.color || FLOW_STYLE.pending.color;

    const box = svgEl("g", { "data-service": service.id });
    box.appendChild(svgEl("rect", {
      x: service._x,
      y: service._y,
      width: SERVICE_W,
      height: SERVICE_H,
      rx: 8,
      fill: "#fff",
      stroke: color,
      "stroke-width": 1.6,
    }));
    drawText(service._x + 10, service._y + 14, truncate(service.id, 22), {
      fill: "var(--text)",
      "font-size": 9.8,
      "font-weight": 700,
    });
    drawText(
      service._x + 10,
      service._y + 26,
      `${metrics.total} call${metrics.total === 1 ? "" : "s"}${metrics.active ? ` - ${metrics.active} active` : ""}`,
      {
        fill: "rgba(26, 31, 46, 0.56)",
        "font-size": 8.9,
      },
    );
    drawText(
      service._x + 10,
      service._y + 37,
      state === "denied" ? "Denied" : state === "allowed" ? "Returning" : "Outbound dependency",
      {
        fill: color,
        "font-size": 8.8,
        "font-weight": 700,
      },
    );
    addTitle(
      box,
      [
        `${service.id}`,
        `Calls: ${metrics.total}`,
        `Pending: ${metrics.pending}`,
        `Allowed: ${metrics.allowed}`,
        `Denied: ${metrics.denied}`,
      ].join("\n"),
    );
    svg.appendChild(box);
  });
}

function buildLayout() {
  const layerIds = LAYER_ORDER.filter((layer) => Object.values(nodes).some((node) => node.layer === layer));
  const internalH = layerIds.length
    ? layerIds.length * LAYER_BAND_H + Math.max(0, layerIds.length - 1) * LAYER_GAP
    : 180;
  const serviceCount = Object.keys(services).length;
  const serviceH = serviceCount
    ? serviceCount * SERVICE_H + Math.max(0, serviceCount - 1) * SERVICE_GAP + 24
    : 180;
  const viewH = TOP_PAD + Math.max(internalH, serviceH, 240) + BOTTOM_PAD;

  resetSvg(viewH);
  drawSectionFrame(viewH);

  if (!layerIds.length && !serviceCount) {
    updateStatus();
    return;
  }

  placeInternalNodes(layerIds);
  placeServices(viewH);
  drawInternalEdges();
  drawFlows();
  drawAgentNodes();
  drawCaracalAndServices();
  updateStatus();
}

function updateNodeStatus(agentId, status) {
  if (!nodes[agentId]) return;
  nodes[agentId].status = status;
}

function handleEvent(event) {
  const payload = event.payload || {};

  switch (event.kind) {
    case "agent_spawn":
      nodes[payload.agent_id] = {
        id: payload.agent_id,
        role: payload.role,
        layer: payload.layer,
        region: payload.region || null,
        parent: payload.parent_id || null,
        scope: payload.scope || "",
        status: "spawned",
        bind: null,
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
      scheduleRender();
      break;

    case "agent_terminate":
      updateNodeStatus(payload.agent_id, payload.status || "completed");
      scheduleRender();
      break;

    case "tool_call": {
      const mapping = TOOL_TO_SERVICE[payload.tool_name];
      if (!mapping) break;
      const flow = ensureFlow(payload.agent_id, mapping.serviceId, mapping.action, payload.tool_name);
      flow.count += 1;
      flow.pendingAuth += 1;
      flow.state = "pending";
      flow.lastTs = sequence++;
      scheduleRender();
      break;
    }

    case "caracal_bind":
      if (nodes[payload.agent_id]) {
        nodes[payload.agent_id].bind = {
          decision: payload.decision,
          reason: payload.reason || "",
          mandateId: payload.mandate_id || "",
        };
      }
      scheduleRender();
      break;

    case "caracal_enforce": {
      const parsed = parseToolId(payload.tool_id);
      if (!parsed) break;
      const flow = ensureFlow(payload.agent_id, parsed.serviceId, parsed.action);
      flow.pendingAuth = Math.max(0, flow.pendingAuth - 1);
      flow.lastReason = payload.reason || payload.decision || "";
      flow.lastTs = sequence++;
      if (payload.decision === "deny") {
        flow.denied += 1;
        flow.state = "denied";
      } else {
        flow.allowed += 1;
        flow.state = "allowed";
      }
      scheduleRender();
      break;
    }

    case "service_call": {
      const flow = ensureFlow(payload.agent_id, payload.service_id, payload.action);
      flow.activeService += 1;
      flow.state = "in_progress";
      flow.lastTs = sequence++;
      const service = ensureService(payload.service_id);
      service.lastAction = payload.action;
      revealSvg();
      scheduleRender();
      break;
    }

    case "service_result": {
      const flow = ensureFlow(payload.agent_id, payload.service_id, payload.action);
      flow.activeService = Math.max(0, flow.activeService - 1);
      flow.lastTs = sequence++;
      const failed = Boolean(
        payload.result && (payload.result.status === "error" || payload.result.status === "failed" || payload.result.error),
      );
      if (failed) {
        flow.failed += 1;
        flow.state = "denied";
      } else {
        flow.completed += 1;
        flow.state = "allowed";
      }
      scheduleRender();
      break;
    }

    case "run_end": {
      runPhase = payload.status || "done";
      scheduleRender();
      break;
    }
  }
}

function attachStream(nextRunId) {
  runId = nextRunId;
  nodes = {};
  services = {};
  flows = {};
  sequence = 0;
  runPhase = "running";

  if (eventSource) eventSource.close();
  if (renderHandle) {
    window.cancelAnimationFrame(renderHandle);
    renderHandle = 0;
  }

  svg.innerHTML = "";
  if (emptyEl) emptyEl.style.display = "";
  if (svg) svg.style.display = "none";
  statusEl.textContent = "running...";

  eventSource = new EventSource(`/api/run/${nextRunId}/events`);
  eventSource.onmessage = (message) => {
    try {
      handleEvent(JSON.parse(message.data));
    } catch {
      /* keepalive */
    }
  };
  eventSource.onerror = () => {
    eventSource.close();
    eventSource = null;
  };
}

window.addEventListener("run-started", (event) => attachStream(event.detail.runId));
