import type { CreateOptions, Pane } from "./types.js";
import { HerdrAdapter } from "./herdr.js";
import { CourierStore } from "./store.js";

export class PlacementPlanner {
  constructor(private herdr: HerdrAdapter, private store: CourierStore) {}

  workerContainmentPane(): Pane | undefined {
    const state = this.store.loadState();
    for (const record of Object.values(state.agents)) {
      if (record.role !== "worker") continue;
      const pane = this.herdr.resolve(record.terminalId);
      if (pane?.pane_id) return pane;
    }
    return undefined;
  }

  createPane(opts: CreateOptions, requestedSource: Pane): Pane {
    if (opts.tab) return this.herdr.createTab(requiredWorkspace(requestedSource), opts.name, opts.tail);

    if (opts.role === "worker") {
      const contained = this.workerContainmentPane();
      if (contained?.pane_id) return this.herdr.splitPane(contained.pane_id, opts.tail);
      return this.herdr.createTab(requiredWorkspace(requestedSource), "courier-workers", opts.tail);
    }

    return this.herdr.splitPane(requestedSource.pane_id, opts.tail);
  }
}

function requiredWorkspace(pane: Pane): string {
  if (!pane.workspace_id) throw new Error("source pane has no workspace_id");
  return pane.workspace_id;
}
