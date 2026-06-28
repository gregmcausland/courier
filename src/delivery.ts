import type { Delivery } from "./types.js";
import { HerdrAdapter, InjectionReadinessTimeout } from "./herdr.js";
import { CourierStore } from "./store.js";
import { sleep } from "./util.js";

export class DeliveryPump {
  constructor(private herdr: HerdrAdapter, private store: CourierStore, private resolveTarget: (target: string) => ReturnType<HerdrAdapter["resolve"]>) {}

  injectText(target: string, text: string, submitDelayMs = 750, pollMs = 1000, timeoutMs = 60000): void {
    const pane = this.herdr.waitUntilInjectable(() => this.resolveTarget(target), target, pollMs, timeoutMs);
    this.herdr.sendText(pane.pane_id, text);
    sleep(submitDelayMs);
    this.herdr.submit(pane.pane_id);
  }

  enqueueCompletion(to: string, from: string, message: string, createdAt: string): void {
    this.store.enqueueDelivery({
      id: `${createdAt}_${process.pid}_${Math.random().toString(16).slice(2)}`,
      to,
      from,
      text: `[courier complete]\ntarget: ${from}\n\n${message}`,
      createdAt,
    });
  }

  // Persist a completion that has no live watcher, keyed under the completer's own
  // terminal, so a watcher arming late can still pick it up. Without this, a
  // completion fired while no watch is armed evaporates with no record.
  bufferCompletion(self: string, message: string, createdAt: string): void {
    this.enqueueCompletion(self, self, message, createdAt);
  }

  // Re-key any completions buffered under `from` so they are delivered to `to`,
  // then return how many were moved. Used when a watch arms after the worker has
  // already completed.
  redeliverPending(from: string, to: string): number {
    const pending = this.store.readDeliveries(from).filter((delivery) => delivery.from === from);
    for (const delivery of pending) {
      this.store.enqueueDelivery({ ...delivery, to, id: `${delivery.id}_redeliver_${Math.random().toString(16).slice(2)}` });
      this.store.removeDelivery(delivery);
    }
    return pending.length;
  }

  drain(to: string, submitDelayMs = 750, pollMs = 1000): number {
    let delivered = 0;
    this.store.withLock(`deliver-${to}`, () => {
      for (;;) {
        const next = this.store.readDeliveries(to)[0];
        if (!next) break;
        try {
          this.injectText(to, next.text, submitDelayMs, pollMs);
        } catch (error) {
          if (error instanceof InjectionReadinessTimeout) {
            if (delivered === 0) process.stderr.write(`${error.message}\n`);
            break;
          }
          throw error;
        }
        this.store.removeDelivery(next);
        delivered += 1;
        sleep(pollMs);
      }
    });
    return delivered;
  }
}
