# Courier

Courier is a small TypeScript CLI for coordinating Herdr-managed AI agent panes.

It lets you create named commander/worker agents, inject prompts safely, register one-shot watches, and route worker completions back to watchers through a serialized delivery queue.

## Status

Early MVP. Built for local experimentation with [Herdr](https://github.com/) and terminal-native agents.

Supported agent launchers:

- `pi` — default
- `claude` — Claude Code live session with `--dangerously-skip-permissions`
- `cursor` — Cursor Agent bootstrap prompt

## Install / build

```bash
npm install
npm run build
```

Run locally:

```bash
node dist/cli.js --help
```

Or via npm bin after linking/installing:

```bash
courier --help
```

## Commands

```text
courier commander [NAME] [--agent COMMAND] [--from PANE_OR_TERMINAL_ID] [--tab] [--cwd PATH] [--focus|--no-focus]
courier create <NAME> [--role commander|worker|none] [--agent COMMAND] [--from PANE_OR_TERMINAL_ID] [--tab] [--cwd PATH] [--focus|--no-focus]
courier inject <NAME_OR_PANE_OR_TERMINAL_ID> --text TEXT [--submit-delay-ms 750] [--poll-ms 1000]
courier watch <TARGET_NAME_OR_ID> [--watcher NAME_OR_ID]
courier complete <TARGET_NAME_OR_ID> --message TEXT
courier deliver <NAME_OR_PANE_OR_TERMINAL_ID>
courier close <NAME_OR_PANE_OR_TERMINAL_ID>
courier suspend <NAME_OR_PANE_OR_TERMINAL_ID>
```

## Basic flow

Create a default commander:

```bash
courier commander
```

This launches a commander named `commander` using Claude Code in the current pane by default. Pass `--tab` only when you want a discrete tab. Override the name or agent if needed:

```bash
courier commander project-lead --agent pi
```

Create a worker:

```bash
courier create worker-1 --role worker
```

Workers are contained in a shared worker tab by default. Use `--tab` to request a discrete tab.

Register a one-shot watch:

```bash
courier watch worker-1 --watcher commander
```

Send a request:

```bash
courier inject worker-1 --text '[courier request] Answer: what is 2 + 2?'
```

The worker should finish by running:

```bash
courier complete worker-1 --message '4'
```

Courier consumes the watch and delivers a structured completion notification to the watcher.

## Commander prompt

Prompt source templates live as Markdown files under `prompts/`. `courier commander` renders those templates into `.courier/prompts/<name>.md` and launches the commander with that file attached. The commander template is intentionally a small stub: it names the Courier command, explains the create/watch/inject delegation sequence, and tells the commander to return idle after fan-out so completions can be delivered safely.

## Delivery model

Completions are queued under `.courier/deliveries/` and drained with a per-watcher lock. This prevents concurrent fan-in completions from being pasted into the same input buffer.

If needed, manually drain pending notifications:

```bash
courier deliver commander
```

## Local state

Courier stores project-local state in `.courier/`:

```text
.courier/
  state.json
  prompts/       # rendered Markdown prompt files
  deliveries/
  locks/
```

This directory is ignored by git.

## Architecture

Courier is split into small, deeper modules:

- `CourierRuntime` coordinates the core flows.
- `HerdrAdapter` contains Herdr CLI calls and response parsing.
- `CourierStore` owns `.courier/` state, deliveries, prompts, and locks.
- `DeliveryPump` serializes completion delivery to watcher agents.
- `PlacementPlanner` owns split/tab placement policy.
- `prompts.ts` owns the Courier prompt contract.
- `parser.ts` turns CLI argv into typed command intents.

## Development

```bash
npm run check
npm run build
```

See `SPEC.md` and `CONTEXT.md` for design notes, domain vocabulary, and MVP rationale.
