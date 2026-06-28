import type { CreateOptions, Role, WorkerType } from "./types.js";
import { defaultRole, isKnownWorkerType, knownWorkerTypes } from "./prompts.js";

export type Command =
  | { kind: "help" }
  | { kind: "create"; options: CreateOptions }
  | { kind: "commander"; options: CreateOptions }
  | { kind: "inject"; target: string; text: string; submitDelayMs: number; pollMs: number }
  | { kind: "watch"; target: string; watcher?: string }
  | { kind: "complete"; target?: string; message: string }
  | { kind: "deliver"; target: string }
  | { kind: "close" | "suspend"; target: string }
  | { kind: "debug-list" };

export function usage(): string {
  return `Usage:
  courier commander [NAME] [--agent COMMAND] [--from PANE_OR_TERMINAL_ID] [--tab] [--cwd PATH] [--focus|--no-focus]
  courier create <NAME> [--role commander|worker|none] [--type triage] [--agent COMMAND] [--from PANE_OR_TERMINAL_ID] [--tab] [--cwd PATH] [--focus|--no-focus]
  courier inject <NAME_OR_PANE_OR_TERMINAL_ID> --text TEXT [--submit-delay-ms 750] [--poll-ms 1000]
  courier watch <TARGET_NAME_OR_ID> [--watcher NAME_OR_ID]
  courier complete [TARGET_NAME_OR_ID] --message TEXT   (target defaults to the calling pane)
  courier deliver <NAME_OR_PANE_OR_TERMINAL_ID>
  courier close <NAME_OR_PANE_OR_TERMINAL_ID>
  courier suspend <NAME_OR_PANE_OR_TERMINAL_ID>

Courier records created agents by name. courier commander launches a default commander named commander with Claude Code in the current pane unless --tab is passed. Worker creates are contained in a shared worker tab by default; pass --tab to open a discrete tab. Watches are one-shot awaits consumed by complete.
Default worker agent: pi. Use --agent claude for Claude Code or --agent cursor for Cursor Agent.
`;
}

export function parse(argv: string[]): Command {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") return { kind: "help" };
  switch (cmd) {
    case "commander": return { kind: "commander", options: parseCommanderArgs(args) };
    case "create": case "open-agent": case "agent": return { kind: "create", options: parseCreateArgs(args) };
    case "inject": return { kind: "inject", ...parseInjectArgs(args) };
    case "watch": return { kind: "watch", ...parseWatchArgs(args) };
    case "complete": return { kind: "complete", ...parseCompleteArgs(args) };
    case "deliver": return { kind: "deliver", target: parseSingleTarget(args) };
    case "close": return { kind: "close", target: parseSingleTarget(args) };
    case "suspend": return { kind: "suspend", target: parseSingleTarget(args) };
    case "debug-list": return { kind: "debug-list" };
    default: throw new Error(`unknown command: ${cmd}`);
  }
}

function parseCommanderArgs(args: string[]): CreateOptions {
  let name = "commander"; let from: string | undefined; let tab = false; let agent = "claude"; const tail: string[] = [];
  if (args[0] && !args[0].startsWith("--")) name = requireValue(args.shift(), "name");
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--agent": agent = requireValue(args.shift(), "--agent value"); break;
      case "--from": from = requireValue(args.shift(), "--from value"); break;
      case "--tab": tab = true; break;
      case "--cwd": tail.push("--cwd", requireValue(args.shift(), "--cwd value")); break;
      case "--focus": case "--no-focus": tail.push(arg); break;
      case "--role": throw new Error("courier commander always uses --role commander");
      case "--split": throw new Error("--split is no longer part of the Courier interface; use default placement or --tab");
      default: throw new Error(`unknown option: ${arg ?? ""}`);
    }
  }
  return { name, from, tab, here: !tab, tail, agent, role: "commander" };
}

function parseCreateArgs(args: string[]): CreateOptions {
  const name = requireValue(args.shift(), "name");
  let from: string | undefined; let tab = false; let agent = "pi"; let role: Role = defaultRole(name); let explicitRole: Role | undefined; let type: WorkerType | undefined; const tail: string[] = [];
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--agent": agent = requireValue(args.shift(), "--agent value"); break;
      case "--role": { const value = requireValue(args.shift(), "--role value"); if (value !== "commander" && value !== "worker" && value !== "none") throw new Error("--role must be commander, worker, or none"); role = value; explicitRole = value; break; }
      case "--type": { const value = requireValue(args.shift(), `--type value (${knownWorkerTypes.join("|")})`); if (!isKnownWorkerType(value)) throw new Error(`--type must be one of: ${knownWorkerTypes.join(", ")}`); type = value; break; }
      case "--from": from = requireValue(args.shift(), "--from value"); break;
      case "--tab": tab = true; break;
      case "--cwd": tail.push("--cwd", requireValue(args.shift(), "--cwd value")); break;
      case "--focus": case "--no-focus": tail.push(arg); break;
      case "--split": throw new Error("--split is no longer part of the Courier interface; use default containment or --tab");
      default: throw new Error(`unknown option: ${arg ?? ""}`);
    }
  }
  if (type) {
    if (explicitRole && explicitRole !== "worker") throw new Error("--type requires --role worker; remove the conflicting --role or use --role worker");
    role = "worker";
  }
  return { name, from, tab, tail, agent, role, type };
}

function parseInjectArgs(args: string[]): { target: string; text: string; submitDelayMs: number; pollMs: number } {
  const target = requireValue(args.shift(), "name or id"); let text: string | undefined; let submitDelayMs = 750; let pollMs = 1000;
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--text": text = requireValue(args.shift(), "--text value"); break;
      case "--submit-delay-ms": submitDelayMs = Number(requireValue(args.shift(), "--submit-delay-ms value")); break;
      case "--poll-ms": pollMs = Number(requireValue(args.shift(), "--poll-ms value")); break;
      default: throw new Error(`unknown option: ${arg ?? ""}`);
    }
  }
  if (!text) throw new Error("missing --text");
  return { target, text, submitDelayMs, pollMs };
}

function parseWatchArgs(args: string[]): { target: string; watcher?: string } {
  const target = requireValue(args.shift(), "target name or id"); let watcher: string | undefined;
  while (args.length > 0) { const arg = args.shift(); if (arg === "--watcher") watcher = requireValue(args.shift(), "--watcher value"); else throw new Error(`unknown option: ${arg ?? ""}`); }
  return { target, watcher };
}

function parseCompleteArgs(args: string[]): { target?: string; message: string } {
  // Target is optional and defaults to the calling pane. A leading positional
  // (not starting with --) is treated as an explicit completer.
  let target: string | undefined; let message: string | undefined;
  if (args[0] && !args[0].startsWith("--")) target = args.shift();
  while (args.length > 0) { const arg = args.shift(); if (arg === "--message") message = requireValue(args.shift(), "--message value"); else throw new Error(`unknown option: ${arg ?? ""}`); }
  if (!message) throw new Error("missing --message");
  return { target, message };
}

function parseSingleTarget(args: string[]): string {
  const target = requireValue(args.shift(), "name or id");
  if (args.length > 0) throw new Error(`unknown option: ${args[0]}`);
  return target;
}
function requireValue(value: string | undefined, name: string): string { if (!value) throw new Error(`missing ${name}`); return value; }
