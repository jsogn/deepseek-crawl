export interface RetryIndexAllocator {
  allocate(preferred?: number): number;
}

export function createIndexAllocator(): RetryIndexAllocator {
  const used = new Set<number>();
  let cursor = 1;

  return {
    allocate(preferred) {
      if (preferred !== undefined && !used.has(preferred)) {
        used.add(preferred);
        return preferred;
      }
      while (used.has(cursor)) {
        cursor += 1;
      }
      const index = cursor;
      used.add(index);
      cursor += 1;
      return index;
    },
  };
}
