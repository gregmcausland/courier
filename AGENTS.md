# Courier Agent Instructions

When working in this repository, use Courier to coordinate terminal agents through Herdr. Panes are homogeneous — any pane can create panes, request work from any other pane, and respond.

## Launch an agent

`commander` is a convenience launcher (Claude Code in the current pane, no special role):

```bash
npm run build
node dist/cli.js commander
```

Defaults: name `commander`, agent `claude`, current pane unless `--tab`.

```bash
node dist/cli.js commander --tab
node dist/cli.js create worker-1               # pi in a split
node dist/cli.js create scout --type triage    # opt-in persona
```

## Delegate work

`request` arms a one-shot watch back to the calling pane and injects the task with a reply trailer, in one step:

```bash
node dist/cli.js create worker-1
node dist/cli.js request worker-1 --text '<task>'
```

Keep to one open request per pane; fan out across panes rather than piling tasks into one.

## Respond

A pane reports back through Courier. The reply trailer tells it exactly what to run — from its own pane, targeting itself, no name:

```bash
node dist/cli.js respond --message '<result>'
```

Courier routes replies through its idle-gated, per-watcher delivery pump so fan-in results arrive as separate submissions. Do not reply to a `[courier respond]` notification — that is a result for you, not a request.
