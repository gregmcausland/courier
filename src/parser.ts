import type { CreateOptions, WorkerType } from "./types.js";
import { isKnownWorkerType, knownWorkerTypes } from "./prompts.js";

export type Command =
  | { kind: "help" }
  | { kind: "create"; options: CreateOptions }
  | { kind: "commander"; options: CreateOptions }
  | { kind: "request"; target: string; text: string; submitDelayMs: number; pollMs: number; awaitReply: boolean; awaitPollMs: number; awaitTimeoutMs: number }
  | { kind: "inject"; target: string; text: string; submitDelayMs: number; pollMs: number }
  | { kind: "watch"; target: string; watcher?: string }
  | { kind: "respond"; target?: string; message: string }
  | { kind: "deliver"; target: string }
  | { kind: "close" | "suspend"; target: string }
  | { kind: "debug-list" };

export function usage(): string {
  return `Usage:
  courier create <NAME> [--type ${knownWorkerTypes.join("|")}] [--agent COMMAND] [--from PANE_OR_TERMINAL_ID] [--tab] [--cwd PATH] [--focus|--no-focus]
  courier commander [NAME] [--agent COMMAND] [--from PANE_OR_TERMINAL_ID] [--tab] [--cwd PATH] [--focus|--no-focus]
  courier request <TARGET_NAME_OR_ID> --text TEXT [--submit-delay-ms 750] [--poll-ms 1000] [--await [--await-timeout-ms 0] [--await-poll-ms 500]]
  courier respond [TARGET_NAME_OR_ID] --message TEXT   (target defaults to the calling pane)
  courier inject <TARGET_NAME_OR_ID> --text TEXT [--submit-delay-ms 750] [--poll-ms 1000]
  courier watch <TARGET_NAME_OR_ID> [--watcher NAME_OR_ID]
  courier deliver <NAME_OR_PANE_OR_TERMINAL_ID>
  courier close <NAME_OR_PANE_OR_TERMINAL_ID>
  courier suspend <NAME_OR_PANE_OR_TERMINAL_ID>

Courier is an agent-agnostic messaging layer over Herdr panes. Any pane can address any other.

  request = arm a one-shot watch back to the calling pane, then inject TEXT plus a reply trailer
            that tells the target how to respond. This is the normal way to hand off work.
            --await instead BLOCKS until the reply lands and prints it to stdout, for headless
            loop drivers (run it in its own driver pane; abort by closing the pane).
  respond = deliver a reply back to whoever is watching the calling pane (or an explicit target),
            consuming the watch. Injected by the trailer, so agents run it verbatim.
  inject  = raw send with no watch and no trailer (fire-and-forget / manual).

A pane holds at most one open request at a time: fan work out across panes, not within one.
Roles were removed — panes are homogeneous. Attach an optional persona with --type (e.g. --type triage).
Default agent: pi. Use --agent claude for Claude Code or --agent cursor for Cursor Agent.
`;
}

export function parse(argv: string[]): Command {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") return { kind: "help" };
  switch (cmd) {
    case "commander": return { kind: "commander", options: parseCommanderArgs(args) };
    case "create": case "open-agent": case "agent": return { kind: "create", options: parseCreateArgs(args) };
    case "request": return { kind: "request", ...parseInjectArgs(args, true) };
    case "inject": { const { target, text, submitDelayMs, pollMs } = parseInjectArgs(args, false); return { kind: "inject", target, text, submitDelayMs, pollMs }; }
    case "watch": return { kind: "watch", ...parseWatchArgs(args) };
    case "respond": case "complete": return { kind: "respond", ...parseRespondArgs(args) };
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
      case "--role": throw new Error("roles were removed; `commander` is just a convenience launcher (claude in the current pane)");
      case "--split": throw new Error("--split is no longer part of the Courier interface; use default placement or --tab");
      default: throw new Error(`unknown option: ${arg ?? ""}`);
    }
  }
  return { name, from, tab, here: !tab, tail, agent };
}

function parseCreateArgs(args: string[]): CreateOptions {
  const name = requireValue(args.shift(), "name");
  let from: string | undefined; let tab = false; let agent = "pi"; let type: WorkerType | undefined; const tail: string[] = [];
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--agent": agent = requireValue(args.shift(), "--agent value"); break;
      case "--type": { const value = requireValue(args.shift(), `--type value (${knownWorkerTypes.join("|")})`); if (!isKnownWorkerType(value)) throw new Error(`--type must be one of: ${knownWorkerTypes.join(", ")}`); type = value; break; }
      case "--from": from = requireValue(args.shift(), "--from value"); break;
      case "--tab": tab = true; break;
      case "--cwd": tail.push("--cwd", requireValue(args.shift(), "--cwd value")); break;
      case "--focus": case "--no-focus": tail.push(arg); break;
      case "--role": throw new Error("roles were removed; panes are homogeneous. Attach a persona with --type instead");
      case "--split": throw new Error("--split is no longer part of the Courier interface; use default placement or --tab");
      default: throw new Error(`unknown option: ${arg ?? ""}`);
    }
  }
  return { name, from, tab, tail, agent, type };
}

function parseInjectArgs(args: string[], allowAwait: boolean): { target: string; text: string; submitDelayMs: number; pollMs: number; awaitReply: boolean; awaitPollMs: number; awaitTimeoutMs: number } {
  const target = requireValue(args.shift(), "name or id"); let text: string | undefined; let submitDelayMs = 750; let pollMs = 1000;
  let awaitReply = false; let awaitPollMs = 500; let awaitTimeoutMs = 0;
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--text": text = requireValue(args.shift(), "--text value"); break;
      case "--submit-delay-ms": submitDelayMs = Number(requireValue(args.shift(), "--submit-delay-ms value")); break;
      case "--poll-ms": pollMs = Number(requireValue(args.shift(), "--poll-ms value")); break;
      case "--await": if (!allowAwait) throw new Error("--await is only valid on `request`"); awaitReply = true; break;
      case "--await-poll-ms": if (!allowAwait) throw new Error("--await-poll-ms is only valid on `request`"); awaitPollMs = Number(requireValue(args.shift(), "--await-poll-ms value")); break;
      case "--await-timeout-ms": if (!allowAwait) throw new Error("--await-timeout-ms is only valid on `request`"); awaitTimeoutMs = Number(requireValue(args.shift(), "--await-timeout-ms value")); break;
      default: throw new Error(`unknown option: ${arg ?? ""}`);
    }
  }
  if (!text) throw new Error("missing --text");
  return { target, text, submitDelayMs, pollMs, awaitReply, awaitPollMs, awaitTimeoutMs };
}

function parseWatchArgs(args: string[]): { target: string; watcher?: string } {
  const target = requireValue(args.shift(), "target name or id"); let watcher: string | undefined;
  while (args.length > 0) { const arg = args.shift(); if (arg === "--watcher") watcher = requireValue(args.shift(), "--watcher value"); else throw new Error(`unknown option: ${arg ?? ""}`); }
  return { target, watcher };
}

function parseRespondArgs(args: string[]): { target?: string; message: string } {
  // Target is optional and defaults to the calling pane. A leading positional
  // (not starting with --) is treated as an explicit responder.
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
