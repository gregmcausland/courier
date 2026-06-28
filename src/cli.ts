#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type AgentSessionRef = { agent?: string; kind?: string; source?: string; value?: string };
type Pane = { pane_id: string; terminal_id?: string; workspace_id?: string; tab_id?: string; focused?: boolean; agent_status?: string; agent_session?: AgentSessionRef };
type PaneListResponse = { result?: { panes?: Pane[] } };
type PaneInfoResponse = { result?: { pane?: Pane; root_pane?: Pane; agent?: Pane } };
type HerdrResult = { status: number; stdout: string; stderr: string };
type AgentRecord = { name: string; terminalId: string; paneId: string; agent: string; role?: Role; agentSession?: AgentSessionRef; createdAt: string; closedAt?: string };
type State = { version: 1; agents: Record<string, AgentRecord>; watches: Record<string, string[]> };

const courierDir = join(process.cwd(), ".courier");
const statePath = join(courierDir, "state.json");
const promptDir = join(courierDir, "prompts");
const deliveryDir = join(courierDir, "deliveries");
const lockDir = join(courierDir, "locks");

function usage(): string {
  return `Usage:
  courier create <NAME> [--role commander|worker|none] [--agent COMMAND] [--from PANE_OR_TERMINAL_ID] [--tab] [--cwd PATH] [--focus|--no-focus]
  courier inject <NAME_OR_PANE_OR_TERMINAL_ID> --text TEXT [--submit-delay-ms 750] [--poll-ms 1000]
  courier watch <TARGET_NAME_OR_ID> [--watcher NAME_OR_ID]
  courier complete <TARGET_NAME_OR_ID> --message TEXT
  courier deliver <NAME_OR_PANE_OR_TERMINAL_ID>
  courier close <NAME_OR_PANE_OR_TERMINAL_ID>
  courier suspend <NAME_OR_PANE_OR_TERMINAL_ID>

Courier records created agents by name. Worker creates are contained in a shared worker tab by default; pass --tab to open a discrete tab. Watches are one-shot awaits consumed by complete.
Default agent: pi. Use --agent claude for Claude Code or --agent cursor for Cursor Agent.
`;
}
function fail(message: string): never { console.error(message); console.error(usage()); process.exit(2); }
function requireValue(value: string | undefined, name: string): string { if (!value) fail(`missing ${name}`); return value; }
function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
function herdr(args: string[]): HerdrResult {
  const result = spawnSync("herdr", args, { encoding: "utf8", shell: false });
  if (result.error) { console.error(`failed to run herdr: ${result.error.message}`); process.exit(1); }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function runHerdr(args: string[], print = true): string {
  const result = herdr(args);
  if (result.status !== 0) { if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr); process.exit(result.status); }
  if (print && result.stdout) process.stdout.write(result.stdout);
  return result.stdout;
}
function loadState(): State {
  if (!existsSync(statePath)) return { version: 1, agents: {}, watches: {} };
  const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<State>;
  return { version: 1, agents: raw.agents ?? {}, watches: raw.watches ?? {} };
}
function saveState(state: State): void { mkdirSync(dirname(statePath), { recursive: true }); writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`); }
function safeFilePart(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_"); }
function writePromptFile(name: string, prompt: string): string {
  mkdirSync(promptDir, { recursive: true });
  const path = join(promptDir, `${safeFilePart(name)}.txt`);
  writeFileSync(path, `${prompt}\n`);
  return path;
}
function parsePaneInfo(output: string): Pane | undefined { const parsed = JSON.parse(output) as PaneInfoResponse; return parsed.result?.pane ?? parsed.result?.root_pane ?? parsed.result?.agent; }
function resolveHerdrTarget(target: string): Pane | undefined {
  let result = herdr(["pane", "get", target]);
  if (result.status === 0) { try { return parsePaneInfo(result.stdout); } catch { return undefined; } }
  result = herdr(["agent", "get", target]);
  if (result.status === 0) { try { return parsePaneInfo(result.stdout); } catch { return undefined; } }
  return undefined;
}
function resolveTarget(target: string): Pane | undefined {
  const state = loadState();
  const alias = state.agents[target];
  return resolveHerdrTarget(alias?.terminalId ?? target);
}
function terminalIdFor(target: string): string {
  const pane = resolveTarget(target);
  if (!pane?.terminal_id) fail(`target is gone or unavailable: ${target}`);
  return pane.terminal_id;
}
function focusedPane(): Pane {
  const output = runHerdr(["pane", "list"], false);
  let parsed: PaneListResponse;
  try { parsed = JSON.parse(output) as PaneListResponse; } catch { console.error(output); fail("could not parse herdr pane list output"); }
  const focused = parsed.result?.panes?.find((pane) => pane.focused);
  if (!focused) fail("could not find focused Herdr pane");
  return focused;
}
function waitUntilIdle(target: string, pollMs: number): Pane {
  for (;;) {
    const pane = resolveTarget(target);
    if (!pane) fail(`target is gone or unavailable: ${target}`);
    if (pane.agent_status === "idle" || pane.agent_status === "done") return pane;
    sleep(pollMs);
  }
}

type Role = "commander" | "worker" | "none";
type CreateArgs = { name: string; from?: string; split: "right" | "down"; tab: boolean; tail: string[]; agent: string; role: Role };
function defaultRole(name: string): Role {
  if (name.toLowerCase().includes("commander")) return "commander";
  if (name.toLowerCase().includes("worker")) return "worker";
  return "none";
}
function rolePrompt(role: Role, name: string): string {
  const base = `COURIER NAME: ${name}. IMPORTANT: If you receive a [courier request], do the task and finish by running: node dist/cli.js complete ${name} --message "<result>". IMPORTANT: If you receive [courier complete], it is a result notification only. DO NOT call complete in response to [courier complete].`;
  if (role === "commander") return `${base} COMMANDER: To delegate, run: node dist/cli.js create <worker-name>; node dist/cli.js watch <worker-name> --watcher ${name}; node dist/cli.js inject <worker-name> --text "[courier request] <task>". After injecting one dependent task, STOP and return idle.`;
  if (role === "worker") return `${base} WORKER: Do not message commanders directly; use complete.`;
  return base;
}
function waitForAgentSession(target: string, timeoutMs = 10000, pollMs = 500): Pane | undefined {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = resolveHerdrTarget(target);
    if (pane?.agent_session) return pane;
    sleep(pollMs);
  }
  return resolveHerdrTarget(target);
}
function agentCommand(agent: string, name: string, promptPath: string | undefined): string {
  if (agent === "pi") {
    return promptPath ? `pi --append-system-prompt ${shellQuote(promptPath)}` : "pi";
  }
  if (agent === "claude") {
    const parts = ["claude", "--name", shellQuote(name), "--dangerously-skip-permissions"];
    if (promptPath) parts.push("--append-system-prompt-file", shellQuote(promptPath));
    return parts.join(" ");
  }
  if (agent === "cursor" || agent === "cursor-agent") {
    const parts = ["cursor-agent", "--yolo"];
    if (promptPath) parts.push(shellQuote(`Use the Courier instructions in ${promptPath} for this session. Respond with nothing.`));
    return parts.join(" ");
  }
  return agent;
}
function parseCreateArgs(args: string[]): CreateArgs {
  const name = requireValue(args.shift(), "name");
  let from: string | undefined; let split: "right" | "down" = "right"; let tab = false; let agent = "pi"; let role = defaultRole(name); const tail: string[] = [];
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--agent": agent = requireValue(args.shift(), "--agent value"); break;
      case "--role": { const value = requireValue(args.shift(), "--role value"); if (value !== "commander" && value !== "worker" && value !== "none") fail("--role must be commander, worker, or none"); role = value; break; }
      case "--from": from = requireValue(args.shift(), "--from value"); break;
      case "--split": { const value = requireValue(args.shift(), "--split value"); if (value !== "right" && value !== "down") fail("--split must be right or down"); split = value; tab = false; break; }
      case "--tab": tab = true; break;
      case "--cwd": tail.push("--cwd", requireValue(args.shift(), "--cwd value")); break;
      case "--focus": case "--no-focus": tail.push(arg); break;
      default: fail(`unknown option: ${arg ?? ""}`);
    }
  }
  return { name, from, split, tab, tail, agent, role };
}
function workerContainmentPane(): Pane | undefined {
  const state = loadState();
  for (const record of Object.values(state.agents)) {
    if (record.role !== "worker") continue;
    const pane = resolveHerdrTarget(record.terminalId);
    if (pane?.pane_id) return pane;
  }
  return undefined;
}
function create(args: string[]): never {
  const opts = parseCreateArgs(args);
  const requestedSource = opts.from ? (resolveTarget(opts.from) ?? fail(`source is gone or unavailable: ${opts.from}`)) : focusedPane();
  const sourcePane = !opts.tab && opts.role === "worker" ? (workerContainmentPane() ?? requestedSource) : requestedSource;
  const output = opts.tab
    ? runHerdr(["tab", "create", "--workspace", sourcePane.workspace_id ?? fail("source pane has no workspace_id"), "--label", opts.name, ...opts.tail])
    : (!workerContainmentPane() && opts.role === "worker"
      ? runHerdr(["tab", "create", "--workspace", sourcePane.workspace_id ?? fail("source pane has no workspace_id"), "--label", "courier-workers", ...opts.tail])
      : runHerdr(["pane", "split", sourcePane.pane_id, "--direction", opts.split, ...opts.tail]));
  let pane: Pane | undefined;
  try { pane = parsePaneInfo(output); } catch { fail("could not parse herdr create output"); }
  if (!pane?.pane_id || !pane.terminal_id) fail("herdr create did not return pane_id and terminal_id");
  runHerdr(["pane", "rename", pane.pane_id, opts.name], false);
  const prompt = rolePrompt(opts.role, opts.name);
  const promptPath = prompt ? writePromptFile(opts.name, prompt) : undefined;
  const command = agentCommand(opts.agent, opts.name, promptPath);
  runHerdr(["pane", "run", pane.pane_id, command]);
  runHerdr(["agent", "rename", pane.terminal_id, opts.name], false);
  const settledPane = waitForAgentSession(pane.terminal_id) ?? pane;
  const state = loadState();
  state.agents[opts.name] = { name: opts.name, terminalId: pane.terminal_id, paneId: settledPane.pane_id, agent: opts.agent, role: opts.role, agentSession: settledPane.agent_session, createdAt: new Date().toISOString() };
  saveState(state);
  console.log(JSON.stringify({ name: opts.name, terminalId: pane.terminal_id, paneId: settledPane.pane_id, agent: opts.agent, role: opts.role, agentSession: settledPane.agent_session }));
  process.exit(0);
}

function parseInjectArgs(args: string[]): { target: string; text: string; submitDelayMs: number; pollMs: number } {
  const target = requireValue(args.shift(), "name or id"); let text: string | undefined; let submitDelayMs = 750; let pollMs = 1000;
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--text": text = requireValue(args.shift(), "--text value"); break;
      case "--submit-delay-ms": submitDelayMs = Number(requireValue(args.shift(), "--submit-delay-ms value")); break;
      case "--poll-ms": pollMs = Number(requireValue(args.shift(), "--poll-ms value")); break;
      default: fail(`unknown option: ${arg ?? ""}`);
    }
  }
  if (!text) fail("missing --text");
  return { target, text, submitDelayMs, pollMs };
}
function injectText(target: string, text: string, submitDelayMs = 750, pollMs = 1000): void {
  const pane = waitUntilIdle(target, pollMs);
  runHerdr(["pane", "send-text", pane.pane_id, text], false);
  sleep(submitDelayMs);
  runHerdr(["pane", "send-keys", pane.pane_id, "Enter"], false);
}
type Delivery = { id: string; to: string; from: string; text: string; createdAt: string };
function deliveryPath(to: string): string { return join(deliveryDir, safeFilePart(to)); }
function deliveryFile(to: string, id: string): string { return join(deliveryPath(to), `${safeFilePart(id)}.json`); }
function enqueueDelivery(delivery: Delivery): void {
  mkdirSync(deliveryPath(delivery.to), { recursive: true });
  writeFileSync(deliveryFile(delivery.to, delivery.id), `${JSON.stringify(delivery, null, 2)}\n`);
}
function readDeliveries(to: string): Delivery[] {
  const dir = deliveryPath(to);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith(".json")).sort().map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as Delivery);
}
function removeDelivery(delivery: Delivery): void { try { unlinkSync(deliveryFile(delivery.to, delivery.id)); } catch {} }
function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function lockOwnerPid(path: string): number | undefined {
  try {
    const data = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { pid?: number };
    return typeof data.pid === "number" ? data.pid : undefined;
  } catch { return undefined; }
}
function withLock(name: string, fn: () => void, staleMs = 120000): boolean {
  mkdirSync(lockDir, { recursive: true });
  const path = join(lockDir, `${safeFilePart(name)}.lock`);
  try { mkdirSync(path); }
  catch {
    try {
      const owner = lockOwnerPid(path);
      const ownerDead = owner !== undefined && !processIsAlive(owner);
      const stale = Date.now() - statSync(path).mtimeMs > staleMs;
      if (ownerDead || stale) {
        rmSync(path, { recursive: true, force: true });
        mkdirSync(path);
      } else return false;
    } catch { return false; }
  }
  writeFileSync(join(path, "owner.json"), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
  try { fn(); } finally { try { rmSync(path, { recursive: true, force: true }); } catch {} }
  return true;
}
function drainDeliveries(to: string, submitDelayMs = 750, pollMs = 1000): number {
  let delivered = 0;
  withLock(`deliver-${to}`, () => {
    for (;;) {
      const next = readDeliveries(to)[0];
      if (!next) break;
      injectText(to, next.text, submitDelayMs, pollMs);
      removeDelivery(next);
      delivered += 1;
      sleep(pollMs);
    }
  });
  return delivered;
}
function inject(args: string[]): never { const { target, text, submitDelayMs, pollMs } = parseInjectArgs(args); injectText(target, text, submitDelayMs, pollMs); process.exit(0); }
function watch(args: string[]): never {
  const target = requireValue(args.shift(), "target name or id");
  let watcher: string | undefined;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--watcher") watcher = requireValue(args.shift(), "--watcher value"); else fail(`unknown option: ${arg ?? ""}`);
  }
  const targetTerminal = terminalIdFor(target);
  const watcherTerminal = watcher ? terminalIdFor(watcher) : (focusedPane().terminal_id ?? fail("focused pane has no terminal_id"));
  let saved = false;
  while (!saved) {
    saved = withLock("state", () => {
      const state = loadState();
      const watchers = new Set(state.watches[targetTerminal] ?? []);
      watchers.add(watcherTerminal);
      state.watches[targetTerminal] = [...watchers];
      saveState(state);
    });
    if (!saved) sleep(100);
  }
  console.log(JSON.stringify({ awaiting: targetTerminal, watcher: watcherTerminal, mode: "once" }));
  process.exit(0);
}
function complete(args: string[]): never {
  const target = requireValue(args.shift(), "target name or id");
  let message: string | undefined;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--message") message = requireValue(args.shift(), "--message value"); else fail(`unknown option: ${arg ?? ""}`);
  }
  if (!message) fail("missing --message");
  const targetTerminal = terminalIdFor(target);
  let watchers: string[] = [];
  let saved = false;
  while (!saved) {
    saved = withLock("state", () => {
      const state = loadState();
      watchers = state.watches[targetTerminal] ?? [];
      delete state.watches[targetTerminal];
      saveState(state);
    });
    if (!saved) sleep(100);
  }
  const createdAt = new Date().toISOString();
  for (const watcherTerminal of watchers) {
    enqueueDelivery({
      id: `${createdAt}_${process.pid}_${Math.random().toString(16).slice(2)}`,
      to: watcherTerminal,
      from: targetTerminal,
      text: `[courier complete]\ntarget: ${targetTerminal}\n\n${message}`,
      createdAt,
    });
  }
  const delivered = [...new Set(watchers)].reduce((sum, watcherTerminal) => sum + drainDeliveries(watcherTerminal), 0);
  console.log(JSON.stringify({ target: targetTerminal, queued: watchers.length, delivered, consumed: watchers.length }));
  process.exit(0);
}
function deliver(args: string[]): never {
  const target = requireValue(args.shift(), "name or id");
  if (args.length > 0) fail(`unknown option: ${args[0]}`);
  const terminalId = terminalIdFor(target);
  const delivered = drainDeliveries(terminalId);
  console.log(JSON.stringify({ target: terminalId, delivered, queued: readDeliveries(terminalId).length }));
  process.exit(0);
}
function closeOrSuspend(args: string[], mode: "close" | "suspend"): never {
  const target = requireValue(args.shift(), "name or id");
  if (args.length > 0) fail(`unknown option: ${args[0]}`);
  const state = loadState();
  const record = state.agents[target];
  const pane = resolveTarget(target);
  if (!pane?.pane_id) fail(`target is gone or unavailable: ${target}`);
  const terminalId = pane.terminal_id ?? record?.terminalId;
  runHerdr(["pane", "close", pane.pane_id], false);
  if (terminalId) {
    delete state.watches[terminalId];
    try { rmSync(deliveryPath(terminalId), { recursive: true, force: true }); } catch {}
    try { rmSync(join(lockDir, `${safeFilePart(terminalId)}.lock`), { recursive: true, force: true }); } catch {}
    for (const [watched, watchers] of Object.entries(state.watches)) {
      state.watches[watched] = watchers.filter((watcher) => watcher !== terminalId);
      if (state.watches[watched].length === 0) delete state.watches[watched];
    }
  }
  if (record) {
    if (mode === "close") delete state.agents[target];
    else state.agents[target] = { ...record, closedAt: new Date().toISOString() };
  }
  saveState(state);
  console.log(JSON.stringify({ [mode]: target, terminalId: terminalId ?? null, retained: Boolean(record && mode === "suspend") }));
  process.exit(0);
}
function debugList(): never {
  const state = loadState();
  const agents = Object.values(state.agents).map((record) => {
    const current = resolveHerdrTarget(record.terminalId);
    return {
      name: record.name,
      terminalId: record.terminalId,
      recordedPaneId: record.paneId,
      currentPaneId: current?.pane_id ?? null,
      status: current?.agent_status ?? "gone",
      agent: current ? record.agent : null,
      role: record.role ?? null,
      agentSession: current?.agent_session ?? record.agentSession ?? null,
      closedAt: record.closedAt ?? null,
    };
  });
  const queuedDeliveries = existsSync(deliveryDir)
    ? Object.fromEntries(readdirSync(deliveryDir).map((to) => [to, readDeliveries(to).length]).filter(([, count]) => Number(count) > 0))
    : {};
  console.log(JSON.stringify({ agents, watches: state.watches, queuedDeliveries }, null, 2));
  process.exit(0);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === "--help" || cmd === "-h") { console.log(usage()); process.exit(0); }
switch (cmd) {
  case "create": case "open-agent": case "agent": create(args); break;
  case "watch": watch(args); break;
  case "complete": complete(args); break;
  case "deliver": deliver(args); break;
  case "inject": inject(args); break;
  case "close": closeOrSuspend(args, "close"); break;
  case "suspend": closeOrSuspend(args, "suspend"); break;
  case "debug-list": debugList(); break;
  default: fail(`unknown command: ${cmd}`);
}
