import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Role } from "./types.js";
import { shellQuote } from "./util.js";

export function defaultRole(name: string): Role {
  if (name.toLowerCase().includes("commander")) return "commander";
  if (name.toLowerCase().includes("worker")) return "worker";
  return "none";
}

export function rolePrompt(role: Role, name: string): string {
  const courier = courierInvocation();
  const base = `COURIER NAME: ${name}. IMPORTANT: If you receive a [courier request], do the task and finish by running: ${courier} complete ${name} --message "<result>". IMPORTANT: If you receive [courier complete], it is a result notification only. DO NOT call complete in response to [courier complete].`;
  if (role === "commander") return `${base} COMMANDER: To delegate, run: ${courier} create <worker-name>; ${courier} watch <worker-name> --watcher ${name}; ${courier} inject <worker-name> --text "[courier request] <task>". After injecting one dependent task, STOP and return idle.`;
  if (role === "worker") return `${base} WORKER: Do not message commanders directly; use complete.`;
  return base;
}

function courierInvocation(): string {
  if (process.env.COURIER_COMMAND) return process.env.COURIER_COMMAND;
  return `node ${shellQuote(join(dirname(fileURLToPath(import.meta.url)), "cli.js"))}`;
}

export function agentCommand(agent: string, name: string, promptPath: string | undefined): string {
  if (agent === "pi") return promptPath ? `pi --append-system-prompt ${shellQuote(promptPath)}` : "pi";
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
