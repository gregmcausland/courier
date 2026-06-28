import { spawnSync } from "node:child_process";
import type { AgentSessionRef, Pane } from "./types.js";
import { sleep } from "./util.js";

type PaneListResponse = { result?: { panes?: Pane[] } };
type PaneInfoResponse = { result?: { pane?: Pane; root_pane?: Pane; agent?: Pane } };
type HerdrResult = { status: number; stdout: string; stderr: string };

export class HerdrAdapter {
  raw(args: string[]): HerdrResult {
    const result = spawnSync("herdr", args, { encoding: "utf8", shell: false });
    if (result.error) throw new Error(`failed to run herdr: ${result.error.message}`);
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  run(args: string[], print = true): string {
    const result = this.raw(args);
    if (result.status !== 0) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      const error = new Error(`herdr ${args.join(" ")} failed with ${result.status}`) as Error & { status?: number };
      error.status = result.status;
      throw error;
    }
    if (print && result.stdout) process.stdout.write(result.stdout);
    return result.stdout;
  }

  parsePaneInfo(output: string): Pane | undefined {
    const parsed = JSON.parse(output) as PaneInfoResponse;
    return parsed.result?.pane ?? parsed.result?.root_pane ?? parsed.result?.agent;
  }

  resolve(target: string): Pane | undefined {
    let result = this.raw(["pane", "get", target]);
    if (result.status === 0) { try { return this.parsePaneInfo(result.stdout); } catch { return undefined; } }
    result = this.raw(["agent", "get", target]);
    if (result.status === 0) { try { return this.parsePaneInfo(result.stdout); } catch { return undefined; } }
    return undefined;
  }

  listPanes(): Pane[] {
    const output = this.run(["pane", "list"], false);
    const parsed = JSON.parse(output) as PaneListResponse;
    return parsed.result?.panes ?? [];
  }

  focusedPane(): Pane | undefined { return this.listPanes().find((pane) => pane.focused); }

  waitUntilInjectable(resolve: () => Pane | undefined, targetLabel: string, pollMs: number): Pane {
    for (;;) {
      const pane = resolve();
      if (!pane) throw new Error(`target is gone or unavailable: ${targetLabel}`);
      if (pane.agent_status === "idle" || pane.agent_status === "done") return pane;
      sleep(pollMs);
    }
  }

  waitForAgentSession(target: string, timeoutMs = 10000, pollMs = 500): Pane | undefined {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pane = this.resolve(target);
      if (pane?.agent_session) return pane;
      sleep(pollMs);
    }
    return this.resolve(target);
  }

  createTab(workspaceId: string, label: string, tail: string[]): Pane {
    const pane = this.parsePaneInfo(this.run(["tab", "create", "--workspace", workspaceId, "--label", label, ...tail]));
    if (!pane) throw new Error("herdr tab create did not return a pane");
    return pane;
  }

  splitPane(paneId: string, tail: string[]): Pane {
    const pane = this.parsePaneInfo(this.run(["pane", "split", paneId, "--direction", "right", ...tail]));
    if (!pane) throw new Error("herdr pane split did not return a pane");
    return pane;
  }

  renamePane(paneId: string, name: string): void { this.run(["pane", "rename", paneId, name], false); }
  renameAgent(terminalId: string, name: string): void { this.run(["agent", "rename", terminalId, name], false); }
  runInPane(paneId: string, command: string): void { this.run(["pane", "run", paneId, command]); }
  sendText(paneId: string, text: string): void { this.run(["pane", "send-text", paneId, text], false); }
  submit(paneId: string): void { this.run(["pane", "send-keys", paneId, "Enter"], false); }
  closePane(paneId: string): void { this.run(["pane", "close", paneId], false); }
}
