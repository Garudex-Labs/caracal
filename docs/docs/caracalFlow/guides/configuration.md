---
sidebar_position: 1
title: Configuration
---

# Caracal Flow Configuration

Customize the appearance and behavior of Caracal Flow.

## Configuration File

Caracal Flow reads from `~/.caracal/flow.yaml`:

```yaml
theme:
  colorScheme: dark  # or 'light'
  accentColor: '#cdfe3e'

display:
  refreshRate: 1000  # ms
  showMetrics: true

keybindings:
  quit: q
  help: '?'
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CARACAL_FLOW_THEME` | Override color scheme |
| `CARACAL_CONFIG_PATH` | Path to config directory |

## Themes

Caracal Flow supports custom themes. Place theme files in `~/.caracal/themes/`.
