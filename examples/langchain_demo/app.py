"""FastAPI app for the Caracal-backed LangChain demo."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

from .baseline.scenario import load_scenario
from .caracal.workflow import GovernedRunConfig
from .demo_runtime import run_demo_workflow_async


class DemoRunRequest(BaseModel):
    mode: str = Field(default="mock", pattern="^(mock|real)$")
    provider_strategy: str = Field(default="mixed", pattern="^(mixed|openai|gemini)$")
    include_revocation_check: bool = True


UI_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Caracal Demo App</title>
  <style>
    :root {
      --bg: #f5efe3;
      --panel: rgba(255, 252, 246, 0.86);
      --panel-strong: #fffaf0;
      --ink: #1e1b18;
      --muted: #655d52;
      --accent: #a34722;
      --accent-soft: #f0d8c8;
      --good: #1d6b4f;
      --warn: #a36213;
      --line: rgba(74, 55, 35, 0.14);
      --shadow: 0 20px 60px rgba(77, 50, 22, 0.12);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(255,255,255,0.75), transparent 28%),
        radial-gradient(circle at bottom right, rgba(163,71,34,0.12), transparent 20%),
        linear-gradient(180deg, #efe2cf 0%, #f7f2e9 100%);
      min-height: 100vh;
    }

    .shell {
      max-width: 1280px;
      margin: 0 auto;
      padding: 24px;
    }

    .hero {
      padding: 28px;
      border: 1px solid var(--line);
      border-radius: 28px;
      background: var(--panel);
      box-shadow: var(--shadow);
      backdrop-filter: blur(10px);
    }

    .eyebrow {
      text-transform: uppercase;
      letter-spacing: 0.18em;
      font-size: 12px;
      color: var(--accent);
      margin-bottom: 10px;
    }

    h1 {
      margin: 0 0 12px;
      font-size: clamp(2rem, 5vw, 4rem);
      line-height: 0.95;
    }

    .subhead {
      max-width: 860px;
      color: var(--muted);
      font-size: 1.05rem;
      line-height: 1.5;
    }

    .grid {
      display: grid;
      grid-template-columns: 340px minmax(0, 1fr);
      gap: 18px;
      margin-top: 18px;
    }

    .panel {
      border: 1px solid var(--line);
      border-radius: 24px;
      background: var(--panel);
      padding: 20px;
      box-shadow: var(--shadow);
    }

    .panel h2, .panel h3 {
      margin: 0 0 12px;
      font-size: 1rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
    }

    label {
      display: block;
      font-size: 0.9rem;
      color: var(--muted);
      margin-bottom: 8px;
    }

    select, button {
      width: 100%;
      border-radius: 14px;
      border: 1px solid var(--line);
      padding: 12px 14px;
      font: inherit;
      background: var(--panel-strong);
      color: var(--ink);
      margin-bottom: 12px;
    }

    button {
      background: linear-gradient(135deg, #9f4523, #c96b39);
      color: #fff;
      border: none;
      cursor: pointer;
      font-weight: 700;
      transition: transform 160ms ease, box-shadow 160ms ease;
    }

    button:hover { transform: translateY(-1px); box-shadow: 0 10px 20px rgba(159,69,35,0.22); }
    button:disabled { opacity: 0.6; cursor: wait; transform: none; }

    .checkbox {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 8px 0 16px;
      color: var(--muted);
    }

    .checkbox input { width: auto; margin: 0; }

    .status {
      min-height: 22px;
      color: var(--accent);
      font-size: 0.92rem;
    }

    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }

    .card {
      background: var(--panel-strong);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 14px;
      animation: rise 260ms ease;
    }

    .card .k {
      display: block;
      color: var(--muted);
      font-size: 0.82rem;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .card .v {
      font-size: 1.1rem;
      line-height: 1.35;
    }

    .section {
      margin-top: 16px;
      border-top: 1px solid var(--line);
      padding-top: 16px;
    }

    .table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.93rem;
    }

    .table th, .table td {
      text-align: left;
      padding: 10px 8px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }

    .table th {
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 0.78rem;
    }

    .pill {
      display: inline-block;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 0.78rem;
      font-weight: 700;
      background: var(--accent-soft);
      color: var(--accent);
    }

    .pill.good { background: rgba(29,107,79,0.12); color: var(--good); }
    .pill.warn { background: rgba(163,98,19,0.12); color: var(--warn); }

    pre {
      margin: 0;
      padding: 14px;
      overflow: auto;
      border-radius: 18px;
      background: #1d1a17;
      color: #f8f1e7;
      font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 0.83rem;
      line-height: 1.45;
    }

    .empty {
      color: var(--muted);
      padding: 24px 4px;
    }

    @keyframes rise {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @media (max-width: 980px) {
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="eyebrow">Caracal Demo App</div>
      <h1>Authority, provider routing, delegation, and enforcement in one local run.</h1>
      <p class="subhead">
        This app runs a realistic AI employee workflow through a real Caracal MCP service path.
        In mock mode, upstream providers are simulated but Caracal is still live. In real mode,
        the same governed workflow calls actual providers if your keys are set.
      </p>
    </section>

    <div class="grid">
      <aside class="panel">
        <h2>Run Controls</h2>
        <label for="mode">Execution mode</label>
        <select id="mode">
          <option value="mock">Mock mode</option>
          <option value="real">Real mode</option>
        </select>

        <label for="strategy">Provider mapping</label>
        <select id="strategy">
          <option value="mixed">Mixed (finance OpenAI, ops Gemini)</option>
          <option value="openai">OpenAI only</option>
          <option value="gemini">Gemini only</option>
        </select>

        <label class="checkbox">
          <input id="revocation" type="checkbox" checked />
          <span>Run the revocation check</span>
        </label>

        <button id="run">Run governed workflow</button>
        <div class="status" id="status"></div>

        <div class="section">
          <h3>What To Watch</h3>
          <div class="empty">
            Look for per-role identity, delegated mandates, provider-specific tool routing,
            local logic execution, and the denied post-revocation finance call.
          </div>
        </div>
      </aside>

      <main class="panel">
        <h2>Run Output</h2>
        <div id="result">
          <div class="empty">Run the demo to inspect the workflow.</div>
        </div>
      </main>
    </div>
  </div>

  <script>
    const statusEl = document.getElementById("status");
    const resultEl = document.getElementById("result");
    const runBtn = document.getElementById("run");

    function esc(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }

    function renderCards(result) {
      const acceptance = result.acceptance?.passed ? "Accepted" : "Review needed";
      const revocation = result.revocation?.denial_captured ? "Denied after revoke" : "No denial recorded";
      return `
        <div class="cards">
          <div class="card"><span class="k">Mode</span><div class="v">${esc(result.mode)}</div></div>
          <div class="card"><span class="k">Provider strategy</span><div class="v">${esc(result.provider_strategy)}</div></div>
          <div class="card"><span class="k">Acceptance</span><div class="v">${esc(acceptance)}</div></div>
          <div class="card"><span class="k">Revocation</span><div class="v">${esc(revocation)}</div></div>
        </div>
      `;
    }

    function renderIdentities(result) {
      const rows = (result.identities || []).map((entry) => `
        <tr>
          <td>${esc(entry.role)}</td>
          <td>${esc(entry.principal_id)}</td>
          <td>${esc(entry.mandate_id)}</td>
          <td>${esc(entry.access_token)}</td>
        </tr>
      `).join("");
      return `
        <div class="section">
          <h3>Identity And Delegation</h3>
          <table class="table">
            <thead><tr><th>Role</th><th>Principal</th><th>Mandate</th><th>Token</th></tr></thead>
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
        <div class="section">
          <h3>Timeline</h3>
          <table class="table">
            <thead><tr><th>Step</th><th>Role</th><th>Tool / Event</th><th>Route</th><th>Output excerpt</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }

    function renderAuthority(result) {
      const rows = (result.authority_validations || []).map((entry) => `
        <tr>
          <td>${esc(entry.caller_principal_id)}</td>
          <td>${esc(entry.requested_resource)}</td>
          <td>${esc(entry.requested_action)}</td>
          <td><span class="pill ${entry.allowed ? "good" : "warn"}">${esc(entry.allowed ? "allowed" : "denied")}</span></td>
          <td>${esc(entry.reason)}</td>
        </tr>
      `).join("");
      return `
        <div class="section">
          <h3>Authority Checks</h3>
          <table class="table">
            <thead><tr><th>Caller</th><th>Resource</th><th>Action</th><th>Decision</th><th>Reason</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }

    function renderJson(result) {
      return `
        <div class="section">
          <h3>Raw Artifact</h3>
          <pre>${esc(JSON.stringify(result, null, 2))}</pre>
        </div>
      `;
    }

    function renderResult(result) {
      resultEl.innerHTML =
        renderCards(result) +
        `<div class="section"><h3>Executive Summary</h3><div class="empty">${esc(result.final_summary)}</div></div>` +
        renderIdentities(result) +
        renderTimeline(result) +
        renderAuthority(result) +
        renderJson(result);
    }

    async function runDemo() {
      runBtn.disabled = true;
      statusEl.textContent = "Running the governed workflow...";
      try {
        const response = await fetch("/api/run", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            mode: document.getElementById("mode").value,
            provider_strategy: document.getElementById("strategy").value,
            include_revocation_check: document.getElementById("revocation").checked,
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.detail || "Request failed");
        }
        statusEl.textContent = "Workflow complete.";
        renderResult(payload);
      } catch (error) {
        statusEl.textContent = error.message || String(error);
      } finally {
        runBtn.disabled = false;
      }
    }

    runBtn.addEventListener("click", runDemo);
  </script>
</body>
</html>
"""


def create_app() -> FastAPI:
    app = FastAPI(title="Caracal Demo App")
    app.state.run_lock = __import__("asyncio").Lock()

    @app.get("/", response_class=HTMLResponse)
    async def index() -> str:
        return UI_HTML

    @app.get("/api/scenario")
    async def scenario() -> JSONResponse:
        return JSONResponse(load_scenario())

    @app.post("/api/run")
    async def run_demo(request: DemoRunRequest) -> JSONResponse:
        async with app.state.run_lock:
            result = await run_demo_workflow_async(
                load_scenario(),
                GovernedRunConfig(
                    mode=request.mode,
                    provider_strategy=request.provider_strategy,
                    include_revocation_check=request.include_revocation_check,
                ),
            )
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
        import asyncio

        result = asyncio.run(
            run_demo_workflow_async(
                load_scenario(),
                GovernedRunConfig(
                    mode=args.mode,
                    provider_strategy=args.provider_strategy,
                    include_revocation_check=True,
                ),
            )
        )
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
