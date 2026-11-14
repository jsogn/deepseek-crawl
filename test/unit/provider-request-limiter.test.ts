import { describe, expect, it } from "vitest";
import { ProviderRequestLimiter } from "../../src/gateway/provider-request-limiter.js";

describe("ProviderRequestLimiter", () => {
  it("caps concurrent provider operations and drains queued work", async () => {
    const limiter = new ProviderRequestLimiter(2);
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const operation = () =>
      limiter.run(undefined, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        active -= 1;
      });

    const first = operation();
    const second = operation();
    const third = operation();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(active).toBe(2);
    expect(limiter.snapshot()).toEqual({ active: 2, queued: 1 });

    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(active).toBe(2);
    expect(limiter.snapshot()).toEqual({ active: 2, queued: 0 });

    while (releases.length > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all([first, second, third]);
    expect(maxActive).toBe(2);
    expect(limiter.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it("removes aborted queued operations", async () => {
    const limiter = new ProviderRequestLimiter(1);
    let release!: () => void;
    const first = limiter.run(
      undefined,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const second = limiter.run(controller.signal, async () => undefined);

    controller.abort(new Error("cancelled"));
    await expect(second).rejects.toThrow("cancelled");
    expect(limiter.snapshot()).toEqual({ active: 1, queued: 0 });
    release();
    await first;
    expect(limiter.snapshot()).toEqual({ active: 0, queued: 0 });
  });
});
