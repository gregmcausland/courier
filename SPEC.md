# Courier Spec

## Mission

Courier is a small, terminal-native coordination layer for Herdr-managed agent sessions.

Its purpose is to let a commander agent delegate work to worker agents, receive reliable completion signals, and continue orchestration without depending on any one agent runtime, SDK, or tool protocol.

Courier treats Herdr as the runtime landscape:

- Herdr owns panes, terminals, sessions, process state, labels, and agent activity.
- Courier owns lightweight task intent, task events, watcher registrations, and safe notification delivery.

Courier should not become a full workflow engine at the start. It should first prove a few concrete mechanics:

1. start or address worker panels;
2. register a watcher for a task;
3. allow a worker to explicitly complete/fail/progress a task;
4. persist the event;
5. deliver the event back into watcher panels safely through Herdr.

The important idea is that task completion should not be inferred from a pane becoming idle. A worker completes a task by explicitly calling Courier.

Example placeholder flow:

```bash
courier watch 100 --target commander
courier complete 100 --details "Implemented the change and tests pass."
```

When a completion event arrives, Courier records it, waits until watcher panels are safe to receive input, injects a structured message into those panels, waits briefly, then submits Enter.

This gives us an agent-agnostic signal path:

```text
worker agent -> courier CLI -> event log -> Herdr injection -> commander agent
```

## Design principles

### Keep Herdr as the source of runtime truth

Courier should not duplicate Herdr state unless it needs a durable reference for delivery.

Herdr already knows:

- pane ids;
- terminal ids;
- workspace/tab ids;
- cwd;
- focused pane;
- agent labels;
- agent status such as idle/working/blocked/unknown;
- recent/visible output;
- session paths;
- how to start, read, send, wait, focus, and close agents/panes.

Courier should use Herdr for those capabilities.

Courier should record only semantic coordination state:

- task ids;
- task status;
- task events;
- watcher registrations;
- worker assignment references, if needed;
- notification delivery attempts/results.

### Prefer explicit task signals

A pane becoming idle is not a reliable semantic completion signal. It may be idle because the agent completed successfully, failed, paused, crashed, or is waiting for more instructions.

Workers should explicitly call Courier when they have something to report:

```bash
courier complete 100 --details "..."
courier fail 100 --details "..."
courier progress 100 --details "..."
```

### Use terminal input as the universal transport

Courier should communicate with agents by injecting text into Herdr panes and submitting Enter.

This is intentionally agent-agnostic. It should work with Pi, Claude Code, Codex, shell-based agents, or other terminal UIs, because every agent panel can receive text input.

The tradeoff is that delivery must be careful. Courier should avoid injecting while a watcher agent is actively generating or busy.

### Deliver safely

Courier should check Herdr panel/agent activity before injecting a notification.

Default delivery mode for watcher notifications should be roughly:

1. resolve watcher target to pane;
2. wait until Herdr reports the watcher agent/pane as idle;
3. inject the notification text;
4. wait a short artificial delay;
5. submit Enter;
6. record delivery.

The submit delay is intentional. It avoids races where Enter is sent before the terminal UI has fully received the injected text.

### Keep the API small

Avoid designing a full orchestration platform up front.

For the first version, do not add:

- complex workflow definitions;
- agent prompt templates;
- fan-out/fan-in primitives;
- retries beyond basic delivery attempts;
- a daemon unless absolutely necessary;
- a database;
- a web UI;
- deep Pi-specific assumptions.

Build the mechanics first.

## Build approach

### Start as a CLI

Courier should begin as a local CLI that shells out to `herdr`.

A CLI is the right first interface because:

- any terminal agent can run it;
- workers can report completion without needing special tools;
- humans can inspect and test it manually;
- Pi tooling can wrap it later if useful;
- it keeps Courier independent of a particular agent SDK.

A future Pi extension/tool package can be added later, but the CLI should remain canonical.

### Use Herdr directly

Courier should call the Herdr CLI/API directly for the first implementation.

Required Herdr operations:

- list/get agents or panes;
- start an agent/pane;
- send text to a target;
- send Enter / submit;
- wait for a target status, especially idle;
- possibly detect current/focused pane for watcher registration.

### Persist simple local state

Use a project-local or user-local `.courier/` directory initially.

Possible initial layout:

```text
.courier/
  state.json
  events.jsonl
```

`state.json` is the compact current view.

`events.jsonl` is the append-only audit log.

This keeps state human-inspectable and easy to recover. Avoid SQLite or a service until file state becomes limiting.

### Treat delivery as idempotent

Every event should have an event id. Every delivery should record whether that event was delivered to a watcher pane.

Injected messages should include identifiers so repeated delivery can be recognized.

Example injected message:

