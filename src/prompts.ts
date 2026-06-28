import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Role, WorkerType } from "./types.js";
import { shellQuote } from "./util.js";

export function defaultRole(name: string): Role {
  if (name.toLowerCase().includes("commander")) return "commander";
  if (name.toLowerCase().includes("worker")) return "worker";
  return "none";
}

export const knownWorkerTypes = ["triage"] as const satisfies readonly WorkerType[];

export function isKnownWorkerType(value: string): value is WorkerType {
  return (knownWorkerTypes as readonly string[]).includes(value);
}

export function rolePrompt(role: Role, name: string, type?: WorkerType): string {
  if (type && !isKnownWorkerType(type)) throw new Error(`unknown worker type: ${type}. Known worker types: ${knownWorkerTypes.join(", ")}`);
  if (type && role !== "worker") throw new Error(`worker type ${type} requires role worker`);

  const context = { name, courier: courierInvocation() };
  const parts = [renderTemplate("base.md", context)];
  if (role === "commander") parts.push(renderTemplate("commander.md", context));
  if (role === "worker") parts.push(renderTemplate("worker.md", context));
  if (type) parts.push(renderTemplate(join("types", `${type}.md`), context));
  return parts.join("\n\n");
}

function renderTemplate(file: string, values: Record<string, string>): string {
  let template = readFileSync(join(templateDir(), file), "utf8");
  for (const [key, value] of Object.entries(values)) template = template.replaceAll(`{{${key}}}`, value);
  return template.trim();
}

function templateDir(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), "prompts");
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
