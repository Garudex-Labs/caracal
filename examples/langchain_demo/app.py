"""FastAPI app for the Caracal-backed LangChain demo."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

from .baseline.scenario import load_scenario
from .demo_runtime import DemoRunConfig, run_demo_workflow_async
from .mock_services import router as mock_router
from .runtime_config import config_status


class DemoRunRequest(BaseModel):
    mode: str = "mock"
    provider_strategy: str = "mixed"
UI_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Caracal Demo App</title>
  <style>
    :root {
      --bg: #f6f7f8;
      --surface: #ffffff;
      --fg: #0f1720;
      --muted: #6b7280;
      --accent: #0b61ff;
      --good: #059669;
      --warn: #b45309;
      --border: #e6e9ef;
      --radius: 4px;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, "Roboto Mono", monospace;
      --ui-font: Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial;
    }

    * { box-sizing: border-box; }
    html,body { height: 100%; }
    body {
      margin: 0;
      font-family: var(--ui-font);
      color: var(--fg);
      background: var(--bg);
      -webkit-font-smoothing:antialiased;
      -moz-osx-font-smoothing:grayscale;
    }

    .container {
      max-width: 1100px;
      margin: 28px auto;
      padding: 18px;
    }

    /* Pre-demo centered entry */
    .pre-demo {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 60vh;
    }

    .pre-card {
      width: 680px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px 24px;
    }

    .pre-card h1 {
      margin: 0 0 8px;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.01em;
    }

    .muted { color: var(--muted); font-size: 14px; line-height:1.45; }

    .pre-list { margin: 12px 0 18px; padding-left: 18px; color: var(--muted); }

    .pre-actions { display:flex; gap:12px; align-items:center; margin-top:12px; }

    .btn {
      display:inline-block;
      padding:8px 12px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: transparent;
      font-weight: 600;
      cursor: pointer;
    }

    .btn[disabled] { opacity: 0.6; cursor: not-allowed; }

    .btn-primary { background: var(--accent); color: #fff; border-color: transparent; }

    /* Main layout */
    .main-grid { display: grid; grid-template-columns: 320px 1fr; gap: 18px; margin-top: 18px; }

    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px;
    }

    .controls h2 { margin: 0 0 10px; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing:0.06em; }

    .group { margin-bottom: 12px; }

    label { display:block; font-size:13px; color:var(--muted); margin-bottom:6px; }

    select, input[type="checkbox"], input[type="text"] { font: inherit; }

    select, .control-input {
      width:100%; padding:8px 10px; border:1px solid var(--border); border-radius:var(--radius); background:transparent; font-size:13px; color:var(--fg);
    }

    .checkbox-row { display:flex; align-items:center; gap:10px; color:var(--muted); }

    .primary-row { margin-top: 8px; display:flex; gap:10px; align-items:center; }

    .status { display:flex; align-items:center; gap:10px; font-size:13px; color:var(--muted); }
    .dot { width:10px; height:10px; border-radius:2px; background:#9ca3af; display:inline-block; }
    .dot.running { background: #f59e0b; }
    .dot.success { background: var(--good); }
    .dot.error { background: #ef4444; }

    /* Minimal rows for key/value summary */
    .cards { display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }
    .card { display:flex; justify-content:space-between; padding:8px 6px; border-bottom:1px solid var(--border); }
    .card .k { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:0.06em; }
    .card .v { font-weight:600; }

    /* Tables kept but simplified */
    .table { width:100%; border-collapse:collapse; font-size:13px; }
    .table th, .table td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--border); }
    .table th { color:var(--muted); font-size:12px; text-transform:uppercase; }

    .pill { display:inline-block; padding:3px 8px; border-radius:6px; font-size:12px; font-weight:700; color:var(--fg); background:transparent; border:1px solid var(--border); }
    .pill.good { color:var(--good); border-color: rgba(5,150,105,0.08); }
    .pill.warn { color:var(--warn); border-color: rgba(180,83,9,0.08); }

    /* Output console */
    .output { background:#0b0f14; color:#e6eefb; padding:12px; border-radius:var(--radius); font-family:var(--mono); font-size:13px; min-height:360px; overflow:auto; }

    pre { margin:0; font-family:var(--mono); font-size:13px; line-height:1.45; }

    .empty { color:var(--muted); padding:18px 4px; }

    @media (max-width: 900px) { .main-grid { grid-template-columns: 1fr; } .pre-card{width:92vw;} }
  </style>
</head>
<body>
  <div class="container">
    <!-- Pre-demo entry -->
    <div id="pre-demo" class="pre-demo">
      <div class="pre-card" role="dialog" aria-labelledby="pre-title">
        <h1 id="pre-title">Caracal Demo — Local Governance Showcase</h1>
        <p class="muted">A compact demo that walks through authority, provider routing, and enforcement. You will see a step-by-step execution trace, provider routing decisions, and authority enforcement outcomes.</p>

        <ul class="pre-list">
          <li><strong>Authority</strong>: who can request actions, enforced by Caracal via Bearer token identity.</li>
          <li><strong>Provider routing</strong>: which provider (mock or real) handles a tool call.</li>
          <li><strong>Enforcement</strong>: authority decisions are visible through tool call success or failure.</li>
        </ul>

        <div style="display:flex;align-items:center;gap:12px;">
          <label style="display:flex;gap:8px;align-items:center;">
            <input id="accept-demo" type="checkbox" />
            <span class="muted">I understand this is a demo environment</span>
          </label>
        </div>

        <div class="pre-actions">
          <button id="enter-demo" class="btn btn-primary" disabled>Enter Demo</button>
        </div>
      </div>
    </div>

    <!-- Main app (hidden until entry) -->
    <div id="main-app" style="display:none;">
      <header style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:8px;">
        <div>
          <div style="color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:0.08em;">Caracal Demo</div>
          <h1 style="margin:6px 0 0;font-size:18px;font-weight:700;">Authority, provider routing, delegation, enforcement</h1>
          <div class="muted" style="margin-top:8px;">Run the demo to see a trace of the governed workflow and its enforcement decisions.</div>
        </div>
        <div style="text-align:right;color:var(--muted);font-size:12px;">Developer-focused demo • Local only</div>
      </header>

      <div class="main-grid">
        <aside class="panel controls">
          <h2>Run Controls</h2>

          <div class="group">
            <label for="mode">Execution</label>
            <select id="mode" class="control-input">
              <option value="mock">Mock mode</option>
              <option value="real">Real mode</option>
            </select>
          </div>

          <div class="group">
            <label for="strategy">Providers</label>
            <select id="strategy" class="control-input">
              <option value="mixed">Mixed (finance OpenAI, ops Gemini)</option>
              <option value="openai">OpenAI only</option>
              <option value="gemini">Gemini only</option>
            </select>
          </div>

          <div class="primary-row">
            <button id="run" class="btn btn-primary" style="flex:1;">Run workflow</button>
          </div>

          <div style="margin-top:12px; display:flex;align-items:center;justify-content:space-between;">
            <div class="status"><span id="status-dot" class="dot"></span><span id="status">Idle</span></div>
            <div style="font-size:12px;color:var(--muted);">&nbsp;</div>
          </div>

          <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px;">
            <h3 style="margin:0 0 10px;font-size:12px;color:var(--muted);text-transform:uppercase;">Setup Status</h3>
            <div id="setup-status" class="muted">Not checked yet.</div>
          </div>

          <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px;">
            <h3 style="margin:0 0 10px;font-size:12px;color:var(--muted);text-transform:uppercase;">What to watch</h3>
            <div class="muted">Per-role identity, provider routing, authority enforcement, and execution trace.</div>
          </div>
        </aside>

        <main class="panel">
          <h2 style="margin:0 0 10px;font-size:13px;color:var(--muted);text-transform:uppercase;">Run Output</h2>
          <div id="result" class="output">
            <div class="empty">Run the demo to see the execution flow and logs here.</div>
          </div>
        </main>
      </div>
    </div>
  </div>

  <script>
    const statusEl = document.getElementById("status");
    const statusDot = document.getElementById("status-dot");
    const resultEl = document.getElementById("result");
    const runBtn = document.getElementById("run");
    const setupStatusEl = document.getElementById("setup-status");

    const preDemo = document.getElementById("pre-demo");
    const mainApp = document.getElementById("main-app");
    const acceptBox = document.getElementById("accept-demo");
    const enterBtn = document.getElementById("enter-demo");

    function esc(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }

    function setStatus(state, text) {
      if (statusDot) {
        statusDot.className = 'dot ' + (state || '');
      }
      if (statusEl) {
        statusEl.textContent = text || '';
      }
    }

    function renderCards(result) {
      const acceptance = result.acceptance?.passed ? "Accepted" : "Review needed";
      const decisions = (result.authority_decisions || []).length;
      const denied = (result.authority_decisions || []).filter(d => !d.allowed).length;
      return `
        <div class="cards">
          <div class="card"><span class="k">Mode</span><span class="v">${esc(result.mode)}</span></div>
          <div class="card"><span class="k">Provider</span><span class="v">${esc(result.provider_strategy)}</span></div>
          <div class="card"><span class="k">Acceptance</span><span class="v">${esc(acceptance)}</span></div>
          <div class="card"><span class="k">Authority</span><span class="v">${decisions} checks, ${denied} denied</span></div>
        </div>
      `;
    }

    function renderIdentities(result) {
      const rows = (result.identities || []).map((entry) => `
        <tr>
          <td>${esc(entry.role)}</td>
          <td>${esc(entry.principal_id)}</td>
        </tr>
      `).join("");
      return `
        <div style="margin-top:12px;">
          <h3 style="margin:0 0 8px;font-size:13px;color:var(--muted);text-transform:uppercase;">Identity</h3>
          <table class="table">
            <thead><tr><th>Role</th><th>Principal</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }

    function renderTimeline(result) {
      const rows = (result.timeline || []).map((step) => `
        <tr>
          <td>${esc(step.step)}</td>
          <td>${esc(step.role || step.event)}</td>
          <td>${esc(step.tool_id || step.event || "")}</td>
          <td><span class="pill">${esc(step.provider_name || step.execution_mode || "event")}</span></td>
          <td>${esc((step.output && JSON.stringify(step.output).slice(0, 200)) || (step.denial_evidence && JSON.stringify(step.denial_evidence).slice(0, 200)) || "")}</td>
        </tr>
      `).join("");
      return `
        <div style="margin-top:12px;">
          <h3 style="margin:0 0 8px;font-size:13px;color:var(--muted);text-transform:uppercase;">Timeline</h3>
          <table class="table">
            <thead><tr><th>Step</th><th>Role</th><th>Tool / Event</th><th>Route</th><th>Output excerpt</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }

    function renderAuthority(result) {
      const rows = (result.authority_decisions || []).map((entry) => `
        <tr>
          <td>${esc(entry.role)}</td>
          <td>${esc(entry.resource_scope)}</td>
          <td>${esc(entry.action_scope)}</td>
          <td><span class="pill ${entry.allowed ? "good" : "warn"}">${esc(entry.allowed ? "allowed" : "denied")}</span></td>
          <td>${esc(entry.reason)}</td>
        </tr>
      `).join("");
      return `
        <div style="margin-top:12px;">
          <h3 style="margin:0 0 8px;font-size:13px;color:var(--muted);text-transform:uppercase;">Authority Decisions</h3>
          <table class="table">
            <thead><tr><th>Role</th><th>Resource</th><th>Action</th><th>Decision</th><th>Reason</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }

    function renderProviderUsage(result) {
      const rows = (result.provider_usage || []).map((entry) => `
        <tr>
          <td>${esc(entry.provider_name)}</td>
          <td>${esc(entry.call_count)}</td>
        </tr>
      `).join("");
      return `
        <div style="margin-top:12px;">
          <h3 style="margin:0 0 8px;font-size:13px;color:var(--muted);text-transform:uppercase;">Provider Usage</h3>
          <table class="table">
            <thead><tr><th>Provider</th><th>Calls</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }

    function renderJson(result) {
      return `
        <div style="margin-top:12px;">
          <h3 style="margin:0 0 8px;font-size:13px;color:var(--muted);text-transform:uppercase;">Raw Artifact</h3>
          <pre>${esc(JSON.stringify(result, null, 2))}</pre>
        </div>
      `;
    }

    function renderResult(result) {
      resultEl.innerHTML = '';
      resultEl.innerHTML += renderCards(result);
      resultEl.innerHTML += `<div style="margin-top:12px;"><h3 style=\"margin:0 0 8px;font-size:13px;color:var(--muted);text-transform:uppercase;\">Executive Summary</h3><div class=\"muted\">${esc(result.final_summary)}</div></div>`;
      resultEl.innerHTML += renderIdentities(result);
      resultEl.innerHTML += renderTimeline(result);
      resultEl.innerHTML += renderAuthority(result);
      resultEl.innerHTML += renderProviderUsage(result);
      resultEl.innerHTML += renderJson(result);
    }

    async function loadSetupStatus() {
      try {
        const response = await fetch("/api/config/status");
        const payload = await response.json();
        if (payload.configured) {
          setupStatusEl.textContent = `Configured: ${payload.config_path}`;
          setupStatusEl.style.color = "var(--good)";
        } else {
          setupStatusEl.textContent = payload.message || "Configuration is incomplete.";
          setupStatusEl.style.color = "var(--warn)";
        }
      } catch (error) {
        setupStatusEl.textContent = `Unable to read setup status: ${error.message || String(error)}`;
        setupStatusEl.style.color = "var(--warn)";
      }
    }

    async function runDemo() {
      runBtn.disabled = true;
      setStatus('running', 'Running the governed workflow...');
      try {
        const response = await fetch("/api/run", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            mode: document.getElementById("mode").value,
            provider_strategy: document.getElementById("strategy").value,
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.detail || "Request failed");
        }
        setStatus('success', 'Workflow complete.');
        renderResult(payload);
      } catch (error) {
        setStatus('error', error.message || String(error));
      } finally {
        runBtn.disabled = false;
      }
    }

    // Pre-demo interactions
    if (enterBtn && acceptBox) {
      enterBtn.disabled = true;
      acceptBox.addEventListener('change', () => { enterBtn.disabled = !acceptBox.checked; });
      enterBtn.addEventListener('click', () => {
        preDemo.style.display = 'none';
        mainApp.style.display = 'block';
        setTimeout(() => { document.getElementById('mode')?.focus(); }, 40);
        setStatus('idle', 'Idle');
        loadSetupStatus();
      });
    }

    runBtn.addEventListener("click", runDemo);
  </script>
</body>
</html>
"""
    


