import { system } from "@silverbulletmd/silverbullet/syscalls";

// Config values read while an index queue batch runs. Every page in a batch
// asks for the same few keys, and each read is a round trip to the main
// thread. Outside a batch, reads go straight to the config.
let batchCache: Map<string, Promise<any>> | undefined;
// Batches that overlap share the cache; it is dropped when the last ends
let activeBatches = 0;

export type DeepReadonly<T> = T extends (...args: any[]) => any
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/**
 * Runs one index queue batch with config reads cached for its duration. A
 * config change applies once no batch is running any more.
 */
export async function withIndexConfigCache<T>(
  fn: () => Promise<T>,
): Promise<T> {
  if (activeBatches++ === 0) {
    batchCache = new Map();
  }
  try {
    return await fn();
  } finally {
    if (--activeBatches === 0) {
      batchCache = undefined;
    }
  }
}

/**
 * Reads a config value for indexing. Within a batch every page gets the same
 * object, so the value is typed read-only: a change made for one page would
 * leak into the next.
 */
export function indexConfig<T>(
  key: string,
  defaultValue: T,
): Promise<DeepReadonly<T>> {
  if (!batchCache) {
    return system.getConfig(key, defaultValue);
  }
  const cacheKey = JSON.stringify([key, defaultValue]);
  let value = batchCache.get(cacheKey);
  if (!value) {
    value = system.getConfig(key, defaultValue);
    batchCache.set(cacheKey, value);
  }
  return value;
}
