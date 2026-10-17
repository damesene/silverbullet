import type { ObjectValue } from "@silverbulletmd/silverbullet/type/index";
import { index } from "@silverbulletmd/silverbullet/syscalls";
import { collectWithinTask } from "./collect.ts";

const write = collectWithinTask(
  (entries: { page: string; objects: ObjectValue<any>[] }[]) =>
    index.indexObjectsBatch(entries),
);

/**
 * `index.indexObjects` for indexing: the objects of concurrently indexed
 * pages are written with one syscall and one transaction instead of one per
 * page. A page that fails gets its own error; the others are written.
 */
export async function indexObjectsBatched(
  page: string,
  objects: ObjectValue<any>[],
): Promise<void> {
  const error = await write({ page, objects });
  if (error !== null) {
    throw new Error(error);
  }
}
