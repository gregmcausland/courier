# Courier Context

Courier is an agent-agnostic messaging layer over Herdr-managed AI agent panes. Any pane can address any other; panes are homogeneous, with no built-in commander/worker roles.

## Domain vocabulary

- **Pane** — a Herdr terminal running an agent (or a plain shell). The unit Courier addresses and the unit of serialization: a pane holds at most one open request at a time.
- **Request** — a one-shot handoff: arm a watch back to the calling pane, then inject a task plus a reply trailer into a target pane.
- **Respond** — an explicit reply submitted through Courier, consuming the watch. Not inferred from agent idleness.
- **Watch** — a one-shot registration that says the calling pane should receive the next reply from a target pane.
- **Reply trailer** — the Courier instructions appended to a request payload; the single place Courier-awareness is injected, so any pane can participate without a special startup prompt.
- **Persona** — an opt-in, durable specialization (e.g. `triage`) attached at launch via the agent's system prompt. Describes domain behavior only; carries no Courier commands.
- **Delivery** — a queued reply from Courier to a watcher pane.
- **Delivery pump** — the module that serializes and idle-gates queued deliveries to a watcher.
- **Serial-pane invariant** — one open request per pane; fan out across panes, not within one. This keeps replies unambiguous without correlation ids.
- **Agent placement** — the policy that decides whether a new pane opens in a split or a discrete tab.
- **Courier runtime** — the module that coordinates Herdr, durable state, placement, requests, responses, and deliveries.
- **Herdr adapter** — the module that translates Courier operations into Herdr CLI calls.
- **Courier store** — the module that owns `.courier/` state, persona files, delivery files, and locks.
