import { expect, test } from "vitest";
import { createMockSystem } from "../../plug-api/system_mock.ts";
import { indexObjectsBatched } from "./batched_index.ts";

test("concurrent writes go out as one syscall", async () => {
  const { objectIndex } = createMockSystem();
  const calls: string[] = [];
  const original = (globalThis as any).syscall;
  (globalThis as any).syscall = (name: string, ...args: any[]) => {
    if (name.startsWith("index.indexObjects")) calls.push(name);
    return original(name, ...args);
  };
  try {
    await Promise.all([
      indexObjectsBatched("A", [{ ref: "A", tag: "page", name: "A" } as any]),
      indexObjectsBatched("B", [{ ref: "B", tag: "page", name: "B" } as any]),
    ]);
  } finally {
    (globalThis as any).syscall = original;
  }
  expect(calls).toEqual(["index.indexObjectsBatch"]);
  expect(await objectIndex.getObjectByRef("B", "page", "B")).toMatchObject({
    name: "B",
  });
});

test("a failing page gets its own error, the others are written", async () => {
  const { objectIndex, config } = createMockSystem();
  config.set("tags", {
    broken: {
      transform: () => {
        throw new Error("bad transform");
      },
    },
  });
  const [failed, written] = await Promise.allSettled([
    indexObjectsBatched("A", [{ ref: "A@1", tag: "broken", page: "A" } as any]),
    indexObjectsBatched("B", [{ ref: "B", tag: "page", name: "B" } as any]),
  ]);
  expect(failed.status).toEqual("rejected");
  expect((failed as PromiseRejectedResult).reason.message).toContain(
    "bad transform",
  );
  expect(written.status).toEqual("fulfilled");
  expect(await objectIndex.getObjectByRef("B", "page", "B")).toMatchObject({
    name: "B",
  });
});
