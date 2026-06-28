import type { Delivery } from "./types.js";
import { HerdrAdapter } from "./herdr.js";
import { CourierStore } from "./store.js";
import { sleep } from "./util.js";

export class DeliveryPump {
  constructor(private herdr: HerdrAdapter, private store: CourierStore, private resolveTarget: (target: string) => ReturnType<HerdrAdapter["resolve"]>) {}

  injectText(target: string, text: string, submitDelayMs = 750, pollMs = 1000): void {
    const pane = this.herdr.waitUntilInjectable(() => this.resolveTarget(target), target, pollMs);
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

  drain(to: string, submitDelayMs = 750, pollMs = 1000): number {
    let delivered = 0;
    this.store.withLock(`deliver-${to}`, () => {
      for (;;) {
        const next = this.store.readDeliveries(to)[0];
        if (!next) break;
        this.injectText(to, next.text, submitDelayMs, pollMs);
        this.store.removeDelivery(next);
        delivered += 1;
        sleep(pollMs);
      }
    });
    return delivered;
  }
}
