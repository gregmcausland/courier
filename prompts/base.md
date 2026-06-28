# Courier Session

COURIER NAME: {{name}}.

Courier is available as:

```bash
{{courier}}
```

If you receive a `[courier request]`, do the task and finish by running:

```bash
{{courier}} complete --message "<result>"
```

`complete` targets your own pane by default — you do not name yourself or the requester.

If you receive `[courier complete]`, it is a result notification only. Do **not** call `complete` in response to `[courier complete]`.
