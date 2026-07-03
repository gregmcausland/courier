import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { DeliveryPump } from "./delivery.js";
import { HerdrAdapter, InjectionReadinessTimeout } from "./herdr.js";
import { CourierStore } from "./store.js";
import type { Pane } from "./types.js";
import { isAwaitWatcher, makeAwaitWatcher } from "./util.js";

// A fake Herdr that never blocks and records what it would have typed into a pane.
// Delivery timing is passed as 0ms in tests so drains complete instantly.
function fakeHerdr(overrides: Partial<HerdrAdapter> = {}): { herdr: HerdrAdapter; sent: string[] } {
  const sent: string[] = [];
  const herdr = {
    waitUntilInjectable: (resolve: () => Pane | undefined): Pane => resolve() ?? { pane_id: "p" },
    sendText: (_paneId: string, text: string): void => { sent.push(text); },
    submit: (): void => {},
    ...overrides,
  } as unknown as HerdrAdapter;
  return { herdr, sent };
}

let root: string;
let store: CourierStore;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "courier-test-")); store = new CourierStore(root); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test("store delivery queue is FIFO and removable", () => {
  store.enqueueDelivery({ id: "2020-01-01T00:00:00.000Z_a", to: "W", from: "T", text: "first", createdAt: "" });
  store.enqueueDelivery({ id: "2020-01-01T00:00:01.000Z_b", to: "W", from: "T", text: "second", createdAt: "" });
  const queued = store.readDeliveries("W");
  assert.deepEqual(queued.map((d) => d.text), ["first", "second"]);
  store.removeDelivery(queued[0]);
  assert.deepEqual(store.readDeliveries("W").map((d) => d.text), ["second"]);
});

test("a completion with no watcher is buffered under the completer, then recovered by a late watch", () => {
  const { herdr } = fakeHerdr();
  const pump = new DeliveryPump(herdr, store, () => ({ pane_id: "p" }));

  // No live watcher: buffer under the completer's own terminal.
  pump.bufferCompletion("T", "the answer", "2020-01-01T00:00:00.000Z");
  const buffered = store.readDeliveries("T");
  assert.equal(buffered.length, 1);
  assert.equal(buffered[0].from, "T");
  assert.equal(buffered[0].to, "T");

  // A watch arms late: re-key the buffered reply from T to watcher W.
  const moved = pump.redeliverPending("T", "W");
  assert.equal(moved, 1);
  assert.equal(store.readDeliveries("T").length, 0);
  const forW = store.readDeliveries("W");
  assert.equal(forW.length, 1);
  assert.equal(forW[0].to, "W");
  assert.match(forW[0].text, /the answer/);

  // Draining delivers it and clears the queue.
  const delivered = pump.drain("W", 0, 0);
  assert.equal(delivered, 1);
  assert.equal(store.readDeliveries("W").length, 0);
});

test("drain leaves the delivery queued when the target never becomes injectable", () => {
  const { herdr } = fakeHerdr({
    waitUntilInjectable: () => { throw new InjectionReadinessTimeout("W"); },
  });
  const pump = new DeliveryPump(herdr, store, () => ({ pane_id: "p" }));
  pump.enqueueCompletion("W", "T", "unread", "2020-01-01T00:00:00.000Z");

  const delivered = pump.drain("W", 0, 0);
  assert.equal(delivered, 0);
  // Durable: the reply survives the failed delivery for a later drain.
  assert.equal(store.readDeliveries("W").length, 1);
});

test("enqueued completion carries the [courier respond] envelope and the raw message", () => {
  const { herdr, sent } = fakeHerdr();
  const pump = new DeliveryPump(herdr, store, () => ({ pane_id: "p" }));
  pump.enqueueCompletion("W", "T", "shipped it", "2020-01-01T00:00:00.000Z");
  // The raw reply is preserved alongside the injectable envelope so `request --await` can return it unwrapped.
  assert.equal(store.readDeliveries("W")[0].message, "shipped it");
  pump.drain("W", 0, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^\[courier respond\]/);
  assert.match(sent[0], /from: T/);
  assert.match(sent[0], /shipped it/);
});

test("drain skips synthetic await watchers (poll-drained in-process, never injected)", () => {
  const { herdr, sent } = fakeHerdr();
  const pump = new DeliveryPump(herdr, store, () => { throw new Error("await watchers must never resolve a pane"); });
  const watcher = makeAwaitWatcher();
  assert.ok(isAwaitWatcher(watcher));
  pump.enqueueCompletion(watcher, "T", "for the driver", "2020-01-01T00:00:00.000Z");

  const delivered = pump.drain(watcher, 0, 0);
  assert.equal(delivered, 0);           // nothing injected
  assert.equal(sent.length, 0);
  // Reply stays queued for the awaiting process to read directly.
  assert.equal(store.readDeliveries(watcher).length, 1);
});

test("unregisterWatch removes only the named watcher", () => {
  store.registerWatch("T", "W1");
  store.registerWatch("T", "W2");
  store.unregisterWatch("T", "W1");
  assert.deepEqual(store.loadState().watches["T"], ["W2"]);
  store.unregisterWatch("T", "W2");
  assert.equal(store.loadState().watches["T"], undefined);   // empty list is dropped
});
