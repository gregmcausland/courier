import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerType } from "./types.js";
import { shellQuote } from "./util.js";

export const knownWorkerTypes = ["triage"] as const satisfies readonly WorkerType[];

export function isKnownWorkerType(value: string): value is WorkerType {
  return (knownWorkerTypes as readonly string[]).includes(value);
}

// A persona is an opt-in, durable specialization attached at launch via the
// agent's own system-prompt flag. Courier-awareness is intentionally NOT baked
// in here: an agent learns how to reply from the request-time trailer, so a
// persona only describes domain behavior and can't drift from the reply contract.
export function personaPrompt(type: WorkerType): string {
  if (!isKnownWorkerType(type)) throw new Error(`unknown type: ${type}. Known types: ${knownWorkerTypes.join(", ")}`);
  return renderTemplate(join("types", `${type}.md`), {}).trim();
}

// The trailer appended to every `request` payload. This is the single place
// Courier-awareness is injected, so any pane — spawned by Courier or not, with a
// persona or plain — knows how to reply the moment it receives work.
export function requestTrailer(): string {
  const courier = courierInvocation();
  return [
    "---",
    "IMPORTANT — required final step. When you finish the task, do not just write your answer as a message. You MUST run this exact command, replacing <your result> with your answer:",
    "",
    `  ${courier} respond --message "<your result>"`,
    "",
    "Your answer is not delivered and the task is not complete until you run that command.",
  ].join("\n");
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
  // Explicit override wins, then a global install (invoked as `courier`, e.g. via
  // install.sh's symlink), then the local build path as a `node <cli.js>` command.
  if (process.env.COURIER_COMMAND) return process.env.COURIER_COMMAND;
  const invokedAs = process.argv[1] ? basename(process.argv[1]) : "";
  if (invokedAs === "courier") return "courier";
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
    if (promptPath) parts.push(shellQuote(`Use the persona instructions in ${promptPath} for this session. Respond with nothing.`));
    return parts.join(" ");
  }
  return agent;
}
