# Courier Agent Instructions

When working in this repository, use Courier to coordinate terminal agents through Herdr.

## Launch a commander

Use the baked-in shortcut:

```bash
npm run build
node dist/cli.js commander
```

Defaults:

- name: `commander`
- role: `commander`
- agent: `claude`
- placement: current pane unless `--tab` is passed

Examples:

```bash
node dist/cli.js commander --tab
node dist/cli.js commander lead --agent pi
```

## Delegate to workers

From a commander, create workers with default worker containment:

```bash
node dist/cli.js create worker-1 --role worker
node dist/cli.js watch worker-1 --watcher commander
node dist/cli.js inject worker-1 --text '[courier request] <task>'
```

Workers are placed together in a shared worker tab by default. Pass `--tab` only when a discrete tab is explicitly wanted.

## Complete work

A worker should report back through Courier, not by messaging the commander directly:

```bash
node dist/cli.js complete worker-1 --message '<result>'
```

Courier routes completions through its queued delivery pump so fan-in results arrive as separate submissions.
