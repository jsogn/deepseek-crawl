import { describe, expect, it } from "vitest";
import { createIndexAllocator } from "../../src/retry/indexes.js";

describe("createIndexAllocator", () => {
  it("preserves free preferred indexes and fills collisions monotonically", () => {
    const allocator = createIndexAllocator();

    expect(allocator.allocate(2)).toBe(2);
    expect(allocator.allocate(2)).toBe(1);
    expect(allocator.allocate(2)).toBe(3);
    expect(allocator.allocate()).toBe(4);
    expect(allocator.allocate(4)).toBe(5);
  });

  it("handles a large collision sequence with unique indexes", () => {
    const allocator = createIndexAllocator();
    const indexes = Array.from({ length: 20_000 }, () => allocator.allocate(1));

    expect(indexes[0]).toBe(1);
    expect(indexes.at(-1)).toBe(20_000);
    expect(new Set(indexes).size).toBe(indexes.length);
  });
});
