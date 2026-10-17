import { expect, test } from "vitest";
import { createMockSystem } from "../../plug-api/system_mock.ts";
import { indexConfig, withIndexConfigCache } from "./config_cache.ts";

test("within a batch every read of a key returns the same read-only value", async () => {
  const { config } = createMockSystem();
  config.set("taskStates", { waiting: { name: "WAIT", done: false } });

  await withIndexConfigCache(async () => {
    const first = await indexConfig("taskStates", {
      waiting: { name: "", done: false },
    });
    const second = await indexConfig("taskStates", {
      waiting: { name: "", done: false },
    });
    expect(second).toBe(first);
    // Checked by the type checker only, never run
    const _mutate = () => {
      // @ts-expect-error: shared between pages, so it must not be changed
      first.waiting.done = true;
    };
  });
});

test("overlapping batches do not leave the cache behind", async () => {
  const { config } = createMockSystem();
  config.set("index.paragraph.all", false);
  let endFirst!: () => void;
  const first = withIndexConfigCache(
    () => new Promise<void>((resolve) => (endFirst = resolve)),
  );
  const second = withIndexConfigCache(async () => {
    await indexConfig("index.paragraph.all", false);
  });
  endFirst();
  await Promise.all([first, second]);

  // Outside any batch, a change is seen right away
  config.set("index.paragraph.all", true);
  expect(await indexConfig("index.paragraph.all", false)).toBe(true);
});
