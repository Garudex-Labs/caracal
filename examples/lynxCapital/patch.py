import re

with open("app/web/static/demo.css", "r") as f:
    css = f.read()

start = css.find(".plan-step-state {")
end = css.find(".chat-stream-shell {")

new_css = """\
.plan-step-state {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted, #ccc);
}

.plan-step-text {
  font-size: 13px;
  line-height: 1.45;
  color: var(--text);
}

.plan-item.status-running {
  border-color: rgba(30, 91, 216, 0.4);
  background: rgba(232, 240, 255, 0.3);
}

.plan-item.status-running .plan-step-state {
  background: var(--accent);
  box-shadow: 0 0 0 2px rgba(30, 91, 216, 0.2);
}

.plan-item.status-completed {
  border-color: rgba(26, 127, 75, 0.15);
  background: transparent;
}

.plan-item.status-completed .plan-step-state {
  background: var(--success);
}

.plan-item.status-completed .plan-step-text {
  color: rgba(26, 31, 46, 0.56);
  text-decoration: line-through;
}

.plan-item.status-failed {
  border-color: rgba(155, 28, 15, 0.2);
  background: rgba(253, 235, 232, 0.3);
}

.plan-item.status-failed .plan-step-state {
  background: var(--danger);
}

"""

patched = css[:start] + new_css + css[end:]
with open("app/web/static/demo.css", "w") as f:
    f.write(patched)

print("Patched demo.css")
