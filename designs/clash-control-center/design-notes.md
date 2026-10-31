# Clash Control Center — design rationale

## Context

- The user primarily needs a reliable ChatGPT route, not a general-purpose Clash dashboard.
- Nodes come from several subscriptions, but the current interface exposes provider, group, scan, mode, quota and node concepts at the same visual level.
- The implementation must remain an Omarchy bar panel and preserve the existing compact dark visual vocabulary.

## Assumptions

- All managed subscriptions should participate in the ChatGPT availability scan.
- A passing node can be shown with its source subscription and selected into the `OPENAI` group.
- General Clash controls remain available, but are secondary to the ChatGPT workflow.

## Information architecture

1. Persistent ChatGPT route summary and primary actions.
2. Two peer views: aggregated ChatGPT-capable nodes and subscriptions.
3. Collapsed advanced network controls for group, mode, TUN and the complete node list.

## Visual system

- Reuse Omarchy's dark surfaces, low-contrast separators, compact density and monospace typography.
- Green is reserved for verified availability/current selection; amber is reserved for latency/quota risk.
- Avoid dashboard cards and decorative metrics. Every visible row is actionable or answers route state.
