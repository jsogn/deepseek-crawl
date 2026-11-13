import { describe, expect, it, vi } from "vitest";
import { runLayeredTasks } from "../../src/crawl/queue.js";

describe("runLayeredTasks", () => {
  it("preserves result order while bounding concurrency", async () => {
    let active = 0;
    let maximum = 0;
    const results = await runLayeredTasks(["a", "b", "c", "d"], {
      concurrency: 2,
      delayMs: 0,
      run: async (value) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, value === "a" ? 10 : 1));
        active -= 1;
        return value.toUpperCase();
      },
    });

    expect(results).toEqual(["A", "B", "C", "D"]);
    expect(maximum).toBeLessThanOrEqual(2);
  });

  it("does not start items after cancellation", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });

    await expect(
      runLayeredTasks(["a", "b"], {
        concurrency: 1,
        delayMs: 0,
        signal: controller.signal,
        run,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("spaces back-to-back request starts with the injected sleep function", async () => {
    const sleep = vi.fn(async () => undefined);
    const run = vi.fn(async (value: string) => value.toUpperCase());

    const results = await runLayeredTasks(["a", "b", "c"], {
      concurrency: 3,
      delayMs: 250,
      sleep,
      run,
    });

    expect(results).toEqual(["A", "B", "C"]);
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    for (const [milliseconds] of sleep.mock.calls) {
      expect(milliseconds).toBeGreaterThan(0);
      expect(milliseconds).toBeLessThanOrEqual(250);
    }
  });
});
