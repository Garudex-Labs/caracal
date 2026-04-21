"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

FastAPI application combining MCPAdapterService routes with demo UI and observability.
"""

from __future__ import annotations

import dataclasses
import os
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse

from caracal.core.authority import AuthorityEvaluator
from caracal.core.ledger import LedgerWriter
from caracal.core.metering import MeteringCollector
from caracal.db.connection import DatabaseConfig, DatabaseConnectionManager
from caracal.mcp.adapter import MCPAdapter
from caracal.mcp.service import MCPAdapterService, MCPServiceConfig

from .demo_runtime import DemoRuntime, RunConfig
from .preflight import WorkspacePreflight
from .trace_store import TraceStore

_DEMO_PORT = int(os.environ.get("CARACAL_DEMO_PORT", "8090"))
_DEMO_LISTEN = os.environ.get("CARACAL_DEMO_LISTEN", "0.0.0.0")
_REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
_MCP_BASE_URL = f"http://localhost:{_DEMO_PORT}"
_WORKSPACE_NAME = os.environ.get("CARACAL_DEMO_WORKSPACE", "")

_trace_store = TraceStore(maxsize=2000)
_db_manager: Optional[DatabaseConnectionManager] = None
_runtime: Optional[DemoRuntime] = None


def _make_db_manager() -> DatabaseConnectionManager:
    config = DatabaseConfig()
    mgr = DatabaseConnectionManager(config)
    mgr.initialize()
    return mgr


def _make_runtime(db_manager: DatabaseConnectionManager, workspace_id: str) -> DemoRuntime:
    with db_manager.session_scope() as session:
        return DemoRuntime(
            db_session=session,
            workspace_id=workspace_id,
            mcp_base_url=_MCP_BASE_URL,
            trace_store=_trace_store,
            redis_url=_REDIS_URL,
        )


def _workspace_id() -> str:
    if _WORKSPACE_NAME:
        return _WORKSPACE_NAME
    try:
        from caracal.deployment.config_manager import ConfigManager
        return ConfigManager().get_default_workspace_name() or "default"
    except Exception:
        return "default"


def build_app() -> FastAPI:
    """Build the combined demo FastAPI app.

    Reuses MCPAdapterService.app and attaches demo routes to it.
    """
    db_manager = _make_db_manager()

    with db_manager.session_scope() as session:
        ledger = LedgerWriter(session)
        evaluator = AuthorityEvaluator(session)
        metering = MeteringCollector(ledger)
        adapter = MCPAdapter(
            authority_evaluator=evaluator,
            metering_collector=metering,
        )
        config = MCPServiceConfig(
            listen_address=f"{_DEMO_LISTEN}:{_DEMO_PORT}",
            mcp_servers=[],
        )
        mcp_service = MCPAdapterService(
            config=config,
            mcp_adapter=adapter,
            authority_evaluator=evaluator,
            metering_collector=metering,
            db_connection_manager=db_manager,
        )

    app: FastAPI = mcp_service.app
    ws_id = _workspace_id()

    global _db_manager
    _db_manager = db_manager

    # ------------------------------------------------------------------
    # Customer-facing UI
    # ------------------------------------------------------------------

    @app.get("/", response_class=HTMLResponse, tags=["demo"])
    async def customer_ui() -> HTMLResponse:
        return HTMLResponse(_CUSTOMER_HTML)

    # ------------------------------------------------------------------
    # Internal observability UI
    # ------------------------------------------------------------------

    @app.get("/caracal", response_class=HTMLResponse, tags=["demo"])
    async def caracal_ui() -> HTMLResponse:
        return HTMLResponse(_CARACAL_HTML)

    # ------------------------------------------------------------------
    # API
    # ------------------------------------------------------------------

    @app.get("/api/preflight", tags=["demo"])
    async def api_preflight() -> JSONResponse:
        with db_manager.session_scope() as session:
            pf = WorkspacePreflight(session, ws_id)
            return JSONResponse(pf.summary())

    @app.post("/api/run", tags=["demo"])
    async def api_run(request: Request) -> JSONResponse:
        body = {}
        try:
            body = await request.json()
        except Exception:
            pass

        with db_manager.session_scope() as session:
            pf = WorkspacePreflight(session, ws_id)
            if not pf.passed():
                summary = pf.summary()
                failed = [c["name"] for c in summary["checks"] if not c["passed"]]
                return JSONResponse(
                    {"error": f"Preflight failed: {', '.join(failed)}. Fix issues before running."},
                    status_code=400,
                )

        mode = str(body.get("mode", "mock"))
        config = RunConfig(mode=mode, workspace_id=ws_id)
        with db_manager.session_scope() as session:
            runtime = DemoRuntime(
                db_session=session,
                workspace_id=ws_id,
                mcp_base_url=_MCP_BASE_URL,
                trace_store=_trace_store,
                redis_url=_REDIS_URL,
            )
            result = await runtime.execute(config)
        return JSONResponse(_serialize_run_result(result))

    @app.get("/api/workspace", tags=["demo"])
    async def api_workspace() -> JSONResponse:
        with db_manager.session_scope() as session:
            pf = WorkspacePreflight(session, ws_id)
            return JSONResponse(pf.summary())

    @app.get("/api/runs", tags=["demo"])
    async def api_runs() -> JSONResponse:
        return JSONResponse({"run_ids": _trace_store.run_ids()})

    @app.get("/api/runs/{run_id}", tags=["demo"])
    async def api_run_events(run_id: str) -> JSONResponse:
        events = _trace_store.get_by_run(run_id)
        return JSONResponse([dataclasses.asdict(e) for e in events])

    @app.get("/api/principals", tags=["demo"])
    async def api_principals() -> JSONResponse:
        from caracal.db.models import AuthorityPolicy, ExecutionMandate, Principal

        with db_manager.session_scope() as session:
            rows = session.query(Principal).order_by(Principal.principal_kind).all()
            out = []
            for r in rows:
                policy_rows = (
                    session.query(AuthorityPolicy)
                    .filter_by(principal_id=r.principal_id, active=True)
                    .all()
                )
                resource_patterns: list[str] = []
                allowed_actions: list[str] = []
                for p in policy_rows:
                    rp = p.allowed_resource_patterns or []
                    if isinstance(rp, list):
                        resource_patterns.extend(rp)
                    aa = p.allowed_actions or []
                    if isinstance(aa, list):
                        allowed_actions.extend(aa)
                resource_patterns = list(dict.fromkeys(resource_patterns))
                allowed_actions = list(dict.fromkeys(allowed_actions))
                active_mandates = (
                    session.query(ExecutionMandate)
                    .filter(
                        ExecutionMandate.subject_id == r.principal_id,
                        ExecutionMandate.revoked.is_(False),
                    )
                    .count()
                )
                out.append({
                    "principal_id": str(r.principal_id),
                    "name": str(r.name),
                    "kind": str(r.principal_kind),
                    "lifecycle_status": str(r.lifecycle_status),
                    "active_policies": len(policy_rows),
                    "active_mandates": active_mandates,
                    "authority_scope": {
                        "allowed_resource_patterns": resource_patterns,
                        "allowed_actions": allowed_actions,
                    },
                })
        return JSONResponse(out)

    @app.get("/api/delegation", tags=["demo"])
    async def api_delegation() -> JSONResponse:
        from caracal.db.models import DelegationEdgeModel

        with db_manager.session_scope() as session:
            rows = (
                session.query(DelegationEdgeModel)
                .order_by(DelegationEdgeModel.granted_at.desc())
                .limit(100)
                .all()
            )
            out = []
            for r in rows:
                out.append({
                    "edge_id": str(r.edge_id),
                    "source_mandate_id": str(r.source_mandate_id),
                    "target_mandate_id": str(r.target_mandate_id),
                    "source_kind": str(r.source_principal_kind),
                    "target_kind": str(r.target_principal_kind),
                    "delegation_type": str(r.delegation_type),
                    "granted_at": r.granted_at.isoformat() if r.granted_at else None,
                    "expires_at": r.expires_at.isoformat() if r.expires_at else None,
                    "revoked": bool(r.revoked),
                })
        return JSONResponse(out)

    @app.get("/api/tools", tags=["demo"])
    async def api_tools() -> JSONResponse:
        from caracal.db.models import RegisteredTool

        with db_manager.session_scope() as session:
            rows = (
                session.query(RegisteredTool)
                .filter_by(workspace_name=ws_id)
                .order_by(RegisteredTool.tool_id)
                .all()
            )
            out = []
            for r in rows:
                out.append({
                    "tool_id": str(r.tool_id),
                    "provider_name": str(r.provider_name or ""),
                    "resource_scope": str(r.resource_scope or ""),
                    "action_scope": str(r.action_scope or ""),
                    "tool_type": str(r.tool_type or ""),
                    "execution_mode": str(r.execution_mode or ""),
                    "handler_ref": str(r.handler_ref or ""),
                    "active": bool(r.active),
                    "provider_definition_id": str(r.provider_definition_id or ""),
                })
        return JSONResponse(out)

    @app.get("/api/mandates", tags=["demo"])
    async def api_mandates() -> JSONResponse:
        from caracal.db.models import ExecutionMandate, Principal
        from datetime import datetime

        with db_manager.session_scope() as session:
            now = datetime.utcnow()
            rows = (
                session.query(ExecutionMandate)
                .filter(
                    ExecutionMandate.revoked.is_(False),
                    (ExecutionMandate.valid_until == None)  # noqa: E711
                    | (ExecutionMandate.valid_until > now),
                )
                .order_by(ExecutionMandate.issued_at.desc())
                .limit(50)
                .all()
            )
            out = []
            for r in rows:
                principal = (
                    session.query(Principal)
                    .filter_by(principal_id=r.subject_id)
                    .first()
                )
                out.append({
                    "mandate_id": str(r.mandate_id),
                    "subject_id": str(r.subject_id),
                    "subject_name": str(principal.name) if principal else "",
                    "subject_kind": str(principal.principal_kind) if principal else "",
                    "resource_scope": (
                        r.resource_scope
                        if isinstance(r.resource_scope, list)
                        else [str(r.resource_scope or "")]
                    ),
                    "action_scope": (
                        r.action_scope
                        if isinstance(r.action_scope, list)
                        else [str(r.action_scope or "")]
                    ),
                    "issued_at": r.issued_at.isoformat() if getattr(r, "issued_at", None) else None,
                    "valid_until": r.valid_until.isoformat() if r.valid_until else None,
                })
        return JSONResponse(out)

    @app.get("/api/authority_ledger", tags=["demo"])
    async def api_authority_ledger(correlation_id: Optional[str] = None) -> JSONResponse:
        from caracal.core.authority_ledger import AuthorityLedgerQuery

        with db_manager.session_scope() as session:
            q = AuthorityLedgerQuery(session)
            events = q.get_events(limit=100)
            out = []
            for e in events:
                cid = str(e.correlation_id or "")
                if correlation_id and correlation_id not in cid:
                    continue
                out.append({
                    "event_id": e.event_id,
                    "event_type": str(e.event_type),
                    "timestamp": e.timestamp.isoformat() if e.timestamp else None,
                    "principal_id": str(e.principal_id),
                    "mandate_id": str(e.mandate_id) if e.mandate_id else None,
                    "decision": str(e.decision or ""),
                    "denial_reason": str(e.denial_reason or ""),
                    "requested_action": str(e.requested_action or ""),
                    "requested_resource": str(e.requested_resource or ""),
                    "correlation_id": cid,
                })
        return JSONResponse(out)

    @app.get("/api/traces", tags=["demo"])
    async def api_traces_filtered(
        correlation_id: Optional[str] = None,
        limit: int = 200,
    ) -> JSONResponse:
        import dataclasses as _dc

        events = _trace_store.recent(limit)
        if correlation_id:
            events = [e for e in events if correlation_id in (e.correlation_id or "")]
        return JSONResponse([_dc.asdict(e) for e in events])

    @app.get("/api/ledger", tags=["demo"])
    async def api_ledger(limit: int = 100) -> JSONResponse:
        from caracal.core.ledger import LedgerReader

        with db_manager.session_scope() as session:
            reader = LedgerReader(session)
            events = reader.get_events(limit=limit)
            out = []
            for e in events:
                out.append({
                    "event_id": str(e.event_id),
                    "event_type": str(e.event_type or ""),
                    "principal_id": str(e.principal_id) if e.principal_id else None,
                    "mandate_id": str(e.mandate_id) if getattr(e, "mandate_id", None) else None,
                    "amount": str(e.amount) if getattr(e, "amount", None) is not None else None,
                    "resource": str(e.resource or "") if getattr(e, "resource", None) else None,
                    "timestamp": e.timestamp.isoformat() if getattr(e, "timestamp", None) else None,
                    "correlation_id": str(e.correlation_id or "") if getattr(e, "correlation_id", None) else None,
                })
        return JSONResponse(out)

    @app.get("/api/audit", tags=["demo"])
    async def api_audit(
        correlation_id: Optional[str] = None,
        event_type: Optional[str] = None,
        limit: int = 100,
    ) -> JSONResponse:
        import json as _json
        from caracal.core.audit import AuditLogManager

        with db_manager.session_scope() as session:
            mgr = AuditLogManager(session)
            raw = mgr.export_json(
                correlation_id=correlation_id,
                event_type=event_type,
                limit=limit,
            )
        return JSONResponse(_json.loads(raw))

    return app


def _serialize_run_result(result: Any) -> dict:
    d = dataclasses.asdict(result)
    for worker in d.get("workers", []):
        if not isinstance(worker.get("result"), (dict, list, str, int, float, bool, type(None))):
            worker["result"] = str(worker["result"])
    trace_events = d.pop("trace_events", [])
    d["trace_count"] = len(trace_events)
    return d


# ------------------------------------------------------------------
# HTML templates (inline, no static file serving dependency)
# ------------------------------------------------------------------

_CUSTOMER_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Caracal Governed Demo</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;background:#f8f9fa}
    h1{color:#1a1a2e}
    .card{background:#fff;border-radius:8px;padding:20px;margin:16px 0;box-shadow:0 1px 4px rgba(0,0,0,.1)}
    .btn{padding:10px 20px;border:none;border-radius:6px;cursor:pointer;font-size:14px}
    .btn-primary{background:#4361ee;color:#fff}
    .check-pass{color:#28a745;font-weight:600}
    .check-fail{color:#dc3545;font-weight:600}
    pre{background:#1e1e2e;color:#cdd6f4;border-radius:6px;padding:16px;overflow-x:auto;font-size:13px}
    .nav a{margin-right:16px;color:#4361ee;text-decoration:none;font-weight:500}
    .badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600}
    .badge-ok{background:#d4edda;color:#155724}
    .badge-fail{background:#f8d7da;color:#721c24}
    .badge-deny{background:#fff3cd;color:#856404}
    .worker-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:12px}
    .worker-card{border:1px solid #dee2e6;border-radius:6px;padding:12px;font-size:13px}
    #status{margin-top:8px;color:#666;font-size:14px}
  </style>
</head>
<body>
<nav class="nav">
  <a href="/">Customer View</a>
  <a href="/caracal">Caracal Internal</a>
  <a href="/docs">API Docs</a>
</nav>
<h1>Caracal Governed Demo</h1>
<div class="card" id="preflight-card">
  <h2>Workspace Readiness</h2>
  <div id="preflight-content">Loading&hellip;</div>
</div>
<div class="card">
  <h2>Run Demo</h2>
  <label>Mode: <select id="mode-select">
    <option value="mock">mock</option>
    <option value="real">real</option>
  </select></label>&nbsp;
  <button class="btn btn-primary" onclick="runDemo()">Run Governed Workflow</button>
  <div id="status"></div>
</div>
<div class="card" id="workers-card" style="display:none">
  <h2>Worker Fan-Out</h2>
  <div id="workers-grid" class="worker-grid"></div>
</div>
<div class="card" id="result-card" style="display:none">
  <h2>Last Run Result</h2>
  <pre id="result-pre"></pre>
</div>
<script>
async function loadPreflight(){
  const r=await fetch('/api/preflight');const d=await r.json();
  const checks=d.checks||[];
  const passed=checks.filter(c=>c.passed).length;
  const html='<p><strong>'+passed+'/'+checks.length+' checks passed</strong> &mdash; workspace: <code>'+(d.workspace||'')+'</code></p>'+
    checks.map(c=>'<div style="margin:4px 0"><span class="'+(c.passed?'check-pass':'check-fail')+'">'+(c.passed?'&#10003;':'&#10007;')+' '+c.name+'</span>: '+c.detail+(!c.passed&&c.cli_fix?'<br/><small>Fix: <code>'+c.cli_fix+'</code>'+(c.tui_screen?' or '+c.tui_screen:'')+'</small>':'')+'</div>').join('');
  document.getElementById('preflight-content').innerHTML=html;
}
async function runDemo(){
  document.getElementById('status').textContent='Running\u2026';
  document.getElementById('result-card').style.display='none';
  document.getElementById('workers-card').style.display='none';
  const mode=document.getElementById('mode-select').value;
  const r=await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode})});
  const d=await r.json();
  if(d.error){
    document.getElementById('status').innerHTML='<span style="color:#dc3545">'+d.error+'</span>';
  } else {
    const w=d.workers||[];
    const ok=w.filter(x=>x.success).length;
    const denied=w.filter(x=>x.result_type==='enforcement_deny').length;
    document.getElementById('status').textContent='Run complete. '+ok+'/'+w.length+' workers succeeded, '+denied+' enforcement denial(s). '+d.trace_count+' trace events.';
    renderWorkers(w);
  }
  document.getElementById('result-pre').textContent=JSON.stringify(d,null,2);
  document.getElementById('result-card').style.display='block';
}
function renderWorkers(workers){
  const grid=document.getElementById('workers-grid');
  grid.innerHTML=workers.map(function(w){
    const cls=w.success?'badge-ok':w.result_type==='enforcement_deny'?'badge-deny':'badge-fail';
    const label=w.success?'allowed':w.result_type==='enforcement_deny'?'enforcement_deny':(w.result_type||'error');
    return '<div class="worker-card"><div><strong>'+w.worker_name+'</strong></div>'+
      '<div style="font-size:11px;color:#666">'+w.tool_id+'</div>'+
      '<div style="margin-top:6px"><span class="badge '+cls+'">'+label+'</span></div>'+
      (w.denial_reason?'<div style="font-size:11px;color:#856404;margin-top:4px">'+w.denial_reason.slice(0,80)+'</div>':'')+
      '<div style="font-size:11px;margin-top:4px">'+(w.latency_ms?w.latency_ms.toFixed(1)+'ms':'')+'</div></div>';
  }).join('');
  document.getElementById('workers-card').style.display='block';
}
loadPreflight();
</script>
</body>
</html>"""

