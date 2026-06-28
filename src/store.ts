import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentRecord, Delivery, State } from "./types.js";
import { safeFilePart } from "./util.js";

export class CourierStore {
  readonly statePath: string;
  readonly promptDir: string;
  readonly deliveryDir: string;
  readonly lockDir: string;

  constructor(readonly rootDir = join(process.cwd(), ".courier")) {
    this.statePath = join(rootDir, "state.json");
    this.promptDir = join(rootDir, "prompts");
    this.deliveryDir = join(rootDir, "deliveries");
    this.lockDir = join(rootDir, "locks");
  }

  loadState(): State {
    if (!existsSync(this.statePath)) return { version: 1, agents: {}, watches: {} };
    const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<State>;
    return { version: 1, agents: raw.agents ?? {}, watches: raw.watches ?? {} };
  }

  saveState(state: State): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  updateState(mutator: (state: State) => void): void {
    this.withLock("state", () => { const state = this.loadState(); mutator(state); this.saveState(state); }, 120000, true);
  }

  addAgent(record: AgentRecord): void { this.updateState((state) => { state.agents[record.name] = record; }); }
  getAgent(name: string): AgentRecord | undefined { return this.loadState().agents[name]; }
  findAgentByTerminalId(terminalId: string): AgentRecord | undefined { return Object.values(this.loadState().agents).find((record) => record.terminalId === terminalId); }

  registerWatch(targetTerminal: string, watcherTerminal: string): void {
    this.updateState((state) => {
      const watchers = new Set(state.watches[targetTerminal] ?? []);
      watchers.add(watcherTerminal);
      state.watches[targetTerminal] = [...watchers];
    });
  }

  consumeWatchers(targetTerminal: string): string[] {
    let watchers: string[] = [];
    this.updateState((state) => { watchers = state.watches[targetTerminal] ?? []; delete state.watches[targetTerminal]; });
    return watchers;
  }

  forgetOrSuspendAgent(name: string, mode: "close" | "suspend"): void {
    this.updateState((state) => {
      const record = state.agents[name];
      if (!record) return;
      if (mode === "close") delete state.agents[name];
      else state.agents[name] = { ...record, closedAt: new Date().toISOString() };
    });
  }

  cleanupTerminal(terminalId: string): void {
    this.updateState((state) => {
      delete state.watches[terminalId];
      for (const [watched, watchers] of Object.entries(state.watches)) {
        state.watches[watched] = watchers.filter((watcher) => watcher !== terminalId);
        if (state.watches[watched].length === 0) delete state.watches[watched];
      }
    });
    rmSync(this.deliveryPath(terminalId), { recursive: true, force: true });
    rmSync(join(this.lockDir, `${safeFilePart(`deliver-${terminalId}`)}.lock`), { recursive: true, force: true });
  }

  writePromptFile(name: string, prompt: string): string {
    mkdirSync(this.promptDir, { recursive: true });
    const path = join(this.promptDir, `${safeFilePart(name)}.md`);
    writeFileSync(path, `${prompt}\n`);
    return path;
  }

  deliveryPath(to: string): string { return join(this.deliveryDir, safeFilePart(to)); }
  deliveryFile(to: string, id: string): string { return join(this.deliveryPath(to), `${safeFilePart(id)}.json`); }

  enqueueDelivery(delivery: Delivery): void {
    mkdirSync(this.deliveryPath(delivery.to), { recursive: true });
    writeFileSync(this.deliveryFile(delivery.to, delivery.id), `${JSON.stringify(delivery, null, 2)}\n`);
  }

  readDeliveries(to: string): Delivery[] {
    const dir = this.deliveryPath(to);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((file) => file.endsWith(".json")).sort().map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as Delivery);
  }

  removeDelivery(delivery: Delivery): void { try { unlinkSync(this.deliveryFile(delivery.to, delivery.id)); } catch {} }

  queuedDeliveryCounts(): Record<string, number> {
    if (!existsSync(this.deliveryDir)) return {};
    return Object.fromEntries(readdirSync(this.deliveryDir).map((to) => [to, this.readDeliveries(to).length]).filter(([, count]) => Number(count) > 0));
  }

  withLock(name: string, fn: () => void, staleMs = 120000, wait = false): boolean {
    for (;;) {
      const acquired = this.tryWithLock(name, fn, staleMs);
      if (acquired || !wait) return acquired;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }

  private tryWithLock(name: string, fn: () => void, staleMs: number): boolean {
    mkdirSync(this.lockDir, { recursive: true });
    const path = join(this.lockDir, `${safeFilePart(name)}.lock`);
    try { mkdirSync(path); }
    catch {
      try {
        const owner = this.lockOwnerPid(path);
        const ownerDead = owner !== undefined && !this.processIsAlive(owner);
        const stale = Date.now() - statSync(path).mtimeMs > staleMs;
        if (ownerDead || stale) { rmSync(path, { recursive: true, force: true }); mkdirSync(path); }
        else return false;
      } catch { return false; }
    }
    writeFileSync(join(path, "owner.json"), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    try { fn(); } finally { rmSync(path, { recursive: true, force: true }); }
    return true;
  }

  private processIsAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
  private lockOwnerPid(path: string): number | undefined {
    try { const data = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { pid?: number }; return typeof data.pid === "number" ? data.pid : undefined; }
    catch { return undefined; }
  }
}
