# Courier Spec

North-star spec for Courier. **Phase 1** (the request/respond messaging primitive)
is implemented and described here concretely. **Phase 2** (workflows) is a
direction, described as intent, not yet built.

## Mission

Courier is a small, terminal-native coordination layer for Herdr-managed agent
sessions. It turns agent panes into an **agent-agnostic messaging layer**: any
pane can hand a task to any other pane and reliably receive its reply, without
depending on a particular agent runtime, SDK, or tool protocol.

Courier treats Herdr as the runtime landscape:

- Herdr owns panes, terminals, sessions, process state, labels, focus, and agent activity.
- Courier owns lightweight coordination state: agent records, watcher registrations, and safe reply delivery.

### What changed from the original design

The first spec framed Courier as a **commander → worker** delegation tool with
numeric task ids and a `complete`/`fail`/`progress` status vocabulary. That has
been replaced. The current model is:

- **Homogeneous panes.** No commander/worker roles. Any pane can create panes, `request` work, and `respond`.
- **request / respond**, not create/complete. A `request` is a one-shot handoff; a `respond` is the reply that closes it.
- **No task ids.** The serial-pane invariant (below) removes the need for correlation ids.
- **Natural language is first-class.** There is no status envelope (`--status done`); a reply is just text. "Done" is a transient, driver-owned judgement, deferred to Phase 2 workflows.

## Core model (Phase 1)

### The primitive: request / respond

```bash
courier request worker-1 --text 'Implement the parser. Report what changed.'
# ... worker-1 does the work, then, from its own pane:
courier respond --message 'Added src/parser.ts; 4 tests pass.'
```

- **`request <target> --text T`** = register a one-shot watch from the calling pane back onto `target`, then inject `T` plus a reply trailer into `target`. One step.
- **`respond [target] --message M`** = deliver `M` back to whoever is watching the calling pane, consuming the watch. `target` defaults to the calling pane (resolved via `HERDR_PANE_ID`), so the trailer can inject a recipient-free command the agent runs verbatim.

`request` is composed from two lower-level primitives that remain available:

- **`inject <target> --text T`** — a raw send (idle-gated), no watch, no trailer.
- **`watch <target> [--watcher W]`** — a standalone one-shot watch registration.

### The serial-pane invariant

**A pane holds at most one open request at a time.** Fan work out across panes,
not within one. This is the load-bearing simplification: because a given pane has
exactly one outstanding watcher, the next reply from that pane is unambiguously
*the* reply — no task ids, no correlation envelope, no matching logic. The usage
convention is "one open request per pane; prefer a fresh pane per task."

### The reply trailer — callee discoverability

Courier-awareness is injected **at request time**, not baked into a startup
system prompt. `request` appends a trailer to the payload:

```text
<the task>

---
[courier] This message was delivered through Courier. When you have finished the
task, reply by running this from THIS pane:

  courier respond --message "<your result>"

`respond` targets your own pane automatically — do not name a recipient. Do not
reply to a `[courier respond]` notification; that is a result for you, not a request.
```

This is the **only** place a callee learns about Courier. Consequences:

- It works for panes Courier never launched — no special startup prompt required.
- The reply contract is fresh exactly when the agent acts, so it can't be compacted away.
- A callee's entire Courier surface is this one line. It can't drift into `create`/`request`/`watch` because it was never shown them (least-privilege by construction).

### The skill — caller discoverability

The **caller** (the pane a human drives to orchestrate) becomes Courier-aware
through a human-invoked skill, not ambient context:

- `skills/courier/SKILL.md` carries `disable-model-invocation: true` — a cross-harness [Agent Skills](https://agentskills.io) standard flag verified in Claude Code, cursor-agent, and pi. The skill is **hidden from the model's auto-discovery**; only a human loads it, via `/courier` (Claude Code, cursor-agent) or `/skill:courier` (pi).
- One `SKILL.md` serves all three launchers. `install.sh` links it into `~/.agents/skills` (pi, cursor-agent) and `~/.claude/skills` (Claude Code).

The caller/callee entrypoints are deliberately asymmetric: the caller opts into
the full command surface on demand; the callee only ever sees the trailer.

### Personas — opt-in specialization

A persona is durable domain specialization attached at launch through the agent's
own system-prompt flag:

```bash
courier create scout --type triage
```

Persona templates live under `prompts/types/<type>.md` and are rendered into
`.courier/prompts/`. **They describe domain behavior only and contain no Courier
commands** — so they can't drift from the reply contract, which lives entirely in
the trailer. Personas are a convenience, not a requirement of the mechanism.

## Design principles

### Keep Herdr as the source of runtime truth

Courier records only semantic coordination state (agent records, watches,
deliveries). Pane ids, terminal ids, focus, cwd, agent status, and lifecycle all
come from Herdr on demand via the `HerdrAdapter`.

### Terminal input as the universal transport

Courier communicates by injecting text into panes and submitting Enter. This is
agent-agnostic — it works with any terminal UI. The tradeoff is that delivery
must be careful, which drives the three collision-prevention layers below.

### Deliver safely — three layers

Concurrent fan-in replies must never be pasted into a busy or shared input buffer.
Three layers guarantee this:

1. **Idle-gating** (`waitUntilInjectable`) — wait until Herdr reports the target pane idle before injecting; then inject, wait a short submit delay, submit Enter.
2. **Per-watcher drain lock** — the `DeliveryPump` serializes delivery to a given watcher so two replies can't interleave.
3. **Serial-pane usage convention** — one open request per pane.

If a pane doesn't become injectable before a timeout, Courier records a **pending
delivery** rather than losing it (see durability).

### Durability — replies are never silently lost

Replies are queued as files under `.courier/deliveries/<to>/<id>.json` and drained
under a per-watcher lock. A reply produced when **no watcher is live** is buffered
under the completer's terminal and recovered by a later `watch` (`redeliverPending`).
An injection that times out stays queued for the next drain.

`request` deliberately **skips** pending-reply recovery on arm, to avoid picking
up a stale reply from a previous exchange — durability protects the reply path
without violating the serial-pane invariant.

### Keep the API small

No workflow DSL, no daemon, no database, no dashboard in Phase 1. File state under
`.courier/`, a CLI that shells out to Herdr. The CLI stays canonical; harness
tooling (skills) wraps it for discovery but adds no behavior.

## State schema (Phase 1, as implemented)

`.courier/` layout:

```text
.courier/
  state.json      # agents + watches
  prompts/        # rendered persona files
  deliveries/     # queued replies: deliveries/<to>/<id>.json
  locks/          # mkdir-based locks (state, per-watcher drain)
```

`state.json`:

```json
{
  "version": 1,
  "agents": {
    "worker-1": {
      "name": "worker-1",
      "terminalId": "term_...",
      "paneId": "w655...",
      "agent": "pi",
      "type": "triage",
      "createdAt": "2026-07-03T00:00:00.000Z"
    }
  },
  "watches": {
    "term_worker1": ["term_caller"]
  }
}
```

- `agents` — keyed by name; `type` and `closedAt` are optional.
- `watches` — maps a **target terminal id** to the list of **watcher terminal ids** awaiting its next reply. `respond` consumes the entry.

A queued delivery (`deliveries/<to>/<id>.json`):

```json
{
  "id": "…",
  "to": "term_caller",
  "from": "worker-1",
  "text": "Added src/parser.ts; 4 tests pass.",
  "createdAt": "2026-07-03T00:00:01.000Z"
}
```

Delivered to the watcher as a structured notification:

```text
[courier respond]
from: worker-1

Added src/parser.ts; 4 tests pass.
```

## Architecture

- **`CourierRuntime`** — coordinates create / request / respond / watch / deliver / close.
- **`HerdrAdapter`** — the only place that shells out to Herdr and parses its output.
- **`CourierStore`** — owns `.courier/` state, deliveries, prompts, and the lock primitive.
- **`DeliveryPump`** — serializes and idle-gates reply delivery to a watcher; buffers/recovers pending replies.
- **`PlacementPlanner`** — split-vs-tab placement policy.
- **`prompts.ts`** — the request trailer, persona rendering, and `courier` invocation resolution.
- **`parser.ts`** — argv → typed command intent.

## Commands (Phase 1)

```text
courier create <NAME> [--type triage] [--agent COMMAND] [--from PANE_OR_TERMINAL_ID] [--tab] [--cwd PATH] [--focus|--no-focus]
courier commander [NAME] ...            # convenience launcher (Claude Code, current pane)
courier request <TARGET> --text TEXT [--submit-delay-ms N] [--poll-ms N] [--await [--await-timeout-ms N] [--await-poll-ms N]]
courier respond [TARGET] --message TEXT # TARGET defaults to the calling pane
courier inject <TARGET> --text TEXT      # raw send, no watch/trailer
courier watch <TARGET> [--watcher W]     # standalone watch
courier deliver <NAME_OR_ID>             # drain pending deliveries
courier close|suspend <NAME_OR_ID>
```

## Phase 2 — Workflows (direction; first primitive landed)

Phase 1 gives a reliable one-shot request/respond primitive. Phase 2 composes it
into **workflows**: multi-step, potentially looping agent processes — implement a
feature, run a debugging loop until bugs are squashed, commit-and-PR.

The design is deliberately **light-touch**: Courier does not own a workflow DSL,
engine, or "done" protocol. It exposes primitives; a workflow is an ordinary
script the user (or an agent) writes. The multiplexer is the point — real
interactive sessions, driven programmatically, nothing blocked.

### Landed: `request --await` and the driver-pane convention

The first Phase-2 primitive is built. `request --await` **blocks the calling
process** until the target's `respond` lands, then prints the raw reply to stdout.
This turns `request` into a composable shell citizen, so a loop is just a script:

```bash
# harden-loop.sh — runs as its own pane
worker=$(courier create harden-worker | jq -r .name)
for i in $(seq 1 5); do
  courier request "$worker" --await --text "Hardening pass $i. Fix what you find." >> .courier/notes
done
```

**How `--await` works.** It reuses the existing durable delivery queue, but
registers a **synthetic watcher** (`await:<pid>-…`) that is *not* a pane terminal:

1. `request --await` mints the synthetic watcher, registers the watch on the target, and injects the task + trailer as usual.
2. Instead of returning, it polls `.courier/deliveries/await:<pid>/` (the same queue `respond` writes to).
3. The worker runs `respond`, which — knowing nothing of the awaiter — `consumeWatchers` finds the synthetic id and enqueues a delivery file to it.
4. The awaiter's next poll reads the file, removes it, prints the raw message, and exits.

The synthetic id is what keeps the `DeliveryPump` from ever trying to *inject*
the reply (it has no pane); it is drained in-process by the poller instead. The
filesystem is the rendezvous — push becomes pull, no daemon, no IPC. `respond`,
`enqueueDelivery`, and `consumeWatchers` are untouched. `--await-timeout-ms 0`
(the default) waits indefinitely; abort by closing the driver pane.

**The driver-pane convention.** `--await` *blocks whoever runs it*, so it is meant
for a **headless driver pane**, never an interactive session. A driver pane is
just a pane whose "agent" is a script (`courier create driver --agent 'bash
./harden-loop.sh'`). Blocking is fine there — waiting is its whole job. This keeps
the loop **inside the multiplexer**: visible (watch worker panes light up in
sequence), killable (close the pane to abort), and deterministic (control flow is
`for i in …`, not an LLM). Control flow lives in the driver script; judgement
lives in the worker panes.

### Guiding intents (to be pinned down, not commitments)

- **Composition over envelope.** A workflow is a driver that issues `request`s and reads replies. No new status protocol on the wire — natural-language replies stay first-class.
- **Control vs. judgement split.** Deterministic control (loop counter, max iterations, running tests/lint) is the driver script's job; finding and fixing is the worker's. LLMs are unreliable loop-owners.
- **Termination is driver-owned.** "Done" is a judgement the driver makes over replies (and possibly repo/test state), **not** a flag a worker asserts. *(Deferred: real exit gates are out of scope for now — `--await` loops are bounded by max iterations only.)*
- **Bounded loops.** A max-iteration budget so a loop can't spin forever.
- **Fan-out/fan-in.** Built on the serial-pane invariant: parallel legs run in separate panes; the driver joins their replies.

### Open Phase 2 questions

- **Cross-iteration ledger (tracked, not committed).** The one place agents slip is remembering what earlier iterations already did. A durable, human-readable per-loop ledger the next `request` can read back could carry that state instead of the agent's memory — e.g. a `courier note` helper writing `.courier/notes/<pane>.log`, or plain shell `>>`. **Shape and whether to build it are both open.**
- What is the minimal shape of a richer workflow definition beyond a shell script — a `courier run <script>` process, a declarative file, or nothing more than shell?
- What does a termination predicate get access to when we do tackle exit gates (replies only, or also test/CI/git signals)?
- How do workflows report their own progress back to the human driving them?

## Non-goals (Phase 1)

- No status envelope on replies (`--status done`); NL is the protocol.
- No task ids or correlation matching (serial-pane invariant replaces them).
- No commander/worker roles.
- No workflow DSL, daemon, database, or dashboard.
- No baked-in startup Courier prompt; awareness rides the trailer (callee) and the skill (caller).
- No assumption that agents are any particular runtime.

## Resolved questions

Questions from the original spec, now settled:

- **Current-pane resolution** — `HERDR_PANE_ID` is exported per pane, so `respond` self-resolves to the calling pane; no `--target` needed.
- **State location** — project-local `.courier/` (git-ignored).
- **`inject` submit behavior** — `request`/`inject` inject and submit (idle-gated) by default; the submit delay avoids the Enter-before-text race.
- **Command naming** — `create`/`request`/`respond`, not `start-worker`/`complete`.
- **Pending deliveries** — recovered on the next relevant `watch`/`deliver` (file-queued), no daemon.