_CARACAL_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Caracal Internal View</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:1200px;margin:40px auto;padding:0 20px;background:#f8f9fa}
    h1{color:#1a1a2e}h2{color:#333;border-bottom:1px solid #dee2e6;padding-bottom:4px}
    .card{background:#fff;border-radius:8px;padding:20px;margin:16px 0;box-shadow:0 1px 4px rgba(0,0,0,.1)}
    pre{background:#1e1e2e;color:#cdd6f4;border-radius:6px;padding:16px;overflow-x:auto;font-size:12px;max-height:400px}
    .nav a{margin-right:16px;color:#4361ee;text-decoration:none;font-weight:500}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{padding:6px 10px;text-align:left;border-bottom:1px solid #dee2e6}
    th{background:#f1f3f5;font-weight:600}
    .badge{display:inline-block;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:600}
    .badge-ok{background:#d4edda;color:#155724}
    .badge-warn{background:#fff3cd;color:#856404}
    .badge-err{background:#f8d7da;color:#721c24}
    .badge-deny{background:#fff3cd;color:#856404}
    .refresh-btn{float:right;padding:6px 14px;background:#4361ee;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:13px}
    .empty{color:#999;font-style:italic}
  </style>
</head>
<body>
<nav class="nav">
  <a href="/">Customer View</a>
  <a href="/caracal">Caracal Internal</a>
  <a href="/docs">API Docs</a>
</nav>
<h1>Caracal Internal Observability</h1>

<div class="card">
  <h2>Preflight Checks <button class="refresh-btn" onclick="loadPreflight()">Refresh</button></h2>
  <div id="preflight-content">Loading&hellip;</div>
</div>

<div class="card">
  <h2>Principals <button class="refresh-btn" onclick="loadPrincipals()">Refresh</button></h2>
  <div id="principals-content">Loading&hellip;</div>
</div>

<div class="card">
  <h2>Registered Tools <button class="refresh-btn" onclick="loadTools()">Refresh</button></h2>
  <div id="tools-content">Loading&hellip;</div>
</div>

<div class="card">
  <h2>Active Mandates <button class="refresh-btn" onclick="loadMandates()">Refresh</button></h2>
  <div id="mandates-content">Loading&hellip;</div>
</div>

<div class="card">
  <h2>Delegation Graph <button class="refresh-btn" onclick="loadDelegation()">Refresh</button></h2>
  <div id="delegation-content">Loading&hellip;</div>
</div>

<div class="card">
  <h2>Authority Ledger <button class="refresh-btn" onclick="loadLedger()">Refresh</button></h2>
  <div id="ledger-content">Loading&hellip;</div>
</div>

<div class="card">
  <h2>Usage Ledger (metering) <button class="refresh-btn" onclick="loadUsageLedger()">Refresh</button></h2>
  <div id="usage-ledger-content">Loading&hellip;</div>
</div>

<div class="card">
  <h2>Audit Log <button class="refresh-btn" onclick="loadAudit()">Refresh</button></h2>
  <div style="margin-bottom:8px"><input id="audit-corr" placeholder="Filter by correlation_id" style="padding:4px 8px;border:1px solid #ccc;border-radius:4px;font-size:13px;width:300px"/> <button onclick="loadAudit()" style="padding:4px 10px;background:#4361ee;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px">Filter</button></div>
  <div id="audit-content">Loading&hellip;</div>
</div>

<div class="card">
  <h2>Trace Events <button class="refresh-btn" onclick="loadTraces()">Refresh</button></h2>
  <div style="margin-bottom:8px"><input id="trace-corr" placeholder="Filter by correlation_id" style="padding:4px 8px;border:1px solid #ccc;border-radius:4px;font-size:13px;width:300px"/> <button onclick="loadTraces()" style="padding:4px 10px;background:#4361ee;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px">Filter</button></div>
  <div id="traces-content">Loading&hellip;</div>
</div>

<script>
function badge(cls,text){return '<span class="badge '+cls+'">'+text+'</span>';}
async function loadPreflight(){
  const r=await fetch('/api/preflight');const d=await r.json();
  const checks=d.checks||[];
  if(!checks.length){document.getElementById('preflight-content').innerHTML='<p class="empty">No checks.</p>';return;}
  const rows=checks.map(function(c){return '<tr><td>'+badge(c.passed?'badge-ok':'badge-err',c.passed?'\\u2713':'\\u2717')+'</td><td>'+c.name+'</td><td>'+c.detail+'</td><td>'+(c.cli_fix?'<code>'+c.cli_fix+'</code>':'')+'</td><td>'+(c.tui_screen||'')+'</td></tr>';}).join('');
  document.getElementById('preflight-content').innerHTML='<table><thead><tr><th>Status</th><th>Check</th><th>Detail</th><th>CLI Fix</th><th>TUI</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
async function loadPrincipals(){
  const r=await fetch('/api/principals');const items=await r.json();
  if(!items.length){document.getElementById('principals-content').innerHTML='<p class="empty">No principals found.</p>';return;}
  const rows=items.map(function(p){
    var ls=p.lifecycle_status;
    var scope=p.authority_scope||{};
    var rp=(scope.allowed_resource_patterns||[]).join(', ')||'\u2014';
    var aa=(scope.allowed_actions||[]).join(', ')||'\u2014';
    return '<tr><td>'+p.name+'</td><td>'+badge('badge-ok',p.kind)+'</td><td>'+badge(ls==='active'?'badge-ok':ls==='provisioned'?'badge-warn':'badge-err',ls)+'</td><td>'+p.active_policies+'</td><td>'+p.active_mandates+'</td><td style="font-size:11px;color:#555">'+rp+'</td><td style="font-size:11px;color:#555">'+aa+'</td><td style="font-size:11px;color:#999">'+p.principal_id.slice(0,12)+'&hellip;</td></tr>';
  }).join('');
  document.getElementById('principals-content').innerHTML='<table><thead><tr><th>Name</th><th>Kind</th><th>Lifecycle</th><th>Policies</th><th>Mandates</th><th>Resource Scope</th><th>Actions</th><th>ID</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
async function loadTools(){
  const r=await fetch('/api/tools');const items=await r.json();
  if(!items.length){document.getElementById('tools-content').innerHTML='<p class="empty">No tools registered for workspace.</p>';return;}
  const rows=items.map(function(t){return '<tr><td>'+t.tool_id+'</td><td>'+t.provider_name+'</td><td>'+t.tool_type+'</td><td>'+t.execution_mode+'</td><td style="font-size:11px">'+t.resource_scope+'</td><td style="font-size:11px">'+t.action_scope+'</td><td>'+badge(t.active?'badge-ok':'badge-err',t.active?'active':'inactive')+'</td></tr>';}).join('');
  document.getElementById('tools-content').innerHTML='<table><thead><tr><th>Tool ID</th><th>Provider</th><th>Type</th><th>Mode</th><th>Resource Scope</th><th>Action Scope</th><th>Status</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
async function loadMandates(){
  const r=await fetch('/api/mandates');const items=await r.json();
  if(!items.length){document.getElementById('mandates-content').innerHTML='<p class="empty">No active mandates.</p>';return;}
  const rows=items.map(function(m){return '<tr><td>'+m.subject_name+'</td><td>'+badge('badge-ok',m.subject_kind)+'</td><td style="font-size:11px">'+((m.resource_scope||[]).join(', '))+'</td><td style="font-size:11px">'+((m.action_scope||[]).join(', '))+'</td><td style="font-size:11px">'+(m.valid_until||'no expiry')+'</td></tr>';}).join('');
  document.getElementById('mandates-content').innerHTML='<table><thead><tr><th>Subject</th><th>Kind</th><th>Resource Scope</th><th>Action Scope</th><th>Valid Until</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
async function loadDelegation(){
  const r=await fetch('/api/delegation');const items=await r.json();
  if(!items.length){document.getElementById('delegation-content').innerHTML='<p class="empty">No delegation edges found.</p>';return;}
  const rows=items.map(function(e){return '<tr><td>'+e.source_kind+' &rarr; '+e.target_kind+'</td><td>'+e.delegation_type+'</td><td style="font-size:11px">'+(e.granted_at||'')+'</td><td style="font-size:11px">'+(e.expires_at||'no expiry')+'</td><td>'+badge(e.revoked?'badge-err':'badge-ok',e.revoked?'revoked':'active')+'</td></tr>';}).join('');
  document.getElementById('delegation-content').innerHTML='<table><thead><tr><th>Direction</th><th>Type</th><th>Granted</th><th>Expires</th><th>Status</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
async function loadLedger(){
  const r=await fetch('/api/authority_ledger');const items=await r.json();
  if(!items.length){document.getElementById('ledger-content').innerHTML='<p class="empty">No authority ledger events yet.</p>';return;}
  const rows=items.slice(0,50).map(function(e){var ts=e.timestamp?e.timestamp.replace('T',' ').slice(0,19):'';return '<tr><td>'+ts+'</td><td>'+badge(e.event_type==='validated'?'badge-ok':e.event_type==='denied'?'badge-deny':'badge-warn',e.event_type)+'</td><td style="font-size:11px">'+e.principal_id.slice(0,12)+'&hellip;</td><td>'+(e.decision||'')+'</td><td style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+(e.denial_reason||'')+'">'+(e.denial_reason||'')+'</td><td style="font-size:11px">'+(e.requested_action||'')+'</td><td style="font-size:11px">'+(e.requested_resource||'')+'</td></tr>';}).join('');
  document.getElementById('ledger-content').innerHTML='<table><thead><tr><th>Timestamp</th><th>Event</th><th>Principal</th><th>Decision</th><th>Denial Reason</th><th>Action</th><th>Resource</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
async function loadUsageLedger(){
  try{const r=await fetch('/api/ledger');const items=await r.json();
  if(!items.length){document.getElementById('usage-ledger-content').innerHTML='<p class="empty">No usage ledger events yet.</p>';return;}
  const rows=items.slice(0,50).map(function(e){return '<tr><td style="font-size:11px">'+(e.timestamp||'')+'</td><td>'+(e.event_type||'')+'</td><td style="font-size:11px">'+(e.principal_id?e.principal_id.slice(0,12)+'&hellip;':'')+'</td><td>'+(e.amount||'')+'</td><td style="font-size:11px">'+(e.resource||'')+'</td><td style="font-size:11px">'+(e.correlation_id||'')+'</td></tr>';}).join('');
  document.getElementById('usage-ledger-content').innerHTML='<table><thead><tr><th>Timestamp</th><th>Event Type</th><th>Principal</th><th>Amount</th><th>Resource</th><th>Correlation</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }catch(ex){document.getElementById('usage-ledger-content').innerHTML='<p class="empty">No usage ledger data.</p>';}}
async function loadAudit(){
  var corrId=document.getElementById('audit-corr')?document.getElementById('audit-corr').value:'';
  var url='/api/audit'+(corrId?'?correlation_id='+encodeURIComponent(corrId):'');
  try{const r=await fetch(url);const items=await r.json();
  if(!items.length){document.getElementById('audit-content').innerHTML='<p class="empty">No audit log entries.</p>';return;}
  const rows=items.slice(0,50).map(function(e){return '<tr><td style="font-size:11px">'+(e.event_timestamp||'')+'</td><td>'+(e.event_type||'')+'</td><td style="font-size:11px">'+(e.principal_id?e.principal_id.slice(0,12)+'&hellip;':'')+'</td><td style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+(e.correlation_id||'')+'">'+(e.correlation_id||'')+'</td></tr>';}).join('');
  document.getElementById('audit-content').innerHTML='<table><thead><tr><th>Timestamp</th><th>Event Type</th><th>Principal</th><th>Correlation ID</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }catch(ex){document.getElementById('audit-content').innerHTML='<p class="empty">No audit data available.</p>';}}
async function loadTraces(){
  var corrId=document.getElementById('trace-corr')?document.getElementById('trace-corr').value:'';
  var url='/api/traces'+(corrId?'?correlation_id='+encodeURIComponent(corrId):'');
  const r=await fetch(url);const evts=await r.json();
  if(!evts.length){document.getElementById('traces-content').innerHTML='<p class="empty">No trace events yet.</p>';return;}
  const rows=evts.slice(-50).reverse().map(function(e){var cls=e.result_type==='allowed'?'badge-ok':e.result_type==='enforcement_deny'?'badge-deny':e.result_type==='provider_error'?'badge-err':'badge-warn';return '<tr><td>'+(e.timestamp||'')+'</td><td>'+(e.run_id?e.run_id.slice(0,8):'')+'</td><td>'+(e.principal_kind||'')+'</td><td>'+(e.tool_id||'')+'</td><td>'+badge(cls,e.result_type||'')+'</td><td>'+(e.lifecycle_event||'')+'</td><td>'+(e.latency_ms?e.latency_ms.toFixed(1)+'ms':'')+'</td><td style="font-size:11px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+(e.detail||'')+'">'+(e.detail||'')+'</td></tr>';}).join('');
  document.getElementById('traces-content').innerHTML='<table><thead><tr><th>Time</th><th>Run</th><th>Kind</th><th>Tool</th><th>Result</th><th>Event</th><th>Latency</th><th>Detail</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
loadPreflight();loadPrincipals();loadTools();loadMandates();loadDelegation();loadLedger();loadUsageLedger();loadAudit();loadTraces();
</script>
</body>
</html>"""


app = build_app()
