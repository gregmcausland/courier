import type { CreateOptions, CreateResult, Pane } from "./types.js";
import { DeliveryPump } from "./delivery.js";
import { HerdrAdapter } from "./herdr.js";
import { PlacementPlanner } from "./placement.js";
import { agentCommand, rolePrompt } from "./prompts.js";
import { CourierStore } from "./store.js";

export class CourierRuntime {
  readonly delivery: DeliveryPump;
  readonly placement: PlacementPlanner;

  constructor(readonly herdr = new HerdrAdapter(), readonly store = new CourierStore()) {
    this.delivery = new DeliveryPump(herdr, store, (target) => this.resolveTarget(target));
    this.placement = new PlacementPlanner(herdr, store);
  }

  resolveTarget(target: string): Pane | undefined {
    const alias = this.store.getAgent(target);
    return this.herdr.resolve(alias?.terminalId ?? target);
  }

  terminalIdFor(target: string): string {
    const pane = this.resolveTarget(target);
    if (!pane?.terminal_id) throw new Error(`target is gone or unavailable: ${target}`);
    return pane.terminal_id;
  }

  focusedPane(): Pane {
    const focused = this.herdr.focusedPane();
    if (!focused) throw new Error("could not find focused Herdr pane");
    return focused;
  }

  create(opts: CreateOptions): CreateResult {
    const requestedSource = opts.from ? (this.resolveTarget(opts.from) ?? fail(`source is gone or unavailable: ${opts.from}`)) : this.focusedPane();
    const pane = this.placement.createPane(opts, requestedSource);
    if (!pane.pane_id || !pane.terminal_id) throw new Error("herdr create did not return pane_id and terminal_id");

    this.herdr.renamePane(pane.pane_id, opts.name);
    const promptPath = this.store.writePromptFile(opts.name, rolePrompt(opts.role, opts.name));
    this.herdr.runInPane(pane.pane_id, agentCommand(opts.agent, opts.name, promptPath));
    this.herdr.renameAgent(pane.terminal_id, opts.name);

    const settledPane = this.herdr.waitForAgentSession(pane.terminal_id) ?? pane;
    this.store.addAgent({ name: opts.name, terminalId: pane.terminal_id, paneId: settledPane.pane_id, agent: opts.agent, role: opts.role, agentSession: settledPane.agent_session, createdAt: new Date().toISOString() });
    return { name: opts.name, terminalId: pane.terminal_id, paneId: settledPane.pane_id, agent: opts.agent, role: opts.role, agentSession: settledPane.agent_session };
  }

  inject(target: string, text: string, submitDelayMs?: number, pollMs?: number): void { this.delivery.injectText(target, text, submitDelayMs, pollMs); }

  watch(target: string, watcher?: string): { awaiting: string; watcher: string; mode: "once" } {
    const targetTerminal = this.terminalIdFor(target);
    const watcherTerminal = watcher ? this.terminalIdFor(watcher) : (this.focusedPane().terminal_id ?? fail("focused pane has no terminal_id"));
    this.store.registerWatch(targetTerminal, watcherTerminal);
    return { awaiting: targetTerminal, watcher: watcherTerminal, mode: "once" };
  }

  complete(target: string, message: string): { target: string; queued: number; delivered: number; consumed: number } {
    const targetTerminal = this.terminalIdFor(target);
    const watchers = this.store.consumeWatchers(targetTerminal);
    const createdAt = new Date().toISOString();
    for (const watcherTerminal of watchers) this.delivery.enqueueCompletion(watcherTerminal, targetTerminal, message, createdAt);
    const delivered = [...new Set(watchers)].reduce((sum, watcherTerminal) => sum + this.delivery.drain(watcherTerminal), 0);
    return { target: targetTerminal, queued: watchers.length, delivered, consumed: watchers.length };
  }

  deliver(target: string): { target: string; delivered: number; queued: number } {
    const terminalId = this.terminalIdFor(target);
    const delivered = this.delivery.drain(terminalId);
    return { target: terminalId, delivered, queued: this.store.readDeliveries(terminalId).length };
  }

  closeOrSuspend(target: string, mode: "close" | "suspend"): { [key: string]: string | boolean | null } {
    const pane = this.resolveTarget(target);
    if (!pane?.pane_id) throw new Error(`target is gone or unavailable: ${target}`);
    const terminalId = pane.terminal_id;
    const record = this.store.getAgent(target) ?? (terminalId ? this.store.findAgentByTerminalId(terminalId) : undefined);
    this.herdr.closePane(pane.pane_id);
    if (terminalId) this.store.cleanupTerminal(terminalId);
    if (record) this.store.forgetOrSuspendAgent(record.name, mode);
    return { [mode]: record?.name ?? target, terminalId: terminalId ?? null, retained: Boolean(record && mode === "suspend") };
  }

  debugList(): object {
    const state = this.store.loadState();
    const agents = Object.values(state.agents).map((record) => {
      const current = this.herdr.resolve(record.terminalId);
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
    return { agents, watches: state.watches, queuedDeliveries: this.store.queuedDeliveryCounts() };
  }
}

function fail(message: string): never { throw new Error(message); }
