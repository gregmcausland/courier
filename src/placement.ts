import type { CreateOptions, Pane } from "./types.js";
import { HerdrAdapter } from "./herdr.js";

export class PlacementPlanner {
  constructor(private herdr: HerdrAdapter) {}

  createPane(opts: CreateOptions, requestedSource: Pane): Pane {
    if (opts.tab) return this.herdr.createTab(requiredWorkspace(requestedSource), opts.name, opts.tail);
    return this.herdr.splitPane(requestedSource.pane_id, opts.tail);
  }
}

function requiredWorkspace(pane: Pane): string {
  if (!pane.workspace_id) throw new Error("source pane has no workspace_id");
  return pane.workspace_id;
}
