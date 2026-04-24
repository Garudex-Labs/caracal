import re

with open("app/web/static/demo.css", "r") as f:
    css = f.read()

start_idx = css.find(".message-row {")
end_idx = css.find(".event-main {")

if start_idx == -1 or end_idx == -1:
    print("Could not find boundaries")
else:
    new_css = """\
.message-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: 12px;
  margin-bottom: 12px;
}

.message-row:last-child {
  padding-bottom: 0;
  margin-bottom: 0;
}

.message-row-user {
  align-items: flex-start;
}

.message-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgba(26, 31, 46, 0.6);
}

.message-time {
  opacity: 0.7;
}

.message-bubble {
  max-width: 100%;
  padding: 0;
  border-radius: 0;
  background: transparent;
  color: var(--primary);
  box-shadow: none;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14px;
  line-height: 1.6;
  text-align: left;
}

.message-row-agent {
  align-items: stretch;
}

.message-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0;
  border-radius: 0;
  border: none;
  background: transparent;
  box-shadow: none;
}

.message-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 2px;
}

.message-ident {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.message-heading {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.message-heading .message-author {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--primary);
}

.message-heading .message-time {
  font-size: 11px;
  color: rgba(26, 31, 46, 0.42);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.message-subtitle {
  font-size: 10px;
  color: rgba(26, 31, 46, 0.5);
}

.message-head-meta {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.message-status-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.message-status-pill.state-thinking {
  background: rgba(41, 69, 108, 0.05);
  color: rgba(41, 69, 108, 0.7);
}

.message-status-pill.state-executing {
  background: rgba(138, 88, 0, 0.05);
  color: rgba(138, 88, 0, 0.8);
}

.message-status-pill.state-ready {
  background: rgba(26, 127, 75, 0.05);
  color: rgba(26, 127, 75, 0.8);
}

.message-telemetry {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  color: rgba(26, 31, 46, 0.4);
}

.message-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}

.message-section[open] .section-label {
  margin-bottom: 6px;
}

.section-label {
  font-size: 11px;
  font-weight: 600;
  color: rgba(26, 31, 46, 0.6);
  cursor: pointer;
  user-select: none;
  display: inline-flex;
  width: max-content;
  align-items: center;
}

.reasoning-body {
  padding-left: 12px;
  border-left: 2px solid rgba(41, 69, 108, 0.15);
  color: rgba(26, 31, 46, 0.8);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.5;
  background: transparent;
}

.reasoning-body.is-streaming::after {
  content: " ";
  display: inline-block;
  width: 6px;
  height: 1em;
  margin-left: 4px;
  vertical-align: text-bottom;
  background: rgba(41, 69, 108, 0.4);
  animation: caret-pulse 1s step-end infinite;
}

@keyframes caret-pulse {
  0%, 100% { opacity: 0; }
  50% { opacity: 1; }
}

.execution-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 12px;
  border-left: 2px solid rgba(138, 88, 0, 0.15);
}

.event-block {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 0;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--ev-system-fg);
  font-size: 12px;
}

.event-block-stream {
  background: transparent;
  border: none;
  box-shadow: none;
}

.event-block-turn {
  padding: 0;
}

.event-marker {
  display: none;
}

"""
    patched = css[:start_idx] + new_css + css[end_idx:]
    with open("app/web/static/demo.css", "w") as f:
        f.write(patched)
    print("CSS successfully patched!")