```text
[courier:event task.complete]
event_id: evt_abc123
task_id: 100
status: complete

Implemented the change and tests pass.
[/courier:event]
```

## Minimal MVP

The MVP should cover only these mechanics.

### 1. Spin up a worker

Courier can ask Herdr to start a worker agent/process.

Possible command:

```bash
courier start-worker worker-1 -- pi
```

or:

```bash
courier start worker-1 -- pi
```

This should be a thin wrapper around Herdr start behavior. It should not create task prompts automatically in v0.

The result should include enough information to address the worker later:

- target/label;
- pane id;
- terminal id;
- workspace/tab ids if available.

### 2. Watch a task

A commander panel can register itself, or an explicit target, as a watcher for a task.

Possible command:

```bash
courier watch 100 --target commander
```

Eventually this should support defaulting to the current pane, but explicit target is acceptable for the first pass if current-pane detection is unclear.

Watching a task records that this target should receive task events such as complete/fail/progress.

### 3. Create/inject a task manually

Courier should support creating minimal task state and optionally injecting manually supplied text into a worker panel.

Possible command:

```bash
courier create 100 --worker worker-1
courier inject worker-1 --text "Please handle task 100. When done, run: courier complete 100 --details '<summary>'"
```

For v0, Courier should not generate the worker prompt automatically. The commander or human should provide the prompt text manually.

This keeps prompt/persona design out of the first implementation.

### 4. Complete/fail/progress a task

A worker reports status through Courier.

Possible commands:

```bash
courier progress 100 --details "I found the relevant files and am testing now."
courier complete 100 --details "The task is done. Tests pass."
courier fail 100 --details "Blocked because credentials are missing."
```

Courier should:

1. append an event;
2. update task status;
3. find watchers for the task;
4. safely deliver the event to watcher panels.

### 5. Safe watcher delivery

Delivery should use Herdr state.

Default behavior:

```text
wait for watcher idle -> inject event message -> sleep briefly -> submit Enter
```

If the watcher does not become idle before a timeout, Courier should record a pending or failed delivery rather than losing the event.

Initial defaults can be simple:

- idle wait timeout: 60 seconds;
- submit delay: 500 ms;
- delivery mode: when-idle.

These can become configurable later.

## Minimal state schema

Draft `state.json`:

```json
{
  "version": 1,
  "tasks": {
    "100": {
      "id": "100",
      "status": "running",
      "createdAt": "2026-06-27T00:00:00.000Z",
      "updatedAt": "2026-06-27T00:00:00.000Z",
      "worker": {
        "target": "worker-1",
        "paneId": "w655...",
        "terminalId": "term_..."
      },
      "watchers": [
        {
          "target": "commander",
          "paneId": "w655...",
          "terminalId": "term_...",
          "notifyMode": "when-idle",
          "submitDelayMs": 500
        }
      ],
      "lastEventId": "evt_abc123",
      "result": null
    }
  },
  "deliveries": {
    "evt_abc123:w655...": {
      "eventId": "evt_abc123",
      "taskId": "100",
      "target": "commander",
      "paneId": "w655...",
      "status": "delivered",
      "attempts": 1,
      "deliveredAt": "2026-06-27T00:00:01.000Z"
    }
  }
}
```

Draft `events.jsonl`:

```jsonl
{"id":"evt_001","type":"task.created","taskId":"100","at":"2026-06-27T00:00:00.000Z"}
{"id":"evt_002","type":"task.watched","taskId":"100","target":"commander","paneId":"w655...","at":"2026-06-27T00:00:00.000Z"}
{"id":"evt_003","type":"task.completed","taskId":"100","details":"The task is done. Tests pass.","at":"2026-06-27T00:00:00.000Z"}
{"id":"evt_004","type":"notification.delivered","taskId":"100","eventId":"evt_003","target":"commander","paneId":"w655...","at":"2026-06-27T00:00:01.000Z"}
```

## Non-goals for v0

- No automatic worker persona prompts.
- No generated task instructions.
- No multi-agent workflow DSL.
- No dashboard.
- No daemon unless file/CLI execution proves insufficient.
- No replacement for Herdr state tracking.
- No Pi-only implementation.
- No assumption that workers are Pi agents.

## Open questions

- How should Courier reliably determine the current pane when `courier watch 100` is run without `--target`?
- Should state be project-local `.courier/` by default, user-global, or configurable?
- Which Herdr commands return JSON reliably, and which need tolerant handling?
- Should `courier inject` submit by default, or require `--submit`?
- What is the minimal pleasant command naming: `start-worker` vs `start`, `complete` vs `task complete`?
- Should pending deliveries be retried on the next Courier invocation, or is a daemon eventually needed?
