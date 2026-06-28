# Courier Context

Courier is a terminal-native coordination layer for Herdr-managed AI agent sessions.

## Domain vocabulary

- **Commander** — an agent that delegates work and receives Courier completion notifications.
- **Worker** — an agent that receives a Courier request and reports back by running `courier complete`.
- **Watch** — a one-shot registration that says a watcher should receive the next completion from a watched target.
- **Completion** — an explicit worker report submitted through Courier, not inferred from agent idleness.
- **Delivery** — a queued notification from Courier to a watcher agent.
- **Delivery pump** — the module that serializes and submits queued deliveries to a watcher.
- **Agent placement** — the policy that decides whether a new agent opens in a split, a shared worker tab, or a discrete tab.
- **Prompt contract** — the generated Courier instructions injected into agent sessions.
- **Courier runtime** — the module that coordinates Herdr, durable state, placement, prompts, watches, completions, and deliveries.
- **Herdr adapter** — the module that translates Courier operations into Herdr CLI calls.
- **Courier store** — the module that owns `.courier/` state, prompt files, delivery files, and locks.