def create_app() -> FastAPI:
    app = FastAPI(title="Caracal Demo App")
    app.include_router(mock_router)
    app.state.run_lock = asyncio.Lock()

    @app.get("/", response_class=HTMLResponse)
    async def index() -> str:
        return UI_HTML

    @app.get("/api/scenario")
    async def scenario() -> JSONResponse:
        return JSONResponse(load_scenario())

    @app.get("/api/config/status")
    async def setup_status() -> JSONResponse:
        return JSONResponse(config_status())

    @app.post("/api/run")
    async def run_demo(request: DemoRunRequest) -> JSONResponse:
        async with app.state.run_lock:
            try:
                result = await run_demo_workflow_async(
                    load_scenario(),
                    DemoRunConfig(
                        mode=request.mode,
                        provider_strategy=request.provider_strategy,
                    ),
                )
            except Exception as exc:  # pragma: no cover - surfaced directly in UI
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        return JSONResponse(result)

    return app


app = create_app()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Serve the Caracal demo app with uvicorn")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8090, type=int)
    parser.add_argument(
        "--output",
        default=None,
        help="Optional path. When set together with --run-once, write one artifact and exit.",
    )
    parser.add_argument("--run-once", action="store_true", help="Execute one run and exit instead of serving UI")
    parser.add_argument("--mode", default="mock", choices=["mock", "real"])
    parser.add_argument("--provider-strategy", default="mixed", choices=["mixed", "openai", "gemini"])
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.run_once:
        try:
            result = asyncio.run(
                run_demo_workflow_async(
                    load_scenario(),
                    DemoRunConfig(
                        mode=args.mode,
                        provider_strategy=args.provider_strategy,
                    ),
                )
            )
        except Exception as exc:
            print(f"Run failed: {exc}")
            return 1

        if args.output:
            output_path = Path(args.output)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result, indent=2))
        return 0

    import uvicorn

    uvicorn.run("examples.langchain_demo.app:app", host=args.host, port=args.port, reload=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
