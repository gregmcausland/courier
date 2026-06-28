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

  // The pane running this command. Herdr exports HERDR_PANE_ID into each pane,
  // so a worker calling `complete` resolves to itself reliably (the focused pane
  // is whatever the human is looking at, which is usually not the caller).
  selfPane(): Pane {
    const paneId = process.env.HERDR_PANE_ID;
    const pane = (paneId ? this.herdr.resolve(paneId) : undefined) ?? this.herdr.focusedPane();
    if (!pane) throw new Error("could not determine the calling pane (HERDR_PANE_ID unset and no focused pane)");
    return pane;
  }

  selfTerminal(): string {
    return this.selfPane().terminal_id ?? fail("calling pane has no terminal_id");
  }

  create(opts: CreateOptions): CreateResult {
    const requestedSource = opts.from ? (this.resolveTarget(opts.from) ?? fail(`source is gone or unavailable: ${opts.from}`)) : this.focusedPane();
    const pane = opts.here ? requestedSource : this.placement.createPane(opts, requestedSource);
    if (!pane.pane_id || !pane.terminal_id) throw new Error("herdr create did not return pane_id and terminal_id");

    this.herdr.renamePane(pane.pane_id, opts.name);
    const promptPath = this.store.writePromptFile(opts.name, rolePrompt(opts.role, opts.name, opts.type));
    this.herdr.runInPane(pane.pane_id, agentCommand(opts.agent, opts.name, promptPath));
    this.herdr.renameAgent(pane.terminal_id, opts.name);

    const settledPane = this.herdr.waitForAgentSession(pane.terminal_id) ?? pane;
    this.store.addAgent({ name: opts.name, terminalId: pane.terminal_id, paneId: settledPane.pane_id, agent: opts.agent, role: opts.role, type: opts.type, agentSession: settledPane.agent_session, createdAt: new Date().toISOString() });
    return { name: opts.name, terminalId: pane.terminal_id, paneId: settledPane.pane_id, agent: opts.agent, role: opts.role, type: opts.type, agentSession: settledPane.agent_session };
  }

  inject(target: string, text: string, submitDelayMs?: number, pollMs?: number): void { this.delivery.injectText(target, text, submitDelayMs, pollMs); }

  watch(target: string, watcher?: string): { awaiting: string; watcher: string; mode: "once"; recovered: number } {
    const targetTerminal = this.terminalIdFor(target);
    const watcherTerminal = watcher ? this.terminalIdFor(watcher) : this.selfTerminal();
    this.store.registerWatch(targetTerminal, watcherTerminal);
    // Self-heal: if the target already completed while no watch was armed, its
    // completion was buffered under its own terminal. Re-key it to this watcher
    // and consume the watch we just registered so it behaves like a normal delivery.
    let recovered = 0;
    if (this.delivery.redeliverPending(targetTerminal, watcherTerminal) > 0) {
      this.store.consumeWatchers(targetTerminal);
      recovered = this.delivery.drain(watcherTerminal);
    }
    return { awaiting: targetTerminal, watcher: watcherTerminal, mode: "once", recovered };
  }

  complete(target: string | undefined, message: string): { target: string; queued: number; delivered: number; consumed: number; buffered: number } {
    const targetTerminal = target ? this.terminalIdFor(target) : this.selfTerminal();
    const watchers = this.store.consumeWatchers(targetTerminal);
    const createdAt = new Date().toISOString();
    for (const watcherTerminal of watchers) this.delivery.enqueueCompletion(watcherTerminal, targetTerminal, message, createdAt);
    const delivered = [...new Set(watchers)].reduce((sum, watcherTerminal) => sum + this.delivery.drain(watcherTerminal), 0);
    // No live watcher: buffer the completion under this terminal so it is never
    // silently lost. A later `watch` on this target will pick it up.
    let buffered = 0;
    if (watchers.length === 0) { this.delivery.bufferCompletion(targetTerminal, message, createdAt); buffered = 1; }
    return { target: targetTerminal, queued: watchers.length, delivered, consumed: watchers.length, buffered };
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
        type: record.type ?? null,
        agentSession: current?.agent_session ?? record.agentSession ?? null,
        closedAt: record.closedAt ?? null,
      };
    });
    return { agents, watches: state.watches, queuedDeliveries: this.store.queuedDeliveryCounts() };
  }
}

function fail(message: string): never { throw new Error(message); }
