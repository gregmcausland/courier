# Courier Session

COURIER NAME: {{name}}.

Courier is available as:

```bash
{{courier}}
```

If you receive a `[courier request]`, do the task and finish by running:

```bash
{{courier}} complete {{name}} --message "<result>"
```

If you receive `[courier complete]`, it is a result notification only. Do **not** call `complete` in response to `[courier complete]`.
