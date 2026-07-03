---
name: courier
description: Coordinate parallel terminal agents through Courier — spin up agent panes in Herdr, hand tasks to them, and collect their replies. Invoke when you want to delegate or parallelize work across separate agent sessions.
disable-model-invocation: true
allowed-tools: Bash
---

# Courier

Courier turns Herdr-managed agent panes into a messaging layer. You (this pane)
are the caller: you launch panes, hand each one a task with `request`, and
Courier routes each reply back to you as a `[courier respond]` notification.

Everything is the `courier` command. Run `courier --help` for the full surface.

## The one rule: one open request per pane

A pane holds **at most one open request at a time**. This is what lets Courier
route replies back without correlation ids. **Fan work out across panes, not
within one** — prefer a fresh pane per task. Do not send a second `request` to a
pane whose first request hasn't come back.

## Launch a pane

```bash
courier create worker-1                 # pi in a split
courier create worker-1 --tab           # discrete tab instead of a split
courier create scout --type triage      # opt-in persona (domain behavior only)
courier commander                        # convenience: Claude Code in the current pane
```

Panes are homogeneous — there are no roles. A persona (`--type`) only specializes
domain behavior; it carries no Courier commands.

## Hand off work

`request` arms a one-shot watch back to this pane and injects the task plus a
reply trailer telling the target how to answer — in one step:

```bash
courier request worker-1 --text 'Implement the parser for <spec>. Report what you changed.'
```

The target does **not** need to know who called it or that Courier exists ahead
of time — the trailer teaches it. You never tell a target to run `respond`; the
trailer already does.

## Collect replies

When a target finishes, it runs `courier respond` on its own pane; Courier
delivers the result to you as a `[courier respond]` notification in your input.
Replies are idle-gated and serialized, so concurrent fan-in results arrive as
separate, clean submissions.

If you expected a reply that never surfaced, drain pending deliveries:

```bash
courier deliver <your-pane-name-or-id>
```

## Fan-out pattern

```bash
courier create impl && courier create tests && courier create docs
courier request impl  --text '<implement task>'
courier request tests --text '<write tests task>'
courier request docs  --text '<update docs task>'
# ...each replies independently via its trailer; watch for [courier respond] notifications.
```

## Lifecycle

```bash
courier close   <name-or-id>    # close a pane you're done with
courier suspend <name-or-id>    # suspend without closing
```

## Notes

- Do **not** reply to a `[courier respond]` notification — that is a result for
  you, not a request.
- `request` = `watch` + `inject` + trailer. The lower-level `courier inject`
  (raw send, no watch/trailer) and `courier watch` (standalone watch) exist if
  you need them, but `request`/`respond` is the normal path.
