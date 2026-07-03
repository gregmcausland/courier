# Courier

Courier is a small TypeScript CLI that turns Herdr-managed AI agent panes into an agent-agnostic messaging layer.

Any pane can address any other: `request` hands a task to a target pane and arms a one-shot watch back to the caller; the target replies with `respond`, and Courier routes the reply back through a safe, serialized delivery queue. Courier-awareness rides along with each request as an injected reply trailer, so panes need no special startup prompt to participate.

## Status

Exploratory. Built for local experimentation with [Herdr](https://github.com/) and terminal-native agents.

Panes are homogeneous — there are no commander/worker roles. Any pane can create panes, request work, and respond. An optional **persona** (`--type`) can specialize an agent's behavior, but that is a convenience, not a requirement of the mechanism.

Supported agent launchers:

- `pi` — default
- `claude` — Claude Code live session with `--dangerously-skip-permissions`
- `cursor` — Cursor Agent bootstrap prompt

## Install

Build and put `courier` on your PATH (user-scoped, no sudo):

```bash
./install.sh
```

This installs a symlink named `courier` (in `~/.local/bin`, or `$COURIER_BIN_DIR`) pointing at the compiled CLI, so a later `npm run build` transparently updates the installed command. When invoked as the global `courier`, request trailers render `courier respond …` rather than the local `node <path>` form.

It also links the human-invoked **courier skill** (see below) into `~/.agents/skills` (read by pi and cursor-agent) and `~/.claude/skills` (read by Claude Code). Set `COURIER_NO_SKILL=1` to skip.

## Entrypoint

The two ways an agent becomes Courier-aware are deliberately asymmetric:

- **Caller** (the pane you drive) → the **courier skill**, human-invoked only. Type `/courier` (Claude Code, cursor-agent) or `/skill:courier` (pi) and the pane loads the full command surface. The skill ships `disable-model-invocation: true`, so it is hidden from the model's auto-discovery — an agent never wanders into Courier on its own, and never spends context on it unless you ask. This is a cross-harness [Agent Skills](https://agentskills.io) standard, so one `skills/courier/SKILL.md` serves all three launchers.
- **Callee** (a pane you hand work to) → nothing but the **reply trailer's one line**. A target only ever learns `courier respond --message "…"`, delivered with the task. It can't drift into `create`/`request`/`watch` because it was never told they exist. Least-privilege by construction.

Or build and run locally without installing:

```bash
npm install
npm run build
node dist/cli.js --help
```

## Commands

```text
courier create <NAME> [--type triage] [--agent COMMAND] [--from PANE_OR_TERMINAL_ID] [--tab] [--cwd PATH] [--focus|--no-focus]
courier commander [NAME] [--agent COMMAND] [--from PANE_OR_TERMINAL_ID] [--tab] [--cwd PATH] [--focus|--no-focus]
courier request <TARGET_NAME_OR_ID> --text TEXT [--submit-delay-ms 750] [--poll-ms 1000] [--await [--await-timeout-ms 0] [--await-poll-ms 500]]
courier respond [TARGET_NAME_OR_ID] --message TEXT   (target defaults to the calling pane)
courier inject <TARGET_NAME_OR_ID> --text TEXT [--submit-delay-ms 750] [--poll-ms 1000]
courier watch <TARGET_NAME_OR_ID> [--watcher NAME_OR_ID]
courier deliver <NAME_OR_PANE_OR_TERMINAL_ID>
courier close <NAME_OR_PANE_OR_TERMINAL_ID>
courier suspend <NAME_OR_PANE_OR_TERMINAL_ID>
```

- **`request`** = arm a one-shot watch back to the calling pane, then inject `TEXT` plus a reply trailer telling the target how to answer. The normal way to hand off work. Async by default: the reply arrives later as an injected `[courier respond]` notification.
- **`request --await`** = the same handoff, but **blocks** until the reply lands and prints it to stdout. For headless loop drivers (run it in its own driver pane; abort by closing the pane). Waits indefinitely unless `--await-timeout-ms` is set. See _Loops_ below.
- **`respond`** = deliver a reply back to whoever is watching the calling pane (defaults to self; injected by the trailer so agents run it verbatim).
- **`inject`** / **`watch`** = the lower-level primitives `request` is built from — a raw send with no watch/trailer, and a standalone watch registration.

## Basic flow

Spin up an agent to work with (`commander` is just a convenience launcher for Claude Code in the current pane; there is no special role):

```bash
courier commander
```

Create a worker pane:

```bash
courier create worker-1
```

Hand it a task. `request` arms the watch and injects the task with a reply trailer in one step:

```bash
courier request worker-1 --text 'Answer: what is 2 + 2?'
```

The pane finishes by running the command from the trailer — targeting itself, no name needed:

```bash
courier respond --message '4'
```

Courier consumes the watch and delivers a structured `[courier respond]` notification back to the requester.

### One pane, one open request

A pane holds at most one open request at a time. Fan work out across panes, not within one — this is the invariant that keeps replies unambiguous without correlation ids. Prefer a fresh pane per task.

## Loops (driver pane + `--await`)

`request --await` blocks until the reply lands and prints it to stdout, so a loop is just a script:

```bash
# harden-loop.sh
worker=$(courier create harden-worker | jq -r .name)
for i in $(seq 1 5); do
  courier request "$worker" --await --text "Hardening pass $i. Fix what you find." >> .courier/notes
done
```

Because `--await` blocks whoever runs it, run the loop in **its own driver pane** — a pane whose "agent" is the script — not your interactive session:

```bash
courier create driver --agent 'bash ./harden-loop.sh'
```

Blocking is fine there (waiting is the pane's whole job), the loop stays inside the multiplexer where you can watch worker panes light up in sequence, and you abort by closing the driver pane. Control flow lives in the script (deterministic — `for i in …`); judgement lives in the worker panes. This is Courier's light-touch take on workflows: no DSL, no engine — just a primitive and a shell script. See `SPEC.md` Phase 2.

## Reply trailer

`request` appends a trailer to the injected text:

```text
<your task>

---
[courier] This message was delivered through Courier. When you have finished the task, reply by running this from THIS pane:

  courier respond --message "<your result>"
...
```

This is the only place Courier-awareness is injected. Because it arrives with the task — not baked into a system prompt that can be compacted away — the reply instruction is fresh exactly when the agent acts, and it works for panes Courier never launched.

## Personas

A persona is an opt-in, durable specialization attached at launch via the agent's own system-prompt flag:

```bash
courier create scout --type triage
```

Persona templates live under `prompts/types/`. They describe domain behavior only — they contain no Courier commands, so they can't drift from the reply contract (that lives entirely in the trailer).

## Delivery model

Replies are queued under `.courier/deliveries/` and drained with a per-watcher lock, and Courier waits for a pane to be idle before injecting. Together these ensure concurrent fan-in replies are never pasted into a busy or shared input buffer. A reply with no live watcher is buffered under the completer's terminal and recovered by a later `watch`, so completions are never silently lost.

Manually drain pending notifications if needed:

```bash
courier deliver commander
```

## Local state

Courier stores project-local state in `.courier/` (git-ignored):

```text
.courier/
  state.json
  prompts/       # rendered persona files
  deliveries/
  locks/
```

## Architecture

Courier is split into small, deeper modules:

- `CourierRuntime` coordinates the core flows.
- `HerdrAdapter` contains Herdr CLI calls and response parsing.
- `CourierStore` owns `.courier/` state, deliveries, prompts, and locks.
- `DeliveryPump` serializes reply delivery to watcher panes.
- `PlacementPlanner` owns split/tab placement policy.
- `prompts.ts` owns the request trailer and persona rendering.
- `parser.ts` turns CLI argv into typed command intents.

## Development

```bash
npm run check   # typecheck
npm test        # build + node:test
npm run build
```

See `SPEC.md` and `CONTEXT.md` for design notes and domain vocabulary.
