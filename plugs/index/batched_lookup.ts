import type { PathLookup } from "@silverbulletmd/silverbullet/lib/resolve_path";
import { space } from "@silverbulletmd/silverbullet/syscalls";
import { collectWithinTask } from "./collect.ts";

/**
 * `space.lookupPaths` for indexing: lookups of concurrently indexed pages go
 * out as one syscall instead of one round trip to the main thread per page.
 * Each caller gets the entries for its own paths only.
 */
export const lookupPathsBatched = collectWithinTask(
  async (pathLists: string[][]) => {
    const all = await space.lookupPaths([...new Set(pathLists.flat())]);
    return pathLists.map((paths) => {
      const result: Record<string, PathLookup> = {};
      for (const path of paths) {
        result[path] = all[path];
      }
      return result;
    });
  },
);
