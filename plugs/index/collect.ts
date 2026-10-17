import { sleep } from "@silverbulletmd/silverbullet/lib/async";

/**
 * Turns a function over many items into one that takes them one at a time:
 * items passed while a collection is open go to `flush` together, and each
 * caller gets the result at its own position, so a failure can stay with the
 * item that caused it. The pages of an index batch are indexed concurrently,
 * so their calls to the main thread can share one round trip.
 *
 * A collection closes after the current task. It deliberately does not wait
 * longer: the pages of a batch get there at different times, and batches run
 * one after another, so waiting would leave the main thread idle.
 */
export function collectWithinTask<Item, Result>(
  flush: (items: Item[]) => Promise<Result[]>,
): (item: Item) => Promise<Result> {
  let collecting: { items: Item[]; results: Promise<Result[]> } | undefined;
  return async (item) => {
    if (!collecting) {
      const items: Item[] = [];
      collecting = {
        items,
        results: sleep(0).then(() => {
          collecting = undefined;
          return flush(items);
        }),
      };
    }
    const { items, results } = collecting;
    const position = items.push(item) - 1;
    return (await results)[position];
  };
}
