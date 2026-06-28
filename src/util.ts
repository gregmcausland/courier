export function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
export function safeFilePart(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_"); }
