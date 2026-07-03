#!/usr/bin/env node
import { parse, usage } from "./parser.js";
import { CourierRuntime } from "./runtime.js";

function printJson(value: unknown): void { console.log(JSON.stringify(value)); }
function fail(error: unknown): never {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: number }).status) : undefined;
  console.error(error instanceof Error ? error.message : String(error));
  if (!status) console.error(usage());
  process.exit(status || 2);
}

try {
  const command = parse(process.argv.slice(2));
  if (command.kind === "help") { console.log(usage()); process.exit(0); }

  const runtime = new CourierRuntime();
  switch (command.kind) {
    case "create":
    case "commander": printJson(runtime.create(command.options)); break;
    case "request":
      if (command.awaitReply) {
        const reply = runtime.requestAwait(command.target, command.text, { submitDelayMs: command.submitDelayMs, pollMs: command.pollMs, awaitPollMs: command.awaitPollMs, awaitTimeoutMs: command.awaitTimeoutMs });
        console.log(reply.message);
      } else printJson(runtime.request(command.target, command.text, command.submitDelayMs, command.pollMs));
      break;
    case "inject": runtime.inject(command.target, command.text, command.submitDelayMs, command.pollMs); break;
    case "watch": printJson(runtime.watch(command.target, command.watcher)); break;
    case "respond": printJson(runtime.respond(command.target, command.message)); break;
    case "deliver": printJson(runtime.deliver(command.target)); break;
    case "close": printJson(runtime.closeOrSuspend(command.target, "close")); break;
    case "suspend": printJson(runtime.closeOrSuspend(command.target, "suspend")); break;
    case "debug-list": console.log(JSON.stringify(runtime.debugList(), null, 2)); break;
  }
} catch (error) { fail(error); }
