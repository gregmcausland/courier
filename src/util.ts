export function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// A synthetic watcher id used by `request --await`. It is NOT a pane terminal, so
// the DeliveryPump never injects into it — the awaiting process drains the queue
// in-process instead. The prefix is how injection is skipped (see delivery.ts).
export const AWAIT_WATCHER_PREFIX = "await:";
export function makeAwaitWatcher(): string { return `${AWAIT_WATCHER_PREFIX}${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`; }
export function isAwaitWatcher(id: string): boolean { return id.startsWith(AWAIT_WATCHER_PREFIX); }
export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
export function safeFilePart(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_"); }
